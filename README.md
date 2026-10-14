# Hourkeep

Reclaim your hours.

Hourkeep is an open source, OS-level focus and digital-wellbeing tool, starting on Linux. A root daemon (`hourkeepd`) enforces limits on distracting sites, adds deliberate friction before anything can be unlocked (cooldowns, puzzles), and will show honest analytics about your time.

> **Status: pre-alpha (milestone M1, blocking MVP).** `hourkeep block youtube` works on Linux through the hosts file and has been tested in Docker with real systemd and real browsers. There is no installable package yet (a draft systemd unit is in `packaging/`), unblocking is instant (cooldowns and challenges are M2), and there are no schedules, limits or analytics yet.

## Why

Browser extensions fail for impulse control: you can switch browsers, open a guest window or remove the extension. Hourkeep moves enforcement into a system service so those easy escapes stop working.

## What it will and will not do

Hourkeep targets **your own impulses**, not a determined adult with root.

It aims to stop (once the relevant milestones ship):

- switching browsers, private/guest windows and removing an extension
- quickly hand-editing `/etc/hosts`, or killing the app, in a weak moment
- instantly disabling a rule (loosening goes through a cooldown and a challenge)

It does **not** and will not try to stop:

- booting a live USB, reinstalling the OS, or using root to stop or uninstall the daemon
- a VPN, a phone hotspot or another device

Limits of the current (hosts file) layer:

- No wildcards. Video bytes come from many `*.googlevideo.com` hosts that cannot be listed, so a video that was already playing when you blocked may keep going. The DNS layer (M3) fixes this.
- It only affects programs that consult `/etc/hosts`. In an automated test Firefox with DNS-over-HTTPS forced still honoured it; other browsers and versions are untested, so treat DoH as an open question (see `docs/BROWSER-CHECKLIST.md`).
- Root can still edit the file between checks; the daemon puts the block back within 5 seconds and records it.

Everything is local: no accounts, no telemetry, no network calls by default.

## Try it (development, nothing real is touched)

```sh
pnpm install && pnpm build
mkdir -p /tmp/hk/etc && echo '127.0.0.1 localhost' > /tmp/hk/etc/hosts
node apps/daemon/dist/main.js --root /tmp/hk --socket /tmp/hk/hk.sock --state-dir /tmp/hk/state --group '' --peercred '' &
export HOURKEEP_SOCKET=/tmp/hk/hk.sock
node apps/cli/dist/main.js block youtube
node apps/cli/dist/main.js status
cat /tmp/hk/etc/hosts
```

The full thing (real systemd, real `/etc/hosts`, single-file binaries) runs only in Docker: `e2e/run.sh`, and with real browsers `e2e/browsers/run.sh`.

## Layout

```text
packages/   core (rules, groups), ipc (protocol), platform (OS enforcement)
apps/       daemon (hourkeepd), cli (hourkeep), desktop, website (later)
packaging/  draft systemd unit; distro packaging later
e2e/        Docker end-to-end and browser checks
spikes/     M0 throwaway experiments, see docs/DECISIONS.md
docs/       SPEC.md, DECISIONS.md, BROWSER-CHECKLIST.md
```

## Development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Unit and integration tests run on any machine with Node 22 (the daemon tests create a throwaway root under `/tmp`). The peer-credential test compiles a small C addon and is skipped if `gcc` or the Node headers are missing.

Spike results (SQLite driver, single-binary packaging under systemd, peer credentials) are in `spikes/*/RESULTS.txt` and summarised in `docs/DECISIONS.md`. Each spike runs in Docker, for example `spikes/sea-daemon/run-test.sh`.

Tests and spikes must never touch the real `/etc/hosts`, firewall or systemd of the host. Anything that needs real system changes runs inside Docker.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
