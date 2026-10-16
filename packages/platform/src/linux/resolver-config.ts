import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile } from './atomic-write.js';

/** Domain the daemon answers itself, to check that the system really asks it. */
export const CANARY_DOMAIN = 'selftest.hourkeep.dev';

export type ResolverStrategy = 'systemd-resolved' | 'resolv.conf';

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs system commands. Injected so tests never touch the real systemd. */
export interface CommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

export const systemRunner: CommandRunner = {
  run: (command, args) =>
    new Promise((resolve) => {
      execFile(command, [...args], { timeout: 30_000 }, (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    }),
};

export interface ResolverOptions {
  /** Directory treated as `/`. */
  readonly root: string;
  readonly dryRun: boolean;
  /** Where the record of what we changed is kept. Outside `root` (it is the daemon's state). */
  readonly backupPath: string;
  /** Where the daemon's resolver listens. */
  readonly listen: { readonly address: string; readonly port: number };
  readonly runner?: CommandRunner;
  /** `auto` (default) picks systemd-resolved when it is running, else resolv.conf. */
  readonly strategy?: 'auto' | ResolverStrategy;
}

type Saved =
  | { readonly path: string; readonly kind: 'absent' }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly content: string;
      readonly mode: number;
    }
  | { readonly path: string; readonly kind: 'symlink'; readonly target: string };

interface Backup {
  readonly version: 1;
  readonly strategy: ResolverStrategy;
  readonly files: readonly Saved[];
}

const MARK = '# Managed by hourkeepd. Removed by "hourkeepd --teardown".';
const isLoopback = (a: string): boolean =>
  /^127\./.test(a) || a === '::1' || a === '0.0.0.0' || a === '::';

/** Addresses from `nameserver` lines, without loopback or duplicates. */
export function parseNameservers(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*nameserver\s+(\S+)/.exec(line);
    const addr = m?.[1];
    if (addr && !isLoopback(addr) && !out.includes(addr)) out.push(addr);
  }
  return out;
}

export interface Verification {
  readonly ok: boolean;
  readonly problem?: string;
}

/**
 * Points the system resolver at the daemon's DNS server, and puts everything back.
 *
 * Fail-safe by construction: nothing is changed unless a usable upstream exists; the
 * original configuration is saved before the first write and is what `restore` uses, even
 * from a fresh process; with resolv.conf the original servers stay listed as fallbacks.
 */
export class ResolverConfigurator {
  private readonly runner: CommandRunner;
  private readonly rooted = (p: string): string => path.join(this.o.root, p);

  constructor(private readonly o: ResolverOptions) {
    if (!path.isAbsolute(o.root)) throw new Error('root must be an absolute path');
    this.runner = o.runner ?? systemRunner;
  }

  private get dropIn(): string {
    return this.rooted('/etc/systemd/resolved.conf.d/hourkeep.conf');
  }
  private get resolvConf(): string {
    return this.rooted('/etc/resolv.conf');
  }

  /** The strategy in use: the saved one if we already changed something, else the best fit. */
  async detect(): Promise<ResolverStrategy> {
    const saved = await this.readBackup();
    if (saved) return saved.strategy;
    if (this.o.strategy && this.o.strategy !== 'auto') return this.o.strategy;
    const r = await this.runner.run('systemctl', ['is-active', '--quiet', 'systemd-resolved']);
    return r.code === 0 ? 'systemd-resolved' : 'resolv.conf';
  }

  /** The real resolvers to forward to, taken from the configuration as it was before us. */
  async upstreams(): Promise<string[]> {
    const strategy = await this.detect();
    if (strategy === 'systemd-resolved') {
      const text = await readText(this.rooted('/run/systemd/resolve/resolv.conf'));
      return parseNameservers(text ?? '');
    }
    const saved = await this.readBackup();
    const original = saved?.files.find((f) => f.path === this.resolvConf);
    if (original?.kind === 'file') return parseNameservers(original.content);
    return parseNameservers((await readText(this.resolvConf)) ?? '');
  }

  /** Expected content of the systemd-resolved drop-in. */
  private dropInContent(): string {
    const { address, port } = this.o.listen;
    return `${MARK}\n[Resolve]\nDNS=${port === 53 ? address : `${address}:${port}`}\nDomains=~.\n`;
  }

  /** Expected resolv.conf: our server first, everything that was there kept after it. */
  private resolvConfContent(original: string): string {
    const kept = original
      .split('\n')
      .filter((l) => !/^\s*nameserver\s+127\.0\.0\.1\s*$/.test(l) && l !== MARK)
      .join('\n')
      .replace(/\n+$/, '');
    return `${MARK}\nnameserver ${this.o.listen.address}\n${kept}${kept ? '\n' : ''}`;
  }

