import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostsFileEnforcer } from './hosts-enforcer.js';
import { BEGIN_MARKER, renderBlock } from './hosts-block.js';

const BASE = '127.0.0.1 localhost\n::1 localhost\n10.0.0.5 nas\n';
let root: string;
let hosts: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hk-hosts-'));
  await fs.mkdir(path.join(root, 'etc'));
  hosts = path.join(root, 'etc', 'hosts');
  await fs.writeFile(hosts, BASE);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const make = (dryRun = false) => new HostsFileEnforcer({ root, dryRun });
const read = () => fs.readFile(hosts, 'utf8');

describe('HostsFileEnforcer', () => {
  it('rejects a relative root', () => {
    expect(() => new HostsFileEnforcer({ root: 'relative', dryRun: false })).toThrow();
  });

  it('writes a managed block, preserving existing entries', async () => {
    const r = await make().reconcile(['a.example', 'b.example'], 'update');
    expect(r).toMatchObject({
      drifted: true,
      tamper: null,
      written: true,
      method: 'rename',
      blockedCount: 2,
    });
    expect(await read()).toBe(BASE + renderBlock(['a.example', 'b.example']));
  });

  it('changes nothing on a second identical pass', async () => {
    const e = make();
    await e.reconcile(['a.example'], 'update');
    const ino = (await fs.stat(hosts)).ino;
    const r = await e.reconcile(['a.example'], 'verify');
    expect(r).toMatchObject({ drifted: false, tamper: null, written: false });
    expect((await fs.stat(hosts)).ino).toBe(ino);
  });

  it('does not touch the file when nothing is blocked and there is no block', async () => {
    const ino = (await fs.stat(hosts)).ino;
    const r = await make().reconcile([], 'verify');
    expect(r).toMatchObject({ drifted: false, written: false });
    expect((await fs.stat(hosts)).ino).toBe(ino);
    expect(await read()).toBe(BASE);
  });

  it('updates the block when rules change, without flagging tamper', async () => {
    const e = make();
    await e.reconcile(['a.example'], 'update');
    const r = await e.reconcile(['a.example', 'b.example'], 'update');
    expect(r).toMatchObject({ drifted: true, tamper: null, written: true });
    expect((await e.inspect()).blocked).toEqual(['a.example', 'b.example']);
  });

  it('removes the block when the last rule goes, restoring the original file', async () => {
    const e = make();
    await e.reconcile(['a.example'], 'update');
    await e.reconcile([], 'update');
    expect(await read()).toBe(BASE);
  });

  describe('tamper detection (verify)', () => {
    let e: HostsFileEnforcer;
    beforeEach(async () => {
      e = make();
      await e.reconcile(['a.example', 'b.example'], 'update');
    });

    it('reverts a line deleted from the block', async () => {
      await fs.writeFile(hosts, (await read()).replace('0.0.0.0 a.example\n', ''));
      const r = await e.reconcile(['a.example', 'b.example'], 'verify');
      expect(r).toMatchObject({ drifted: true, tamper: 'modified', written: true });
      expect(await read()).toBe(BASE + renderBlock(['a.example', 'b.example']));
    });

    it('reverts an injected line inside the block', async () => {
      await fs.writeFile(
        hosts,
        (await read()).replace(BEGIN_MARKER, `${BEGIN_MARKER}\n1.2.3.4 evil.example`),
      );
      const r = await e.reconcile(['a.example', 'b.example'], 'verify');
      expect(r.tamper).toBe('modified');
      expect(await read()).not.toContain('evil.example');
    });

    it('restores a block that was removed entirely', async () => {
      await fs.writeFile(hosts, BASE);
      const r = await e.reconcile(['a.example', 'b.example'], 'verify');
      expect(r).toMatchObject({ tamper: 'removed', written: true });
      expect((await e.inspect()).blocked).toEqual(['a.example', 'b.example']);
    });

    it('repairs a half-deleted block', async () => {
      await fs.writeFile(hosts, (await read()).replace(/# END HOURKEEP.*\n/, ''));
      const r = await e.reconcile(['a.example', 'b.example'], 'verify');
      expect(r.tamper).toBe('malformed');
      expect(await read()).toBe(BASE + renderBlock(['a.example', 'b.example']));
    });

    it('keeps unrelated edits made outside the block', async () => {
      await fs.writeFile(hosts, '# mine\n' + (await read()));
      const r = await e.reconcile(['a.example', 'b.example'], 'verify');
      expect(r).toMatchObject({ drifted: false, tamper: null });
      expect((await read()).startsWith('# mine\n')).toBe(true);
    });

    it('reports nothing for the same drift under intent update', async () => {
      await fs.writeFile(hosts, BASE);
      const r = await e.reconcile(['a.example', 'b.example'], 'update');
      expect(r).toMatchObject({ drifted: true, tamper: null, written: true });
    });

    it('removes a block that appears when nothing should be blocked', async () => {
      const empty = make();
      const r = await empty.reconcile([], 'verify');
      expect(r.tamper).toBe('modified');
      expect(await read()).toBe(BASE);
    });
  });

  describe('dry run', () => {
    it('reports drift but never writes', async () => {
      const r = await make(true).reconcile(['a.example'], 'update');
      expect(r).toMatchObject({ drifted: true, written: false, method: null, blockedCount: 1 });
      expect(await read()).toBe(BASE);
      expect(await fs.readdir(path.join(root, 'etc'))).toEqual(['hosts']);
    });

    it('still detects tamper', async () => {
      await make().reconcile(['a.example'], 'update');
      await fs.writeFile(hosts, BASE);
      const r = await make(true).reconcile(['a.example'], 'verify');
      expect(r).toMatchObject({ tamper: 'removed', written: false });
      expect(await read()).toBe(BASE);
    });
  });

  it('uses the in-place fallback when rename is busy', async () => {
    const e = new HostsFileEnforcer({
      root,
      dryRun: false,
      fileOps: {
        rename: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })),
      },
    });
    const ino = (await fs.stat(hosts)).ino;
    const r = await e.reconcile(['a.example'], 'update');
    expect(r).toMatchObject({ written: true, method: 'in-place' });
    expect((await fs.stat(hosts)).ino).toBe(ino);
    expect((await e.inspect()).blocked).toEqual(['a.example']);
  });

  it('creates the hosts file if it does not exist', async () => {
    await fs.rm(hosts);
    await make().reconcile(['a.example'], 'update');
    expect(await read()).toBe(renderBlock(['a.example']));
  });

  it('inspect reports an empty state when there is no block', async () => {
    expect(await make().inspect()).toEqual({ blocked: [], managedBlockPresent: false });
  });

  it('teardown removes the block and leaves the rest', async () => {
    const e = make();
    await e.reconcile(['a.example'], 'update');
    await e.teardown();
    expect(await read()).toBe(BASE);
  });

  it('follows a symlinked hosts file inside the root and keeps the link', async () => {
    await fs.rename(hosts, path.join(root, 'etc', 'hosts.real'));
    await fs.symlink('hosts.real', hosts);
    await make().reconcile(['a.example'], 'update');
    expect((await fs.lstat(hosts)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(root, 'etc', 'hosts.real'), 'utf8')).toContain(
      '0.0.0.0 a.example',
    );
  });

  it('refuses to follow a symlink out of the root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'hk-outside-'));
    try {
      const target = path.join(outside, 'hosts');
      await fs.writeFile(target, 'untouched\n');
      await fs.rm(hosts);
      await fs.symlink(target, hosts);
      await expect(make().reconcile(['a.example'], 'update')).rejects.toThrow(/outside the root/);
      expect(await fs.readFile(target, 'utf8')).toBe('untouched\n');
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('preserves the file mode', async () => {
    await fs.chmod(hosts, 0o600);
    await make().reconcile(['a.example'], 'update');
    expect((await fs.stat(hosts)).mode & 0o777).toBe(0o600);
  });
});
