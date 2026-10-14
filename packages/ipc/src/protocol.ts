import { z } from 'zod';

/**
 * Protocol version carried in every message. Bump on any incompatible change.
 * v2: loosening operations return a pending change; schedules, limits, settings, pending
 * changes and passes were added.
 */
export const PROTOCOL_VERSION = 2;

/** Upper bound for one framed message, request or response, in bytes. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const requestId = z.string().min(1).max(64);
const target = z.string().min(1).max(253);
const pendingId = z.number().int().positive();

/** Fields every request carries. */
const envelope = { v: z.literal(PROTOCOL_VERSION), id: requestId } as const;

// ---- shared value shapes ----------------------------------------------------------------

const WindowSchema = z.strictObject({
  /** Minutes since local midnight. */
  start: z.number().int().min(0).max(1440),
  end: z.number().int().min(0).max(1440),
});

export const ScheduleSchema = z.strictObject({
  timezone: z.string().min(1).max(64),
  days: z.strictObject({
    mon: z.array(WindowSchema).max(24),
    tue: z.array(WindowSchema).max(24),
    wed: z.array(WindowSchema).max(24),
    thu: z.array(WindowSchema).max(24),
    fri: z.array(WindowSchema).max(24),
    sat: z.array(WindowSchema).max(24),
    sun: z.array(WindowSchema).max(24),
  }),
});
export type ScheduleWire = z.infer<typeof ScheduleSchema>;

// ---- requests ----------------------------------------------------------------------------
// Every schema is strict: unknown fields are rejected, not ignored.

export const StatusRequest = z.strictObject({ ...envelope, op: z.literal('status') });
export const ListRequest = z.strictObject({ ...envelope, op: z.literal('list') });
export const BlockRequest = z.strictObject({ ...envelope, op: z.literal('block'), target });
export const UnblockRequest = z.strictObject({ ...envelope, op: z.literal('unblock'), target });
export const ScheduleSetRequest = z.strictObject({
  ...envelope,
  op: z.literal('schedule_set'),
  target,
  schedule: ScheduleSchema,
});
export const ScheduleClearRequest = z.strictObject({
  ...envelope,
  op: z.literal('schedule_clear'),
  target,
});
export const LimitSetRequest = z.strictObject({
  ...envelope,
  op: z.literal('limit_set'),
  target,
  /** Max pass minutes per day for the rule; null removes the limit. */
  minutes: z.number().int().min(0).max(1440).nullable(),
});
export const SettingsGetRequest = z.strictObject({ ...envelope, op: z.literal('settings_get') });
export const SettingsSetRequest = z.strictObject({
  ...envelope,
  op: z.literal('settings_set'),
  key: z.string().min(1).max(32),
  value: z.string().min(1).max(100),
});
export const PendingListRequest = z.strictObject({ ...envelope, op: z.literal('pending_list') });
export const PendingCancelRequest = z.strictObject({
  ...envelope,
  op: z.literal('pending_cancel'),
  changeId: pendingId,
});
export const PendingChallengeRequest = z.strictObject({
  ...envelope,
  op: z.literal('pending_challenge'),
  changeId: pendingId,
});
export const PendingAnswerRequest = z.strictObject({
  ...envelope,
  op: z.literal('pending_answer'),
  changeId: pendingId,
  response: z.string().max(4000),
});
export const PassStartRequest = z.strictObject({
  ...envelope,
  op: z.literal('pass_start'),
  target,
});
export const PassEndRequest = z.strictObject({ ...envelope, op: z.literal('pass_end'), target });

export const RequestSchema = z.discriminatedUnion('op', [
  StatusRequest,
  ListRequest,
  BlockRequest,
  UnblockRequest,
  ScheduleSetRequest,
  ScheduleClearRequest,
  LimitSetRequest,
  SettingsGetRequest,
  SettingsSetRequest,
  PendingListRequest,
  PendingCancelRequest,
  PendingChallengeRequest,
  PendingAnswerRequest,
  PassStartRequest,
  PassEndRequest,
]);
export type Request = z.infer<typeof RequestSchema>;
export type Op = Request['op'];

/** A request without the envelope; the client fills in `v` and `id`. */
export type RequestParams<O extends Op> = Omit<Extract<Request, { op: O }>, 'v' | 'id' | 'op'>;

// ---- response data -----------------------------------------------------------------------

export const RuleSchema = z.strictObject({
  kind: z.enum(['domain', 'group']),
  target: z.string(),
  /** Epoch milliseconds. */
  createdAt: z.number().int(),
});
export type RuleInfo = z.infer<typeof RuleSchema>;

export const RuleDetailSchema = z.strictObject({
  ...RuleSchema.shape,
  /** Null means the rule blocks around the clock. */
  schedule: ScheduleSchema.nullable(),
  scheduleText: z.string(),
  /** Max pass minutes per day, or null for no per-rule limit. */
  dailyLimitMinutes: z.number().int().nullable(),
  /** Is this rule blocking right now (schedule active and no pass running)? */
  blockingNow: z.boolean(),
  /** End of the running pass, or null. */
  passEndsAt: z.number().int().nullable(),
});
export type RuleDetail = z.infer<typeof RuleDetailSchema>;

export const GroupInfoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  domainCount: z.number().int(),
});

export const CHANGE_KINDS = [
  'remove_rule',
  'set_schedule',
  'set_limit',
  'set_setting',
  'start_pass',
] as const;

export const PendingViewSchema = z.strictObject({
  id: z.number().int(),
  kind: z.enum(CHANGE_KINDS),
  /** What will happen, in words: "stop blocking youtube". */
  summary: z.string(),
  requestedAt: z.number().int(),
  requestedByUid: z.number().int().nullable(),
  cooldownEndsAt: z.number().int(),
  /** After this the change can no longer be confirmed. */
  expiresAt: z.number().int(),
  phase: z.enum(['cooldown', 'ready']),
  challengeIssued: z.boolean(),
  attemptsLeft: z.number().int(),
});
export type PendingView = z.infer<typeof PendingViewSchema>;

const ChallengeDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('typing'), text: z.string() }),
  z.strictObject({ kind: z.literal('arithmetic'), problems: z.array(z.string()) }),
  z.strictObject({
    kind: z.literal('reflection'),
    question: z.string(),
    minWords: z.number().int(),
    minChars: z.number().int(),
  }),
]);

export const PublicChallengeSchema = z.strictObject({
  id: z.string(),
  issuedAt: z.number().int(),
  earliestAnswerAt: z.number().int(),
  instructions: z.string(),
  data: ChallengeDataSchema,
});
export type PublicChallengeWire = z.infer<typeof PublicChallengeSchema>;

export const StatusData = z.strictObject({
  daemonVersion: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  dryRun: z.boolean(),
  ruleCount: z.number().int(),
  blockedDomainCount: z.number().int(),
  /** Epoch ms of the last successful reconcile, or null before the first. */
  lastReconcileAt: z.number().int().nullable(),
  tamperCount: z.number().int(),
  lastTamperAt: z.number().int().nullable(),
  pendingCount: z.number().int(),
  passesUsedToday: z.number().int(),
  passesPerDay: z.number().int(),
  /** UID the daemon saw for this connection, or null when peer credentials are unavailable. */
  callerUid: z.number().int().nullable(),
});

export const ListData = z.strictObject({
  rules: z.array(RuleDetailSchema),
  groups: z.array(GroupInfoSchema),
  blockedDomains: z.array(z.string()),
});

export const BlockData = z.strictObject({
  rule: RuleSchema,
  /** False when the rule already existed. */
  added: z.boolean(),
  blockedDomainCount: z.number().int(),
});

/**
 * Result of an operation that may loosen protection. Tightening applies at once; loosening
 * returns the pending change that must wait out its cooldown and be confirmed.
 */
export const ChangeOutcomeData = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), message: z.string() }),
  z.strictObject({ status: z.literal('pending'), change: PendingViewSchema }),
  z.strictObject({ status: z.literal('noop'), message: z.string() }),
]);
export type ChangeOutcome = z.infer<typeof ChangeOutcomeData>;

export const SettingsData = z.strictObject({
  cooldownSeconds: z.number().int(),
  passesPerDay: z.number().int(),
  passMinutes: z.number().int(),
  timezone: z.string(),
});

export const PendingListData = z.strictObject({ changes: z.array(PendingViewSchema) });
export const PendingCancelData = z.strictObject({ message: z.string() });
export const PendingChallengeData = z.strictObject({
  challenge: PublicChallengeSchema,
  attemptsLeft: z.number().int(),
});
export const PendingAnswerData = z.discriminatedUnion('result', [
  z.strictObject({ result: z.literal('applied'), message: z.string() }),
  z.strictObject({
    result: z.literal('wrong'),
    hint: z.string(),
    attemptsLeft: z.number().int(),
    /** Set when the attempts ran out and a fresh challenge replaced the old one. */
    newChallenge: PublicChallengeSchema.nullable(),
  }),
]);

/** Response payload schema for each operation. */
export const ResponseData = {
  status: StatusData,
  list: ListData,
  block: BlockData,
  unblock: ChangeOutcomeData,
  schedule_set: ChangeOutcomeData,
  schedule_clear: ChangeOutcomeData,
  limit_set: ChangeOutcomeData,
  settings_get: SettingsData,
  settings_set: ChangeOutcomeData,
  pending_list: PendingListData,
  pending_cancel: PendingCancelData,
  pending_challenge: PendingChallengeData,
  pending_answer: PendingAnswerData,
  pass_start: ChangeOutcomeData,
  pass_end: ChangeOutcomeData,
} as const satisfies Record<Op, z.ZodType>;

export type DataOf<O extends Op> = z.infer<(typeof ResponseData)[O]>;

export const ERROR_CODES = [
  'bad_request',
  'unsupported_version',
  'too_large',
  'invalid_target',
  'invalid_value',
  'not_found',
  /** The change is still in its cooldown. */
  'cooldown_active',
  /** The challenge cannot be answered yet. */
  'too_early',
  /** The pending change timed out. */
  'expired',
  /** Pass limits or daily limit reached. */
  'limit_reached',
  'internal',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBody = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().max(1024),
});
export type IpcError = z.infer<typeof ErrorBody>;

const responseEnvelope = { v: z.literal(PROTOCOL_VERSION), id: z.string() } as const;

export const ErrorResponseSchema = z.strictObject({
  ...responseEnvelope,
  ok: z.literal(false),
  error: ErrorBody,
});

/** Build the schema for a response to operation `op`. */
export function responseSchema<O extends Op>(op: O) {
  return z.union([
    z.strictObject({ ...responseEnvelope, ok: z.literal(true), data: ResponseData[op] }),
    ErrorResponseSchema,
  ]);
}

export type Response<O extends Op> =
  | { v: typeof PROTOCOL_VERSION; id: string; ok: true; data: DataOf<O> }
  | { v: typeof PROTOCOL_VERSION; id: string; ok: false; error: IpcError };

/**
 * Read `v` and `id` from an untrusted message without validating the rest, so an
 * incompatible client still gets a well-formed `unsupported_version` reply.
 */
export function peekEnvelope(raw: unknown): { v: unknown; id: string } {
  if (typeof raw !== 'object' || raw === null) return { v: undefined, id: '' };
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' && o['id'].length <= 64 ? o['id'] : '';
  return { v: o['v'], id };
}