  /**
   * Make the system use our resolver. Safe to call repeatedly: when it is already set up
   * nothing is written, and a repair after someone else rewrote the file keeps the
   * original backup (it never saves our own configuration as "the original").
   */
  async configure(): Promise<{ strategy: ResolverStrategy; changed: boolean }> {
    const strategy = await this.detect();
    const upstreams = await this.upstreams();
    if (upstreams.length === 0) {
      throw new Error('no usable upstream DNS server found (not taking over the system resolver)');
    }
    if (strategy === 'resolv.conf' && this.o.listen.port !== 53) {
      throw new Error('the resolv.conf strategy needs the DNS server on port 53');
    }
    const status = await this.verify();
    if (status.ok) return { strategy, changed: false };
    if (this.o.dryRun) return { strategy, changed: true };

    const paths = strategy === 'systemd-resolved' ? [this.dropIn] : [this.resolvConf];
    if (!(await this.readBackup()))
      await this.writeBackup(strategy, await Promise.all(paths.map((p) => this.save(p))));

    if (strategy === 'systemd-resolved') {
      await fs.mkdir(path.dirname(this.dropIn), { recursive: true });
      await atomicWriteFile(this.dropIn, this.dropInContent());
      await this.reloadResolved();
    } else {
      const backup = await this.readBackup();
      const orig = backup?.files.find((f) => f.path === this.resolvConf);
      const text = orig?.kind === 'file' ? orig.content : '';
      // If the original was a symlink, replace the link itself with a regular file.
      if ((await lstat(this.resolvConf))?.isSymbolicLink()) await fs.rm(this.resolvConf);
      await atomicWriteFile(this.resolvConf, this.resolvConfContent(text));
    }
    return { strategy, changed: true };
  }

  /** Is the system still set up the way `configure` left it? */
  async verify(): Promise<Verification> {
    const strategy = await this.detect();
    if (strategy === 'systemd-resolved') {
      const text = await readText(this.dropIn);
      if (text === null) return { ok: false, problem: 'the systemd-resolved drop-in is missing' };
      return text === this.dropInContent()
        ? { ok: true }
        : { ok: false, problem: 'the systemd-resolved drop-in was changed' };
    }
    const st = await lstat(this.resolvConf);
    if (!st || st.isSymbolicLink())
      return { ok: false, problem: 'resolv.conf is missing or was replaced' };
    const text = (await readText(this.resolvConf)) ?? '';
    const first = text.split('\n').find((l) => /^\s*nameserver\s/.test(l));
    return first?.trim() === `nameserver ${this.o.listen.address}` && text.startsWith(MARK)
      ? { ok: true }
      : { ok: false, problem: 'resolv.conf no longer points at the hourkeep resolver' };
  }

  /** Put the system resolver back exactly as it was. Works from the saved record alone. */
  async restore(): Promise<{ restored: boolean }> {
    const backup = await this.readBackup();
    if (this.o.dryRun) return { restored: backup !== null };
    if (!backup) {
      // Nothing recorded: still remove a drop-in that carries our marker.
      const text = await readText(this.dropIn);
      if (text?.startsWith(MARK)) {
        await fs.rm(this.dropIn);
        await this.reloadResolved();
        return { restored: true };
      }
      return { restored: false };
    }
    for (const f of backup.files) await this.put(f);
    if (backup.strategy === 'systemd-resolved') await this.reloadResolved();
    await fs.rm(this.o.backupPath, { force: true });
    return { restored: true };
  }

  // ---- saved state ------------------------------------------------------------------------

  private async save(p: string): Promise<Saved> {
    const st = await lstat(p);
    if (!st) return { path: p, kind: 'absent' };
    if (st.isSymbolicLink()) return { path: p, kind: 'symlink', target: await fs.readlink(p) };
    return { path: p, kind: 'file', content: await fs.readFile(p, 'utf8'), mode: st.mode & 0o7777 };
  }

  private async put(f: Saved): Promise<void> {
    if (f.kind === 'absent') {
      await fs.rm(f.path, { force: true });
      return;
    }
    if (f.kind === 'symlink') {
      await fs.rm(f.path, { force: true });
      await fs.symlink(f.target, f.path);
      return;
    }
    await fs.mkdir(path.dirname(f.path), { recursive: true });
    if ((await lstat(f.path))?.isSymbolicLink()) await fs.rm(f.path);
    await atomicWriteFile(f.path, f.content);
    await fs.chmod(f.path, f.mode).catch(() => undefined);
  }

  private async readBackup(): Promise<Backup | null> {
    const text = await readText(this.o.backupPath);
    if (text === null) return null;
    try {
      const b = JSON.parse(text) as Backup;
      return b.version === 1 ? b : null;
    } catch {
      return null;
    }
  }

  private async writeBackup(strategy: ResolverStrategy, files: Saved[]): Promise<void> {
    await fs.mkdir(path.dirname(this.o.backupPath), { recursive: true, mode: 0o700 });
    await atomicWriteFile(
      this.o.backupPath,
      JSON.stringify({ version: 1, strategy, files } satisfies Backup, null, 2),
    );
    await fs.chmod(this.o.backupPath, 0o600).catch(() => undefined);
  }

  private async reloadResolved(): Promise<void> {
    const r = await this.runner.run('systemctl', ['restart', 'systemd-resolved']);
    if (r.code !== 0)
      throw new Error(`could not restart systemd-resolved: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
}

async function lstat(p: string) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function readText(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw e;
  }
}
