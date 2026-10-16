import { describe, expect, it } from 'vitest';
import { RCODE, TYPE, buildAnswerA, buildError, buildNxdomain, buildQuery, parseQuery, rcodeOf, type Query } from './packet.js';

function q(packet: Buffer): Query {
  const r = parseQuery(packet);
  if (!r.ok) throw new Error(r.reason);
  return r.query;
}

/** A small decoder for what we build, so the tests check the wire format independently. */
function decode(buf: Buffer) {
  const flags = buf.readUInt16BE(2);
  const counts = { qd: buf.readUInt16BE(4), an: buf.readUInt16BE(6), ns: buf.readUInt16BE(8), ar: buf.readUInt16BE(10) };
  let pos = 12;
  const skipName = (): void => {
    for (;;) {
      const len = buf[pos] as number;
      if (len === 0) return void pos++;
      if ((len & 0xc0) === 0xc0) return void (pos += 2);
      pos += len + 1;
    }
  };
  const questions: { type: number }[] = [];
  for (let i = 0; i < counts.qd; i++) {
    skipName();
    questions.push({ type: buf.readUInt16BE(pos) });
    pos += 4;
  }
  const records: { type: number; ttl: number; rdata: Buffer }[] = [];
  for (let i = 0; i < counts.an + counts.ns + counts.ar; i++) {
    skipName();
    const type = buf.readUInt16BE(pos);
    const ttl = buf.readUInt32BE(pos + 4);
    const len = buf.readUInt16BE(pos + 8);
    records.push({ type, ttl, rdata: buf.subarray(pos + 10, pos + 10 + len) });
    pos += 10 + len;
  }
  return {
    id: buf.readUInt16BE(0),
    qr: (flags & 0x8000) !== 0,
    rd: (flags & 0x0100) !== 0,
    ra: (flags & 0x0080) !== 0,
    aa: (flags & 0x0400) !== 0,
    tc: (flags & 0x0200) !== 0,
    rcode: flags & 0xf,
    counts,
    questions,
    records,
    end: pos,
  };
}

describe('parseQuery', () => {
  it('reads name, type and class, lower-casing the name', () => {
    const r = q(buildQuery('Rr1---SN-ab5l6n7y.GoogleVideo.com', TYPE.AAAA, 0xbeef));
    expect(r).toMatchObject({ id: 0xbeef, question: { name: 'rr1---sn-ab5l6n7y.googlevideo.com', type: TYPE.AAAA, cls: 1 }, hasEdns: false });
  });

  it('notices EDNS', () => {
    expect(q(buildQuery('a.example', TYPE.A, 1, { edns: true })).hasEdns).toBe(true);
    expect(q(buildQuery('a.example', TYPE.A, 1)).hasEdns).toBe(false);
  });

  it('accepts the root name and a long but legal name', () => {
    expect(q(buildQuery('', TYPE.A)).question.name).toBe('');
    const label = 'a'.repeat(63);
    expect(q(buildQuery(`${label}.${label}.${label}.com`, TYPE.A)).question.name.length).toBeGreaterThan(190);
  });

  it.each<[string, () => Buffer, string]>([
    ['empty', () => Buffer.alloc(0), 'short'],
    ['11 bytes', () => Buffer.alloc(11), 'short'],
    ['a response', () => { const b = buildQuery('a.example', 1); b[2] = (b[2] as number) | 0x80; return b; }, 'response'],
    ['a non-QUERY opcode', () => { const b = buildQuery('a.example', 1); b[2] = (b[2] as number) | (4 << 3); return b; }, 'opcode'],
    ['two questions', () => { const b = buildQuery('a.example', 1); b.writeUInt16BE(2, 4); return b; }, 'malformed'],
    ['no question', () => { const b = buildQuery('a.example', 1); b.writeUInt16BE(0, 4); return b; }, 'malformed'],
    ['truncated name', () => buildQuery('a.example', 1).subarray(0, 16), 'malformed'],
    ['missing type and class', () => buildQuery('a.example', 1).subarray(0, -3), 'malformed'],
    ['compression pointer in the question', () => { const b = buildQuery('a.example', 1); b[12] = 0xc0; b[13] = 0; return b; }, 'malformed'],
    ['label longer than 63', () => { const b = buildQuery('a.example', 1); b[12] = 64; return b; }, 'malformed'],
  ])('rejects %s', (_n, make, reason) => {
    const r = parseQuery(make());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(reason);
  });

  it('keeps the id so an error reply can still be sent', () => {
    const b = buildQuery('a.example', 1, 0x4321);
    b.writeUInt16BE(3, 4);
    const r = parseQuery(b);
    expect(!r.ok && r.id).toBe(0x4321);
  });

  it('rejects names over 255 octets', () => {
    const label = 'a'.repeat(63);
    expect(parseQuery(buildQuery(`${label}.${label}.${label}.${label}.com`, 1)).ok).toBe(false);
  });
});

