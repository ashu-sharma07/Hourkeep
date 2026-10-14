# @hourkeep/daemon (`hourkeepd`)

The product. A root service that owns the rules, keeps the hosts file in line with them and serves a Unix socket. Clients (CLI, later the desktop app) only send requests.

## What it does

- Stores rules, schedules, daily limits, pending changes, passes, settings and an event log in SQLite (`node:sqlite`, versioned migrations that roll back in tests). Everything survives a restart.
- Serves the `@hourkeep/ipc` protocol (v2) on `/run/hourkeep/hourkeep.sock`, mode `0660`, group `hourkeep`. If the group does not exist the socket falls back to root-only (`0600`) and an error is logged.
- **Tightening is instant, loosening is not.** Adding a rule, adding schedule coverage, lowering a limit, raising the cooldown, lowering passes per day or pass length, or ending a pass applies at once. Removing a rule, removing schedule coverage, raising or clearing a limit, lowering the cooldown, raising passes per day or pass length, or changing the timezone becomes a pending change: cooldown (default 10 minutes), then a challenge (typing, arithmetic or reflection), then it is applied. See `docs/DECISIONS.md` for the exact rules.
- **Schedules** decide when a rule is blocking (weekly windows in an IANA timezone, DST-safe). **Passes** suspend one rule for a while (default 3 per day, 15 minutes), need a challenge but no cooldown, and respect a per-rule daily limit in pass minutes.
- Every `--interval-ms` (default 5 s) it expires stale requests, follows schedule and pass transitions, and re-checks the hosts file. Any unexpected difference in the managed block is reverted and a `tamper` event is stored. A change of the desired set (schedule edge, pass start or end) is never reported as tampering.
- Records the caller's UID (via the SO_PEERCRED addon) with each change, and a `clock_jump` event if the wall clock moves without the boot clock.
- Talks to systemd: `READY=1`, `STOPPING=1`, and watchdog pings that stop if the check loop stops.
- Stopping the daemon leaves the hosts block in place. Removing it is a deliberate act: `hourkeepd --teardown`.

## Usage

```text
hourkeepd [--root DIR] [--dry-run] [--socket PATH] [--group NAME] [--state-dir DIR]
          [--interval-ms N] [--peercred PATH]
          [--cooldown-seconds N] [--passes-per-day N] [--pass-minutes N] [--timezone ZONE]
          [--challenge-kinds typing,arithmetic,reflection]
          [--reflection-wait-seconds N] [--min-answer-seconds N]
hourkeepd --teardown | --version | --help
```

The protection flags (`--cooldown-seconds`, `--passes-per-day`, `--pass-minutes`, `--timezone`) only seed the database the first time the daemon runs. After that the stored values win and can only be loosened through the friction flow, otherwise setting a 1 second cooldown would be an instant bypass. The Docker end-to-end test uses a short cooldown this way.

For development, run against a throwaway root so nothing real is touched:

```sh
mkdir -p /tmp/hk/etc && echo '127.0.0.1 localhost' > /tmp/hk/etc/hosts
node apps/daemon/dist/main.js --root /tmp/hk --socket /tmp/hk/hk.sock --state-dir /tmp/hk/state --group '' --peercred ''
```

## Peer credentials addon

Node has no `SO_PEERCRED` API, so a 16 KB C addon provides it (`native/peercred.c`, build with `native/build.sh OUT.node`). Packaging installs it as `/usr/lib/hourkeep/peercred.node`. See `docs/DECISIONS.md`.

## Layout

`config.ts` flags, `store.ts` SQLite and migrations, `engine.ts` state, classification and reconcile logic, `pending.ts` the cooldown and challenge state machine, `changes.ts` change types and summaries, `daemon.ts` wiring and request handler, `clock.ts` boot clock, `notify.ts` systemd, `peercred.ts` caller identity, `main.ts` entry point.
