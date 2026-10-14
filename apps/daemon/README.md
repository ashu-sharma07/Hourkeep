# @hourkeep/daemon (`hourkeepd`)

The product. A root service that owns the rules, keeps the hosts file in line with them and serves a Unix socket. Clients (CLI, later the desktop app) only send requests.

## What it does (M1)

- Stores rules and an event log in SQLite (`node:sqlite`, versioned migrations that can be rolled back in tests).
- Serves the `@hourkeep/ipc` protocol on `/run/hourkeep/hourkeep.sock`, mode `0660`, group `hourkeep`. If the group does not exist the socket falls back to root-only (`0600`) and an error is logged.
- Applies rules to `/etc/hosts` through `@hourkeep/platform` immediately on `block`/`unblock`.
- Re-checks every `--interval-ms` (default 5 s). Any difference in the managed block is reverted and a `tamper` event is stored.
- Records the caller's UID (via the SO_PEERCRED addon) with each rule change. Without the addon the UID is logged as unknown.
- Talks to systemd: `READY=1`, `STOPPING=1`, and watchdog pings that stop if the check loop stops.
- Stopping the daemon leaves the hosts block in place. Removing it is a deliberate act: `hourkeepd --teardown`.

`unblock` is instant in M1. Cooldowns and challenges arrive in M2.

## Usage

```text
hourkeepd [--root DIR] [--dry-run] [--socket PATH] [--group NAME] [--state-dir DIR]
          [--interval-ms N] [--peercred PATH]
hourkeepd --teardown | --version | --help
```

For development, run against a throwaway root so nothing real is touched:

```sh
mkdir -p /tmp/hk/etc && echo '127.0.0.1 localhost' > /tmp/hk/etc/hosts
node apps/daemon/dist/main.js --root /tmp/hk --socket /tmp/hk/hk.sock --state-dir /tmp/hk/state --group '' --peercred ''
```

## Peer credentials addon

Node has no `SO_PEERCRED` API, so a 16 KB C addon provides it (`native/peercred.c`, build with `native/build.sh OUT.node`). Packaging installs it as `/usr/lib/hourkeep/peercred.node`. See `docs/DECISIONS.md`.

## Layout

`config.ts` flags, `store.ts` SQLite and migrations, `engine.ts` rules and reconcile logic, `daemon.ts` wiring and request handler, `notify.ts` systemd, `peercred.ts` caller identity, `main.ts` entry point.
