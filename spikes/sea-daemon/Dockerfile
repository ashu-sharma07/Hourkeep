# ---- build the single executable ----
FROM node:22-bookworm AS build
WORKDIR /build
RUN npm install --no-audit --no-fund --prefix /opt/tools postject@1.0.0-alpha.6
COPY daemon.cjs sea-config.json ./
RUN node --experimental-sea-config sea-config.json \
 && strip -o hourkeepd "$(command -v node)" \
 && /opt/tools/node_modules/.bin/postject hourkeepd NODE_SEA_BLOB daemon.blob \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 >/dev/null 2>&1 \
 && chmod 755 hourkeepd && ls -lh hourkeepd

# ---- clean systemd image with NO node installed ----
FROM ubuntu:24.04
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus iproute2 util-linux procps \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system hourkeep \
 && useradd -m -G hourkeep member \
 && useradd -m outsider
COPY --from=build /build/hourkeepd /usr/local/bin/hourkeepd
COPY hourkeepd.service /etc/systemd/system/hourkeepd.service
RUN systemctl enable hourkeepd.service \
 && systemctl mask systemd-udevd.service systemd-udevd-kernel.socket systemd-udevd-control.socket \
      systemd-modules-load.service sys-kernel-debug.mount sys-kernel-tracing.mount getty.target console-getty.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
