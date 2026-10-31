ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:trixie
FROM node:22-trixie-slim AS node

# API server: install, type-check, test and build on the target architecture.
FROM node:22-trixie-slim AS server
WORKDIR /src
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run typecheck && npm test && npm run build && npm prune --omit=dev

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

# Full Chromium (headless shell + headed browser for the sign-in window), plus the on-demand
# sign-in display: TigerVNC's Xvnc, websockify and noVNC (served through HA ingress).
RUN npm install -g "continentept-mcp@${CONTINENTEPT_MCP_VERSION}" \
 && cd /usr/local/lib/node_modules/continentept-mcp \
 && npx playwright install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends tigervnc-standalone-server websockify novnc \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

COPY rootfs /
COPY --from=server /src/dist /opt/server/dist
COPY --from=server /src/node_modules /opt/server/node_modules
COPY --from=server /src/package.json /src/openapi.yaml /opt/server/
COPY --from=server /src/web /opt/server/web

# Upstream contract: the installed continentept-mcp must publish exactly the reviewed tools and
# schemas (tools/list over stdio, no sign-in, empty data directory). A new, removed or changed tool
# fails the build until it is reviewed (server/test/contract/).
COPY --from=server /src/scripts/upstream-tools.mjs /opt/server/contract-check/scripts/
COPY --from=server /src/test/contract/upstream-tools.json /opt/server/contract-check/test/contract/
RUN node /opt/server/contract-check/scripts/upstream-tools.mjs --check && rm -rf /opt/server/contract-check
RUN cd /opt/smoke && npm ci --omit=dev && rm -rf /root/.npm
