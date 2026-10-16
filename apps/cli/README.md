# @hourkeep/cli (`hourkeep`)

A thin, unprivileged client for `hourkeepd`. It contains no enforcement logic: it sends your request to the daemon, which validates it, decides whether it tightens or loosens protection, and applies it or makes you wait.

```text
hourkeep status                              daemon state, DNS layer, pending changes, passes used today
hourkeep list                                rules with schedule, daily limit and current state
hourkeep stats [--range today|week|month|all]  blocked lookups, time under each rule, friction, streak, tamper
hourkeep block <domain|group>                e.g. hourkeep block youtube, hourkeep block reddit.com  (instant)
hourkeep unblock <domain|group>              starts a cooldown, then a challenge (see confirm)

hourkeep schedule set <target> <windows...>  e.g. hourkeep schedule set youtube "mon-fri 09:00-17:00" "sat 10:00-12:00"
hourkeep schedule clear <target>             block around the clock again (instant)
hourkeep limit set <target> <minutes>        daily limit of pass minutes; 0 means no passes at all
hourkeep limit clear <target>

hourkeep pass start <target>                 a short break: a challenge but no cooldown, limited per day
hourkeep pass end <target>                   end a pass early (instant)

hourkeep pending [list]                      changes waiting for their cooldown or challenge
hourkeep pending cancel <id>
hourkeep confirm [id] [--wait] [--answer T]  take the challenge for a pending change and apply it

hourkeep settings [get]                      cooldown, passes-per-day, pass-minutes, timezone
hourkeep settings set <key> <value>
```

**Tightening is instant, loosening waits.** Adding a rule, widening a schedule, lowering a limit, raising the cooldown or ending a pass applies at once. Anything that loosens protection (removing a rule, shrinking a schedule, raising or clearing a limit, shortening the cooldown, more or longer passes, changing the timezone) prints a pending change instead. After its cooldown (default 10 minutes) run `hourkeep confirm <id>` and answer the challenge. `confirm --wait` sleeps through the cooldown for you. Cancel any time with `hourkeep pending cancel <id>`. A request you do not confirm within 30 minutes after the cooldown expires.

**Schedule windows** read like `mon-fri 09:00-17:00`, `sat,sun 10:00-12:00`, `daily 22:00-02:00` (overnight is fine). A schedule says when the rule _blocks_; outside it the site is reachable. `--tz Area/City` picks the timezone, otherwise the daemon's setting is used.

**Challenges** are typing a long random string, five small arithmetic problems, or a short written reflection after a 30 second wait. An answer sent too quickly is held and resent for you. Three wrong answers get you a fresh challenge.

**Stats** (`hourkeep stats`, default the last 7 days) count blocked _lookups_ per rule, per blocked domain and per hour of day; one page load makes several lookups, so this is a measure of how often something tried to reach a blocked site, not of visits. It also shows the seconds each rule spent blocking, on a pass or outside its schedule, how many changes you asked for, applied, cancelled or let expire, the solve rate per challenge type, your streak of clean days and any tamper events. Blocked-lookup counts need the DNS layer (`hourkeepd --dns`); `hourkeep status` says whether it is running and, importantly, whether the system actually uses it.

Global options (before or after the subcommand):

- `--socket <path>`: daemon socket. Defaults to `$HOURKEEP_SOCKET`, then `/run/hourkeep/hourkeep.sock`.
- `--json`: print `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message" } }`. For scripts: `confirm <id> --json` prints the challenge, then `confirm <id> --answer "<text>"` submits it.

Exit codes: `0` success, `1` the daemon refused or could not be reached, `2` bad usage.

If you get "permission denied", add your user to the `hourkeep` group and log in again.

## Public API

`runCli(argv, io)` returns the exit code and takes all I/O (daemon calls, output, prompts, sleeping, the clock) through the `CliIo` interface, so tests run it without a terminal or a daemon.
