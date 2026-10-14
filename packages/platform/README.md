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
