import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slotStart, type Rule } from '@hourkeep/core';
import type { CommandRunner } from '@hourkeep/platform';
import { DnsLayer, type DnsLayerOptions } from './dns-layer.js';
import { Store } from './store.js';
import { RCODE, dnsAsk, dnsRcode, makeSandbox, silent, type Sandbox } from './test-helpers.js';

let sb: Sandbox;
let store: Store;
let layers: DnsLayer[];
let commands: string[];
let restartFails: boolean;

const runner: CommandRunner = {
  run: async (cmd, args) => {
    commands.push(`${cmd} ${args.join(' ')}`);
    if (args.includes('is-active')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('restart') && restartFails)
      return { code: 1, stdout: '', stderr: 'unit not found' };
    return { code: 0, stdout: '', stderr: '' };
  },
};

const youtube: Rule = { kind: 'group', target: 'youtube' };
const reddit: Rule = { kind: 'domain', target: 'reddit.com' };
const spec = {
  block: [
    { suffix: 'googlevideo.com', owner: youtube },
    { suffix: 'reddit.com', owner: reddit },
  ],
  allow: [] as string[],
};
const dropIn = () => path.join(sb.root, 'etc/systemd/resolved.conf.d/hourkeep.conf');
const backup = () => path.join(sb.dir, 'dns-backup.json');

function seedResolved(upstream = '192.168.1.1') {
  fs.mkdirSync(path.join(sb.root, 'run/systemd/resolve'), { recursive: true });
  fs.writeFileSync(
    path.join(sb.root, 'run/systemd/resolve/resolv.conf'),
    `nameserver ${upstream}\nnameserver 127.0.0.53\n`,
  );
}

/** A "system lookup" that really asks our server, as the OS would once configured. */
function viaServer(layer: () => DnsLayer): (name: string) => Promise<string[]> {
  return async (name) => {
    const port = layer().port;
    const r = port ? await dnsAsk(port, name) : null;
    if (!r || (r.readUInt16BE(2) & 0xf) !== 0 || r.readUInt16BE(6) === 0)
      throw new Error('no answer');
    return [[...r.subarray(r.length - 4)].join('.')];
  };
}

function make(over: Partial<DnsLayerOptions> = {}): DnsLayer {
  const layer: DnsLayer = new DnsLayer({
    root: sb.root,
    dryRun: false,
    backupPath: backup(),
    address: '127.0.0.1',
    port: 0,
    upstreams: [],
    store,
    logger: silent,
    runner,
    strategy: 'systemd-resolved',
    lookup: viaServer(() => layer),
    upstreamTimeoutMs: 300,
    ...over,
  });
  layers.push(layer);
  return layer;
}

beforeEach(() => {
  sb = makeSandbox();
  store = Store.open(':memory:');
  layers = [];
  commands = [];
  restartFails = false;
  seedResolved();
});
afterEach(async () => {
  for (const l of layers) await l.stop();
  store.close();
  sb.cleanup();
});

