import { describe, expect, it } from 'vitest';
import { BUILTIN_GROUPS, parseGroupData } from './groups.js';

describe('built-in group data', () => {
  it('has a versioned youtube group', () => {
    expect(BUILTIN_GROUPS.dataVersion).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    const yt = BUILTIN_GROUPS.groups.find((g) => g.id === 'youtube');
    expect(yt).toBeDefined();
  });

  it('contains every domain required by the spec that resolves', () => {
    const yt = BUILTIN_GROUPS.groups.find((g) => g.id === 'youtube');
    for (const d of [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
      'youtubei.googleapis.com',
      'i.ytimg.com',
      'googlevideo.com',
    ]) {
      expect(yt?.domains).toContain(d);
    }
  });

  it('does not list shared sign-in endpoints', () => {
    const yt = BUILTIN_GROUPS.groups.find((g) => g.id === 'youtube');
    expect(yt?.domains).not.toContain('accounts.youtube.com');
    expect(yt?.domains).not.toContain('consent.youtube.com');
  });
});

describe('parseGroupData', () => {
  const good = {
    schemaVersion: 1,
    dataVersion: '2026-01-01.1',
    groups: [{ id: 'x', name: 'X', domains: ['x.example'] }],
  };

  it('accepts minimal valid data', () => {
    expect(parseGroupData(good).groups[0]?.domains).toEqual(['x.example']);
  });

  it.each([
    ['non-object', 5],
    ['bad schema version', { ...good, schemaVersion: 2 }],
    ['missing dataVersion', { ...good, dataVersion: undefined }],
    ['bad id', { ...good, groups: [{ ...good.groups[0], id: 'Bad Id' }] }],
    ['duplicate id', { ...good, groups: [good.groups[0], good.groups[0]] }],
    ['empty domains', { ...good, groups: [{ ...good.groups[0], domains: [] }] }],
    ['invalid domain', { ...good, groups: [{ ...good.groups[0], domains: ['bad domain'] }] }],
    ['unnormalised domain', { ...good, groups: [{ ...good.groups[0], domains: ['X.example'] }] }],
    [
      'duplicate domain',
      { ...good, groups: [{ ...good.groups[0], domains: ['x.example', 'x.example'] }] },
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseGroupData(raw)).toThrow();
  });
});