describe('buildNxdomain', () => {
  const query = buildQuery('RR1.GoogleVideo.com', TYPE.A, 0x0042, { edns: true });
  const out = buildNxdomain(query, q(query));
  const d = decode(out);

  it('is a well-formed NXDOMAIN reply to the same id with recursion flags set', () => {
    expect(d).toMatchObject({ id: 0x42, qr: true, rd: true, ra: true, aa: false, tc: false, rcode: RCODE.NXDOMAIN });
    expect(rcodeOf(out)).toBe(3);
    expect(d.end).toBe(out.length);
  });

  it('echoes the question byte for byte, keeping the case the client used (0x20 encoding)', () => {
    expect(d.questions).toEqual([{ type: TYPE.A }]);
    expect(out.subarray(12, q(query).questionEnd)).toEqual(query.subarray(12, q(query).questionEnd));
    expect(out.includes(Buffer.from('GoogleVideo'))).toBe(true);
  });

  it('carries a 1 second SOA so the refusal is not cached for long', () => {
    const soa = d.records.find((r) => r.type === TYPE.SOA);
    expect(d.counts).toMatchObject({ an: 0, ns: 1 });
    expect(soa?.ttl).toBe(1);
    expect(soa?.rdata.readUInt32BE(soa.rdata.length - 4)).toBe(1); // minimum
  });

  it('answers EDNS with an OPT record, and omits it when the query had none', () => {
    expect(d.counts.ar).toBe(1);
    expect(d.records.some((r) => r.type === TYPE.OPT)).toBe(true);
    const plain = buildQuery('a.example', TYPE.A);
    expect(decode(buildNxdomain(plain, q(plain))).counts.ar).toBe(0);
  });

  it('works for every query type, with RD copied from the query', () => {
    for (const type of [TYPE.A, TYPE.AAAA, TYPE.HTTPS, 15, 255]) {
      const p = buildQuery('x.example', type, 7, { rd: false });
      const r = decode(buildNxdomain(p, q(p)));
      expect(r).toMatchObject({ rcode: 3, rd: false, id: 7 });
      expect(r.questions[0]?.type).toBe(type);
    }
  });
});

describe('buildError', () => {
  it('echoes the question when there is one', () => {
    const p = buildQuery('a.example', TYPE.A, 9);
    const r = decode(buildError(9, 0x0100, RCODE.SERVFAIL, p, q(p)));
    expect(r).toMatchObject({ id: 9, rcode: RCODE.SERVFAIL, counts: { qd: 1 } });
  });

  it('is a bare header when the question is unreadable', () => {
    const out = buildError(5, 0, RCODE.FORMERR);
    expect(out).toHaveLength(12);
    expect(decode(out)).toMatchObject({ id: 5, rcode: RCODE.FORMERR, counts: { qd: 0 } });
  });
});

describe('buildAnswerA', () => {
  it('answers an A query with the address and TTL 0', () => {
    const p = buildQuery('canary.example', TYPE.A, 3);
    const r = decode(buildAnswerA(p, q(p), '127.0.0.1'));
    expect(r).toMatchObject({ rcode: RCODE.NOERROR, counts: { an: 1 } });
    expect([...(r.records[0]?.rdata ?? [])]).toEqual([127, 0, 0, 1]);
    expect(r.records[0]?.ttl).toBe(0);
  });

  it('gives other types an empty NOERROR', () => {
    const p = buildQuery('canary.example', TYPE.AAAA, 3);
    expect(decode(buildAnswerA(p, q(p), '127.0.0.1'))).toMatchObject({ rcode: RCODE.NOERROR, counts: { an: 0 } });
  });
});
