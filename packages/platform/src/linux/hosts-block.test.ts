import { describe, expect, it } from 'vitest';
import {
  BEGIN_MARKER,
  END_MARKER,
  applyBlock,
  findBlock,
  parseBlockDomains,
  renderBlock,
} from './hosts-block.js';

const BASE = '127.0.0.1 localhost\n::1 localhost\n';

describe('renderBlock', () => {
  it('maps each domain to IPv4 and IPv6 sinks between markers', () => {
    expect(renderBlock(['a.example', 'b.example'])).toBe(
      `${BEGIN_MARKER}\n0.0.0.0 a.example\n:: a.example\n0.0.0.0 b.example\n:: b.example\n${END_MARKER}\n`,
    );
  });
});

describe('findBlock', () => {
  it('reports absent without markers', () => {
    expect(findBlock(BASE)).toEqual({ kind: 'absent' });
    expect(findBlock('')).toEqual({ kind: 'absent' });
  });

  it('finds a well-formed block', () => {
    const block = renderBlock(['a.example']);
    const s = findBlock(BASE + block + '# trailer\n');
    expect(s).toMatchObject({ kind: 'present', block });
  });

  it.each([
    ['lone BEGIN', `${BASE}${BEGIN_MARKER}\n0.0.0.0 a.example\n`],
    ['lone END', `${BASE}${END_MARKER}\n`],
    ['END before BEGIN', `${END_MARKER}\n${BEGIN_MARKER}\n`],
    ['duplicate blocks', renderBlock(['a.example']) + renderBlock(['b.example'])],
  ])('reports malformed for %s', (_n, content) => {
    expect(findBlock(content)).toEqual({ kind: 'malformed' });
  });

  it('tolerates CRLF on marker lines', () => {
    const content = `${BEGIN_MARKER}\r\n0.0.0.0 a.example\r\n${END_MARKER}\r\n`;
    expect(findBlock(content).kind).toBe('present');
  });
});

describe('parseBlockDomains', () => {
  it('returns each domain once from the IPv4 lines', () => {
    expect(parseBlockDomains(renderBlock(['a.example', 'b.example']))).toEqual([
      'a.example',
      'b.example',
    ]);
  });
});

describe('applyBlock', () => {
  const block = renderBlock(['a.example']);

  it('appends to a file without a block, keeping existing text', () => {
    expect(applyBlock(BASE, block)).toBe(BASE + block);
  });

  it('adds a newline when the file lacks a trailing one', () => {
    expect(applyBlock('127.0.0.1 localhost', block)).toBe('127.0.0.1 localhost\n' + block);
  });

  it('works on an empty file', () => {
    expect(applyBlock('', block)).toBe(block);
  });

  it('replaces an existing block in place, preserving text before and after', () => {
    const before = BASE + '10.0.0.1 nas\n';
    const after = '10.0.0.2 printer\n';
    const old = renderBlock(['old.example']);
    expect(applyBlock(before + old + after, block)).toBe(before + block + after);
  });

  it('removes the block when asked for an empty one, restoring the original text', () => {
    expect(applyBlock(BASE + block, '')).toBe(BASE);
    expect(applyBlock(BASE, '')).toBe(BASE);
  });

  it('is idempotent', () => {
    const once = applyBlock(BASE, block);
    expect(applyBlock(once, block)).toBe(once);
  });

  it('cleans up a malformed block before writing a fresh one', () => {
    const broken = `${BASE}${BEGIN_MARKER}\n0.0.0.0 a.example\n${BEGIN_MARKER}\n`;
    const fixed = applyBlock(broken, block);
    expect(findBlock(fixed)).toMatchObject({ kind: 'present', block });
    expect(fixed.startsWith(BASE)).toBe(true);
  });

  it('removes duplicated blocks entirely when clearing', () => {
    const dup = BASE + renderBlock(['a.example']) + renderBlock(['b.example']);
    expect(applyBlock(dup, '')).toBe(BASE);
  });
});