describe('starting', () => {
  it('serves, points systemd-resolved at the real port, and sees itself in effect', async () => {
    const layer = make();
    layer.setSpec(spec);
    await layer.start();
    const st = layer.status();
    expect(st).toMatchObject({
      enabled: true,
      strategy: 'systemd-resolved',
      inEffect: true,
      upstreamCount: 1,
      problem: null,
    });
    expect(st.listening).toBe(`127.0.0.1:${layer.port}`);
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain(`DNS=127.0.0.1:${layer.port}`);
    expect(commands).toContain('systemctl restart systemd-resolved');
  });

  it('uses the spec set before it started', async () => {
    const layer = make();
    layer.setSpec(spec);
    await layer.start();
    expect(await dnsRcode(layer.port as number, 'rr1---sn-ab.googlevideo.com')).toBe(
      RCODE.NXDOMAIN,
    );
  });

  it('takes the upstreams from the system unless told otherwise', async () => {
    const a = make();
    await a.start();
    expect(a.status().upstreamCount).toBe(1);
    const b = make({
      upstreams: ['9.9.9.9', '149.112.112.112'],
      backupPath: path.join(sb.dir, 'other.json'),
    });
    await b.start();
    expect(b.status().upstreamCount).toBe(2);
  });

  it('leaves the system alone when there is nothing to forward to', async () => {
    fs.writeFileSync(
      path.join(sb.root, 'run/systemd/resolve/resolv.conf'),
      'nameserver 127.0.0.53\n',
    );
    const layer = make();
    await layer.start();
    expect(layer.status()).toMatchObject({ enabled: true, listening: null, inEffect: null });
    expect(layer.status().problem).toContain('no usable upstream');
    expect(fs.existsSync(dropIn())).toBe(false);
    expect(fs.existsSync(backup())).toBe(false);
    expect(commands.filter((c) => c.includes('restart'))).toEqual([]);
  });

  it('leaves the system alone when the port is taken', async () => {
    const first = make();
    await first.start();
    fs.rmSync(dropIn());
    fs.rmSync(backup());
    const second = make({ port: first.port as number });
    await second.start();
    expect(second.status().problem).toContain('cannot listen');
    expect(second.status().listening).toBeNull();
    expect(fs.existsSync(dropIn())).toBe(false);
  });

  it('closes the server and reports it if the system could not be configured', async () => {
    restartFails = true;
    const layer = make();
    await layer.start();
    expect(layer.status().problem).toContain('could not configure the system resolver');
    expect(layer.status().listening).toBeNull();
    expect(layer.port).toBeNull();
  });

  it('a dry run starts nothing and touches nothing', async () => {
    const layer = make({ dryRun: true });
    await layer.start();
    expect(layer.status()).toMatchObject({ enabled: true, listening: null });
    expect(layer.status().problem).toContain('dry run');
    expect(fs.existsSync(dropIn())).toBe(false);
  });
});

describe('the self-test', () => {
  it('says the layer is not in effect when programs do not reach it, with the reason', async () => {
    const layer = make({ lookup: async () => ['203.0.113.7'] });
    await layer.start();
    expect(layer.status().inEffect).toBe(false);
    expect(layer.status().problem).toContain('do not reach the hourkeep resolver');
  });

  it('also fails if the lookup errors', async () => {
    const layer = make({ lookup: async () => Promise.reject(new Error('ENOTFOUND')) });
    await layer.start();
    expect(layer.status().inEffect).toBe(false);
  });

  it('does not forward the canary name to the real resolver', async () => {
    const layer = make({ upstreams: ['192.0.2.1'] });
    await layer.start();
    layer.flush();
    expect(store.dnsTotalsSince(0)).toEqual([]);
  });
});

