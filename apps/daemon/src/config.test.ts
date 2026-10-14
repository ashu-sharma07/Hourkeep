import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('uses production defaults', () => {
    expect(parseConfig([])).toEqual({ command: 'run', config: DEFAULT_CONFIG });
  });

  it('reads every flag', () => {
    const { command, config } = parseConfig([
      '--root',
      '/tmp/r',
      '--dry-run',
      '--socket',
      '/tmp/s.sock',
      '--group',
      'wheel',
      '--state-dir',
      '/tmp/state',
      '--interval-ms',
      '250',
      '--peercred',
      '/tmp/p.node',
    ]);
    expect(command).toBe('run');
    expect(config).toEqual({
      root: '/tmp/r',
      dryRun: true,
      socketPath: '/tmp/s.sock',
      socketGroup: 'wheel',
      stateDir: '/tmp/state',
      reconcileIntervalMs: 250,
      peercredPath: '/tmp/p.node',
    });
  });

  it('lets an empty --group or --peercred disable the feature', () => {
    const { config } = parseConfig(['--group', '', '--peercred', '']);
    expect(config.socketGroup).toBeNull();
    expect(config.peercredPath).toBeNull();
  });

  it('selects commands', () => {
    expect(parseConfig(['--teardown']).command).toBe('teardown');
    expect(parseConfig(['--version']).command).toBe('version');
    expect(parseConfig(['--help']).command).toBe('help');
  });

  it.each([
    [['--root', 'relative']],
    [['--socket', 'rel.sock']],
    [['--interval-ms', '5']],
    [['--interval-ms', 'abc']],
    [['--interval-ms', '99999999']],
    [['--bogus']],
    [['positional']],
  ])('rejects %j', (argv) => {
    expect(() => parseConfig(argv)).toThrow(ConfigError);
  });
});
