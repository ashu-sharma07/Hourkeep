# End-to-end image: real systemd, the real single-executable binaries, a real /etc/hosts.
# Build context is the repository root:  docker build -f e2e/Dockerfile .

# ---- build ----
FROM node:22-bookworm AS build
RUN npm install -g pnpm@12.11.2 --no-audit --no-fund
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
RUN npm install --no-audit --no-fund --prefix /opt/tools esbuild@0.28.2 postject@1.0.0-alpha.6
RUN e2e/build-binaries.sh /src /opt/tools /out

# ---- runtime: clean Ubuntu with systemd and NO node ----
FROM ubuntu:24.04
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus iproute2 util-linux procps libc-bin \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system hourkeep \
 && useradd -m -G hourkeep member \
 && useradd -m outsider
COPY --from=build /out/hourkeepd /out/hourkeep /usr/bin/
COPY --from=build /out/peercred.node /usr/lib/hourkeep/peercred.node
COPY packaging/systemd/hourkeepd.service /etc/systemd/system/hourkeepd.service
# Test-only timing, as a drop-in over the real unit: a 3 second cooldown, 1 minute passes and short
# challenge waits, so the friction flow can be exercised in seconds. All of these only seed the
# database on first run (see docs/DECISIONS.md); the unit itself is tested unmodified otherwise.
RUN mkdir -p /etc/systemd/system/hourkeepd.service.d \
 && printf '[Service]\nExecStart=\nExecStart=/usr/bin/hourkeepd --cooldown-seconds 3 --pass-minutes 1 --challenge-kinds typing,arithmetic,reflection --reflection-wait-seconds 2 --min-answer-seconds 1\n' \
      > /etc/systemd/system/hourkeepd.service.d/e2e.conf
RUN systemctl enable hourkeepd.service \
 && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount getty.target console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
