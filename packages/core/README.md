# @hourkeep/core

Rules, groups, schedules, the friction state machine and challenges. Zero OS-specific code and no runtime dependencies. Everything that depends on time or randomness takes it as an argument, so it is tested with fake clocks and seeded generators.

## Public API

**Rules and groups**

- `normalizeDomain(input)`: strict hostname validation. The result is written into `/etc/hosts`, so whitespace, wildcards, URLs, IP addresses and non-ASCII are rejected.
- `BUILTIN_GROUPS`, `parseGroupData(raw)`: built-in groups, loaded from `src/data/groups.json` (versioned, validated at load).
- `parseTarget(input, groups)`: `youtube` becomes a group rule, `example.com` a domain rule.
- `resolveRules(rules, groups)`: sorted, de-duplicated hostnames to block. A plain domain also blocks `www.` + domain.
- `Result<T>`, `ok`, `err`.

**Schedules** (`schedule.ts`)

- `parseScheduleSpec(["mon-fri 09:00-17:00", "sat 10:00-12:00"], "Asia/Kolkata")`: builds a `WeeklySchedule` (per-weekday minute windows plus an IANA timezone). Overnight windows continue into the next day.
- `isActive(schedule | null, instant)`: is the rule blocking at this instant? Evaluated in the schedule's timezone with `Intl`, so daylight saving never needs special cases (including the skipped and repeated hours). `null` means always.
- `loosensSchedule(from, to)`: exact per-minute comparison. True if any minute that was blocking no longer is, or the timezone changed (unless both always block).
- `describeSchedule`, `scheduleEquals`, `isAlwaysOn`, `dateKey(instant, tz)` (local date for "per day" counting).

**Friction** (`friction.ts`)

- `planTimes(now, cooldownMs)` and `phaseOf(times, now)`: `cooldown`, then `ready`, then `expired` 30 minutes after the cooldown ends.
- `compareLimit`, `compareSettings`, `parseSetting`: which direction a change moves, so the daemon knows whether it is instant or must wait. Defaults: 10 minute cooldown, 3 passes of 15 minutes per day.
- `decidePass({...})`: may a pass start, and for how long? Counts passes per local day across all rules and trims the grant to what is left of the rule's daily limit in pass minutes.

**Challenges** (`challenge.ts`)

- `issueChallenge(kinds, { rng, now, subject })` returns the public challenge (shown to the user) and the secret (kept by the daemon). Kinds: `typing` (retype a 41 character random string), `arithmetic` (five small problems), `reflection` (wait, then explain why in your own words).
- `checkAnswer(issued, response, now)`: `correct`, `wrong` with a hint, or `too_early` (not counted as an attempt).
- `seededRng(seed)` for tests, `secureRng()` for production.

## Updating group data

Edit `src/data/groups.json`, bump `dataVersion`, and re-verify each hostname resolves (`getent hosts <name>`). Record anything deliberately excluded in the group's `notes`. Tests refuse malformed or unnormalised data.
