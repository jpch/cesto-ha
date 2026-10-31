# Changelog

All notable changes to this add-on are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.7.0] - 2026-10-31

### Added
- Add-on option `remote_cart` (default `false`). When `true`, the cart routes (proposals, line edits, preview, apply,
  jobs, promotions, photos) are also allowed through HA ingress with the same HA user/token authentication.
  Checkout, payment, order and address paths are always refused remotely.
- Per-device rate limit on remote cart changes (30 non-GET calls per minute, `429 error.rate_limited`).
- One log line per remote cart change with the device id (`by=ha-user:<id>` or `by=token#<id>`), ids masked.
- `remote_cart` in `GET /api/v1/health`.
- Async preview: `POST /basket/proposals/{id}/preview {async: true}` returns `202` with a run;
  poll `GET /basket/proposals/{id}/previews/{run}`.
- Docs: HA ingress and reverse proxy (QNAP) timeouts for long calls.
- Contract tests for the remote cart allowlist, the `remote-cart` openapi tag, the rate limit and the log line.

## [1.6.0] - 2026-10-31

### Added
- Promotion results have `items[]`: one entry per searched item with `promotions[]` (max 3) and one deduplicated
  `cheaper[]` (max 5) compared with the **selected** product's price per kg/l (`basis`). Neither list repeats the
  selected product, and a product is never in both lists. Without a selection the first promotion is the basis.
- `POST /api/v1/promotions/searches` (and `GET /api/v1/promotions?proposal_id=`) take an optional `proposal_id`
  whose selected products are the basis. A selection without a unit price is read once with `get_product` (cached).
- Proposal options and the selected product carry `unit_price` when the shop shows one.

### Changed
- `suggestions[]` and its per-promotion `cheaper[]` are unchanged for older apps.

## [1.5.0] - 2026-10-31

### Added
- Timing instrumentation: one info line per MCP job (`[cesto] job=… prio=… wait_ms run_ms calls mcp_ms cache_hits
  steps=tool:NxMS`), per-call lines only with `log_level: debug`, at most 60 lines a minute (suppressed lines are
  counted). No log files of our own; stdout is rotated by the Supervisor.
- `GET /api/v1/admin/metrics` (HA ingress, admins only): in-memory ring of the last 500 MCP calls and 100 jobs with
  per-tool p50/p95/max, queue length and waiting jobs per priority, error codes, session-lost, throttling and
  sign-in failure counts, and cache statistics.
- In-memory TTL caches for catalogue reads: searches 8 h, product details (unit prices, promotions) 6 h, at most 500
  entries each. Errors are never cached; the caches are cleared after a sign-in or an account change.
- Session keep-alive: a read-only `get_cart` every 20–30 minutes (random jitter), skipped when the add-on talked to
  Continente in the last 20 minutes, during a sign-in, or while the session is already known to be expired. An
  expired session raises the existing Home Assistant persistent notification.

### Changed
- The MCP job queue has priorities: preview, apply and line edits run before proposals and searches, which run
  before promotion searches, the habits refresh and session checks. Still one job at a time; a running job is never
  interrupted.

### Security
- Preview and apply still read the live cart and prices (cart reads, previews and writes never go through the
  cache). The test-mode guard and the checkout/payment block are unchanged and sit in front of the timing layer.
- Metrics hold tool names, durations and error codes only; never queries, product ids, cart contents or tokens.

## [1.4.0] - 2026-10-31

### Added
- Async promotion search with per-item progress and cancel: `POST /api/v1/promotions/searches`, then
  `GET`/`DELETE /api/v1/promotions/searches/{id}`. Cancelling keeps the promotions already found. Each catalogue
  search goes through the MCP queue on its own, so other calls are not blocked for the whole search.
- Unit-price alternatives: each promotion now has `unit_price`, `discount_percent` and `cheaper[]`, the related
  products (same product type, any brand, size or pack, on promotion or not) whose price per kg or per litre is
  strictly lower, compared only in the same unit, without products that have no unit price, cheapest first.

## [1.3.2] - 2026-10-31

### Changed
- The access log now also records successful requests that took 10 s or more, so a phone-side timeout on a slow
  browser-backed call (promotions, line edits, preview) can be traced. Paths and token ids only, never secrets.

