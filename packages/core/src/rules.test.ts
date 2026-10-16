import { describe, expect, it } from 'vitest';
import { BUILTIN_GROUPS } from './groups.js';
import { parseTarget, resolveRules, resolveSuffixes, ruleKey } from './rules.js';

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

describe('resolveSuffixes', () => {
  const yt = { kind: 'group', target: 'youtube' } as const;

  it('uses group domains as whole-domain suffixes and drops names a shorter suffix already covers', () => {
    const spec = resolveSuffixes([yt], groups);
    const suffixes = spec.block.map((e) => e.suffix);
    expect(suffixes).toContain('googlevideo.com');
    expect(suffixes).toContain('youtube.com');
    expect(suffixes).not.toContain('www.youtube.com'); // covered by youtube.com
    expect(suffixes).not.toContain('redirector.googlevideo.com');
    expect(suffixes).toContain('youtubei.googleapis.com'); // never the whole of googleapis.com
    expect(suffixes).not.toContain('googleapis.com');
    expect(spec.block.every((e) => e.owner.target === 'youtube')).toBe(true);
  });

  it('carries the group exceptions only while the group is a rule', () => {
    expect(resolveSuffixes([yt], groups).allow).toEqual([
      'accounts.youtube.com',
      'consent.youtube.com',
    ]);
    expect(resolveSuffixes([{ kind: 'domain', target: 'youtube.com' }], groups).allow).toEqual([]);
  });

  it('does not add www. for a plain domain: the suffix already covers it', () => {
    expect(resolveSuffixes([{ kind: 'domain', target: 'reddit.com' }], groups).block).toEqual([
      { suffix: 'reddit.com', owner: { kind: 'domain', target: 'reddit.com' } },
    ]);
  });

  it('the first rule to ask for a suffix owns it', () => {
    const spec = resolveSuffixes([{ kind: 'domain', target: 'youtube.com' }, yt], groups);
    expect(spec.block.find((e) => e.suffix === 'youtube.com')?.owner).toEqual({
      kind: 'domain',
      target: 'youtube.com',
    });
  });

  it('a domain rule under a blocked suffix is redundant and dropped', () => {
    const spec = resolveSuffixes(
      [
        { kind: 'domain', target: 'reddit.com' },
        { kind: 'domain', target: 'old.reddit.com' },
      ],
      groups,
    );
    expect(spec.block.map((e) => e.suffix)).toEqual(['reddit.com']);
  });

  it('is sorted and empty for no rules or unknown groups', () => {
    expect(resolveSuffixes([], groups)).toEqual({ block: [], allow: [] });
    expect(resolveSuffixes([{ kind: 'group', target: 'gone' }], groups)).toEqual({
      block: [],
      allow: [],
    });
    const names = resolveSuffixes([yt], groups).block.map((e) => e.suffix);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});
