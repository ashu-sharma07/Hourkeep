# @hourkeep/ipc

The wire protocol between `hourkeepd` and its clients: Zod schemas, framing and Unix-socket helpers. No OS-specific code; peer-credential lookup is injected by the daemon.

Depends on `zod` (runtime validation of every message, required by the spec).

## Protocol (version 1)

Newline-delimited JSON over a Unix socket. Every message is at most 64 KiB; longer input is cut off with `too_large`.

Request: `{ "v": 1, "id": "<1-64 chars>", "op": "status" | "list" | "block" | "unblock", "target"?: string }`

Response: `{ "v": 1, "id": "...", "ok": true, "data": ... }` or `{ ..., "ok": false, "error": { "code", "message" } }`

All schemas are strict: unknown fields are rejected. A request with another `v` gets `unsupported_version`. Error codes: `bad_request`, `unsupported_version`, `too_large`, `invalid_target`, `not_found`, `internal`.

## Public API

- Schemas and types: `RequestSchema`, `responseSchema(op)`, `ResponseData`, `PROTOCOL_VERSION`, `MAX_MESSAGE_BYTES`.
- Framing: `encodeMessage`, `LineDecoder`, `FrameTooLargeError`.
- Client: `call(socketPath, op, params, { timeoutMs })` returns a validated response, or throws `IpcClientError` with `kind` of `not-running`, `permission`, `timeout`, `protocol` or `connect`.
- Server: `createIpcServer({ socketPath, mode, handler, resolvePeer, onListening, onError })`. Applies the socket mode before any client can connect, removes stale sockets from crashed runs (but never a live one or a non-socket), serialises requests per connection, drops idle connections and caps concurrent connections.