## [1.3.1] - 2026-10-31

### Fixed
- "Preparar carrinho" could hang and end in a connection error: matching runs one Continente search per item
  (plus a daily order-history refresh) and could take longer than the phone's 30 s read timeout, and each
  retry queued another full match behind the first. `POST /api/v1/basket/proposals` now accepts `async: true`,
  returns 202 at once with progress, and `GET /api/v1/basket/proposals/{id}` reports `matching`, `ready` or
  `failed` with the cause. A retry while a match is running joins it instead of queueing a new one.
  Synchronous requests (older apps) work as before.

## [1.3.0] - 2026-10-31
### Added
- Contract tests for the bundled `continentept-mcp`: a reviewed snapshot of its `tools/list` (names, input and output schemas), anonymised recorded results for all 15 allowlisted tools (including signed-out, unknown-quantity, unavailable and unconfirmed-change cases), and tests that validate the fixtures against the upstream output schemas, our calls against the input schemas, and every adapter against the fixtures. No Continente login is needed.
- Live contract check: CI and the Docker build start the installed package over stdio and fail if any tool was added, removed or changed.
- Daily automated update (`upstream-bump.yaml`): opens a PR when npm has a newer `continentept-mcp` (after a 72-hour cooldown), lists new, removed or changed tools in the body, and when the contract is unchanged and the build is green, merges, publishes the images and releases the add-on. Any tool change blocks the merge for review. See `docs/upstream-updates.md`.

### Changed
- All reads of upstream result shapes moved into one module, `server/src/mcp/upstream.ts`. A cart mutation with an unrecognised outcome is now treated as `unknown` (stop and check) instead of a failure.
- `build.yaml` can be called by other workflows and its jobs check out code without persisting git credentials.

## [1.2.1] - 2026-10-31
### Added
- Access log in the add-on log: every failed API request (status 400+) is logged as one line with method, path (no query string), status, `via=lan|ingress`, the caller (`token#<id>`, `ha-user` or `anonymous`), the auth failure cause (`no token`, `unknown or revoked token`) and the duration. Successful requests are logged too with `log_level: debug`. Tokens, headers and bodies are never logged.

### Notes
- "Could not read the favorites cache." comes from the bundled `continentept-mcp` and is harmless: its saved favourites snapshot is unreadable or belongs to another login (e.g. after a reinstall), so it fetches favourites live and rewrites the cache.

## [1.2.0] - 2026-10-31
### Added
- Product search from outside home: `POST /catalog/search` is now reachable through Home Assistant ingress (tagged `remote`). It stays read-only and never touches the cart.
- Per-user rate limit on `POST /catalog/search` (10 per minute per HA user or add-on token, LAN and remote): 429 `error.rate_limited` with `Retry-After`.
- The add-on reports its own Supervisor slug (from the container hostname, `ADDON_SLUG` overrides) in `GET /health` (`addon_slug`) and in the pairing QR (`&slug=`), so the app no longer relies on a hard-coded slug.

### Fixed
- `docs/remote-access.md` no longer names a fixed add-on slug.

## [1.1.0] - 2026-10-31
### Added
- `thumbnail_url` on every product option the app shows (basket proposal options and selection, promotion suggestions, `POST /catalog/search` and `POST /photos` candidates): the store's own small image size (Continente CDN `sw`/`sh` = 120 px). Only https URLs on allowlisted store image hosts (`www.continente.pt`) get one; anything else is `null`. The add-on never fetches or proxies images (no SSRF surface).

### Changed
- OpenAPI: `GET /connectors` documents its response schema (`ConnectorsResponse`, `Connector`).
- GitHub Actions pinned to commit SHAs; Dependabot for npm and GitHub Actions.

## [1.0.0] - 2026-10-31

Renamed to **Cesto** (repository `jpch/cesto-ha`, add-on slug `cesto`, image `ghcr.io/jpch/{arch}-cesto`). The new slug installs as a new add-on: export from the old one and import here (see README), then sign in to Continente once.

### Added

