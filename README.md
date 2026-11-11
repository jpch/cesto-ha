# Cesto for Home Assistant

**Cesto** is a self-hosted shared shopping list that prepares your supermarket cart. This repository is the
Home Assistant add-on (slug `cesto`), which is the only server: each household runs its own, and nothing is
hosted by anyone else. The Android app is installed from GitHub releases with [Obtainium](https://github.com/ImranR98/Obtainium)
(`https://github.com/jpch/cesto-releases`).

Cesto fills the cart and stops there: it can never check out, pay or place an order.

## Continente MCP add-on (2.0.0)

Cesto 2.0.0 no longer bundles `continentept-mcp`, Chromium or noVNC. The generic
[Continente MCP add-on](https://github.com/jpch/continente-mcp-ha) holds the Continente account and session, does
the sign-in and serves MCP to any agent; Cesto is one of its agents.

- **Discovery:** `/share/continente-mcp/endpoint.json` (written by that add-on). The option `continente_mcp_url`
  overrides it.
- **Token:** Cesto generates its own token (`/data/continente-mcp/token`, 0600) and writes only its SHA-256 hash to
  `/share/continente-mcp/requests/cesto.json`, asking for a priority token. An HA admin approves it on the
  Continente MCP page, comparing the fingerprint with the one on the Cesto page. The option `continente_mcp_token`
  (a token created on that page) skips the request.
- **Migration from 1.x:** on the first start next to the Continente MCP add-on (1.0.2 or later), Cesto copies its
  old `/data/continente` (session and account) to `/share/continente-mcp/import/`. The other add-on imports it only
  if it has no account or session yet and deletes the hand-off at once.
- **Removing the 1.x Continente password from Cesto (2.0.2):** once that hand-off has been consumed and the Continente MCP add-on
  reports its own account or a valid session (its public `/health`), Cesto deletes its old `/data/continente`
  (`credentials.env` and the browser profile). Until then it keeps it and checks again every 30 s. New Cesto backups
  then hold no Continente password; backups taken before that still do, so delete old Cesto backups you no longer
  need. Rollback to 1.9.0 needs a backup of the Cesto add-on taken before the update to 2.x.
- `GET /api/v1/health` gains `continente: {available, addon_slug, session_valid, signing_in, token}`; nothing else
  in the API changes. `session_valid`, the session check, keep-alive, caches, priorities, `remote_cart` and metrics
  work as before.

## Supermarkets (connectors)

The add-on has a common core (shared list, preferences, preview, cart orchestration) and one connector per
supermarket. Every connector must provide product search, cart read/add and its own sign-in; promotions,
purchase history and barcode lookup are optional and declared per connector (`GET /api/v1/connectors`), and the
app hides what a connector does not support. Enable connectors in the add-on options (`connectors`).

| Connector | Search, cart, sign-in | Promotions | Purchase history | Barcode |
| --- | --- | --- | --- | --- |
| `continente` (unofficial [continentept-mcp](https://github.com/andredelgado/continente-mcp), through the [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha)) | yes | yes | yes | yes |

Each list item can have a preferred supermarket (`store`), learned from your choices and editable; preparing the
basket creates one cart per supermarket (`POST /api/v1/basket/proposals` with `store`). The app never sees a
supermarket password; the Continente account lives only in the Continente MCP add-on.

## Connecting a phone

1. Open the add-on page (Home Assistant sidebar → Cesto), section **Ligar um telemóvel**.
2. Enter a device name and check the home network address (default: the host you opened Home Assistant on, port 8099).
3. Scan the QR code in the app's first-run wizard. Each phone gets its own token, which you can revoke on the same page.

The app can also find the add-on on the home network (it looks for Home Assistant via mDNS and checks port 8099),
or you can type the address and token by hand. List and preferences are shared by the whole household.

## Migrating from the pre-1.0 add-on of this repository

Two different add-ons have been called "Continente MCP":

- **Old (before Cesto 1.0.0):** this repository's add-on, before it was renamed to Cesto. Slug `continente_mcp`, it
  bundled `continentept-mcp` itself. It is no longer published.
- **Current:** the generic [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha) (version 1.0.x), from
  another repository. It also uses the slug `continente_mcp`, but Home Assistant prefixes every slug with a hash of
  its repository, so it is a separate add-on. Cesto 2.x needs it.

If you still run the old one (Cesto 2.x updates from Cesto 1.x need none of this; see above):

1. Install **Cesto** from this repository and start it (it starts empty, in test mode unless you turn it off).
2. On the old add-on page, **Exportar** the data; on the Cesto page, **Importar dados** with that file (only works while Cesto is empty).
   Lists, items, purchase history and preferences are kept. Tokens and Continente credentials are not exported.
3. Install the current [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha) (1.0.2 or later), enter the Continente account on its page and sign in once there. On that page, approve the token request named "Cesto" (the fingerprint matches the one on the Cesto page).
4. Stop the old add-on. Uninstall it once you are happy.

## Remote access (list, and optionally the cart)

Away from home the app reaches the shared list API, the Continente catalogue search (`POST /api/v1/catalog/search`,
read-only) and the session check through Home Assistant ingress on your external HA URL, authenticated with an HA
long-lived token (a non-admin HA user is enough). Port 8099 must not be forwarded. The exact remote allowlists are
`REMOTE_ROUTE` and `REMOTE_CART_ROUTE` in `cesto/server/src/app.ts`.

The cart is LAN only unless you turn on the add-on option **`remote_cart`** (1.7.0, default `false`). With it on,
proposals, line edits, preview, apply, job polling, promotions and photos are also allowed over ingress, with the
same HA authentication, a limit of 30 cart changes per device per minute (`429`), and one log line per remote cart
change (`[cesto] remote_cart POST /api/v1/basket/proposals/:id/apply 202 by=ha-user:<id> 120ms`, no ids or tokens).
Checkout, payment, order and address paths are always refused remotely (the add-on has none anyway). `/api/v1/health`
reports `remote_cart`. "Produtos já enviados" uses `GET /api/v1/history/products` and `POST /api/v1/history/products/add` (1.9.0, list-level, never touch the cart). The app's refresh calls `POST /api/v1/session/check` (1.8.0, list-level, read-only, at most one real check per minute). Long work (matching, preview, apply) runs as jobs the app polls, so no remote request stays
open for long. Setup and proxy timeouts: [docs/remote-access.md](docs/remote-access.md).

## Promotion suggestions

`GET /api/v1/promotions` suggests products on promotion for the pending list items (read-only; on the home network,
and away from home through HA ingress only when `remote_cart` is on). Set
`ai_provider` and `ai_api_key` in the add-on options to let an AI choose and explain them; with `none` (default)
nothing leaves the server and the suggestions come from a Continente search of each item's category.

Since 1.4.0 the app uses the async form, `POST /api/v1/promotions/searches`, and polls it for per-item progress
("7 de 18 produtos vistos"); it can cancel and keep the partial results. Each promotion also lists related products
that are cheaper per kg or per litre (same product type, any brand or size, same unit only, cheapest first).

## Main features

- Uses the [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha), which runs `continentept-mcp` (Continente catalogue search, favourites, history and cart), over streamable HTTP with its own priority token, and exposes the list and cart API on the home network.
- Shared shopping list in SQLite, with a documented HTTP API and one token per app or phone.
- Parsing of text lists (quantities and units) and product identification by photo, with a configurable vision AI provider.
- Request queue, so two people don't change the cart at the same time.
- Edits the real Continente cart (add, change, remove), and can never check out, pay or place an order: a hard tool allowlist/denylist that no option turns off.
- Optional test mode that only simulates cart changes.
- HA sensors (server, Continente session, items in the list, last sync) and a notification when the session expires.
- The Continente account and session live in the Continente MCP add-on; 2.0.2 deletes the copy left by 1.x once that add-on reports its own account or session (installs without it keep the old copy). Never completes checkout or payment.
- Multi-language ready: the add-on web page ships in European Portuguese (default), with all user-facing strings in i18n files and no hardcoded text, so new languages can be added without code changes.

## Product matching

`POST /api/v1/basket/proposals` turns the pending list items into Continente products, read-only on the account. For each item the server tries, in order: the household's shared preference for that item name, the products you buy most often, your favourites, then a catalogue search. Generic names ("iogurtes") return 2–4 options to choose from; when the usual product is out of stock the line shows it as `unavailable` with up to 3 available alternatives. Quantities are converted to what the cart needs (1,5 kg of rice in 1 kg packs → 2; 1 kg of apples sold per piece → 5 pieces). A choice made on one phone (`PUT /api/v1/preferences/{item}`) is reused by everyone next time.

## Photos

The app reads the barcode and the packaging text on the phone (ML Kit) and sends them to `POST /api/v1/photos`; the server searches Continente and returns up to 5 candidates to add to the list. `vision_provider` is `none` by default and is the only option in this version, so images are never sent to any outside service, and the original photo is never written to disk. Only an optional small thumbnail is kept, until you delete it.

## Searching Continente for a product (linked items)

After reading a product with the camera, the app can ask `POST /api/v1/catalog/search` (`query` = composed name, `barcode` optional) for candidates with image, size, price, price per kg/l and promotions. The product the user picks is saved on the list item (`product`), and the basket then uses exactly that product instead of matching the name again. Read-only; on the home network and away from home through HA ingress (1.2.0, at most 10 searches per minute per user).

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

- `cesto/`: the add-on (Debian trixie base, Node.js 22). Since 2.0.0 it bundles no MCP, browser or noVNC; see [Continente MCP add-on](#continente-mcp-add-on-200).
- `cesto/server/`: add-on HTTP API (Node.js 22, TypeScript, Fastify, built-in `node:sqlite`). Contract: [`openapi.yaml`](cesto/server/openapi.yaml), served at `/api/v1/openapi.yaml`. Unit tests (Vitest) run inside the image build on both architectures.
- `cesto/rootfs/opt/smoke/`: container smoke test: the API server starts, `/health` answers in test mode, unauthenticated calls are refused and no MCP, browser or VNC is bundled. No supermarket call.
- `.github/workflows/build.yaml`: builds for `aarch64` and `amd64` and runs the smoke test.
- `docs/`: architecture and task list.

Supported architectures: `aarch64` (e.g. Raspberry Pi 5) and `amd64`.

Run the smoke test locally:

```sh
docker build -t cesto:test cesto
docker run --rm --entrypoint node -w /opt/smoke cesto:test smoke.mjs
```

## API basics

- Base URL: `http://<home-assistant>:8099/api/v1`. `GET /health` needs no token.
- Every other call needs `Authorization: Bearer <token>`. Tokens are created and revoked on the add-on page (admin routes only accept requests coming through the Home Assistant ingress); only a SHA-256 hash is stored.
- Errors are `{"error": {"code", "message_key"}}`: clients translate the key, so the server never returns user-facing text.
- Data lives in `/data/app.db` (SQLite, included in HA backups).

### Continente connector, cart safety and test mode

- **Hard tool policy** (`server/src/mcp/tools.ts`): only the 11 read tools and the 4 cart tools of continentept-mcp (0.12.1 and 0.13.0) are allowed. Anything else, and any name that mentions checkout, payment, placing/confirming an order, purchase, delivery slots, vouchers, coupons, billing or cards, is refused with `ForbiddenToolError` before it reaches the MCP. It is enforced on the HTTP transport itself, in `TestModeGuard` and in `ContinenteMcp`; there is no option to turn it off. continentept-mcp has no checkout tool, and the allowlist keeps it that way if a future release adds one; the coupon tools 0.13.0 added (`list_coupons`, `set_cart_coupons`) are refused too. `server/test/policy.test.ts` proves it with test mode off.
- **Upstream contract** (`docs/upstream-updates.md`): every read of a continentept-mcp result goes through `server/src/mcp/upstream.ts`, checked against anonymised fixtures and the reviewed tool schemas of the version the Continente MCP add-on pins. The pin, the live check against the installed package and the daily update workflow live in that add-on.

- The Continente MCP add-on is called over streamable HTTP. Read calls are retried once after a connection failure; cart mutations never are. When the add-on is missing or does not accept the token, Continente routes answer `503 error.continente_unavailable` and `/health` reports `continente.available: false`.
- Cart changes go only through `CartWriter`. In test mode it returns a simulated result and never calls the MCP; a second guard on the transport refuses `add_cart_item`, `set_cart_item_quantity`, `remove_cart_item` and `clear_cart` while test mode is on. Tests run against a fake Continente MCP add-on over streamable HTTP (`server/test/fake-mcp.mjs`) and check that no mutating call reaches it.
- One MCP job runs at a time (single-worker queue); a `not_authenticated` error marks the Continente session as invalid (`session_valid` in `/health`).

### Shared list

- One household list (`/lists/current`); every item records who added it (the token name), its quantity/unit, note and state (`pending`, `in_cart`, `not_bought`).
- Sync: `GET /lists/current` for a full snapshot, then `GET /lists/current/changes?since=<version>` for deltas (deleted items included). Creating with a `client_id` is idempotent, so offline queues can be resent.
- Last write wins: edits carry the client's `updated_at`; older edits are ignored (`applied: false`, or 409 for deletes); clocks ahead of the server are clamped.
- `POST /lists/current/parse` turns pasted or dictated pt-PT text (`2 kg batata`, `leite x6`, `meia dúzia de ovos`, `33cl cerveja`) into proposed items without saving them.
- `POST /lists` archives the current list into history; `POST /lists/history/{id}/repeat` copies one back as pending items. The cart is only ever changed through the preview.

### Add-on page (HA ingress)

Open the add-on from the Home Assistant sidebar ("Open web UI"). The page is in European Portuguese by default (English if the `language` is English); every string lives in `server/web/i18n/*.json`. It is only served through ingress: requests from the LAN to `/` or `/api/v1/admin/*` get 403.

- Status: version, test-mode banner, Continente session (with a "check session" button that does a read-only `get_cart`, and a link to the Continente MCP page while the session is expired), queue length.
- Continente account and sign in (2.0.0): on the Continente MCP add-on page; the Cesto page links to it. Cesto stores no Continente password. The old `/api/v1/admin/credentials` and `POST`/`DELETE /api/v1/admin/login` routes answer `410 error.moved_to_continente_mcp`.
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

When the Continente session expires, a persistent notification links to the Continente MCP add-on page (slug from its `/health`; the add-ons page while it is unknown), where the sign-in happens; it is dismissed once the session is valid. These entities are created by the add-on (no `unique_id`), so they reappear after a Home Assistant restart within a minute.

The `continente_` prefix comes from before the rename to Cesto. The entities are kept under these ids on purpose, so
existing dashboards, automations and history keep working; the friendly names already say Cesto or describe the list.

Run the server tests locally:

```sh
cd cesto/server && npm ci && npm test
```

## Installation

In Home Assistant, open the add-on store, add this repository (`https://github.com/jpch/cesto-ha`) and install the add-on. Home Assistant pulls a prebuilt image (`ghcr.io/jpch/{arch}-cesto`, aarch64 and amd64) published by CI on every push to `main` and on `v*` tags, so nothing is built on the device. CI actions are pinned to commit SHAs and Dependabot proposes weekly npm and GitHub Actions updates.

Warning: the Continente connector uses an unofficial MCP; Cesto is not affiliated with any supermarket.

Licence: [MIT](LICENSE). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

See the [CHANGELOG](CHANGELOG.md) for the change history.
