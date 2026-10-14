import { describe, expect, it } from 'vitest';
import { banner } from './index.js';

describe('daemon', () => {
  it('prints a banner with the protocol version', () => {
    expect(banner()).toBe('hourkeepd (protocol v1)');
  });
});
