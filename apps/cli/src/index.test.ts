import { describe, expect, it } from 'vitest';
import { versionLine } from './index.js';

describe('cli', () => {
  it('prints a version line', () => {
    expect(versionLine()).toBe('hourkeep (protocol v1)');
  });
});
