import * as dgram from 'node:dgram';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SuffixMatcher } from './matcher.js';
import { RCODE, TYPE, buildAnswerA, buildQuery, parseQuery, rcodeOf } from './packet.js';
import { startDnsServer, type DnsServer, type QueryEvent, type Upstream } from './server.js';

type Owner = { kind: 'domain' | 'group'; target: string };
const youtube: Owner = { kind: 'group', target: 'youtube' };
const matcher = () =>
  new SuffixMatcher<Owner>({
    block: [
      { suffix: 'googlevideo.com', owner: youtube },
      { suffix: 'reddit.com', owner: { kind: 'domain', target: 'reddit.com' } },
    ],
    allow: [],
  });

// ---- a fake upstream resolver on loopback (UDP and TCP, one port) ---------------------------

interface Fake {
  port: number;
  seen: string[];
  close(): Promise<void>;
  mode: 'answer' | 'silent' | 'truncate';
}

async function fakeUpstream(initial: Fake['mode'] = 'answer'): Promise<Fake> {
  const udp = dgram.createSocket('udp4');
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  const port = udp.address().port;
  const tcp = net.createServer();
  await new Promise<void>((r) => tcp.listen(port, '127.0.0.1', r));
  const fake: Fake = { port, seen: [], mode: initial, close: () => new Promise((r) => udp.close(() => tcp.close(() => r()))) };
  const answerFor = (packet: Buffer, viaUdp: boolean): Buffer | null => {
    const p = parseQuery(packet);
    if (!p.ok) return null;
    fake.seen.push(p.query.question.name);
    if (fake.mode === 'silent') return null;
    const out = buildAnswerA(packet, p.query, '93.184.216.34');
    if (fake.mode === 'truncate' && viaUdp) out[2] = (out[2] as number) | 0x02; // TC
    return out;
  };
  udp.on('message', (msg, rinfo) => {
    const out = answerFor(Buffer.from(msg), true);
    if (out) udp.send(out, rinfo.port, rinfo.address);
  });
  tcp.on('connection', (s) => {
    let buf = Buffer.alloc(0);
    s.on('error', () => undefined);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
      const out = answerFor(buf.subarray(2, 2 + buf.readUInt16BE(0)), false);
      if (out) {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(out.length);
        s.write(Buffer.concat([len, out]));
      }
    });
  });
  return fake;
}

// ---- clients -------------------------------------------------------------------------------

function udpAsk(port: number, packet: Buffer, timeoutMs = 2000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const timer = setTimeout(() => (s.close(), resolve(null)), timeoutMs);
    s.on('message', (m) => (clearTimeout(timer), s.close(), resolve(m)));
    s.send(packet, port, '127.0.0.1');
  });
}

function tcpAsk(port: number, packets: Buffer[], timeoutMs = 2000): Promise<Buffer[]> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    const out: Buffer[] = [];
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => (s.destroy(), resolve(out)), timeoutMs);
    s.on('error', () => undefined);
    s.on('connect', () => {
      for (const p of packets) {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(p.length);
        s.write(Buffer.concat([len, p]));
      }
    });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        out.push(Buffer.from(buf.subarray(2, 2 + buf.readUInt16BE(0))));
        buf = buf.subarray(2 + buf.readUInt16BE(0));
      }
      if (out.length >= packets.length) {
        clearTimeout(timer);
        s.destroy();
        resolve(out);
      }
    });
  });
}

const answerIp = (p: Buffer): string => [...p.subarray(p.length - 4)].join('.');

// ---- harness -------------------------------------------------------------------------------

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()?.();
});

async function start(over: { upstreams?: Upstream[]; canary?: string; timeout?: number; maxInflight?: number } = {}) {
  const fake = await fakeUpstream();
  cleanup.push(() => fake.close());
  const events: QueryEvent<Owner>[] = [];
  const errors: unknown[] = [];
  const server: DnsServer<Owner> = await startDnsServer<Owner>({
    address: '127.0.0.1',
    port: 0,
    upstreams: over.upstreams ?? [{ address: '127.0.0.1', port: fake.port }],
    matcher: matcher(),
    ...(over.canary ? { canary: over.canary } : {}),
    onQuery: (e) => events.push(e),
    onError: (e) => errors.push(e),
    upstreamTimeoutMs: over.timeout ?? 500,
    ...(over.maxInflight ? { maxInflight: over.maxInflight } : {}),
  });
  cleanup.push(() => server.close());
  return { server, fake, events, errors };
}

