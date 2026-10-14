import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile, type FileOps, type WriteMethod } from './atomic-write.js';
import { applyBlock, findBlock, parseBlockDomains, renderBlock } from './hosts-block.js';
import type {
  EnforcerOptions,
  Observed,
  PlatformEnforcer,
  ReconcileIntent,
  ReconcileResult,
  TamperKind,
} from '../enforcer.js';

export interface HostsEnforcerOptions extends EnforcerOptions {
  /** Test seam for simulating rename failures. */
  readonly fileOps?: FileOps;
}

/**
 * Layer 1 blocking: a managed section in `<root>/etc/hosts` mapping blocked names to
 * `0.0.0.0` and `::`. Hosts files have no wildcards and browsers using DNS-over-HTTPS
 * ignore them; see docs/SPEC.md section 7.
 */
export class HostsFileEnforcer implements PlatformEnforcer {
  readonly hostsPath: string;

  constructor(private readonly options: HostsEnforcerOptions) {
    if (!path.isAbsolute(options.root)) throw new Error('root must be an absolute path');
    this.hostsPath = path.join(options.root, 'etc', 'hosts');
  }

  async reconcile(blocked: readonly string[], intent: ReconcileIntent): Promise<ReconcileResult> {
    const current = await this.read();
    const state = findBlock(current);
    const desiredBlock = blocked.length === 0 ? '' : renderBlock(blocked);

    let drifted: boolean;
    let kind: TamperKind;
    if (state.kind === 'malformed') {
      drifted = true;
      kind = 'malformed';
    } else if (state.kind === 'absent') {
      drifted = desiredBlock !== '';
      kind = 'removed';
    } else {
      drifted = state.block !== desiredBlock;
      kind = 'modified';
    }
    // Only the periodic check treats a mismatch as someone else's change.
    const tamper: TamperKind | null = drifted && intent === 'verify' ? kind : null;

    const blockedCount = blocked.length;
    if (!drifted) return { drifted, tamper, written: false, method: null, blockedCount };
    if (this.options.dryRun) return { drifted, tamper, written: false, method: null, blockedCount };

    const next = applyBlock(current, desiredBlock);
    const method = await this.write(next);
    return { drifted, tamper, written: true, method, blockedCount };
  }

  async inspect(): Promise<Observed> {
    const state = findBlock(await this.read());
    if (state.kind !== 'present') return { blocked: [], managedBlockPresent: false };
    return { blocked: parseBlockDomains(state.block), managedBlockPresent: true };
  }

  teardown(): Promise<ReconcileResult> {
    return this.reconcile([], 'update');
  }

  private async read(): Promise<string> {
    try {
      return await fs.readFile(await this.resolveTarget(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw e;
    }
  }

  private async write(content: string): Promise<WriteMethod> {
    return atomicWriteFile(await this.resolveTarget(), content, this.options.fileOps);
  }

  /**
   * Follow a symlinked hosts file so rename replaces the file, not the link, but never
   * follow a link out of the configured root.
   */
  private async resolveTarget(): Promise<string> {
    let st;
    try {
      st = await fs.lstat(this.hostsPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.hostsPath;
      throw e;
    }
    if (!st.isSymbolicLink()) return this.hostsPath;
    const real = await fs.realpath(this.hostsPath);
    const root = await fs.realpath(this.options.root);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error(`hosts file symlink points outside the root: ${real}`);
    }
    return real;
  }
}
