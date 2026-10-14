import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RequestSchema,
  peekEnvelope,
  responseSchema,
} from './protocol.js';

const base = { v: PROTOCOL_VERSION, id: 'abc' };

describe('RequestSchema', () => {
  it.each([
    { ...base, op: 'status' },
    { ...base, op: 'list' },
    { ...base, op: 'block', target: 'youtube' },
    { ...base, op: 'unblock', target: 'example.com' },
  ])('accepts %j', (msg) => {
    expect(RequestSchema.safeParse(msg).success).toBe(true);
  });

  it.each([
    ['unknown field', { ...base, op: 'status', extra: 1 }],
    ['unknown op', { ...base, op: 'shutdown' }],
    ['missing op', base],
    ['missing id', { v: 1, op: 'status' }],
    ['empty id', { v: 1, id: '', op: 'status' }],
    ['overlong id', { v: 1, id: 'x'.repeat(65), op: 'status' }],
    ['wrong version', { v: 2, id: 'a', op: 'status' }],
    ['version as string', { v: '1', id: 'a', op: 'status' }],
    ['block without target', { ...base, op: 'block' }],
    ['empty target', { ...base, op: 'block', target: '' }],
    ['numeric target', { ...base, op: 'block', target: 5 }],
    ['overlong target', { ...base, op: 'block', target: 'a'.repeat(254) }],
    ['status with target', { ...base, op: 'status', target: 'x' }],
    ['null', null],
    ['array', []],
    ['string', 'status'],
  ])('rejects %s', (_name, msg) => {
    expect(RequestSchema.safeParse(msg).success).toBe(false);
  });

  it('does not let prototype pollution keys through', () => {
    const msg = JSON.parse('{"v":1,"id":"a","op":"status","__proto__":{"admin":true}}');
    expect(RequestSchema.safeParse(msg).success).toBe(false);
  });
});

describe('responseSchema', () => {
  it('accepts an ok status reply', () => {
    const data = {
      daemonVersion: '0.0.0',
      protocol: 1,
      dryRun: false,
      ruleCount: 0,
      blockedDomainCount: 0,
      lastReconcileAt: null,
      tamperCount: 0,
      lastTamperAt: null,
      callerUid: 1000,
    };
    expect(responseSchema('status').safeParse({ ...base, ok: true, data }).success).toBe(true);
  });

  it('rejects data of the wrong shape or extra fields', () => {
    expect(responseSchema('status').safeParse({ ...base, ok: true, data: {} }).success).toBe(false);
    expect(
      responseSchema('list').safeParse({
        ...base,
        ok: true,
        data: { rules: [], groups: [], blockedDomains: [], x: 1 },
      }).success,
    ).toBe(false);
  });

  it('accepts an error reply for any op and rejects unknown codes', () => {
    const error = { code: 'not_found', message: 'nope' };
    expect(responseSchema('block').safeParse({ ...base, ok: false, error }).success).toBe(true);
    expect(
      responseSchema('block').safeParse({
        ...base,
        ok: false,
        error: { code: 'weird', message: 'x' },
      }).success,
    ).toBe(false);
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
