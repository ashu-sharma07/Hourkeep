# Real browsers (Playwright's Chromium and Firefox) on Debian bookworm with systemd and the
# real hourkeepd. Needs the hk-e2e image first (e2e/browsers/run.sh builds it):
#   it supplies the single-executable binaries and the peercred addon.
FROM node:22-bookworm AS node

FROM debian:bookworm
ENV container=docker DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus iproute2 util-linux procps ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system hourkeep \
 && useradd -m -G hourkeep member
# The browser test tooling is isolated from the monorepo and pinned.
COPY e2e/browsers/package.json /opt/browsers/package.json
RUN cd /opt/browsers && npm install --no-audit --no-fund \
 && ./node_modules/.bin/playwright install --with-deps chromium firefox \
 && chmod -R a+rX /opt/pw-browsers /opt/browsers
COPY e2e/browsers/check.mjs /opt/browsers/check.mjs
COPY --from=hk-e2e /usr/bin/hourkeepd /usr/bin/hourkeep /usr/bin/
COPY --from=hk-e2e /usr/lib/hourkeep/peercred.node /usr/lib/hourkeep/peercred.node
COPY packaging/systemd/hourkeepd.service /etc/systemd/system/hourkeepd.service
RUN systemctl enable hourkeepd.service \
 && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount getty.target console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
