import { describe, expect, it } from 'vitest';
import { FrameTooLargeError, LineDecoder, encodeMessage } from './framing.js';

describe('encodeMessage', () => {
  it('emits one JSON line', () => {
    expect(encodeMessage({ a: 1 }).toString()).toBe('{"a":1}\n');
  });
  it('refuses oversize messages', () => {
    expect(() => encodeMessage({ s: 'x'.repeat(100) }, 50)).toThrow(FrameTooLargeError);
  });
});

describe('LineDecoder', () => {
  it('splits multiple lines in one chunk', () => {
    expect(new LineDecoder().push('a\nb\nc')).toEqual(['a', 'b']);
  });

  it('reassembles a line split across chunks, including a split multi-byte character', () => {
    const d = new LineDecoder();
    const bytes = Buffer.from('héllo\n', 'utf8');
    expect(d.push(bytes.subarray(0, 2))).toEqual([]);
    expect(d.push(bytes.subarray(2))).toEqual(['héllo']);
    expect(d.pending).toBe(0);
  });

  it('returns empty lines as empty strings', () => {
    expect(new LineDecoder().push('\n\n')).toEqual(['', '']);
  });

  it('throws when a line without newline exceeds the limit', () => {
    const d = new LineDecoder(16);
    expect(d.push('x'.repeat(10))).toEqual([]);
    expect(() => d.push('x'.repeat(10))).toThrow(FrameTooLargeError);
  });

  it('throws when a complete line exceeds the limit', () => {
    expect(() => new LineDecoder(8).push('x'.repeat(20) + '\n')).toThrow(FrameTooLargeError);
  });

  it('accepts a line just under the limit', () => {
    expect(new LineDecoder(8).push('1234567\n')).toEqual(['1234567']);
  });

  it('never buffers more than the limit while waiting', () => {
    const d = new LineDecoder(32);
    for (let i = 0; i < 3; i++) d.push('xxxxxxxx');
    expect(d.pending).toBeLessThan(32);
  });
});