- Supermarket connectors: a common core plus one connector per supermarket. Mandatory: product search, cart read/add and session; optional and declared per connector: promotions, purchase history, barcode lookup (`404 error.capability_unsupported` when missing). Continente is the first connector. New option `connectors` (default `[continente]`).
- `GET /api/v1/connectors` (also remote): enabled connectors, their capabilities and session state, `default_store`, and `mode` (`simple` with one supermarket, `multi` with several).
- Preferred supermarket per list item (`store`), validated against the enabled connectors and learned from choices (`store_preferences`, database migration 4). `POST /api/v1/basket/proposals` takes `store`, so each supermarket gets its own cart.
- Phone pairing: `POST /api/v1/admin/pair` creates one token for a device and returns a `cesto://pair` link and its QR code (SVG, generated in the add-on); new "Ligar um telemóvel" section on the add-on page.
- `POST /api/v1/admin/import`: one-time import of an export (also the old `continente-mcp-export` format) into an empty add-on; "Importar dados" on the add-on page.
- MIT licence and CONTRIBUTING.md.

### Changed

- Exports are `cesto-export` format 2 and now include each item's linked product and preferred supermarket.
- New tokens start with `cesto_` (existing tokens keep working).
- No personal data in the repository or its history (addresses, names, URLs replaced by documentation placeholders).

### Removed

- The installation report of one specific device (`docs/t14-pi-install.md`).

## [0.3.0] - 2026-10-30

### Fixed

- Cart verification reported "needs attention" (e.g. "added 5, failed 0, some items are not in the cart") although everything was added: continentept-mcp 0.12 reports cart quantities as `{status, quantity: {value, unit}}`, which was read as NaN. Quantities are now parsed correctly (plain numbers still accepted), the shopping bag line is ignored, and lines are compared by product id and quantity.

### Added

- Cart read-back with retries: after the writes the cart is read up to 4 times (waiting 1, 2, 4 and 8 s) until every line is present, because the cart page can lag behind. Only lines that are really missing are reported, by name, in the job's new `missing` list.
- `POST /api/v1/jobs/{id}/retry-missing` ("Try adding what is missing"): a new job that re-sends exact quantities only for the missing lines and reads the cart again. Merge mode, never clears; simulated in test mode.
- Job progress for the phone's progress screen: `progress {step connect|clear|adding|verifying|done, done, total, current, verify_attempt}`; job lines now carry the product `name` and the `found_quantity` read back.
- `POST /api/v1/catalog/search` (LAN only, read-only): search Continente by barcode, then by the composed name, returning up to 8 candidates with image, name, size, price, price per kg/l (`unit_price`) and promotions.
- Linked products: a list item can carry `product` (product id plus the attributes shown when it was picked). The basket uses that product as is (reason `linked`), without matching again; when it is out of stock, alternatives are offered as before. `product: null` unlinks. Database migration 3 adds the columns.


## [0.2.0] - 2026-10-30

### Added

