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

# Node.js 22 from the official image (same Debian release, glibc).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# 2.0.0: no continentept-mcp, Chromium or noVNC here any more. The Continente account, session, sign-in
# and browser live in the Continente MCP add-on (jpch/continente-mcp-ha), reached over streamable HTTP.
ENV NODE_ENV=production

COPY rootfs /
COPY --from=server /src/dist /opt/server/dist
COPY --from=server /src/node_modules /opt/server/node_modules
COPY --from=server /src/package.json /src/openapi.yaml /opt/server/
COPY --from=server /src/web /opt/server/web
