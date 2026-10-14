import { z } from 'zod';

/** Protocol version carried in every message. Bump on any incompatible change. */
export const PROTOCOL_VERSION = 1;

/** Upper bound for one framed message, request or response, in bytes. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

const requestId = z.string().min(1).max(64);
const target = z.string().min(1).max(253);

/** Fields every request carries. */
const envelope = { v: z.literal(PROTOCOL_VERSION), id: requestId } as const;

// Every schema is strict: unknown fields are rejected, not ignored.
export const StatusRequest = z.strictObject({ ...envelope, op: z.literal('status') });
export const ListRequest = z.strictObject({ ...envelope, op: z.literal('list') });
export const BlockRequest = z.strictObject({ ...envelope, op: z.literal('block'), target });
export const UnblockRequest = z.strictObject({ ...envelope, op: z.literal('unblock'), target });

export const RequestSchema = z.discriminatedUnion('op', [
  StatusRequest,
  ListRequest,
  BlockRequest,
  UnblockRequest,
]);
export type Request = z.infer<typeof RequestSchema>;
export type Op = Request['op'];

/** A request without the envelope; the client fills in `v` and `id`. */
export type RequestParams<O extends Op> = Omit<Extract<Request, { op: O }>, 'v' | 'id' | 'op'>;

export const RuleSchema = z.strictObject({
  kind: z.enum(['domain', 'group']),
  target: z.string(),
  /** Epoch milliseconds. */
  createdAt: z.number().int(),
});
export type RuleInfo = z.infer<typeof RuleSchema>;

export const GroupInfoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  domainCount: z.number().int(),
});

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
  /** UID the daemon saw for this connection, or null when peer credentials are unavailable. */
  callerUid: z.number().int().nullable(),
});

export const ListData = z.strictObject({
  rules: z.array(RuleSchema),
  groups: z.array(GroupInfoSchema),
  blockedDomains: z.array(z.string()),
});

export const BlockData = z.strictObject({
  rule: RuleSchema,
  /** False when the rule already existed. */
  added: z.boolean(),
  blockedDomainCount: z.number().int(),
});

export const UnblockData = z.strictObject({
  rule: z.strictObject({ kind: z.enum(['domain', 'group']), target: z.string() }),
  /** False when there was no such rule. */
  removed: z.boolean(),
  blockedDomainCount: z.number().int(),
});

/** Response payload schema for each operation. */
export const ResponseData = {
  status: StatusData,
  list: ListData,
  block: BlockData,
  unblock: UnblockData,
} as const satisfies Record<Op, z.ZodType>;

export type DataOf<O extends Op> = z.infer<(typeof ResponseData)[O]>;

export const ERROR_CODES = [
  'bad_request',
  'unsupported_version',
  'too_large',
  'invalid_target',
  'not_found',
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
