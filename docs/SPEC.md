### 1. Vision

Hourkeep helps people take back their time from distracting sites and apps. Unlike browser extensions, it runs at the operating system level, so it cannot be bypassed by switching browsers, using private windows or uninstalling an extension. It combines enforcement, deliberate friction before unlocking, and honest analytics.

Name: **Hourkeep**. Domain: `hourkeep.dev`. GitHub org: `hourkeep`. CLI command: `hourkeep`. Daemon: `hourkeepd`.

### 2. Principles

1. **The daemon is the product.** Enforcement lives in a root service. Clients only send requests.
2. **Friction, not imprisonment.** The goal is to defeat impulse, not a determined adult with root. Disabling Hourkeep should be possible but slow and deliberate.
3. **Local-first and private.** No accounts, no telemetry, no network calls by default. All data stays on the machine.
4. **Least privilege.** Only the daemon runs as root. The CLI and GUI are unprivileged.
5. **Honest about limits.** Document what Hourkeep can and cannot stop.
6. **Small and shippable.** Each milestone must produce something usable.

### 3. Threat model

**In scope (what we defend against):** the user's own impulses. Switching browsers, guest or incognito mode, removing an extension, editing `/etc/hosts` by hand in a hurry, killing the app process, quickly disabling a rule, changing the schedule at midnight.

**Out of scope:** a user who deliberately boots a live USB, uses a VPN or phone hotspot, or reinstalls the OS. We cannot and will not try to stop this. We document it.

**Design consequence:** rule changes that weaken protection go through a delay (cooldown) and a friction challenge. Changes that strengthen protection are instant.

### 4. Architecture

```text
  hourkeep (CLI)      Desktop app (Electron + React)
        \                 /
         \               /      unprivileged clients
          Unix socket / IPC
                 |
          hourkeepd (root, systemd service)
           - rule engine + scheduler
           - enforcement via platform layer
           - friction state machine (cooldowns, puzzles)
           - analytics collector
           - SQLite store
                 |
          platform/linux: hosts, nftables, DNS resolver, browser policies
```

**IPC:** a Unix domain socket at `/run/hourkeep/hourkeep.sock`, owned by `root:hourkeep`, mode `0660`. The daemon identifies callers by peer credentials (SO\_PEERCRED) and logs which user made each request. Messages are JSON, validated by shared Zod schemas, with a protocol version field.

**Daemon lifecycle:** a systemd unit with `Restart=always`, a watchdog, and a reconcile loop that re-applies the desired state every few seconds. If someone edits the managed section of `/etc/hosts`, the daemon restores it and records a tamper event.

### 5. Tech stack

| Area | Choice |
| --- | --- |
| Language | TypeScript (strict) everywhere |
| Monorepo | pnpm workspaces + Turborepo |
| Runtime | Node.js current LTS |
| Validation | Zod |
| Storage | SQLite. Evaluate built-in `node:sqlite` first to avoid native modules, and fall back to `better-sqlite3` only if needed. Decide in M0. |
| CLI | `commander` or `citty` |
| Desktop | Electron + React + Vite |
| Charts | A small library such as Recharts or uPlot |
| Website | Astro (static) |
| Tests | Vitest; Docker for integration tests |
| Lint/format | ESLint + Prettier |
| CI | GitHub Actions with path filters |
| Packaging | Single executable (Node SEA or `bun build --compile`), then `.deb` and AUR first |

### 6. Monorepo layout

```text
hourkeep/
  packages/
    core/        rules, schedules, friction state machine, puzzle logic, analytics math
    ipc/         Zod schemas, protocol types, socket client and server helpers
    platform/    OS enforcement behind an interface (linux now; macos, windows later)
  apps/
    daemon/      hourkeepd
    cli/         hourkeep
    desktop/     Electron app
    website/     Astro site and docs
  packaging/     systemd unit, deb, AUR PKGBUILD, install scripts
  docs/          SPEC.md, DECISIONS.md, ARCHITECTURE.md
  .github/workflows/
```

`core` and `ipc` must have zero OS-specific code. All OS behavior sits behind a `PlatformEnforcer` interface in `packages/platform`, with a `dryRun` option and a configurable root directory so tests never touch the real system.

### 7. Blocking strategy (layered)

Build the layers in order. Each is more robust and more complex.

**Layer 1: hosts file (M1).** Maintain a clearly marked managed block in `/etc/hosts` mapping blocked domains to `0.0.0.0` and `::`. The daemon owns that block, rewrites it atomically, and restores it if changed.

