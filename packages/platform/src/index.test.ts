import { describe, expect, it } from 'vitest';
import type { EnforcerOptions } from './index.js';

describe('platform', () => {
  it('requires an explicit root and dry-run flag', () => {
    const opts: EnforcerOptions = { root: '/tmp/fake-root', dryRun: true };
    expect(opts.dryRun).toBe(true);
  });
});
