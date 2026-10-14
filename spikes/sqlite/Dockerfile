FROM node:22-bookworm
WORKDIR /spike
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY driver-test.cjs build-sea.sh ./
