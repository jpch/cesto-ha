# Changelog

All notable changes to this add-on are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Add-on ingress page (pt-PT default, English, all strings in i18n files): status, Continente account form (0600 file, password never returned), on-demand sign-in with Xvnc + noVNC for the CAPTCHA, token management, JSON export. Web page, noVNC and admin routes are ingress-only. (2026-10-30)
- Shared list API: items CRUD with who-added, idempotent creates, last-write-wins edits, delta sync, in-cart state, clear/new list, history and repeat; pt-PT text parser (quantities and units) with `POST /lists/current/parse`. (2026-10-29)
- Continente MCP client: supervised stdio process with restart, typed wrappers for all 15 tools, session-expiry detection, single-worker job queue, and a test-mode guard (`CartWriter` + transport guard) proven by tests against a fake MCP. (2026-10-29)
- API server core: Fastify + TypeScript, `/api/v1/health`, hashed and revocable bearer tokens with ingress-only admin routes, SQLite schema migrations, OpenAPI contract with a contract test, and unit tests run in the image build. (2026-10-29)
- Prebuilt add-on images on ghcr.io (`ghcr.io/jpch/{arch}-continente-mcp`) and `repository.yaml` for installing from the HA add-on store. (2026-10-29)
- Add-on skeleton (`continente_mcp`): Debian trixie base, Node.js 22, `continentept-mcp` 0.12.1 with Chromium baked in, test mode on by default, pt/en option translations. (2026-10-29)
- CI build for aarch64 and amd64 with a headless `search_products` smoke test. (2026-10-29)
- README and CHANGELOG. (2026-10-29)

### Changed
- Image now ships the full Chromium (headed, for the sign-in window) and TigerVNC/websockify/noVNC. (2026-10-30)
- Translated documentation to English (2026-10-29).
- Multi-language requirement: the add-on web page must keep all user-facing strings in i18n files, with no hardcoded text (2026-10-29).
