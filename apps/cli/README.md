# @hourkeep/cli (`hourkeep`)

A thin, unprivileged client for `hourkeepd`. It contains no enforcement logic: it sends the target string to the daemon, which decides whether it is a group or a domain, validates it and applies it.

```text
hourkeep status                 daemon state, rule and tamper counts, who you are
hourkeep list                   rules and available groups
hourkeep block <domain|group>   e.g. hourkeep block youtube, hourkeep block reddit.com
hourkeep unblock <domain|group> instant in M1; cooldown and challenge arrive in M2
```

Options (before or after the subcommand):

- `--socket <path>`: daemon socket. Defaults to `$HOURKEEP_SOCKET`, then `/run/hourkeep/hourkeep.sock`.
- `--json`: print `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code", "message" } }`.

Exit codes: `0` success, `1` the daemon refused or could not be reached, `2` bad usage.

If you get "permission denied", add your user to the `hourkeep` group and log in again.

## Public API

`runCli(argv, io)` returns the exit code and takes all I/O through the `CliIo` interface, so tests can run it without a terminal or a daemon.
