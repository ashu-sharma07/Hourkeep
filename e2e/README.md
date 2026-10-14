# End-to-end test

Runs the real single-executable `hourkeepd` and `hourkeep` under real systemd, editing a real `/etc/hosts`, all inside a throwaway Docker container. It never touches the host's hosts file, firewall or systemd.

```sh
e2e/run.sh        # builds the image (about a minute), runs 44 checks, removes the container
```

What it proves (see `RESULTS.txt` for the last run):

- the binaries run on a clean Ubuntu 24.04 with no Node installed, and the unit reaches `READY` as `Type=notify`;
- the socket is `0660 root:hourkeep`; a group member can use the CLI and the daemon sees the caller's real uid (SO_PEERCRED); an outsider is refused;
- `hourkeep block youtube` makes `getent` resolve YouTube names to `0.0.0.0`, keeps the original hosts lines intact, and preserves edits outside the block;
- five kinds of hand edit to the block (delete, delete one line, rewrite an address, remove the end marker, comment out) are each reverted within the 5 s reconcile interval, plus a whole-file overwrite;
- rules survive `systemctl restart` and `kill -9`; stopping the daemon leaves the block; start re-applies it without counting tampering;
- `unblock` restores the original file byte for byte; `hourkeepd --teardown` removes the block;
- the hardened unit (`systemd-analyze security` 3.9) still works.

Docker specifics: `/etc/hosts` is a bind mount there, so `rename()` onto it fails with `EBUSY` and the daemon uses its in-place fallback (the test asserts that from the journal). On a normal host the atomic rename path is used instead; that path is covered by the unit tests in `packages/platform`.

The browser check is separate: see `e2e/browsers/`.

`build-binaries.sh` bundles the built apps with esbuild and injects them into a stripped Node binary with postject (tool versions pinned in `package.json`, installed inside the image).