Starting YouTube domain set (the agent must verify and expand this list, and keep it in a versioned data file, not hard-coded): `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`, `youtube-nocookie.com`, `youtubei.googleapis.com`, `ytimg.com`, `i.ytimg.com`, `googlevideo.com`. Note that hosts files do not support wildcards, so subdomains such as `*.googlevideo.com` need Layer 2 or Layer 3.

**Layer 2: local DNS resolver (M3 or later).** Run a small local resolver on 127.0.0.1 that answers blocked names with NXDOMAIN or a sink address, supports wildcards and logs query counts for analytics. Point the system resolver at it (systemd-resolved or NetworkManager config), and restore settings on uninstall.

**Layer 3: nftables (later).** Block resolved IP sets and DNS-over-HTTPS endpoints so browsers cannot route around the resolver. Handle QUIC (UDP 443) explicitly.

**Layer 4: browser policies (later).** Write managed policy files to disable DNS-over-HTTPS in Chrome/Chromium (`/etc/opt/chrome/policies/managed/`, `/etc/chromium/policies/managed/`) and Firefox (`/etc/firefox/policies/policies.json`), since DoH can bypass the system resolver.

At each layer, the agent must test with real browsers in a VM (Chrome, Firefox, a guest or private window) and document exactly what bypasses remain.

### 8. Friction and unlock mechanisms

Friction is a core feature. The state machine lives in `packages/core` and is enforced by the daemon.

- **Instant tightening:** adding a block, extending a schedule or lowering a limit takes effect immediately.
- **Delayed loosening:** removing a block, shortening a schedule or raising a limit starts a **cooldown** (default 10 minutes, configurable up to hours). The request is cancelable during cooldown.
- **Challenge to unlock:** after the cooldown, the user must complete a challenge. Initial challenge types: a typing challenge (retype a long random string), arithmetic or logic puzzles, and a wait-and-confirm screen with a reflection prompt (why do you want this?). Challenges are pluggable and live in `core`.
- **Temporary pass:** a time-boxed pass (for example 15 minutes) that auto-reverts. Limit the number of passes per day.
- **Lock mode (optional):** a commitment mode where loosening is disabled until a chosen date.
- **Everything is logged:** each unlock attempt, cooldown, cancel and tamper event is recorded for analytics.

### 9. Analytics

Only record what the daemon can observe reliably and honestly.

- Blocked attempts per domain and per hour (from the DNS layer, or approximated earlier).
- Time spent in each state (blocked, in a temporary pass, in cooldown).
- Unlock attempts, cancellations and success rate by challenge type.
- Streaks: days within limits.
- Tamper events.

Do not attempt keylogging, screen capture or window-title tracking in the first versions. Active-window tracking on Wayland is unreliable, and it would hurt trust. If added later it must be opt-in and clearly explained.

Storage: SQLite with migrations. Expose analytics to clients through IPC queries (aggregated), never direct database access.

### 10. Data model (initial sketch)

- `rules`: id, kind (domain, group), target, schedule, daily\_limit, created\_at, updated\_at
- `groups`: id, name, domains (for example the YouTube group)
- `schedules`: id, rrule or weekly grid, timezone
- `pending_changes`: id, change payload, requested\_by\_uid, cooldown\_ends\_at, status
- `passes`: id, rule\_id, starts\_at, ends\_at
- `events`: id, ts, type, payload (block attempt, unlock, tamper, and so on)
- `meta`: schema version, protocol version

The agent may refine this, but must keep migrations versioned and reversible where practical.

### 11. Security requirements

- Only `hourkeepd` runs as root. Apply systemd hardening where it does not break enforcement (`NoNewPrivileges`, `ProtectSystem` with explicit write paths, `PrivateTmp`).
- Validate every IPC message. Reject unknown fields and enforce size limits.
- Authorization: any local user in the `hourkeep` group may request changes, but loosening always goes through the friction flow. Record the caller's UID.
- Write system files atomically (write temp file, fsync, rename), and preserve permissions.
- Uninstall must cleanly remove everything it changed (hosts block, DNS settings, policies). Test it.
- No network access by the daemon unless explicitly enabled for a future feature.

### 12. Packaging and distribution

- Users must not need Node installed. Produce a single executable for the daemon and CLI.
- Run a packaging spike in M0: build a minimal daemon plus SQLite into a single binary and run it under systemd in a clean VM. Fail early if native modules block this.
- Targets in order: `.deb`, AUR PKGBUILD, then `.rpm`. No Flatpak or Snap for the daemon, because sandboxing conflicts with OS-level enforcement. The desktop GUI may be packaged separately later.
- Provide a systemd unit and a `postinst` script that creates the `hourkeep` group.

