import { describe, expect, it } from 'vitest';
import { SuffixMatcher } from './matcher.js';

const owner = (t: string) => ({ kind: 'domain' as const, target: t });
const yt = new SuffixMatcher({
  block: [
    { suffix: 'googlevideo.com', owner: owner('googlevideo') },
    { suffix: 'youtube.com', owner: owner('youtube') },
    { suffix: 'youtubei.googleapis.com', owner: owner('api') },
  ],
  allow: ['accounts.youtube.com', 'consent.youtube.com'],
});

describe('SuffixMatcher', () => {
  it('blocks the domain itself and every subdomain at any depth', () => {
    for (const n of [
      'googlevideo.com',
      'rr1---sn-ab5l6n7y.googlevideo.com',
      'a.b.c.d.googlevideo.com',
      'www.youtube.com',
      'm.youtube.com',
    ]) {
      expect(yt.match(n)).toMatchObject({ blocked: true });
    }
  });

  it('reports which suffix matched and who owns it', () => {
    expect(yt.match('rr1.googlevideo.com')).toEqual({
      blocked: true,
      suffix: 'googlevideo.com',
      owner: owner('googlevideo'),
    });
    expect(yt.match('youtubei.googleapis.com')).toEqual({
      blocked: true,
      suffix: 'youtubei.googleapis.com',
      owner: owner('api'),
    });
  });

  it('matches whole labels only, never a substring', () => {
    for (const n of [
      'notgooglevideo.com',
      'googlevideo.com.evil.example',
      'myyoutube.com',
      'youtube.com.au',
      'youtube.co',
    ]) {
      expect(yt.match(n)).toEqual({ blocked: false });
    }
  });

  it('blocks a narrow entry without blocking its parent', () => {
    expect(yt.match('googleapis.com')).toEqual({ blocked: false });
    expect(yt.match('www.googleapis.com')).toEqual({ blocked: false });
    expect(yt.match('x.youtubei.googleapis.com')).toMatchObject({ blocked: true });
  });

  it('lets exceptions through, and their subdomains', () => {
    expect(yt.match('accounts.youtube.com')).toEqual({ blocked: false });
    expect(yt.match('x.accounts.youtube.com')).toEqual({ blocked: false });
    expect(yt.match('consent.youtube.com')).toEqual({ blocked: false });
    expect(yt.match('accounts.youtube.com.evil.example')).toEqual({ blocked: false });
  });

  it('a more specific block beats a broader exception', () => {
    const m = new SuffixMatcher({
      block: [
        { suffix: 'youtube.com', owner: 1 },
        { suffix: 'ads.accounts.youtube.com', owner: 2 },
      ],
      allow: ['accounts.youtube.com'],
    });
    expect(m.match('accounts.youtube.com')).toEqual({ blocked: false });
    expect(m.match('ads.accounts.youtube.com')).toEqual({
      blocked: true,
      suffix: 'ads.accounts.youtube.com',
      owner: 2,
    });
    expect(m.match('x.ads.accounts.youtube.com')).toMatchObject({ blocked: true, owner: 2 });
  });

  it('on a tie the block wins', () => {
    const m = new SuffixMatcher({
      block: [{ suffix: 'a.example', owner: 1 }],
      allow: ['a.example'],
    });
    expect(m.match('a.example')).toMatchObject({ blocked: true });
  });

  it('ignores case and a trailing dot', () => {
    expect(yt.match('RR1.GoogleVideo.COM.')).toMatchObject({ blocked: true });
    expect(
      new SuffixMatcher({ block: [{ suffix: 'Example.COM.', owner: 1 }], allow: [] }).match(
        'a.example.com',
      ),
    ).toMatchObject({ blocked: true });
  });

  it('allows everything when empty, and copes with odd names', () => {
    const empty = new SuffixMatcher<number>({ block: [], allow: [] });
    expect(empty.match('anything.example')).toEqual({ blocked: false });
    expect(empty.size).toBe(0);
    expect(yt.match('')).toEqual({ blocked: false });
    expect(yt.match('com')).toEqual({ blocked: false });
    expect(yt.size).toBe(3);
  });
});