describe('counting', () => {
  it('counts every blocked lookup under the rule and suffix that matched, and nothing else', async () => {
    const layer = make();
    layer.setSpec(spec);
    await layer.start();
    const port = layer.port as number;
    for (let i = 0; i < 40; i++) await dnsAsk(port, `rr${i}---sn-x${i}.googlevideo.com`);
    for (let i = 0; i < 7; i++) await dnsAsk(port, 'www.reddit.com');
    layer.flush();
    const rows = store.dnsBlockedSince(0);
    const by = (suffix: string) =>
      rows.filter((r) => r.suffix === suffix).reduce((n, r) => n + r.count, 0);
    expect(by('googlevideo.com')).toBe(40);
    expect(by('reddit.com')).toBe(7);
    expect(
      rows
        .filter((r) => r.suffix === 'googlevideo.com')
        .every((r) => r.kind === 'group' && r.target === 'youtube'),
    ).toBe(true);
    expect(rows.every((r) => !r.suffix.includes('rr1'))).toBe(true); // random names collapse into the suffix
  });

  it('puts counts into the 15 minute slot they happened in', async () => {
    let now = Date.parse('2026-10-16T10:07:00Z');
    const layer = make({ clock: () => now });
    layer.setSpec(spec);
    await layer.start();
    await dnsAsk(layer.port as number, 'a.reddit.com');
    now = Date.parse('2026-10-16T10:22:00Z');
    await dnsAsk(layer.port as number, 'b.reddit.com');
    await dnsAsk(layer.port as number, 'c.reddit.com');
    layer.flush();
    expect(store.dnsBlockedSince(0).map((r) => [r.slot, r.count])).toEqual([
      [slotStart(Date.parse('2026-10-16T10:07:00Z')), 1],
      [slotStart(Date.parse('2026-10-16T10:22:00Z')), 2],
    ]);
  });

  it('adds up across flushes', async () => {
    const layer = make();
    layer.setSpec(spec);
    await layer.start();
    await dnsAsk(layer.port as number, 'a.reddit.com');
    layer.flush();
    await dnsAsk(layer.port as number, 'b.reddit.com');
    layer.flush();
    layer.flush();
    expect(store.dnsBlockedSince(0).reduce((n, r) => n + r.count, 0)).toBe(2);
  });

  it('counts forwarded lookups without recording the name, and failures', async () => {
    const layer = make({ upstreams: ['192.0.2.1'], upstreamTimeoutMs: 100 });
    await layer.start();
    await dnsAsk(layer.port as number, 'very-private-site.example.org', 1, 3000); // 192.0.2.1 does not answer
    layer.flush();
    const t = store.dnsTotalsSince(0);
    expect(t.reduce((n, r) => n + r.forwarded, 0)).toBe(1);
    expect(t.reduce((n, r) => n + r.failed, 0)).toBe(1);
    expect(JSON.stringify([store.dnsBlockedSince(0), t])).not.toContain('private');
  });

  it('applies a new spec to the next lookup (pass or schedule edge)', async () => {
    const layer = make({ upstreams: ['192.0.2.1'], upstreamTimeoutMs: 100 });
    layer.setSpec(spec);
    await layer.start();
    const port = layer.port as number;
    expect(await dnsRcode(port, 'x.reddit.com')).toBe(RCODE.NXDOMAIN);
    layer.setSpec({ block: [], allow: [] });
    expect(await dnsRcode(port, 'x.reddit.com')).toBe(RCODE.SERVFAIL); // forwarded to the unreachable test upstream
    layer.setSpec(spec);
    expect(await dnsRcode(port, 'x.reddit.com')).toBe(RCODE.NXDOMAIN);
  });
});

describe('upkeep', () => {
  it('puts the settings back if they are removed, and says so', async () => {
    const tampered: string[] = [];
    const layer = make({ onTamper: (p) => tampered.push(p) });
    await layer.start();
    fs.rmSync(dropIn());
    await layer.tick();
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain('Domains=~.');
    expect(tampered).toEqual(['the systemd-resolved drop-in is missing']);
    expect(layer.status().inEffect).toBe(true);
  });

  it('is quiet when nothing changed', async () => {
    const tampered: string[] = [];
    const layer = make({ onTamper: (p) => tampered.push(p) });
    await layer.start();
    await layer.tick();
    await layer.tick();
    expect(tampered).toEqual([]);
  });

  it('re-runs the self-test on schedule and notices when the system stops using us', async () => {
    let routed = true;
    let now = 1_000_000;
    const layer: DnsLayer = make({
      clock: () => now,
      selfTestEveryMs: 60_000,
      lookup: async (n) => (routed ? viaServer(() => layer)(n) : ['203.0.113.7']),
    });
    await layer.start();
    expect(layer.status().inEffect).toBe(true);
    routed = false;
    now += 30_000;
    await layer.tick();
    expect(layer.status().inEffect).toBe(true); // not yet time to re-check
    now += 31_000;
    await layer.tick();
    expect(layer.status().inEffect).toBe(false);
  });

  it('saves counters on every tick', async () => {
    const layer = make();
    layer.setSpec(spec);
    await layer.start();
    await dnsAsk(layer.port as number, 'a.reddit.com');
    await layer.tick();
    expect(store.dnsBlockedSince(0)).toHaveLength(1);
  });

  it('does nothing before it has started', async () => {
    const layer = make();
    await layer.tick();
    expect(layer.status().listening).toBeNull();
  });
});

describe('stopping', () => {
  it('saves counters, closes the port and leaves the system settings in place', async () => {
    const layer = make();
    layer.setSpec(spec);
    await layer.start();
    const port = layer.port as number;
    await dnsAsk(port, 'a.reddit.com');
    await layer.stop();
    expect(store.dnsBlockedSince(0)).toHaveLength(1);
    expect(await dnsAsk(port, 'a.reddit.com', 1, 200)).toBeNull();
    expect(fs.existsSync(dropIn())).toBe(true);
    expect(layer.status().listening).toBeNull();
  });
});
