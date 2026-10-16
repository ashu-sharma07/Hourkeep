/** Owner of a blocked suffix; the daemon uses its rule so lookups are counted under the right rule. */
export interface SuffixSpec<O> {
  readonly block: readonly { readonly suffix: string; readonly owner: O }[];
  /** Names that stay reachable even under a blocked suffix. */
  readonly allow: readonly string[];
}

export type Match<O> =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly suffix: string; readonly owner: O };

/**
 * Whole-domain blocking. A name is blocked when the most specific rule that covers it
 * (itself, then each parent in turn) is a block entry. When a block and an allow entry cover
 * the same name length the block wins, so an explicit block is never overridden by an
 * exception for the same name.
 */
export class SuffixMatcher<O> {
  private readonly block = new Map<string, O>();
  private readonly allow = new Set<string>();

  constructor(spec: SuffixSpec<O>) {
    for (const e of spec.block) this.block.set(normalize(e.suffix), e.owner);
    for (const a of spec.allow) this.allow.add(normalize(a));
  }

  get size(): number {
    return this.block.size;
  }

  match(name: string): Match<O> {
    let candidate = normalize(name);
    for (;;) {
      const owner = this.block.get(candidate);
      if (owner !== undefined) return { blocked: true, suffix: candidate, owner };
      if (this.allow.has(candidate)) return { blocked: false };
      const dot = candidate.indexOf('.');
      if (dot === -1) return { blocked: false };
      candidate = candidate.slice(dot + 1);
    }
  }
}

function normalize(name: string): string {
  const n = name.toLowerCase();
  return n.endsWith('.') ? n.slice(0, -1) : n;
}
