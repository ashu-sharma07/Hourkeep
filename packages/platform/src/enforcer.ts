/** Options every enforcer must honour so tests never touch the real system. */
export interface EnforcerOptions {
  /** Directory treated as the filesystem root (default `/`). Must be absolute. */
  readonly root: string;
  /** When true, compute changes but write nothing. */
  readonly dryRun: boolean;
}

/**
 * Why a reconcile pass was run.
 * - `update`: the desired state just changed on purpose (rule edit, daemon start). A mismatch
 *   with the system is expected and is not tampering.
 * - `verify`: periodic check. Any mismatch means someone else changed what we manage.
 */
export type ReconcileIntent = 'update' | 'verify';

/** What the enforcer found wrong with the managed section. */
export type TamperKind = 'modified' | 'removed' | 'malformed';

export interface ReconcileResult {
  /** The system differed from the desired state. */
  readonly drifted: boolean;
  /** Set when intent was `verify` and the system differed (someone changed our section). */
  readonly tamper: TamperKind | null;
  /** The system was changed. Always false in dry-run mode. */
  readonly written: boolean;
  /** How the change was written. `in-place` is the non-atomic fallback for busy files. */
  readonly method: 'rename' | 'in-place' | null;
  /** Number of hostnames in the desired state. */
  readonly blockedCount: number;
}

export interface Observed {
  readonly blocked: readonly string[];
  readonly managedBlockPresent: boolean;
}

/**
 * OS enforcement boundary. The daemon decides *what* must be blocked; an enforcer makes the
 * machine match. Methods are not re-entrant: callers must serialise them.
 */
export interface PlatformEnforcer {
  /** Make the system block exactly `blocked` (sorted, normalised hostnames). */
  reconcile(blocked: readonly string[], intent: ReconcileIntent): Promise<ReconcileResult>;
  /** Read what the system currently blocks through our managed section. */
  inspect(): Promise<Observed>;
  /** Remove everything this enforcer manages (used on uninstall). */
  teardown(): Promise<ReconcileResult>;
}
