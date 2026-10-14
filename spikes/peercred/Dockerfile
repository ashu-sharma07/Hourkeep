FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 gcc \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --no-audit --no-fund --prefix /opt/tools postject@1.0.0-alpha.6 \
 && groupadd --gid 2000 hourkeep && useradd -m --uid 1001 -G hourkeep member
WORKDIR /spike
COPY peercred.c server.cjs client.cjs ./
RUN mkdir -p /opt/peercred \
 && gcc -shared -fPIC -O2 -Wall -I/usr/local/include/node -DNAPI_VERSION=8 peercred.c -o /opt/peercred/peercred.node \
 && ls -l /opt/peercred/peercred.node
