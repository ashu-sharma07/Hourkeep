# Decisions

Short dated entries. Newest at the bottom. Evidence for spike decisions lives in `spikes/*/RESULTS.txt`.

## 2026-10-14: License is GPL-3.0-or-later

Chosen by the owner. Keeps forks open.

## 2026-10-14: Planning pack is not committed

`Hourkeep Agent Kickoff Pack.md` is git-ignored. `docs/SPEC.md` is the canonical spec.

## 2026-10-14: pnpm installed user-level via npm

`npm i -g pnpm` under the nvm-managed Node (pnpm 12.11.2, pinned in `packageManager`). No system-wide changes.

## 2026-10-14: TypeScript pinned to 6.0.3, not 7.x

`typescript-eslint` 8.71.2 declares `typescript >=4.8.4 <6.1.0`. Revisit when it supports TS 7. Other tooling is pinned to exact versions: turbo 2.11.8, eslint 10.12.0, prettier 3.9.10, vitest 5.0.4. `@types/node` is pinned to 22.x to match the runtime.

## 2026-10-14: Monorepo conventions

- ESM everywhere, `module: NodeNext`, strict TS plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Each package has `tsconfig.json` (typecheck, includes tests) and `tsconfig.build.json` (emit, excludes tests).
- `apps/desktop` and `apps/website` are README-only until M4/M5 so we do not pull in Electron or Astro early.
- No runtime dependencies yet (Zod arrives with the first real IPC schema in M1).
- `spikes/` is outside the pnpm workspace, ignored by ESLint, still formatted by Prettier.
- CI uses path filters for the build/test job. A separate Prettier job always runs so docs-only changes are still checked. CI has not run on GitHub yet because nothing has been pushed. Locally, a fresh clone passes `pnpm install --frozen-lockfile && pnpm lint && pnpm build && pnpm test`.

## 2026-10-14: SQLite driver is `node:sqlite` (spike 1)

Both drivers passed the same checks (WAL, foreign keys, STRICT tables, `user_version` for migrations, JSON functions, rollback, 10k inserts in about 10 ms). The difference is packaging:

- `node:sqlite` works inside a Node SEA binary with no extra files.
- `better-sqlite3` 13.0.3 needs its 2.2 MB `.node` file shipped beside the binary, loaded with `process.dlopen` and passed as the `nativeBinding` object, because a SEA `require` only resolves built-ins.

Known costs of `node:sqlite`:

- It is still marked experimental. API changes between Node majors are possible, so we pin the Node version used to build the SEA.
- It prints `ExperimentalWarning`. A SEA `execArgv: ["--disable-warning=ExperimentalWarning"]` silences it (verified in spike 2).
- Integers above 2^53 throw instead of losing precision. That is safer. Store timestamps as epoch milliseconds.

Fallback: `better-sqlite3` behind the same small storage interface if `node:sqlite` regresses. Keep SQL behind that interface.

## 2026-10-14: Single executable is Node SEA (spike 2)

A stripped SEA binary (103 MB, because it embeds Node) runs on a clean `ubuntu:24.04` with no Node installed, under systemd. Verified in Docker (14/14 checks):

- `Type=notify`, `Restart=always` (recovers from `SIGKILL`), SQLite state survives restarts.
- The watchdog restarts a process whose event loop is blocked.
- Socket is `0660 root:hourkeep`. A non-member gets `EACCES`.
- An atomic write (temp file, fsync, rename) into `/etc` works under `ProtectSystem=strict` with `ReadWritePaths=/etc`.

`bun build --compile` was not tried since SEA works. Size is the main downside. Mitigation later: strip the binary (done here, 125 MB to 103 MB) and compress in the package.

Notes for M1/M5:

- Node cannot send datagrams to `NOTIFY_SOCKET`, so the daemon shells out to `systemd-notify` for READY and WATCHDOG. This requires `NotifyAccess=all` in the unit.
- `postject` prints `.note` section warnings. They are harmless.
- The spike unit scores 7.7 EXPOSED in `systemd-analyze security`. M1/M5 should tighten it (capability bounding set, `SystemCallFilter`, `ProtectKernel*`) without breaking enforcement.

## 2026-10-14: How to run systemd inside Docker for tests

`--privileged` works but grants far more than needed. This narrower recipe also works:

```text
--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cap-add SYS_ADMIN \
--security-opt apparmor=unconfined --tmpfs /run --tmpfs /run/lock --tmpfs /tmp
```

`--cgroupns=private` without `--privileged` made the container exit with 255 and no logs. The recipe gives the container write access to the host cgroup tree, so it is for local dev and CI only. It never touches the host's `/etc` or systemd.

## 2026-10-14: Docker's `/etc/hosts` is a bind mount

Docker bind-mounts `/etc/hosts` into containers, so `rename()` onto it fails with `EBUSY`. M1 end-to-end tests must account for this (for example, run the platform layer against a root directory inside the container, or add an in-place write fallback used only when rename fails). The production path stays temp file, fsync, rename. A real install on a normal host is not affected.

## 2026-10-14: Peer credentials come from a tiny N-API addon (spike 3)

Node has no API for `SO_PEERCRED`. Compared:

- A small (about 45-line) C N-API addon (16 KB, libc only), loaded with `process.dlopen` as a sidecar file. It works in plain Node and in a SEA. It returns the right pid/uid/gid in about 6 µs, and still works when the client exits before the daemon looks.
- Parsing `ss -xapne`: about 2 ms and a process spawn per connection, needs `iproute2`, and returned no uid and often no pid in my attempt. Rejected.

Decision: ship `peercred.node` next to the daemon (for example `/usr/lib/hourkeep/peercred.node`) and build it per architecture in CI with `gcc`. The addon needs the file descriptor of the accepted socket. `conn._handle.fd` provides it, but it is undocumented, so M1 needs a test that fails loudly if it disappears. If the addon fails to load, the daemon logs the caller UID as unknown and keeps working, because group membership on the socket remains the primary access gate.

## 2026-10-14: Defaults for the remaining open decisions

Confirmed by the owner on 2026-10-14:

- CLI library: `commander`. Mature and typed. `citty` was the alternative. Not installed yet.
- Default cooldown: 10 minutes (configurable up to hours).
- Temporary passes: 3 per day, 15 minutes each.
- Packaging targets: Debian/Ubuntu (`.deb`) first, then Arch (AUR), then `.rpm`.

## 2026-10-14: M0 accepted

CI (`build-test` and `docs-lint`) passed on GitHub for the M0 commits on `main`.
