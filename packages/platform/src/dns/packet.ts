// Just enough of RFC 1035 for a blocking forwarder. Allowed queries are forwarded as raw
// bytes and never parsed beyond the question; blocked ones get a response built here.

export const TYPE = { A: 1, SOA: 6, AAAA: 28, OPT: 41, HTTPS: 65 } as const;
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;

export interface Question {
  /** Lower-case, no trailing dot. */
  readonly name: string;
  readonly type: number;
  readonly cls: number;
}

export interface Query {
  readonly id: number;
  readonly flags: number;
  readonly question: Question;
  /** Offset just past the question section in the original packet. */
  readonly questionEnd: number;
  /** The query carried an EDNS OPT record. */
  readonly hasEdns: boolean;
  readonly arcount: number;
}

const HEADER = 12;
const MAX_NAME = 255;

/** Why a packet is not a query we can answer. `id` is set when at least the header was readable. */
export type ParseResult =
  | { readonly ok: true; readonly query: Query }
  | { readonly ok: false; readonly reason: 'short' | 'response' | 'opcode' | 'malformed'; readonly id: number | null; readonly flags: number };

/** Read a question name. Compression pointers are not allowed in a question. */
function readName(buf: Buffer, start: number): { name: string; end: number } | null {
  const labels: string[] = [];
  let pos = start;
  let total = 1;
  for (;;) {
    if (pos >= buf.length) return null;
    const len = buf[pos] as number;
    if (len === 0) {
      pos++;
      break;
    }
    if (len & 0xc0) return null; // pointer or reserved label type
    if (len > 63 || pos + 1 + len > buf.length) return null;
    total += len + 1;
    if (total > MAX_NAME) return null;
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len).toLowerCase());
    pos += 1 + len;
  }
  return { name: labels.join('.'), end: pos };
}

/** Parse a standard query with exactly one question. */
export function parseQuery(buf: Buffer): ParseResult {
  if (buf.length < HEADER) return { ok: false, reason: 'short', id: null, flags: 0 };
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return { ok: false, reason: 'response', id, flags };
  if (((flags >> 11) & 0xf) !== 0) return { ok: false, reason: 'opcode', id, flags };
  const qd = buf.readUInt16BE(4);
  if (qd !== 1) return { ok: false, reason: 'malformed', id, flags };
  const name = readName(buf, HEADER);
  if (!name || name.end + 4 > buf.length) return { ok: false, reason: 'malformed', id, flags };
  const type = buf.readUInt16BE(name.end);
  const cls = buf.readUInt16BE(name.end + 2);
  const questionEnd = name.end + 4;
  const arcount = buf.readUInt16BE(10);
  const hasEdns = arcount > 0 && buf[questionEnd] === 0 && buf.length >= questionEnd + 3 && buf.readUInt16BE(questionEnd + 1) === TYPE.OPT;
  return { ok: true, query: { id, flags, question: { name: name.name, type, cls }, questionEnd, hasEdns, arcount } };
}

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split('.').filter(Boolean)) parts.push(Buffer.from([label.length]), Buffer.from(label, 'latin1'));
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** A minimal EDNS OPT record (advertises 1232 bytes), so clients that sent EDNS keep using it. */
const OPT_RECORD = Buffer.from([0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);

/** Short-lived SOA so a blocked name is not negatively cached for long (TTL 1 second). */
function soaRecord(): Buffer {
  const rdata = Buffer.concat([
    encodeName('ns.hourkeep.invalid'),
    encodeName('hostmaster.hourkeep.invalid'),
    Buffer.alloc(20),
  ]);
  rdata.writeUInt32BE(1, rdata.length - 20); // serial
  rdata.writeUInt32BE(1, rdata.length - 16); // refresh
  rdata.writeUInt32BE(1, rdata.length - 12); // retry
  rdata.writeUInt32BE(1, rdata.length - 8); // expire
  rdata.writeUInt32BE(1, rdata.length - 4); // minimum
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0); // owner: the question name
  head.writeUInt16BE(TYPE.SOA, 2);
  head.writeUInt16BE(1, 4); // IN
  head.writeUInt32BE(1, 6); // TTL
  head.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, rdata]);
}

function header(q: { id: number; flags: number }, rcode: number, counts: { an: number; ns: number; ar: number }): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt16BE(q.id, 0);
  // QR=1, opcode and RD copied, RA=1, AA/TC/AD/CD cleared
  h.writeUInt16BE(0x8000 | (q.flags & 0x7900) | 0x0080 | (rcode & 0xf), 2);
  h.writeUInt16BE(1, 4);
  h.writeUInt16BE(counts.an, 6);
  h.writeUInt16BE(counts.ns, 8);
  h.writeUInt16BE(counts.ar, 10);
  return h;
}

/** NXDOMAIN for a blocked name: the question echoed exactly (case included), a 1 second SOA, EDNS if asked. */
export function buildNxdomain(packet: Buffer, q: Query): Buffer {
  const parts = [header(q, RCODE.NXDOMAIN, { an: 0, ns: 1, ar: q.hasEdns ? 1 : 0 }), packet.subarray(HEADER, q.questionEnd), soaRecord()];
  if (q.hasEdns) parts.push(OPT_RECORD);
  return Buffer.concat(parts);
}

/** An error reply (SERVFAIL, FORMERR, NOTIMP) that echoes the question when there is one. */
export function buildError(id: number, flags: number, rcode: number, packet?: Buffer, q?: Query): Buffer {
  const hasQ = packet !== undefined && q !== undefined;
  const h = header({ id, flags }, rcode, { an: 0, ns: 0, ar: 0 });
  h.writeUInt16BE(hasQ ? 1 : 0, 4);
  return hasQ ? Buffer.concat([h, packet.subarray(HEADER, q.questionEnd)]) : h;
}

/** Answer an A query with one address (used for the self-test name); other types get an empty NOERROR. */
export function buildAnswerA(packet: Buffer, q: Query, address: string): Buffer {
  const octets = address.split('.').map(Number);
  const isA = q.question.type === TYPE.A && octets.length === 4;
  const rr = Buffer.alloc(16);
  if (isA) {
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(TYPE.A, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(0, 6); // TTL 0: never cached
    rr.writeUInt16BE(4, 10);
    Buffer.from(octets).copy(rr, 12);
  }
  const parts = [header(q, RCODE.NOERROR, { an: isA ? 1 : 0, ns: 0, ar: q.hasEdns ? 1 : 0 }), packet.subarray(HEADER, q.questionEnd)];
  if (isA) parts.push(rr);
  if (q.hasEdns) parts.push(OPT_RECORD);
  return Buffer.concat(parts);
}

/** Response code of a packet, or null if too short. */
export function rcodeOf(packet: Buffer): number | null {
  return packet.length < HEADER ? null : packet.readUInt16BE(2) & 0xf;
}

/** Build a plain query packet (for tests and for the self-test). */
export function buildQuery(name: string, type: number, id = 0x1234, opts: { edns?: boolean; rd?: boolean } = {}): Buffer {
  const h = Buffer.alloc(HEADER);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(opts.rd === false ? 0 : 0x0100, 2);
  h.writeUInt16BE(1, 4);
  if (opts.edns) h.writeUInt16BE(1, 10);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(type, 0);
  tail.writeUInt16BE(1, 2);
  const parts = [h, encodeName(name), tail];
  if (opts.edns) parts.push(OPT_RECORD);
  return Buffer.concat(parts);
}