describe('blocking', () => {
  it('answers a blocked name and every subdomain with NXDOMAIN, without asking upstream', async () => {
    const { server, fake, events } = await start();
    for (const name of ['googlevideo.com', 'rr1---sn-ab5l6n7y.googlevideo.com', 'a.b.c.googlevideo.com', 'WWW.Reddit.COM']) {
      const r = await udpAsk(server.port, buildQuery(name, TYPE.A));
      expect(rcodeOf(r as Buffer)).toBe(RCODE.NXDOMAIN);
    }
    expect(fake.seen).toEqual([]);
    expect(events.filter((e) => e.kind === 'blocked')).toHaveLength(4);
  });

  it('blocks every query type for a blocked name', async () => {
    const { server, events } = await start();
    for (const type of [TYPE.A, TYPE.AAAA, TYPE.HTTPS, 15, 16]) {
      expect(rcodeOf((await udpAsk(server.port, buildQuery('x.googlevideo.com', type))) as Buffer)).toBe(RCODE.NXDOMAIN);
    }
    expect(events.map((e) => (e.kind === 'blocked' ? e.qtype : -1))).toEqual([TYPE.A, TYPE.AAAA, TYPE.HTTPS, 15, 16]);
  });

  it('reports the matching suffix and its owner, so a flood of random names counts under one rule', async () => {
    const { server, events } = await start();
    await udpAsk(server.port, buildQuery('rr1---sn-aaaa.googlevideo.com', TYPE.A));
    await udpAsk(server.port, buildQuery('rr9---sn-bbbb.googlevideo.com', TYPE.A));
    expect(events).toMatchObject([
      { kind: 'blocked', suffix: 'googlevideo.com', owner: youtube },
      { kind: 'blocked', suffix: 'googlevideo.com', owner: youtube },
    ]);
  });

  it('lets other names through to the upstream and relays its answer untouched', async () => {
    const { server, fake } = await start();
    const r = (await udpAsk(server.port, buildQuery('example.org', TYPE.A, 0x77))) as Buffer;
    expect(rcodeOf(r)).toBe(RCODE.NOERROR);
    expect(r.readUInt16BE(0)).toBe(0x77);
    expect(answerIp(r.subarray(0, r.length))).toBe('93.184.216.34');
    expect(fake.seen).toEqual(['example.org']);
  });

  it('does not treat a lookalike as blocked', async () => {
    const { server, fake } = await start();
    await udpAsk(server.port, buildQuery('notgooglevideo.com', TYPE.A));
    await udpAsk(server.port, buildQuery('googlevideo.com.example.org', TYPE.A));
    expect(fake.seen).toEqual(['notgooglevideo.com', 'googlevideo.com.example.org']);
  });
});

describe('counting is exact', () => {
  it('counts every blocked lookup and every forwarded one, concurrently', async () => {
    const { server, fake, events } = await start();
    const asks: Promise<Buffer | null>[] = [];
    for (let i = 0; i < 60; i++) asks.push(udpAsk(server.port, buildQuery(`rr${i}.googlevideo.com`, TYPE.A, i)));
    for (let i = 0; i < 25; i++) asks.push(udpAsk(server.port, buildQuery(`site${i}.example.org`, TYPE.A, 1000 + i)));
    const answers = await Promise.all(asks);
    expect(answers.every((a) => a !== null)).toBe(true);
    expect(events.filter((e) => e.kind === 'blocked')).toHaveLength(60);
    expect(events.filter((e) => e.kind === 'forwarded')).toHaveLength(25);
    expect(fake.seen).toHaveLength(25);
  });

  it('never puts a looked-up name into an event for allowed traffic', async () => {
    const { server, events } = await start();
    await udpAsk(server.port, buildQuery('very-private-site.example.org', TYPE.A));
    expect(JSON.stringify(events)).not.toContain('private');
    expect(events).toEqual([{ kind: 'forwarded' }]);
  });

  it('counts the same query once whichever transport carried it', async () => {
    const { server, events } = await start();
    await udpAsk(server.port, buildQuery('a.reddit.com', TYPE.A));
    await tcpAsk(server.port, [buildQuery('a.reddit.com', TYPE.A)]);
    expect(events.filter((e) => e.kind === 'blocked')).toHaveLength(2);
  });
});

