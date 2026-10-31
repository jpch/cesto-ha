# Cesto for Home Assistant

**Cesto** is a self-hosted shared shopping list that prepares your supermarket cart. This repository is the
Home Assistant add-on (slug `cesto`), which is the only server: each household runs its own, and nothing is
hosted by anyone else. The Android app is installed from GitHub releases with [Obtainium](https://github.com/ImranR98/Obtainium)
(`https://github.com/jpch/cesto-releases`).

Cesto fills the cart and stops there: it can never check out, pay or place an order.

## Supermarkets (connectors)

The add-on has a common core (shared list, preferences, preview, cart orchestration) and one connector per
supermarket. Every connector must provide product search, cart read/add and its own sign-in; promotions,
purchase history and barcode lookup are optional and declared per connector (`GET /api/v1/connectors`), and the
app hides what a connector does not support. Enable connectors in the add-on options (`connectors`).

| Connector | Search, cart, sign-in | Promotions | Purchase history | Barcode |
| --- | --- | --- | --- | --- |
| `continente` (unofficial [continentept-mcp](https://github.com/andredelgado/continente-mcp)) | yes | yes | yes | yes |

Each list item can have a preferred supermarket (`store`), learned from your choices and editable; preparing the
basket creates one cart per supermarket (`POST /api/v1/basket/proposals` with `store`). Supermarket passwords stay
in the add-on only; the app never sees them.

## Connecting a phone

1. Open the add-on page (Home Assistant sidebar → Cesto), section **Ligar um telemóvel**.
2. Enter a device name and check the home network address (default: the host you opened Home Assistant on, port 8099).
3. Scan the QR code in the app's first-run wizard. Each phone gets its own token, which you can revoke on the same page.

The app can also find the add-on on the home network (it looks for Home Assistant via mDNS and checks port 8099),
or you can type the address and token by hand. List and preferences are shared by the whole household.

## Migrating from the Continente MCP add-on

The add-on used to be called "Continente MCP" (slug `continente_mcp`). A new slug means a new add-on:

1. Install **Cesto** from this repository and start it (it starts empty, in test mode unless you turn it off).
2. On the old add-on page, **Exportar** the data; on the Cesto page, **Importar dados** with that file (only works while Cesto is empty).
   Lists, items, purchase history and preferences are kept. Tokens and Continente credentials are not exported.
3. Enter the Continente account on the Cesto page and sign in once (noVNC window).
4. Stop the old add-on. Uninstall it once you are happy.

## Remote access (list, and optionally the cart)

Away from home the app reaches the shared list API through Home Assistant ingress on your external HA URL,
authenticated with an HA long-lived token (a non-admin HA user is enough). Port 8099 must not be forwarded.

The cart is LAN only unless you turn on the add-on option **`remote_cart`** (1.7.0, default `false`). With it on,
proposals, line edits, preview, apply, job polling, promotions and photos are also allowed over ingress, with the
same HA authentication, a limit of 30 cart changes per device per minute (`429`), and one log line per remote cart
change (`[cesto] remote_cart POST /api/v1/basket/proposals/:id/apply 202 by=ha-user:<id> 120ms`, no ids or tokens).
Checkout, payment, order and address paths are always refused remotely (the add-on has none anyway). `/api/v1/health`
reports `remote_cart`. Long work (matching, preview, apply) runs as jobs the app polls, so no remote request stays
open for long. Setup and proxy timeouts: [docs/remote-access.md](docs/remote-access.md).

## Promotion suggestions

`GET /api/v1/promotions` suggests products on promotion for the pending list items (LAN only, read-only). Set
`ai_provider` and `ai_api_key` in the add-on options to let an AI choose and explain them; with `none` (default)
nothing leaves the server and the suggestions come from a Continente search of each item's category.

Since 1.4.0 the app uses the async form, `POST /api/v1/promotions/searches`, and polls it for per-item progress
("7 de 18 produtos vistos"); it can cancel and keep the partial results. Each promotion also lists related products
that are cheaper per kg or per litre (same product type, any brand or size, same unit only, cheapest first).

## Main features

- Runs `continentept-mcp` (Continente catalogue search, favourites, history and cart) and exposes it over HTTP on the home network.
- Shared shopping list in SQLite, with a documented HTTP API and one token per app or phone.
- Parsing of text lists (quantities and units) and product identification by photo, with a configurable vision AI provider.
- Request queue, so two people don't change the cart at the same time.
- Edits the real Continente cart (add, change, remove), and can never check out, pay or place an order: a hard tool allowlist/denylist that no option turns off.
- Optional test mode that only simulates cart changes.
- HA sensors (server, Continente session, items in the list, last sync) and a notification when the session expires.
- Continente credentials stored only on the server; never completes checkout or payment.
- Multi-language ready: the add-on web page ships in European Portuguese (default), with all user-facing strings in i18n files and no hardcoded text, so new languages can be added without code changes.

## Product matching

`POST /api/v1/basket/proposals` turns the pending list items into Continente products, read-only on the account. For each item the server tries, in order: the household's shared preference for that item name, the products you buy most often, your favourites, then a catalogue search. Generic names ("iogurtes") return 2–4 options to choose from; when the usual product is out of stock the line shows it as `unavailable` with up to 3 available alternatives. Quantities are converted to what the cart needs (1,5 kg of rice in 1 kg packs → 2; 1 kg of apples sold per piece → 5 pieces). A choice made on one phone (`PUT /api/v1/preferences/{item}`) is reused by everyone next time.

## Photos

The app reads the barcode and the packaging text on the phone (ML Kit) and sends them to `POST /api/v1/photos`; the server searches Continente and returns up to 5 candidates to add to the list. `vision_provider` is `none` by default and is the only option in this version, so images are never sent to any outside service, and the original photo is never written to disk. Only an optional small thumbnail is kept, until you delete it.

## Searching Continente for a product (linked items)

After reading a product with the camera, the app can ask `POST /api/v1/catalog/search` (`query` = composed name, `barcode` optional) for candidates with image, size, price, price per kg/l and promotions. The product the user picks is saved on the list item (`product`), and the basket then uses exactly that product instead of matching the name again. Read-only; LAN only.

## Filling the cart

1. `POST /api/v1/basket/proposals/{id}/preview` with `mode` `merge` (add to what is already in the cart) or `replace` (empty it first). This only reads the account and shows the totals and estimated cost.
2. `POST /api/v1/basket/proposals/{id}/apply` with that `preview_id`. Any change to the proposal makes the preview stale (409).
3. Poll `GET /api/v1/jobs/{id}` (its `progress` says which step is running, e.g. adding 3 of 5). The server sets exact quantities, then reads the cart back to check every line by product id and quantity, waiting and reading again (up to 4 times) while the cart page catches up. Lines still missing are listed by name in `missing`; `POST /api/v1/jobs/{id}/retry-missing` re-sends only those. If Continente cannot say whether a change went through (`unknown`), it stops and asks you to look at the cart instead of retrying. If the session expired, the job waits and resumes after you log in again.

The add-on never checks out or pays: you finish the order in the Continente app or site. With `test_mode` off it changes your real cart; with `test_mode` on (the default for new installs) nothing is sent and the job ends as `simulated`. Both modes are equally unable to reach checkout or payment.

## Performance and diagnostics

- **Caching.** Continente searches are cached in memory for 8 hours and product details (unit price, promotions)
  for 6 hours, so repeated proposals and promotion searches skip the site. Preview and apply always read the live
  cart and prices. Restarting the add-on empties the caches.
- **Priorities.** There is still only one browser session and one job at a time. Preview, apply and line edits go
  first, promotion searches and background checks last.
- **Session keep-alive.** Every 20–30 minutes (randomised) the add-on reads the cart once, only when it has been idle,
  to find out early that a new sign-in is needed. Home Assistant then shows a notification.
- **Timing.** Each job writes one summary line to the add-on log (at most 60 lines a minute; per-call lines only at
  `debug`). `GET /api/v1/admin/metrics` on the add-on page (admins) returns the latest timings.

## Repository layout

- `cesto/`: the add-on (Debian trixie base, Node.js 22, `continentept-mcp` pinned, Playwright Chromium baked into the image, plus Xvnc/noVNC for the sign-in window).
- `cesto/server/`: add-on HTTP API (Node.js 22, TypeScript, Fastify, built-in `node:sqlite`). Contract: [`openapi.yaml`](cesto/server/openapi.yaml), served at `/api/v1/openapi.yaml`. Unit tests (Vitest) run inside the image build on both architectures.
- `cesto/rootfs/opt/smoke/`: headless smoke test that calls the read-only `search_products` tool. It never touches the cart.
- `.github/workflows/build.yaml`: builds for `aarch64` and `amd64` and runs the smoke test.
- `docs/`: architecture and task list.

Supported architectures: `aarch64` (e.g. Raspberry Pi 5) and `amd64`. `armv7` is not supported because Playwright has no Chromium build for it, and Alpine is not used because Chromium needs glibc.

Run the smoke test locally:

```sh
docker build -t cesto:test cesto
docker run --rm --entrypoint node -w /opt/smoke -e CONTINENTE_DATA_DIR=/tmp/c cesto:test smoke.mjs
```

## API basics

- Base URL: `http://<home-assistant>:8099/api/v1`. `GET /health` needs no token.
- Every other call needs `Authorization: Bearer <token>`. Tokens are created and revoked on the add-on page (admin routes only accept requests coming through the Home Assistant ingress); only a SHA-256 hash is stored.
- Errors are `{"error": {"code", "message_key"}}`: clients translate the key, so the server never returns user-facing text.
- Data lives in `/data/app.db` (SQLite, included in HA backups).

### Continente connector, cart safety and test mode

- **Hard tool policy** (`server/src/mcp/tools.ts`): only the 11 read tools and the 4 cart tools of continentept-mcp 0.12.1 are allowed. Anything else, and any name that mentions checkout, payment, placing/confirming an order, purchase, delivery slots, vouchers, coupons, billing or cards, is refused with `ForbiddenToolError` before it reaches the MCP. It is enforced on the stdio transport itself, in `TestModeGuard` and in `ContinenteMcp`; there is no option to turn it off. continentept-mcp 0.12.1 has no checkout tool, and the allowlist keeps it that way if a future release adds one. `server/test/policy.test.ts` proves it with test mode off.
- **Upstream contract** (`docs/upstream-updates.md`): every read of a continentept-mcp result goes through `server/src/mcp/upstream.ts`, checked against anonymised fixtures and the package's own schemas. CI and the image build fail if the installed package adds, removes or changes a tool; a daily workflow proposes updates and only auto-merges them when the contract is unchanged.

- `continentept-mcp` runs as a supervised child process over stdio, started on the first call; if it crashes, the next call starts it again. Read calls are retried after a crash; cart mutations never are.
- Cart changes go only through `CartWriter`. In test mode it returns a simulated result and never calls the MCP; a second guard on the transport refuses `add_cart_item`, `set_cart_item_quantity`, `remove_cart_item` and `clear_cart` while test mode is on. Tests run against a fake MCP (`server/test/fake-mcp.mjs`) and check that no mutating call reaches it.
- One MCP job runs at a time (single-worker queue); a `not_authenticated` error marks the Continente session as invalid (`session_valid` in `/health`).

### Shared list

- One household list (`/lists/current`); every item records who added it (the token name), its quantity/unit, note and state (`pending`, `in_cart`, `not_bought`).
- Sync: `GET /lists/current` for a full snapshot, then `GET /lists/current/changes?since=<version>` for deltas (deleted items included). Creating with a `client_id` is idempotent, so offline queues can be resent.
- Last write wins: edits carry the client's `updated_at`; older edits are ignored (`applied: false`, or 409 for deletes); clocks ahead of the server are clamped.
- `POST /lists/current/parse` turns pasted or dictated pt-PT text (`2 kg batata`, `leite x6`, `meia dúzia de ovos`, `33cl cerveja`) into proposed items without saving them.
- `POST /lists` archives the current list into history; `POST /lists/history/{id}/repeat` copies one back as pending items. The cart is only ever changed through the preview.

### Add-on page (HA ingress)

Open the add-on from the Home Assistant sidebar ("Open web UI"). The page is in European Portuguese by default (English if the `language` is English); every string lives in `server/web/i18n/*.json`. It is only served through ingress: requests from the LAN to `/`, `/vnc/` or `/api/v1/admin/*` get 403.

- Status: version, test-mode banner, Continente session (with a "check session" button that does a read-only `get_cart`), queue length.
- Continente account: email and password are written to `/data/continente/credentials.env` (0600, folder 0700). The password is never shown or returned; the page only shows a masked email.
- Sign in: starts, on demand, a virtual display (TigerVNC `Xvnc`), `websockify` + noVNC (proxied under `./vnc/`) and `continentept-mcp login --show-browser`. If Continente asks "Não sou um robô", tick it in the embedded window. Everything stops when the session is saved, on failure, on cancel or after 6 minutes; the MCP process then restarts to use the new session.
- Connect a phone: one token per device, shown once as a QR code with the home network address; list and revoke tokens.
- Export and import: lists, items, purchase runs and shared preferences as JSON (no tokens or credentials). Import only into an empty add-on.

### Home Assistant entities

Published through the Supervisor (`homeassistant_api`), refreshed every minute, after list changes and on session changes:

| Entity | State |
| --- | --- |
| `sensor.continente_server_status` | `online`, or `test_mode` while test mode is on (attributes: version, queue length) |
| `binary_sensor.continente_session_valid` | `on` / `off` / `unknown` |
| `sensor.continente_list_items` | Pending items in the current list (attribute: total items) |
| `sensor.continente_last_sync` | Time of the last list change |

When the Continente session expires, a persistent notification links to the add-on page to sign in again; it is dismissed once the session is valid. These entities are created by the add-on (no `unique_id`), so they reappear after a Home Assistant restart within a minute.

Run the server tests locally:

```sh
cd cesto/server && npm ci && npm test
```

## Installation

In Home Assistant, open the add-on store, add this repository (`https://github.com/jpch/cesto-ha`) and install the add-on. Home Assistant pulls a prebuilt image (`ghcr.io/jpch/{arch}-cesto`, aarch64 and amd64) published by CI on every push to `main` and on `v*` tags, so nothing is built on the device. CI actions are pinned to commit SHAs and Dependabot proposes weekly npm and GitHub Actions updates.

Warning: the Continente connector uses an unofficial MCP; Cesto is not affiliated with any supermarket.

Licence: [MIT](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

See the [CHANGELOG](CHANGELOG.md) for the change history.
