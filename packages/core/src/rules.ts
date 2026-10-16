import { normalizeDomain } from './domain.js';
import type { Group } from './groups.js';
import { err, ok, type Result } from './result.js';

/** A block rule. `target` is a normalised domain or a group id. */
export interface Rule {
  readonly kind: 'domain' | 'group';
  readonly target: string;
}

/** Stable identity of a rule, used for de-duplication. */
export function ruleKey(rule: Rule): string {
  return `${rule.kind}:${rule.target}`;
}

/**
 * Turn user input (`youtube`, `example.com`) into a rule. A known group id wins; anything
 * else must be a valid domain, and a dotless unknown word is reported as an unknown group.
 */
export function parseTarget(input: string, groups: readonly Group[]): Result<Rule> {
  const word = input.trim().toLowerCase();
  if (word === '') return err('target is empty');
  const group = groups.find((g) => g.id === word);
  if (group) return ok({ kind: 'group', target: group.id });
  if (!word.includes('.')) {
    const known = groups.map((g) => g.id).join(', ') || 'none';
    return err(
      `unknown group "${word}". Known groups: ${known}. For a site, give a domain such as example.com`,
    );
  }
  const d = normalizeDomain(word);
  if (!d.ok) return d;
  return ok({ kind: 'domain', target: d.value });
}

/**
 * Expand rules into the sorted, de-duplicated list of hostnames to block.
 * A plain domain also blocks its `www.` variant (hosts files have no wildcards, and
 * almost every site answers on both). Group domains are used exactly as listed.
 */
export function resolveRules(rules: readonly Rule[], groups: readonly Group[]): string[] {
  const out = new Set<string>();
  for (const rule of rules) {
    if (rule.kind === 'group') {
      const g = groups.find((x) => x.id === rule.target);
      if (g) for (const d of g.domains) out.add(d);
    } else {
      out.add(rule.target);
      if (!rule.target.startsWith('www.')) out.add(`www.${rule.target}`);
    }
  }
  return [...out].sort();
}

/** A blocked domain suffix and the rule that asked for it. */
export interface SuffixEntry {
  readonly suffix: string;
  readonly owner: Rule;
}

/** What the DNS layer blocks: whole domains (every subdomain too), minus exceptions. */
export interface SuffixSpec {
  readonly block: readonly SuffixEntry[];
  /** Exceptions: reachable even under a blocked suffix, unless a longer or equal block entry matches. */
  readonly allow: readonly string[];
}

/**
 * Expand rules into suffixes for the DNS layer. Unlike `resolveRules` this does not add
 * `www.` (a suffix already covers it) and it drops entries that a shorter suffix already
 * covers, so `www.youtube.com` disappears behind `youtube.com`. When two rules want the
 * same suffix the first one owns it (this decides which rule a blocked lookup is counted
 * under). Group `allow` entries are kept only for groups that are actually blocking.
 */
export function resolveSuffixes(rules: readonly Rule[], groups: readonly Group[]): SuffixSpec {
  const wanted = new Map<string, Rule>();
  const allow = new Set<string>();
  const add = (suffix: string, owner: Rule): void => {
    if (!wanted.has(suffix)) wanted.set(suffix, owner);
  };
  for (const rule of rules) {
    if (rule.kind === 'domain') {
      add(rule.target, rule);
      continue;
    }
    const g = groups.find((x) => x.id === rule.target);
    if (!g) continue;
    for (const d of g.domains) add(d, rule);
    for (const a of g.allow) allow.add(a);
  }
  const covered = (s: string): boolean => {
    for (let i = s.indexOf('.'); i !== -1; i = s.indexOf('.', i + 1)) {
      if (wanted.has(s.slice(i + 1))) return true;
    }
    return false;
  };
  const block = [...wanted.entries()]
    .filter(([s]) => !covered(s))
    .map(([suffix, owner]) => ({ suffix, owner }))
    .sort((a, b) => a.suffix.localeCompare(b.suffix));
  return { block, allow: [...allow].sort() };
}
