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
