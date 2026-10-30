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

### Continente MCP client and test mode

- `continentept-mcp` runs as a supervised child process over stdio, started on the first call; if it crashes, the next call starts it again. Read calls are retried after a crash; cart mutations never are.
- Cart changes go only through `CartWriter`. In test mode it returns a simulated result and never calls the MCP; a second guard on the transport refuses `add_cart_item`, `set_cart_item_quantity`, `remove_cart_item` and `clear_cart` while test mode is on. Tests run against a fake MCP (`server/test/fake-mcp.mjs`) and check that no mutating call reaches it.
- One MCP job runs at a time (single-worker queue); a `not_authenticated` error marks the Continente session as invalid (`session_valid` in `/health`).

### Shared list

- One household list (`/lists/current`); every item records who added it (the token name), its quantity/unit, note and state (`pending`, `in_cart`, `not_bought`).
- Sync: `GET /lists/current` for a full snapshot, then `GET /lists/current/changes?since=<version>` for deltas (deleted items included). Creating with a `client_id` is idempotent, so offline queues can be resent.
- Last write wins: edits carry the client's `updated_at`; older edits are ignored (`applied: false`, or 409 for deletes); clocks ahead of the server are clamped.
- `POST /lists/current/parse` turns pasted or dictated pt-PT text (`2 kg batata`, `leite x6`, `meia dúzia de ovos`, `33cl cerveja`) into proposed items without saving them.
- `POST /lists` archives the current list into history; `POST /lists/history/{id}/repeat` copies one back as pending items. The cart is only ever changed through the preview.

Run the server tests locally:

```sh
cd continente_mcp/server && npm ci && npm test
```

## Installation

In Home Assistant, open the add-on store, add this repository (`https://github.com/jpch/continente-mcp-ha`) and install the add-on. Home Assistant pulls a prebuilt image (`ghcr.io/jpch/{arch}-continente-mcp`, aarch64 and amd64) published by CI on every push to `main` and on `v*` tags, so nothing is built on the device.

Warning: uses an unofficial MCP, not affiliated with Continente.

See the [CHANGELOG](CHANGELOG.md) for the change history.
