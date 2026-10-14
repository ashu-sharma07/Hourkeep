import { describe, expect, it } from 'vitest';
import { normalizeDomain } from './domain.js';

describe('normalizeDomain', () => {
  it.each([
    ['YouTube.com', 'youtube.com'],
    ['  www.Example.ORG ', 'www.example.org'],
    ['example.com.', 'example.com'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
    ['a-b.c-d.io', 'a-b.c-d.io'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeDomain(input)).toEqual({ ok: true, value: expected });
  });

  it.each([
    '',
    '   ',
    'localhost',
    'foo.localhost',
    'singlelabel',
    '*.googlevideo.com',
    'https://youtube.com/watch',
    'youtube.com/watch',
    '127.0.0.1',
    '1.2.3.4',
    'exa mple.com',
    'example.com\n0.0.0.0 evil.com',
    'example.com # comment',
    '-bad.example.com',
    'bad-.example.com',
    'a..b.com',
    'bücher.example',
    `${'a'.repeat(64)}.com`,
    `${'a.'.repeat(130)}com`,
  ])('rejects %j', (input) => {
    const r = normalizeDomain(input);
    expect(r.ok).toBe(false);
  });

  it('gives a helpful message for wildcards', () => {
    const r = normalizeDomain('*.googlevideo.com');
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toContain('wildcards');
  });
});
