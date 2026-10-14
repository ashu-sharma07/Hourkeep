import data from './data/groups.json' with { type: 'json' };
import { normalizeDomain } from './domain.js';

/** A named set of domains that can be blocked together. */
export interface Group {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly domains: readonly string[];
  readonly notes: readonly string[];
}

export interface GroupData {
  readonly schemaVersion: number;
  readonly dataVersion: string;
  readonly groups: readonly Group[];
}

const GROUP_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Validate raw group data. Throws on the first problem so a bad data file fails loudly at
 * startup and in tests, never silently at enforcement time.
 */
export function parseGroupData(raw: unknown): GroupData {
  if (typeof raw !== 'object' || raw === null) throw new Error('group data must be an object');
  const r = raw as Record<string, unknown>;
  if (r['schemaVersion'] !== 1)
    throw new Error(`unsupported group schemaVersion ${String(r['schemaVersion'])}`);
  if (typeof r['dataVersion'] !== 'string')
    throw new Error('group data needs a dataVersion string');
  if (!Array.isArray(r['groups'])) throw new Error('group data needs a groups array');

  const seen = new Set<string>();
  const groups: Group[] = (r['groups'] as unknown[]).map((g, i) => {
    const o = g as Record<string, unknown>;
    const id = o['id'];
    if (typeof id !== 'string' || !GROUP_ID.test(id)) throw new Error(`groups[${i}]: invalid id`);
    if (seen.has(id)) throw new Error(`duplicate group id "${id}"`);
    seen.add(id);
    const name = o['name'];
    if (typeof name !== 'string' || name === '') throw new Error(`group "${id}": missing name`);
    const domains = o['domains'];
    if (!Array.isArray(domains) || domains.length === 0)
      throw new Error(`group "${id}": no domains`);
    const unique = new Set<string>();
    for (const d of domains as unknown[]) {
      if (typeof d !== 'string') throw new Error(`group "${id}": domain is not a string`);
      const n = normalizeDomain(d);
      if (!n.ok) throw new Error(`group "${id}": ${n.error}`);
      if (n.value !== d) throw new Error(`group "${id}": "${d}" is not normalised`);
      if (unique.has(d)) throw new Error(`group "${id}": duplicate domain "${d}"`);
      unique.add(d);
    }
    return {
      id,
      name,
      description: typeof o['description'] === 'string' ? o['description'] : '',
      domains: domains as string[],
      notes: Array.isArray(o['notes']) ? (o['notes'] as string[]) : [],
    };
  });
  return { schemaVersion: 1, dataVersion: r['dataVersion'], groups };
}

/** The groups shipped with Hourkeep, loaded from `data/groups.json`. */
export const BUILTIN_GROUPS: GroupData = parseGroupData(data);
