import * as dgram from 'node:dgram';
import * as net from 'node:net';
import type { Match, SuffixMatcher } from './matcher.js';
import { RCODE, buildAnswerA, buildError, buildNxdomain, parseQuery, type Query } from './packet.js';

export interface Upstream {
  readonly address: string;
  readonly port?: number;
}

/**
 * What the server tells its owner. Allowed names are never reported, only that a lookup was
 * forwarded: the server must not become a log of what the user looks up.
 */
export type QueryEvent<O> =
  | { readonly kind: 'blocked'; readonly suffix: string; readonly owner: O; readonly qtype: number }
  | { readonly kind: 'forwarded' }
  | { readonly kind: 'canary' }
  | { readonly kind: 'failed' };

export interface DnsServerOptions<O> {
  readonly address: string;
  /** 0 picks a free port (UDP and TCP share it). */
  readonly port: number;
  readonly upstreams: readonly Upstream[];
  readonly matcher: SuffixMatcher<O>;
  /** Answered locally with 127.0.0.1; lets the daemon check the system really asks us. */
  readonly canary?: string;
  readonly onQuery?: (event: QueryEvent<O>) => void;
  readonly onError?: (error: unknown) => void;
  /** Per upstream, default 2500 ms. */
  readonly upstreamTimeoutMs?: number;
  /** Queries being forwarded at once, default 256. Beyond it the client gets SERVFAIL. */
  readonly maxInflight?: number;
}

export interface DnsServer<O> {
  readonly address: string;
  readonly port: number;
  setMatcher(matcher: SuffixMatcher<O>): void;
  setUpstreams(upstreams: readonly Upstream[]): void;
  close(): Promise<void>;
}

const sameServer = (a: Upstream, address: string, port: number): boolean => a.address === address && (a.port ?? 53) === port;

/** Send `packet` to one upstream over UDP from a fresh socket (fresh source port per query). */
function askUdp(up: Upstream, packet: Buffer, id: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const family = up.address.includes(':') ? 'udp6' : 'udp4';
    const sock = dgram.createSocket(family);
    let done = false;
    const finish = (r: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('message', (msg, rinfo) => {
      // Only the server we asked, and only an answer to this query.
      if (rinfo.address === up.address && msg.length >= 12 && msg.readUInt16BE(0) === id) finish(msg);
    });
    sock.send(packet, up.port ?? 53, up.address, (err) => {
      if (err) finish(null);
    });
  });
}

/** Same over TCP: two byte length prefix each way. */
function askTcp(up: Upstream, packet: Buffer, id: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: up.address, port: up.port ?? 53 });
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (r: Buffer | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    sock.on('connect', () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(packet.length, 0);
      sock.write(Buffer.concat([len, packet]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 2) return;
      const n = buf.readUInt16BE(0);
      if (buf.length >= 2 + n) {
        const msg = buf.subarray(2, 2 + n);
        finish(msg.length >= 12 && msg.readUInt16BE(0) === id ? Buffer.from(msg) : null);
      }
    });
  });
}

/**
 * A DNS server that answers blocked names itself (NXDOMAIN, so every subdomain is covered)
 * and forwards everything else, untouched, to the real resolvers. Serves UDP and TCP.
 */
export async function startDnsServer<O>(options: DnsServerOptions<O>): Promise<DnsServer<O>> {
  let matcher = options.matcher;
  let upstreams = [...options.upstreams];
  const timeoutMs = options.upstreamTimeoutMs ?? 2500;
  const maxInflight = options.maxInflight ?? 256;
  let inflight = 0;
  const report = options.onError ?? (() => undefined);
  const emit = (e: QueryEvent<O>): void => {
    try {
      options.onQuery?.(e);
    } catch (err) {
      report(err);
    }
  };

  const udp = dgram.createSocket({ type: 'udp4' });
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(options.port, options.address, () => {
      udp.off('error', reject);
      resolve();
    });
  });
  const port = udp.address().port;
  upstreams = upstreams.filter((u) => !sameServer(u, options.address, port));

  const tcp = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(port, options.address, () => {
        tcp.off('error', reject);
        resolve();
      });
    });
  } catch (e) {
    udp.close();
    throw e;
  }
  udp.on('error', (e) => report(e));
  tcp.on('error', (e) => report(e));

  /** Work out the response for one raw query. `viaTcp` selects the transport used upstream. */
  async function respond(packet: Buffer, viaTcp: boolean): Promise<Buffer | null> {
    const parsed = parseQuery(packet);
    if (!parsed.ok) {
      if (parsed.id === null || parsed.reason === 'response') return null; // not worth an answer
      return buildError(parsed.id, parsed.flags, parsed.reason === 'opcode' ? RCODE.NOTIMP : RCODE.FORMERR);
    }
    const q: Query = parsed.query;
    const m: Match<O> = matcher.match(q.question.name);
    if (m.blocked) {
      emit({ kind: 'blocked', suffix: m.suffix, owner: m.owner, qtype: q.question.type });
      return buildNxdomain(packet, q);
    }
    if (options.canary !== undefined && q.question.name === options.canary) {
      emit({ kind: 'canary' });
      return buildAnswerA(packet, q, '127.0.0.1');
    }
    if (inflight >= maxInflight || upstreams.length === 0) {
      emit({ kind: 'failed' });
      return buildError(q.id, q.flags, RCODE.SERVFAIL, packet, q);
    }
    inflight++;
    try {
      emit({ kind: 'forwarded' });
      for (const up of [...upstreams]) {
        const answer = viaTcp ? await askTcp(up, packet, q.id, timeoutMs) : await askUdp(up, packet, q.id, timeoutMs);
        if (answer) return answer;
      }
      emit({ kind: 'failed' });
      return buildError(q.id, q.flags, RCODE.SERVFAIL, packet, q);
    } finally {
      inflight--;
    }
  }

  udp.on('message', (msg, rinfo) => {
    respond(Buffer.from(msg), false).then(
      (out) => {
        if (out) udp.send(out, rinfo.port, rinfo.address, (err) => err && report(err));
      },
      (e) => report(e),
    );
  });

  let closing: Promise<void> | undefined;
  const open = new Set<net.Socket>();
  tcp.on('connection', (sock) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    sock.on('error', () => sock.destroy());
    sock.setTimeout(10_000, () => sock.destroy());
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const n = buf.readUInt16BE(0);
        if (buf.length < 2 + n) return;
        const packet = Buffer.from(buf.subarray(2, 2 + n));
        buf = buf.subarray(2 + n);
        respond(packet, true).then(
          (out) => {
            if (!out || sock.destroyed) return;
            const len = Buffer.alloc(2);
            len.writeUInt16BE(out.length, 0);
            sock.write(Buffer.concat([len, out]));
          },
          (e) => report(e),
        );
      }
    });
  });

  return {
    address: options.address,
    port,
    setMatcher(next) {
      matcher = next;
    },
    setUpstreams(next) {
      // Never forward to ourselves.
      upstreams = next.filter((u) => !sameServer(u, options.address, port));
    },
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        udp.close(() => tcp.close(() => resolve()));
      });
      return closing;
    },
  };
}
