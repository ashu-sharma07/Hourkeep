# Browser bypass check

Real browsers against a hosts block set by the real daemon, inside Docker.

```sh
e2e/browsers/run.sh    # first run downloads Chromium and Firefox (a few minutes)
```

It builds `hk-e2e` (for the binaries), then a Debian 12 image with systemd, `hourkeepd` and Playwright's Chromium and Firefox, and runs four phases:

1. baseline: nothing blocked, every window must reach YouTube (proves the browsers and network work);
2. `hourkeep block youtube`: every window must fail to reach `www`, `m`, `music` and `youtu.be`, while `example.org` still loads;
3. a DNS-over-HTTPS probe (informational): Firefox forced onto DoH, with a self-check that DoH is really active;
4. `hourkeep unblock youtube`: every window reaches YouTube again.

Windows covered: Chromium normal, `--incognito` and `--guest`; Firefox normal and private (`browser.privatebrowsing.autostart`). Last results: `RESULTS.txt`.

What this does not show: a real desktop session, Chrome (branded), Safari or Edge, Snap/Flatpak packaging, or playback in a tab opened before the block. Use `docs/BROWSER-CHECKLIST.md` on a real VM for those.

Needs network access to reach YouTube. If your network blocks it, phases 1 and 4 fail and that is reported, not hidden.