- Remote access (replaces spec decision 9): through Home Assistant ingress on the external HA URL, authenticated by Home Assistant (long-lived token -> ingress session), only the shared list API is reachable. Basket, cart preview/apply, jobs, photos, promotions, preferences and habits answer 403 `error.remote_forbidden`; this cannot be configured. Remote edits are attributed to the HA user. See docs/remote-access.md.
- `panel_admin: false`, so a non-admin HA user can use the list remotely; the add-on page and admin routes now require HA administrators.
- `GET /api/v1/promotions`: promotion suggestions for the pending list items, before the cart preview. Read-only (`search_products` of each item's category or name, filtered to products on promotion). Optional AI ranking with reasons.
- Add-on options `ai_provider` (none|openai|anthropic, default none), `ai_api_key` and `ai_model`, shared with the planned vision AI. Without AI, or when it fails, the search result is returned (`ai_error: error.ai_failed`).
- `remote` tags in openapi.yaml mark the operations available remotely; a test keeps them equal to the allowlist.

### Fixed

- Health check and admin status reported version 0.1.0: the server version now matches the add-on version, enforced by a test.


## [0.1.2] - 2026-10-30

### Added

- Hard tool policy that no option can disable: only the read tools and the four cart tools (add, set quantity, remove, clear) can reach continentept-mcp; checkout, payment, order placement and any unknown tool are refused at the transport. Tested with test mode off.
- Add-on page banner when the real cart is in use.

### Changed

- Docs, add-on option text and page translations: test mode is an optional simulation, not the only safe mode; the real-cart mode is equally unable to check out or pay.

### Fixed

- Simulated apply jobs no longer return `message_key: "basket.simulated"`. The phone app (0.1.3) did not know that key and showed it as "Ocorreu um erro no servidor." after a successful simulation.

## [0.1.1] - 2026-10-30

### Fixed

- Cart preview: `problems` is now always a list of `{product_id, name, availability, error_key}`. continentept-mcp 0.12 reports it as a number, which the add-on passed through, so the phone app could not read the preview ("O servidor enviou uma resposta que a app não percebe").

### Added

- T14 installation report for a Home Assistant Pi: installed 0.1.0 in test mode, health and entities verified, 35 MB idle.

- Photo identification (T12): `POST /photos` looks a product up by barcode, then by packaging text read on the phone, then by the vision provider (only `none`, the default: no image leaves the server). The original image is never stored; an optional thumbnail is kept until `DELETE /photos/{id}`.

- Cart preview and apply (T10): `POST /basket/proposals/{id}/preview` (merge or replace, read-only) and `/apply` (background job, `GET /jobs/{id}`). Exact totals with `set_cart_item_quantity`, result verified with `get_cart`, items marked `in_cart`, choices saved as shared preferences, run stored in history. An `unknown` outcome stops the job for the user; an expired session parks the job until the next login. Test mode only simulates.

- Product matching (T9): `POST /basket/proposals` ranks shared preference > frequently bought > favourite > search; generic items get 2-4 options, out-of-stock usual products up to 3 available alternatives; quantities converted to packs, weighed pieces or weight steps; promotion hints (multi-buy, nth unit). Line choices via `PATCH`, shared preferences (`/preferences`) and cached habits (`/habits`, 24 h).
- Home Assistant integration: `sensor.continente_server_status`, `binary_sensor.continente_session_valid`, `sensor.continente_list_items`, `sensor.continente_last_sync`, and a persistent notification with a link to the add-on page while the Continente session is expired. (2026-10-30)
- Add-on ingress page (pt-PT default, English, all strings in i18n files): status, Continente account form (0600 file, password never returned), on-demand sign-in with Xvnc + noVNC for the CAPTCHA, token management, JSON export. Web page, noVNC and admin routes are ingress-only. (2026-10-30)
- Shared list API: items CRUD with who-added, idempotent creates, last-write-wins edits, delta sync, in-cart state, clear/new list, history and repeat; pt-PT text parser (quantities and units) with `POST /lists/current/parse`. (2026-10-29)
- Continente MCP client: supervised stdio process with restart, typed wrappers for all 15 tools, session-expiry detection, single-worker job queue, and a test-mode guard (`CartWriter` + transport guard) proven by tests against a fake MCP. (2026-10-29)
- API server core: Fastify + TypeScript, `/api/v1/health`, hashed and revocable bearer tokens with ingress-only admin routes, SQLite schema migrations, OpenAPI contract with a contract test, and unit tests run in the image build. (2026-10-29)
- Prebuilt add-on images on ghcr.io (`ghcr.io/jpch/{arch}-continente-mcp`) and `repository.yaml` for installing from the HA add-on store. (2026-10-29)
- Add-on skeleton (`continente_mcp`): Debian trixie base, Node.js 22, `continentept-mcp` 0.12.1 with Chromium baked in, test mode on by default, pt/en option translations. (2026-10-29)
- CI build for aarch64 and amd64 with a headless `search_products` smoke test. (2026-10-29)
- README and CHANGELOG. (2026-10-29)

### Changed

- Proposal previews are invalidated by a revision counter instead of timestamps.
- Image now ships the full Chromium (headed, for the sign-in window) and TigerVNC/websockify/noVNC. (2026-10-30)
- Translated documentation to English (2026-10-29).
- Multi-language requirement: the add-on web page must keep all user-facing strings in i18n files, with no hardcoded text (2026-10-29).
