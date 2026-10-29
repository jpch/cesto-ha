# Task list: Continente Basket Builder v1

Ordered; each task is one PR with tests, README/CHANGELOG updates and English commits. "S" = server repo (`continente-mcp-ha`), "A" = app repo (`assistente-compras`). Tasks with the same wave can run in parallel.

## Wave 0: feasibility gate
**T1 (S) Add-on skeleton + ARM smoke test.** `config.yaml` (arches aarch64/amd64, ingress, port 8099, options incl. `test_mode: true` default), Debian trixie base Dockerfile, Node 22, Playwright Chromium baked in, `continentept-mcp` pinned. CI builds `linux/arm64` + `amd64` via buildx/QEMU and runs a headless `search_products("leite")` smoke test.
- AC: image builds for both arches; smoke test returns ≥1 product on arm64 in CI; image size and peak RSS recorded in the PR; installing on the Pi is done manually by Alex, not by the pipeline.

## Wave 1: foundations
**T2 (S) Server core.** Fastify + TypeScript, config loader, structured logs, `/api/v1/health`, SQLite migrations (all tables), token auth (hashed, revocable), `openapi.yaml`.
- AC: unit/API tests green; unauthenticated calls 401 except `/health`; DB in `/data`.

**T3 (S) MCP client + fake MCP.** Spawn/supervise `continentept-mcp` over stdio, typed wrappers for all 15 tools, session-expired detection, single-worker queue, `CartWriter` test-mode guard. Fake MCP server for tests.
- AC: test proves no mutating tool reaches the transport in test mode; crash → restart; queue serialises jobs.

**T4 (A) App skeleton.** Compose + Hilt + Room + Retrofit generated from `openapi.yaml`, setup screen (NSD discovery, manual IP 192.0.2.10 fallback, token in Keystore), strings.xml pt-PT + en, lint `HardcodedText` as error, CI build + signed APK release workflow.
- AC: APK installable via Obtainium from a release; `/health` shown; no hardcoded strings.

## Wave 2: list
**T5 (S) Shared list API + parser.** Items CRUD, delta sync, LWW, who-added, in-cart state, clear/new list, history, `parse` endpoint (pt units/quantities).
- AC: parser table tests (≥30 pt-PT cases); LWW conflict tests; two tokens show different "added by".

**T6 (A) List UI + sync.** List screen, add by text/paste/dictation, parse review, offline queue (Room), sync on open/periodic/manual, in-cart strike-through.
- AC: works offline then syncs; MockWebServer UI tests.

## Wave 3: Continente
**T7 (S) Login & session web page.** Ingress page (i18n pt-PT/en), credentials form → `/data/continente/credentials.env`, on-demand Xvfb+noVNC CAPTCHA flow, session status, token management, test-mode indicator, JSON export.
- AC: login with CAPTCHA completed through the page in a manual test; export downloads list + history JSON; no strings hardcoded.

**T8 (S) HA integration.** Four sensors + persistent notification with link on expired session; queued lists while expired.
- AC: entities visible in HA; notification fired by a simulated expiry in tests.

**T9 (S) Habits + matcher + preferences.** Cache frequent/favourites/orders, ranking, 2–4 options for generic items, promo suggestion, out-of-stock ≤3 alternatives, weighed-product quantities, learned shared preferences.
- AC: matcher unit tests on fixtures; chosen product reused next run.

**T10 (S) Basket preview/apply.** Proposal, preview (recomputed from current cart), apply with `preview_id`, merge vs empty first, `get_cart` verify, `unknown` → `needs_attention`, mark items in cart, history update.
- AC: fake-MCP end-to-end tests; test mode returns simulated summary and the real cart is untouched.

**T11 (A) Matching, preview and summary UI.** Choices, preview (total, adds, refusals, promos), confirm, job progress, summary + "open cart on Continente", disclaimer screen (unofficial, no checkout), history repeat.
- AC: UI tests; checkout button only opens continente.pt.

## Wave 4: photo
**T12 (S) Photo/vision service.** Barcode lookup via search, vision provider abstraction (OpenAI/Gemini/none) with key in options, candidates, photo deletion + thumbnail.
- AC: provider mocked in tests; original photo never persisted.

**T13 (A) Camera + barcode.** CameraX + ML Kit barcode; fall back to photo upload; candidate chooser adds to list (never cart).
- AC: barcode path works offline-first (queued).

## Wave 5: release
**T14 (S+A) End-to-end validation in test mode on the Pi**, docs (API docs for other apps, README, CHANGELOG), v1.0.0 release notes. Turning test mode off is The owner's decision.