### 13. Milestones and acceptance criteria

**M0: Scaffold and spikes**

- pnpm + Turborepo monorepo with the layout above, strict TypeScript, ESLint, Prettier, Vitest and CI (path-filtered).
- Placeholder packages build and test green.
- Spike 1: SQLite choice (`node:sqlite` vs `better-sqlite3`), recorded in `DECISIONS.md`.
- Spike 2: single-executable packaging works for a hello-world daemon under systemd in a VM or container.
- README with project purpose and honest limitations. LICENSE chosen by the owner.
- Acceptance: `pnpm build && pnpm test` passes in CI from a clean checkout; spike results documented.

**M1: Blocking MVP**

- `PlatformEnforcer` interface and Linux hosts-file implementation with dry-run and custom root.
- `hourkeepd` serves the Unix socket, applies rules, runs the reconcile loop and restores tampered hosts blocks.
- CLI: `hourkeep status`, `hourkeep block <domain|group>`, `hourkeep unblock <domain|group>` (unblock is instant for now), `hourkeep list`.
- Built-in YouTube group.
- Acceptance: in a VM, `hourkeep block youtube` makes youtube.com unreachable in Chrome and Firefox including private windows; hand-editing the hosts block is reverted within the reconcile interval; unit and integration tests pass.

**M2: Schedules and friction**

- Schedules (weekly grid), daily limits, cooldown and challenge state machine, temporary passes.
- CLI flows for cooldown status, challenges and passes.
- Acceptance: loosening a rule requires cooldown plus challenge, tightening is instant, state survives a daemon restart, and all of it is covered by tests.

**M3: Analytics and DNS layer**

- Local DNS resolver with wildcard blocking and query logging.
- Analytics queries over IPC and `hourkeep stats` in the CLI.
- Acceptance: blocked-attempt counts match test traffic; wildcard subdomains are blocked; uninstall restores DNS settings.

**M4: Desktop app**

- Electron + React app as an IPC client: status, rules, schedules, challenges and analytics charts, plus a tray icon.
- Acceptance: all actions available in the CLI work in the app, with no enforcement logic in the renderer.

**M5: Packaging, website and first release**

- `.deb` and AUR packages, install and uninstall docs, Astro website on `hourkeep.dev`, `v0.1.0` tag and changelog.
- Acceptance: a fresh VM can install from the package, block YouTube and uninstall cleanly.

**M6 and later:** nftables and DoH hardening, browser policies, more challenge types, cross-platform platform layers (macOS, Windows), optional phone companion.

### 14. Testing strategy

- Unit tests for `core` (state machine, schedules, challenge generation) with fake clocks.
- Contract tests for `ipc` schemas.
- Integration tests for the daemon with a temp root directory and the dry-run enforcer.
- End-to-end tests in a Docker or VM image with real hosts-file changes.
- A manual browser bypass checklist (Chrome, Firefox, private windows, a second browser) that is re-run at each enforcement layer.

### 15. Conventions

- Conventional Commits. Small pull requests, each tied to a milestone.
- Every package has its own README with purpose and public API.
- Architectural decisions go in `docs/DECISIONS.md` as short dated entries.
- Public APIs are documented with TSDoc. No `any` without a comment explaining why.
- Never commit secrets. There should not be any.

### 16. Out of scope for now

Accounts or cloud sync, telemetry, keylogging, screen recording, browser extensions, mobile enforcement, and anything that tries to defeat a determined user with physical or root access.

### 17. Open decisions (agent proposes, owner approves)

1. **License.** Owner decision. Options: GPL-3.0-or-later or AGPL-3.0 (keeps forks open) versus MIT or Apache-2.0 (maximum adoption).
2. **SQLite driver.** `node:sqlite` versus `better-sqlite3`, decided by the M0 spike.
3. **Single-executable tool.** Node SEA versus `bun build --compile`, decided by the M0 spike.
4. **CLI library.** `commander` versus `citty`.
5. **Default cooldown length** and the default number of temporary passes per day.
6. **Which Linux distributions to target first** for packaging (suggested: Debian/Ubuntu and Arch).

### 18. Definition of done (any milestone)

- Acceptance criteria are met and demonstrated with test output or a command transcript.
- CI is green and docs are updated.
- No code path touches the real host system in tests.
- Decisions and known limitations are recorded.
