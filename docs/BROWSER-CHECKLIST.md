# Browser bypass checklist

Re-run this at every enforcement layer (hosts file now, DNS resolver, nftables, browser policies later). Record the date, Hourkeep version, distro and browser versions, and what bypasses remain.

`e2e/browsers/run.sh` automates the "does the block hold" part for Playwright's Chromium and Firefox inside Docker. This checklist covers what automation cannot: a real desktop session, the browsers people actually use, and the settings people change.

## Setup (a throwaway VM, never your daily machine while testing tampering)

1. Install `hourkeepd` and `hourkeep`, create the `hourkeep` group, add your user, log in again.
2. `systemctl status hourkeepd` shows active. `hourkeep status` works without sudo.
3. Install the browsers under test. Include at least two engines, and one packaged as Snap or Flatpak if your distro ships it that way.

## Baseline (before blocking)

For each browser, normal window: `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be/<id>` load and play a video. Note any consent page.

## Blocking matrix

Run `hourkeep block youtube`, then for every row confirm all four URLs fail to load (connection refused or similar), and that an unrelated site still loads.

| Browser                       | Normal | Private / incognito | Guest | Second profile | Result / notes |
| ----------------------------- | ------ | ------------------- | ----- | -------------- | -------------- |
| Chrome                        |        |                     |       |                |                |
| Chromium                      |        |                     |       |                |                |
| Firefox                       |        |                     |       |                |                |
| Brave / Edge (other Chromium) |        |                     |       |                |                |
| Snap/Flatpak browser          |        |                     |       |                |                |

Also check:

- [ ] A YouTube embed on a third-party page (for example a blog with an embedded video) fails to play.
- [ ] A tab that already had a video open before the block: note whether playback continues. Video bytes come from `*.googlevideo.com` hosts that cannot be listed in a hosts file, so already-open playback may continue until the DNS layer (M3). Record what you see.
- [ ] A cached page, a service worker or an installed PWA for YouTube: note behaviour.
- [ ] The YouTube mobile app on the same machine (Android emulator) is out of scope; just note it.

## Resolver and DNS settings people change

- [ ] Chrome: Settings, Privacy and security, Security, "Use secure DNS" on with a public provider. Reload YouTube. Record whether it loads.
- [ ] Firefox: Settings, Privacy and security, DNS over HTTPS set to "Max Protection". Reload YouTube. Record whether it loads. (Automated probe so far: Firefox with DoH confirmed active still honoured the hosts file, both with default prefs and with `network.trr.exclude-etc-hosts=false`. Chrome has not been tested.)
- [ ] Change the system DNS server to 1.1.1.1 or 8.8.8.8. The hosts file takes priority, so YouTube should stay blocked.
- [ ] Use a VPN or a phone hotspot. Expected: not stopped. Out of scope.

## Tamper checks

- [ ] `sudo nano /etc/hosts`, delete the Hourkeep block, save. Within 5 seconds the block returns. `hourkeep status` shows a tamper event.
- [ ] Delete only the `youtube.com` lines. Restored within 5 seconds.
- [ ] `sudo systemctl stop hourkeepd`: the block stays in place (documented behaviour). `sudo systemctl start hourkeepd` resumes checking.
- [ ] `sudo kill -9 $(pidof hourkeepd)`: systemd restarts it within about 2 seconds.
- [ ] Reboot: the block is present before you can open a browser.

## Cleanup

- [ ] `hourkeep unblock youtube`, then confirm YouTube loads again and `/etc/hosts` has no Hourkeep lines.
- [ ] Uninstall: `sudo hourkeepd --teardown` first if the package script has not done so, then remove the package. Confirm nothing is left in `/etc/hosts`.

## Known bypasses of the hosts layer (keep this list honest)

- Wildcard subdomains such as `*.googlevideo.com`: not blockable by a hosts file.
- Direct IP addresses, VPNs, proxies, a second device.
- Anything that does not use the system resolver and does not consult `/etc/hosts`. Firefox with DoH forced still did in our automated probe. Other browsers and versions might not; record what you find.
- Root: anyone with root can stop the daemon or edit the file faster than the reconcile interval.
