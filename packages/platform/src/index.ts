/** Options every enforcer must honour so tests never touch the real system. */
export interface EnforcerOptions {
  /** Directory treated as the filesystem root (default `/`). */
  readonly root: string;
  /** When true, compute changes but write nothing. */
  readonly dryRun: boolean;
}
