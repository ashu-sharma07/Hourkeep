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
      '--cooldown-seconds',
      '3',
      '--passes-per-day',
      '2',
      '--pass-minutes',
      '5',
      '--timezone',
      'Asia/Kolkata',
      '--challenge-kinds',
      'typing, arithmetic',
      '--reflection-wait-seconds',
      '2',
      '--min-answer-seconds',
      '1',
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
      initialSettings: {
        cooldownSeconds: 3,
        passesPerDay: 2,
        passMinutes: 5,
        timezone: 'Asia/Kolkata',
      },
      challengeKinds: ['typing', 'arithmetic'],
      challengeTiming: { reflectionWaitMs: 2000, minAnswerMs: 1000 },
      dns: { enabled: false, address: '127.0.0.1', port: 53, upstreams: [] },
    });
  });

  it('defaults to the owner-approved protection settings and all challenge kinds', () => {
    const { config } = parseConfig([]);
    expect(config.initialSettings).toEqual({
      cooldownSeconds: 600,
      passesPerDay: 3,
      passMinutes: 15,
      timezone: null,
    });
    expect(config.challengeKinds).toEqual(['typing', 'arithmetic', 'reflection']);
    expect(config.challengeTiming).toEqual({ reflectionWaitMs: 30_000, minAnswerMs: 5000 });
  });

  it('the DNS layer is off by default and configured by flags', () => {
    expect(parseConfig([]).config.dns).toEqual({
      enabled: false,
      address: '127.0.0.1',
      port: 53,
      upstreams: [],
    });
    expect(
      parseConfig([
        '--dns',
        '--dns-listen',
        '127.0.0.1:5353',
        '--upstream',
        '1.1.1.1',
        '--upstream',
        '2606:4700::1111',
      ]).config.dns,
    ).toEqual({
      enabled: true,
      address: '127.0.0.1',
      port: 5353,
      upstreams: ['1.1.1.1', '2606:4700::1111'],
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
    [['--cooldown-seconds', '0']],
    [['--cooldown-seconds', 'abc']],
    [['--passes-per-day', '25']],
    [['--pass-minutes', '0']],
    [['--timezone', 'Mars/Base']],
    [['--challenge-kinds', 'typing,telepathy']],
    [['--challenge-kinds', '']],
    [['--dns-listen', 'localhost:53']],
    [['--dns-listen', '127.0.0.1']],
    [['--dns-listen', '127.0.0.1:0']],
    [['--dns-listen', '127.0.0.1:70000']],
    [['--upstream', 'dns.example']],
    [['--upstream', '127.0.0.53']],
    [['--upstream', '::1']],
    [['--bogus']],
    [['positional']],
  ])('rejects %j', (argv) => {
    expect(() => parseConfig(argv)).toThrow(ConfigError);
  });
});
