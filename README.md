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
- `continente_mcp/rootfs/opt/smoke/`: headless smoke test that calls the read-only `search_products` tool. It never touches the cart.
- `ci/build.yaml`: GitHub Actions workflow (to be moved to `.github/workflows/` by a token with `workflow` scope); builds for `aarch64` and `amd64` and runs the smoke test.
- `docs/`: architecture and task list.

Supported architectures: `aarch64` (e.g. Raspberry Pi 5) and `amd64`. `armv7` is not supported because Playwright has no Chromium build for it, and Alpine is not used because Chromium needs glibc.

Run the smoke test locally:

```sh
docker build -t continente-mcp:test continente_mcp
docker run --rm --entrypoint node -w /opt/smoke -e CONTINENTE_DATA_DIR=/tmp/c continente-mcp:test smoke.mjs
```

## Installation

In Home Assistant, open the add-on store, add this repository (`https://github.com/jpch/continente-mcp-ha`) and install the add-on.

Warning: uses an unofficial MCP, not affiliated with Continente.

See the [CHANGELOG](CHANGELOG.md) for the change history.
