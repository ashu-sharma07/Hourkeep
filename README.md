# Hourkeep

Reclaim your hours.

Hourkeep is an open source, OS-level focus and digital-wellbeing tool, starting on Linux. A root daemon (`hourkeepd`) enforces limits on distracting sites, adds deliberate friction before anything can be unlocked (cooldowns, puzzles), and will show honest analytics about your time.

> **Status: pre-alpha (milestone M0, scaffolding and spikes).** Nothing is blocked yet. There is no installable package and no enforcement code. This repository currently contains the monorepo skeleton and the results of technical spikes.

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
- (until later milestones) browsers using DNS-over-HTTPS, or wildcard subdomains such as `*.googlevideo.com`. The first blocking layer is the hosts file, which has no wildcards and cannot see DoH.

Everything is local: no accounts, no telemetry, no network calls by default.

## Layout

```text
packages/   core (rules, friction), ipc (schemas), platform (OS enforcement)
apps/       daemon (hourkeepd), cli (hourkeep), desktop, website
packaging/  systemd unit and distro packaging (later)
spikes/     M0 throwaway experiments, see docs/DECISIONS.md
docs/       SPEC.md, DECISIONS.md
```

## Development

Requires Node.js 22+ and pnpm.

```sh
pnpm install
pnpm build
pnpm test
pnpm lint
```

Tests and spikes must never touch the real `/etc/hosts`, firewall or systemd of the host. Anything that needs real system changes runs inside Docker.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
