import { describe, expect, it } from 'vitest';
import {
  CHANGE_KINDS,
  ERROR_CODES,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RequestSchema,
  ResponseData,
  peekEnvelope,
  responseSchema,
  type Op,
} from './protocol.js';

const base = { v: PROTOCOL_VERSION, id: 'abc' };
const schedule = {
  timezone: 'Asia/Kolkata',
  days: {
    mon: [{ start: 540, end: 1020 }],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
    sun: [],
  },
};

it('is protocol version 2', () => {
  expect(PROTOCOL_VERSION).toBe(2);
});

describe('RequestSchema accepts', () => {
  it.each([
    { op: 'status' },
    { op: 'list' },
    { op: 'block', target: 'youtube' },
    { op: 'unblock', target: 'example.com' },
    { op: 'schedule_set', target: 'youtube', schedule },
    { op: 'schedule_clear', target: 'youtube' },
    { op: 'limit_set', target: 'youtube', minutes: 30 },
    { op: 'limit_set', target: 'youtube', minutes: null },
    { op: 'limit_set', target: 'youtube', minutes: 0 },
    { op: 'settings_get' },
    { op: 'settings_set', key: 'cooldown', value: '30' },
    { op: 'pending_list' },
    { op: 'pending_cancel', changeId: 3 },
    { op: 'pending_challenge', changeId: 3 },
    { op: 'pending_answer', changeId: 3, response: 'some answer' },
    { op: 'pass_start', target: 'youtube' },
    { op: 'pass_end', target: 'youtube' },
  ])('%j', (rest) => {
    expect(RequestSchema.safeParse({ ...base, ...rest }).success).toBe(true);
  });
});

describe('RequestSchema rejects', () => {
  it.each([
    ['unknown field', { ...base, op: 'status', extra: 1 }],
    ['unknown op', { ...base, op: 'shutdown' }],
    ['missing op', base],
    ['missing id', { v: PROTOCOL_VERSION, op: 'status' }],
    ['empty id', { v: PROTOCOL_VERSION, id: '', op: 'status' }],
    ['overlong id', { v: PROTOCOL_VERSION, id: 'x'.repeat(65), op: 'status' }],
    ['old version', { v: 1, id: 'a', op: 'status' }],
    ['version as string', { v: String(PROTOCOL_VERSION), id: 'a', op: 'status' }],
    ['block without target', { ...base, op: 'block' }],
    ['empty target', { ...base, op: 'block', target: '' }],
    ['numeric target', { ...base, op: 'block', target: 5 }],
    ['overlong target', { ...base, op: 'block', target: 'a'.repeat(254) }],
    ['status with target', { ...base, op: 'status', target: 'x' }],
    ['schedule without a schedule', { ...base, op: 'schedule_set', target: 'x.com' }],
    ['schedule with extra day', { ...base, op: 'schedule_set', target: 'x.com', schedule: { ...schedule, days: { ...schedule.days, funday: [] } } }],
    ['schedule missing a day', { ...base, op: 'schedule_set', target: 'x.com', schedule: { ...schedule, days: { mon: [] } } }],
    ['schedule window out of range', { ...base, op: 'schedule_set', target: 'x.com', schedule: { ...schedule, days: { ...schedule.days, mon: [{ start: 0, end: 1441 }] } } }],
    ['schedule window with extra field', { ...base, op: 'schedule_set', target: 'x.com', schedule: { ...schedule, days: { ...schedule.days, mon: [{ start: 0, end: 60, x: 1 }] } } }],
    ['too many windows in a day', { ...base, op: 'schedule_set', target: 'x.com', schedule: { ...schedule, days: { ...schedule.days, mon: Array.from({ length: 25 }, () => ({ start: 0, end: 1 })) } } }],
    ['limit as string', { ...base, op: 'limit_set', target: 'x.com', minutes: '30' }],
    ['limit negative', { ...base, op: 'limit_set', target: 'x.com', minutes: -1 }],
    ['limit fractional', { ...base, op: 'limit_set', target: 'x.com', minutes: 1.5 }],
    ['limit above a day', { ...base, op: 'limit_set', target: 'x.com', minutes: 1441 }],
    ['limit omitted', { ...base, op: 'limit_set', target: 'x.com' }],
    ['setting value not a string', { ...base, op: 'settings_set', key: 'cooldown', value: 30 }],
    ['setting with empty value', { ...base, op: 'settings_set', key: 'cooldown', value: '' }],
    ['pending id zero', { ...base, op: 'pending_cancel', changeId: 0 }],
    ['pending id string', { ...base, op: 'pending_cancel', changeId: '3' }],
    ['pending id fractional', { ...base, op: 'pending_challenge', changeId: 1.5 }],
    ['answer without response', { ...base, op: 'pending_answer', changeId: 1 }],
    ['answer too long', { ...base, op: 'pending_answer', changeId: 1, response: 'x'.repeat(4001) }],
    ['null', null],
    ['array', []],
    ['string', 'status'],
  ])('%s', (_name, msg) => {
    expect(RequestSchema.safeParse(msg).success).toBe(false);
  });

  it('does not let prototype pollution keys through', () => {
    const msg = JSON.parse(`{"v":${PROTOCOL_VERSION},"id":"a","op":"status","__proto__":{"admin":true}}`);
    expect(RequestSchema.safeParse(msg).success).toBe(false);
  });
});

