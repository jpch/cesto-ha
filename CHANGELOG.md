# Changelog

All notable changes to this add-on are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- T14 installation report for the Home Assistant Pi (`docs/t14-pi-install.md`): installed 0.1.0 in test mode, health and entities verified, 35 MB idle.

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
