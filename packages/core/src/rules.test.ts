import { describe, expect, it } from 'vitest';
import { BUILTIN_GROUPS } from './groups.js';
import { parseTarget, resolveRules, ruleKey } from './rules.js';

const groups = BUILTIN_GROUPS.groups;

describe('parseTarget', () => {
  it('recognises a group id, case-insensitively', () => {
    expect(parseTarget('YouTube', groups)).toEqual({
      ok: true,
      value: { kind: 'group', target: 'youtube' },
    });
  });

  it('treats dotted input as a domain', () => {
    expect(parseTarget('Reddit.com', groups)).toEqual({
      ok: true,
      value: { kind: 'domain', target: 'reddit.com' },
    });
  });

  it('reports unknown dotless words as unknown groups and lists known ones', () => {
    const r = parseTarget('tiktok', groups);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('youtube');
  });

  it('propagates domain validation errors', () => {
    expect(parseTarget('*.example.com', groups).ok).toBe(false);
    expect(parseTarget('', groups).ok).toBe(false);
  });
});

describe('resolveRules', () => {
  it('expands a group exactly as listed', () => {
    const out = resolveRules([{ kind: 'group', target: 'youtube' }], groups);
    const yt = groups.find((g) => g.id === 'youtube');
    expect(out).toEqual([...(yt?.domains ?? [])].sort());
  });

  it('adds www for a plain domain but not twice', () => {
    expect(resolveRules([{ kind: 'domain', target: 'reddit.com' }], groups)).toEqual([
      'reddit.com',
      'www.reddit.com',
    ]);
    expect(resolveRules([{ kind: 'domain', target: 'www.reddit.com' }], groups)).toEqual([
      'www.reddit.com',
    ]);
  });

  it('de-duplicates overlapping rules and sorts', () => {
    const out = resolveRules(
      [
        { kind: 'domain', target: 'youtube.com' },
        { kind: 'group', target: 'youtube' },
      ],
      groups,
    );
    expect(new Set(out).size).toBe(out.length);
    expect([...out].sort()).toEqual(out);
  });

  it('ignores rules pointing at unknown groups', () => {
    expect(resolveRules([{ kind: 'group', target: 'gone' }], groups)).toEqual([]);
  });

  it('is empty for no rules', () => {
    expect(resolveRules([], groups)).toEqual([]);
  });
});

describe('ruleKey', () => {
  it('distinguishes kind', () => {
    expect(ruleKey({ kind: 'group', target: 'a' })).not.toBe(
      ruleKey({ kind: 'domain', target: 'a' }),
    );
  });
});
