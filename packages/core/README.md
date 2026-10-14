# @hourkeep/core

Rules, groups and (from M2) schedules, the friction state machine and analytics math. Zero OS-specific code and no runtime dependencies.

## Public API

- `normalizeDomain(input)`: strict hostname validation and normalisation. The result is written into `/etc/hosts`, so whitespace, wildcards, URLs, IP addresses and non-ASCII are rejected.
- `BUILTIN_GROUPS`, `parseGroupData(raw)`: built-in groups, loaded from `src/data/groups.json` (versioned, validated at load).
- `parseTarget(input, groups)`: `youtube` becomes a group rule, `example.com` a domain rule.
- `resolveRules(rules, groups)`: sorted, de-duplicated hostnames to block. A plain domain also blocks `www.` + domain.
- `Result<T>`, `ok`, `err`.

## Updating group data

Edit `src/data/groups.json`, bump `dataVersion`, and re-verify each hostname resolves (`getent hosts <name>`). Record anything deliberately excluded in the group's `notes`. Tests refuse malformed or unnormalised data.