describe('the self-test name', () => {
  it('covers the domain and any name under it', async () => {
    const { server, fake, events } = await start({ canary: 'selftest.hourkeep.dev' });
    for (const name of ['selftest.hourkeep.dev', 'hk-12345.selftest.hourkeep.dev']) {
      expect(answerIp((await udpAsk(server.port, buildQuery(name, TYPE.A))) as Buffer)).toBe('127.0.0.1');
    }
    await udpAsk(server.port, buildQuery('notselftest.hourkeep.dev', TYPE.A));
    expect(fake.seen).toEqual(['notselftest.hourkeep.dev']);
    expect(events.filter((e) => e.kind === 'canary')).toHaveLength(2);
  });

  it('is answered locally with 127.0.0.1 and reported', async () => {
    const { server, fake, events } = await start({ canary: 'canary.hourkeep.invalid' });
    const r = (await udpAsk(server.port, buildQuery('canary.hourkeep.invalid', TYPE.A))) as Buffer;
    expect(answerIp(r)).toBe('127.0.0.1');
    expect(fake.seen).toEqual([]);
    expect(events).toEqual([{ kind: 'canary' }]);
  });
});

describe('bad input', () => {
  it('replies FORMERR to a query with a broken question and NOTIMP to other opcodes', async () => {
    const { server } = await start();
    const bad = buildQuery('a.example', 1, 0x11);
    bad.writeUInt16BE(2, 4);
    expect(rcodeOf((await udpAsk(server.port, bad)) as Buffer)).toBe(RCODE.FORMERR);
    const notify = buildQuery('a.example', 1, 0x12);
    notify[2] = (notify[2] as number) | (4 << 3);
    expect(rcodeOf((await udpAsk(server.port, notify)) as Buffer)).toBe(RCODE.NOTIMP);
  });

  it('drops garbage and stray responses instead of answering them, and keeps working', async () => {
    const { server, errors } = await start();
    expect(await udpAsk(server.port, Buffer.from([1, 2, 3]), 200)).toBeNull();
    const resp = buildQuery('a.example', 1);
    resp[2] = (resp[2] as number) | 0x80;
    expect(await udpAsk(server.port, resp, 200)).toBeNull();
    expect(rcodeOf((await udpAsk(server.port, buildQuery('x.reddit.com', 1))) as Buffer)).toBe(RCODE.NXDOMAIN);
    expect(errors).toEqual([]);
  });
});

describe('when the upstream misbehaves', () => {
  it('falls through to the next upstream', async () => {
    const dead = await fakeUpstream('silent');
    cleanup.push(() => dead.close());
    const live = await fakeUpstream();
    cleanup.push(() => live.close());
    const { server } = await start({ upstreams: [{ address: '127.0.0.1', port: dead.port }, { address: '127.0.0.1', port: live.port }] });
    const r = (await udpAsk(server.port, buildQuery('example.org', TYPE.A), 3000)) as Buffer;
    expect(rcodeOf(r)).toBe(RCODE.NOERROR);
    expect(dead.seen).toEqual(['example.org']);
    expect(live.seen).toEqual(['example.org']);
  });

  it('answers SERVFAIL when nothing answers, and counts a failure', async () => {
    const dead = await fakeUpstream('silent');
    cleanup.push(() => dead.close());
    const { server, events } = await start({ upstreams: [{ address: '127.0.0.1', port: dead.port }], timeout: 150 });
    const r = (await udpAsk(server.port, buildQuery('example.org', TYPE.A, 0x33), 3000)) as Buffer;
    expect(rcodeOf(r)).toBe(RCODE.SERVFAIL);
    expect(r.readUInt16BE(0)).toBe(0x33);
    expect(events.map((e) => e.kind)).toEqual(['forwarded', 'failed']);
  });

  it('answers SERVFAIL at once with no upstreams, but still blocks', async () => {
    const { server } = await start({ upstreams: [] });
    expect(rcodeOf((await udpAsk(server.port, buildQuery('example.org', 1))) as Buffer)).toBe(RCODE.SERVFAIL);
    expect(rcodeOf((await udpAsk(server.port, buildQuery('x.reddit.com', 1))) as Buffer)).toBe(RCODE.NXDOMAIN);
  });

  it('sheds load past the in-flight limit rather than queueing forever', async () => {
    const dead = await fakeUpstream('silent');
    cleanup.push(() => dead.close());
    const { server } = await start({ upstreams: [{ address: '127.0.0.1', port: dead.port }], timeout: 600, maxInflight: 1 });
    const first = udpAsk(server.port, buildQuery('one.example.org', 1), 3000);
    await new Promise((r) => setTimeout(r, 50));
    const second = (await udpAsk(server.port, buildQuery('two.example.org', 1), 3000)) as Buffer;
    expect(rcodeOf(second)).toBe(RCODE.SERVFAIL);
    expect(rcodeOf((await first) as Buffer)).toBe(RCODE.SERVFAIL);
  });

  it('never forwards to itself', async () => {
    const { server, events } = await start({ upstreams: [] });
    server.setUpstreams([{ address: '127.0.0.1', port: server.port }]);
    expect(rcodeOf((await udpAsk(server.port, buildQuery('example.org', 1))) as Buffer)).toBe(RCODE.SERVFAIL);
    expect(events).toEqual([{ kind: 'failed' }]);
  });
});

