# @hourkeep/platform

OS enforcement behind the `PlatformEnforcer` interface. Every implementation takes a `root` directory and a `dryRun` flag so tests never touch the real system.

## Public API

- `PlatformEnforcer`: `reconcile(blocked, intent)`, `inspect()`, `teardown()`.
  - `intent: 'update'` means the desired state changed on purpose. `'verify'` is the periodic check, and any mismatch is reported as `tamper` (`modified`, `removed` or `malformed`).
- `HostsFileEnforcer` (Linux, layer 1): keeps a marked block in `<root>/etc/hosts` that maps each blocked name to `0.0.0.0` and `::`.
- `atomicWriteFile`: temp file, fsync, rename, fsync directory, preserving mode and owner. Falls back to an in-place rewrite only on `EBUSY` (Docker bind-mounted `/etc/hosts`) and reports which method it used.
- Pure helpers: `renderBlock`, `findBlock`, `applyBlock`, `parseBlockDomains`.

## Behaviour worth knowing

- Text outside the managed block is preserved byte for byte.
- A malformed block (lone marker, duplicates) is cleaned up and reported as tamper.
- A symlinked hosts file is followed, but never out of `root`.
- Not re-entrant: serialise calls (the daemon does).

## Limits

The hosts file has no wildcards and is ignored by DNS-over-HTTPS. See `docs/SPEC.md` section 7 for the later layers.

## DNS layer (M3)

- `startDnsServer({ address, port, upstreams, matcher, canary, onQuery })`: a UDP and TCP DNS server on one port. A name the `SuffixMatcher` blocks gets `NXDOMAIN` (with a 1 second SOA, so every subdomain is refused and the refusal is not cached for long); everything else is forwarded as raw bytes to the upstreams, each query from a fresh source port, with the next upstream tried on timeout and `SERVFAIL` if none answers. `onQuery` reports blocked lookups (with the matching suffix and owner), forwarded lookups (just a count, never the name), canary hits and failures. `setMatcher` swaps the rules while running, which is how schedules and passes take effect.
- `SuffixMatcher`: whole-domain blocking, longest match wins, exceptions (`allow`) let a name through unless a block of equal or greater length covers it.
- `ResolverConfigurator`: points the system at the daemon and puts it back. `systemd-resolved` gets a drop-in (`DNS=127.0.0.1`, `Domains=~.`) and a restart; a plain `/etc/resolv.conf` gets our server first with every original line kept as a fallback. The original files are saved to the backup path before the first write (contents, modes, symlinks), repair never overwrites that record, and `restore()` works from the record alone. It refuses to change anything unless a real (non-loopback) upstream exists.
- `parseNameservers`, `CANARY_DOMAIN`, `systemRunner`.
