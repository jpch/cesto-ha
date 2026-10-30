# continente-mcp-ha

Home Assistant add-on that acts as the central server for the [assistente-compras](https://github.com/jpch/assistente-compras) app. It runs the unofficial Continente MCP and stores the household's shared shopping list.

## Main features

- Runs `continentept-mcp` (Continente catalogue search, favourites, history and cart) and exposes it over HTTP on the home network.
- Shared shopping list in SQLite, with a documented HTTP API and one token per app or phone.
- Parsing of text lists (quantities and units) and product identification by photo, with a configurable vision AI provider.
- Request queue, so two people don't change the cart at the same time.
- Test mode that never changes the real cart.
- HA sensors (server, Continente session, items in the list, last sync) and a notification when the session expires.
- Continente credentials stored only on the server; never completes checkout or payment.
- Multi-language ready: the add-on web page ships in European Portuguese (default), with all user-facing strings in i18n files and no hardcoded text, so new languages can be added without code changes.

## Repository layout

- `continente_mcp/`: the add-on (Debian trixie base, Node.js 22, `continentept-mcp` pinned, Playwright Chromium headless shell baked into the image).
- `continente_mcp/server/`: add-on HTTP API (Node.js 22, TypeScript, Fastify, built-in `node:sqlite`). Contract: [`openapi.yaml`](continente_mcp/server/openapi.yaml), served at `/api/v1/openapi.yaml`. Unit tests (Vitest) run inside the image build on both architectures.
- `continente_mcp/rootfs/opt/smoke/`: headless smoke test that calls the read-only `search_products` tool. It never touches the cart.
- `.github/workflows/build.yaml`: builds for `aarch64` and `amd64` and runs the smoke test.
- `docs/`: architecture and task list.

Supported architectures: `aarch64` (e.g. Raspberry Pi 5) and `amd64`. `armv7` is not supported because Playwright has no Chromium build for it, and Alpine is not used because Chromium needs glibc.

Run the smoke test locally:

```sh
docker build -t continente-mcp:test continente_mcp
docker run --rm --entrypoint node -w /opt/smoke -e CONTINENTE_DATA_DIR=/tmp/c continente-mcp:test smoke.mjs
```

## API basics

- Base URL: `http://<home-assistant>:8099/api/v1`. `GET /health` needs no token.
- Every other call needs `Authorization: Bearer <token>`. Tokens are created and revoked on the add-on page (admin routes only accept requests coming through the Home Assistant ingress); only a SHA-256 hash is stored.
- Errors are `{"error": {"code", "message_key"}}`: clients translate the key, so the server never returns user-facing text.
- Data lives in `/data/app.db` (SQLite, included in HA backups).

Run the server tests locally:

```sh
cd continente_mcp/server && npm ci && npm test
```

## Installation

In Home Assistant, open the add-on store, add this repository (`https://github.com/jpch/continente-mcp-ha`) and install the add-on. Home Assistant pulls a prebuilt image (`ghcr.io/jpch/{arch}-continente-mcp`, aarch64 and amd64) published by CI on every push to `main` and on `v*` tags, so nothing is built on the device.

Warning: uses an unofficial MCP, not affiliated with Continente.

See the [CHANGELOG](CHANGELOG.md) for the change history.