describe('TCP', () => {
  it('blocks and forwards over TCP, and answers several queries on one connection', async () => {
    const { server, fake } = await start();
    const out = await tcpAsk(server.port, [
      buildQuery('a.googlevideo.com', TYPE.A, 1),
      buildQuery('example.org', TYPE.A, 2),
      buildQuery('b.reddit.com', TYPE.AAAA, 3),
    ]);
    const byId = new Map(out.map((p) => [p.readUInt16BE(0), rcodeOf(p)]));
    expect(byId.get(1)).toBe(RCODE.NXDOMAIN);
    expect(byId.get(2)).toBe(RCODE.NOERROR);
    expect(byId.get(3)).toBe(RCODE.NXDOMAIN);
    expect(fake.seen).toEqual(['example.org']);
  });

  it('lets a client retry a truncated UDP answer over TCP', async () => {
    const { server, fake } = await start();
    fake.mode = 'truncate';
    const udp = (await udpAsk(server.port, buildQuery('big.example.org', TYPE.A, 9))) as Buffer;
    expect(udp.readUInt16BE(2) & 0x0200).toBe(0x0200); // TC passed through
    const [tcp] = await tcpAsk(server.port, [buildQuery('big.example.org', TYPE.A, 9)]);
    expect(((tcp as Buffer).readUInt16BE(2) & 0x0200)).toBe(0);
    expect(rcodeOf(tcp as Buffer)).toBe(RCODE.NOERROR);
  });
});

describe('changing what is blocked while running', () => {
  it('applies a new matcher to the next lookup (schedule edge, pass start or end)', async () => {
    const { server } = await start();
    const ask = async () => rcodeOf((await udpAsk(server.port, buildQuery('x.reddit.com', 1))) as Buffer);
    expect(await ask()).toBe(RCODE.NXDOMAIN);
    server.setMatcher(new SuffixMatcher<Owner>({ block: [], allow: [] })); // a pass starts
    expect(await ask()).toBe(RCODE.NOERROR);
    server.setMatcher(matcher()); // it ends
    expect(await ask()).toBe(RCODE.NXDOMAIN);
  });
});

describe('lifecycle', () => {
  it('shares one port between UDP and TCP and frees both on close', async () => {
    const { server } = await start();
    const port = server.port;
    expect(port).toBeGreaterThan(0);
    await server.close();
    const again = await startDnsServer<Owner>({ address: '127.0.0.1', port, upstreams: [], matcher: matcher() });
    expect(again.port).toBe(port);
    await again.close();
  });

  it('fails cleanly when the port is taken', async () => {
    const { server } = await start();
    await expect(startDnsServer<Owner>({ address: '127.0.0.1', port: server.port, upstreams: [], matcher: matcher() })).rejects.toThrow();
  });
});
