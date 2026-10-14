import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_GROUPS } from '@hourkeep/core';
import { HostsFileEnforcer, renderBlock } from '@hourkeep/platform';
import { Engine } from './engine.js';
import { Store } from './store.js';
import { HOSTS_BASE, makeSandbox, silent, type Sandbox } from './test-helpers.js';

let sb: Sandbox;
let store: Store;
let now: number;

beforeEach(() => {
  sb = makeSandbox();
  store = Store.open(':memory:');
  now = 1_000;
});
afterEach(() => {
  store.close();
  sb.cleanup();
});

const make = (dryRun = false, s = store) =>
  new Engine({
    store: s,
    enforcer: new HostsFileEnforcer({ root: sb.root, dryRun }),
    groups: BUILTIN_GROUPS,
    logger: silent,
    dryRun,
    clock: () => now++,
  });
const hosts = () => fs.readFileSync(sb.hosts, 'utf8');
const ytDomains = () => BUILTIN_GROUPS.groups.find((g) => g.id === 'youtube')?.domains ?? [];

describe('Engine', () => {
  it('blocks a group: stores the rule and writes every domain to the hosts file', async () => {
    const e = make();
    await e.start();
    const r = await e.block('youtube', 1000);
    expect(r).toMatchObject({
      ok: true,
      value: { added: true, rule: { kind: 'group', target: 'youtube' } },
    });
    expect(hosts()).toBe(HOSTS_BASE + renderBlock([...ytDomains()].sort()));
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(hosts()).toContain(':: www.youtube.com');
  });

  it('blocks a plain domain together with its www variant', async () => {
    const e = make();
    await e.start();
    await e.block('Reddit.com', null);
    expect(hosts()).toContain('0.0.0.0 reddit.com');
    expect(hosts()).toContain('0.0.0.0 www.reddit.com');
  });

  it('is idempotent and records the caller uid only for real changes', async () => {
    const e = make();
    await e.start();
    await e.block('youtube', 1000);
    const again = await e.block('youtube', 1001);
    expect(again).toMatchObject({ ok: true, value: { added: false } });
    expect(store.events('rule_added')).toMatchObject([
      { uid: 1000, payload: { kind: 'group', target: 'youtube' } },
    ]);
  });

  it('rejects invalid targets without changing anything', async () => {
    const e = make();
    await e.start();
    for (const bad of ['', '*.example.com', 'nonsense', 'http://x.com', 'a b.com']) {
      expect(await e.block(bad, 1)).toMatchObject({ ok: false, code: 'invalid_target' });
    }
    expect(store.listRules()).toEqual([]);
    expect(hosts()).toBe(HOSTS_BASE);
  });

  it('unblocks instantly and restores the original file', async () => {
    const e = make();
    await e.start();
    await e.block('youtube', 1);
    const r = await e.unblock('youtube', 2);
    expect(r).toMatchObject({ ok: true, value: { removed: true, blockedDomainCount: 0 } });
    expect(hosts()).toBe(HOSTS_BASE);
    expect(store.events('rule_removed')).toHaveLength(1);
  });

  it('reports removed:false when there was no such rule', async () => {
    const e = make();
    await e.start();
    expect(await e.unblock('youtube', 1)).toMatchObject({ ok: true, value: { removed: false } });
    expect(store.events('rule_removed')).toHaveLength(0);
  });

  it('does not treat a domain rule as the group rule', async () => {
    const e = make();
    await e.start();
    await e.block('youtube', 1);
    expect(await e.unblock('youtube.com', 1)).toMatchObject({
      ok: true,
      value: { removed: false },
    });
    expect(hosts()).toContain('0.0.0.0 youtube.com');
  });

  it('re-applies stored rules after a restart, without calling it tampering', async () => {
    await (async () => {
      const e = make();
      await e.start();
      await e.block('youtube', 1);
    })();
    fs.writeFileSync(sb.hosts, HOSTS_BASE); // hosts reset while the daemon was down
    const e2 = make();
    await e2.start();
    expect(hosts()).toContain('0.0.0.0 youtube.com');
    expect(store.countEvents('tamper')).toBe(0);
    expect(store.countEvents('daemon_start')).toBe(2);
  });

  describe('verify', () => {
    it('reverts a hand edit and records a tamper event', async () => {
      const e = make();
      await e.start();
      await e.block('youtube', 1);
      fs.writeFileSync(sb.hosts, HOSTS_BASE); // user deletes the block
      await e.verify();
      expect(hosts()).toContain('0.0.0.0 youtube.com');
      expect(store.events('tamper')).toMatchObject([
        { uid: null, payload: { kind: 'removed', restored: true } },
      ]);
      expect(e.status()).toMatchObject({ tamperCount: 1 });
      expect(e.status().lastTamperAt).not.toBeNull();
    });

    it('stays quiet when nothing changed', async () => {
      const e = make();
      await e.start();
      await e.block('youtube', 1);
      await e.verify();
      await e.verify();
      expect(store.countEvents('tamper')).toBe(0);
    });

    it('survives an enforcer failure and reports each distinct error once', async () => {
      const e = make();
      await e.start();
      await e.block('youtube', 1);
      fs.rmSync(sb.hosts);
      fs.mkdirSync(sb.hosts); // reading a directory as a file fails
      await e.verify();
      await e.verify();
      expect(store.countEvents('reconcile_error')).toBe(1);
      fs.rmdirSync(sb.hosts);
      fs.writeFileSync(sb.hosts, HOSTS_BASE);
      await e.verify();
      expect(hosts()).toContain('0.0.0.0 youtube.com');
    });
  });

  it('keeps the rule but tells the client when applying fails', async () => {
    const e = make();
    await e.start();
    fs.rmSync(sb.hosts);
    fs.mkdirSync(sb.hosts);
    const r = await e.block('youtube', 1);
    expect(r).toMatchObject({ ok: false, code: 'internal' });
    expect(store.listRules()).toHaveLength(1);
  });

  it('serialises concurrent operations', async () => {
    const e = make();
    await e.start();
    await Promise.all([
      e.block('a.example', 1),
      e.block('b.example', 1),
      e.verify(),
      e.block('c.example', 1),
    ]);
    expect(e.list().rules).toHaveLength(3);
    expect(hosts()).toBe(HOSTS_BASE + renderBlock(e.desiredDomains()));
    expect(store.countEvents('tamper')).toBe(0);
  });

  it('dry run computes everything but writes nothing', async () => {
    const e = make(true);
    await e.start();
    const r = await e.block('youtube', 1);
    expect(r).toMatchObject({ ok: true, value: { blockedDomainCount: ytDomains().length } });
    expect(hosts()).toBe(HOSTS_BASE);
    expect(e.status().dryRun).toBe(true);
  });

  it('status counts rules and blocked domains', async () => {
    const e = make();
    await e.start();
    expect(e.status()).toMatchObject({ ruleCount: 0, blockedDomainCount: 0, tamperCount: 0 });
    await e.block('youtube', 1);
    await e.block('example.com', 1);
    expect(e.status()).toMatchObject({ ruleCount: 2, blockedDomainCount: ytDomains().length + 2 });
    expect(e.status().lastReconcileAt).not.toBeNull();
  });
});
