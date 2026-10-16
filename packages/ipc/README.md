# @hourkeep/ipc

The wire protocol between `hourkeepd` and its clients: Zod schemas, framing and Unix-socket helpers. No OS-specific code; peer-credential lookup is injected by the daemon.

Depends on `zod` (runtime validation of every message, required by the spec).

## Protocol (version 3)

Newline-delimited JSON over a Unix socket. Every message is at most 64 KiB; longer input is cut off with `too_large`.

Request: `{ "v": 3, "id": "<1-64 chars>", "op": "<operation>", ...fields }`

Response: `{ "v": 3, "id": "...", "ok": true, "data": ... }` or `{ ..., "ok": false, "error": { "code", "message" } }`

Operations:

| op                                                      | fields                        | data                                               |
| ------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `status`, `list`                                        |                               | daemon state; rules with schedule, limit and state |
| `block`                                                 | `target`                      | rule added (tightening, instant)                   |
| `unblock`                                               | `target`                      | change outcome                                     |
| `schedule_set`, `schedule_clear`                        | `target`, `schedule`          | change outcome                                     |
| `limit_set`                                             | `target`, `minutes` (or null) | change outcome                                     |
| `settings_get`, `settings_set`                          | `key`, `value`                | settings; change outcome                           |
| `pass_start`, `pass_end`                                | `target`                      | change outcome                                     |
| `pending_list`                                          |                               | pending changes                                    |
| `pending_cancel`, `pending_challenge`, `pending_answer` | `changeId` (+ `response`)     | message; challenge; applied or wrong               |

A change outcome is `applied`, `noop`, or `pending` with the pending change (cooldown and expiry times, phase, attempts left). Tightening is applied at once; loosening is always `pending`. Challenges never contain the answer.

All schemas are strict: unknown fields are rejected. A request with another `v` gets `unsupported_version`. Analytics are aggregated by the daemon; clients never see the database, and blocked lookups are counted per rule and matching suffix, never by the exact name looked up. Error codes: `bad_request`, `unsupported_version`, `too_large`, `invalid_target`, `invalid_value`, `not_found`, `cooldown_active`, `too_early`, `expired`, `limit_reached`, `internal`.

## Public API

- Schemas and types: `RequestSchema`, `responseSchema(op)`, `ResponseData`, `PROTOCOL_VERSION`, `MAX_MESSAGE_BYTES`.
- Framing: `encodeMessage`, `LineDecoder`, `FrameTooLargeError`.
- Client: `call(socketPath, op, params, { timeoutMs })` returns a validated response, or throws `IpcClientError` with `kind` of `not-running`, `permission`, `timeout`, `protocol` or `connect`.
- Server: `createIpcServer({ socketPath, mode, handler, resolvePeer, onListening, onError })`. Applies the socket mode before any client can connect, removes stale sockets from crashed runs (but never a live one or a non-socket), serialises requests per connection, drops idle connections and caps concurrent connections.