describe('responses', () => {
  const view = {
    id: 3,
    kind: 'remove_rule',
    summary: 'stop blocking youtube',
    requestedAt: 1,
    requestedByUid: 1000,
    cooldownEndsAt: 601,
    expiresAt: 1801,
    phase: 'cooldown',
    challengeIssued: false,
    attemptsLeft: 3,
  };
  const challenge = {
    id: 'abcd1234',
    issuedAt: 1,
    earliestAnswerAt: 6,
    instructions: 'Type this',
    data: { kind: 'typing', text: 'abc' },
  };
  const ok = (op: Op, data: unknown) => responseSchema(op).safeParse({ ...base, ok: true, data }).success;

  it('accepts a status reply', () => {
    expect(
      ok('status', {
        daemonVersion: '0.0.0',
        protocol: PROTOCOL_VERSION,
        dryRun: false,
        ruleCount: 0,
        blockedDomainCount: 0,
        lastReconcileAt: null,
        tamperCount: 0,
        lastTamperAt: null,
        pendingCount: 1,
        passesUsedToday: 0,
        passesPerDay: 3,
        callerUid: 1000,
      }),
    ).toBe(true);
  });

  it('every change operation returns a change outcome with exactly three shapes', () => {
    for (const op of ['unblock', 'schedule_set', 'schedule_clear', 'limit_set', 'settings_set', 'pass_start', 'pass_end'] as const) {
      expect(ResponseData[op]).toBe(ResponseData.unblock);
      expect(ok(op, { status: 'applied', message: 'done' })).toBe(true);
      expect(ok(op, { status: 'noop', message: 'nothing' })).toBe(true);
      expect(ok(op, { status: 'pending', change: view })).toBe(true);
      expect(ok(op, { status: 'pending' })).toBe(false);
      expect(ok(op, { status: 'weird', message: 'x' })).toBe(false);
    }
  });

  it('validates pending views strictly', () => {
    expect(ok('pending_list', { changes: [view] })).toBe(true);
    expect(ok('pending_list', { changes: [{ ...view, phase: 'expired' }] })).toBe(false);
    expect(ok('pending_list', { changes: [{ ...view, kind: 'format_disk' }] })).toBe(false);
    expect(ok('pending_list', { changes: [{ ...view, extra: 1 }] })).toBe(false);
  });

  it('knows all five change kinds', () => {
    expect([...CHANGE_KINDS]).toEqual(['remove_rule', 'set_schedule', 'set_limit', 'set_setting', 'start_pass']);
  });

  it('validates challenges of every kind and rejects mismatched data', () => {
    expect(ok('pending_challenge', { challenge, attemptsLeft: 3 })).toBe(true);
    expect(ok('pending_challenge', { challenge: { ...challenge, data: { kind: 'arithmetic', problems: ['1 + 1'] } }, attemptsLeft: 3 })).toBe(true);
    expect(
      ok('pending_challenge', {
        challenge: { ...challenge, data: { kind: 'reflection', question: 'why?', minWords: 8, minChars: 40 } },
        attemptsLeft: 3,
      }),
    ).toBe(true);
    expect(ok('pending_challenge', { challenge: { ...challenge, data: { kind: 'typing', problems: [] } }, attemptsLeft: 3 })).toBe(false);
    expect(ok('pending_challenge', { challenge: { ...challenge, data: { kind: 'telepathy' } }, attemptsLeft: 3 })).toBe(false);
  });

  it('never carries a secret field in a challenge', () => {
    expect(ok('pending_challenge', { challenge: { ...challenge, secret: { text: 'abc' } }, attemptsLeft: 3 })).toBe(false);
  });

  it('answers are applied or wrong', () => {
    expect(ok('pending_answer', { result: 'applied', message: 'done' })).toBe(true);
    expect(ok('pending_answer', { result: 'wrong', hint: 'no', attemptsLeft: 2, newChallenge: null })).toBe(true);
    expect(ok('pending_answer', { result: 'wrong', hint: 'no', attemptsLeft: 3, newChallenge: challenge })).toBe(true);
    expect(ok('pending_answer', { result: 'maybe' })).toBe(false);
  });

  it('list rules carry schedule, limit and state', () => {
    const rule = {
      kind: 'group',
      target: 'youtube',
      createdAt: 1,
      schedule,
      scheduleText: 'mon 09:00-17:00 (Asia/Kolkata)',
      dailyLimitMinutes: 30,
      blockingNow: true,
      passEndsAt: null,
    };
    expect(ok('list', { rules: [rule], groups: [], blockedDomains: [] })).toBe(true);
    expect(ok('list', { rules: [{ ...rule, schedule: null }], groups: [], blockedDomains: [] })).toBe(true);
    expect(ok('list', { rules: [{ ...rule, blockingNow: 'yes' }], groups: [], blockedDomains: [] })).toBe(false);
  });

  it('accepts every error code and rejects unknown ones', () => {
    for (const code of ERROR_CODES) {
      expect(responseSchema('block').safeParse({ ...base, ok: false, error: { code, message: 'x' } }).success).toBe(true);
    }
    expect(responseSchema('block').safeParse({ ...base, ok: false, error: { code: 'weird', message: 'x' } }).success).toBe(false);
  });

  it('has the friction error codes clients need to tell states apart', () => {
    for (const c of ['cooldown_active', 'too_early', 'expired', 'limit_reached', 'invalid_value']) {
      expect(ERROR_CODES).toContain(c);
    }
  });
});

describe('peekEnvelope', () => {
  it('extracts v and id leniently', () => {
    expect(peekEnvelope({ v: 7, id: 'z', op: 'whatever' })).toEqual({ v: 7, id: 'z' });
  });
  it('survives junk', () => {
    expect(peekEnvelope(null)).toEqual({ v: undefined, id: '' });
    expect(peekEnvelope({ id: 5 })).toEqual({ v: undefined, id: '' });
    expect(peekEnvelope({ id: 'x'.repeat(100) }).id).toBe('');
  });
});

it('exposes a sane size limit', () => {
  expect(MAX_MESSAGE_BYTES).toBe(65536);
});
