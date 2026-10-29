ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:trixie
FROM node:22-trixie-slim AS node

FROM ${BUILD_FROM}
ARG CONTINENTEPT_MCP_VERSION=0.12.1

# Node.js 22 from the official image (same Debian release, glibc).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Chromium is baked into the image: no runtime download.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw \
    CONTINENTE_DATA_DIR=/data/continente \
    CONTINENTE_SIGN_IN_WINDOW=0 \
    NODE_ENV=production

RUN npm install -g "continentept-mcp@${CONTINENTEPT_MCP_VERSION}" \
 && cd /usr/local/lib/node_modules/continentept-mcp \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY rootfs /
RUN cd /opt/smoke && npm ci --omit=dev && rm -rf /root/.npm
