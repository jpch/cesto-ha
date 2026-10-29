# Architecture: Continente Basket Builder

Status: proposed (tech lead plan, v1). Source spec: [`jpch/assistente-compras/docs/spec.md`](https://github.com/jpch/assistente-compras/blob/main/docs/spec.md) (39 decisions).

## 1. Goal and constraints

Turn the household's shared shopping list into a Continente.pt cart, with preview and explicit confirmation, **never checkout or payment**.

Hard rules:
- All server-side logic (parsing, matching, MCP calls, preview, cart mutations, preferences) lives in this add-on (decision 39). The Android app (`jpch/assistente-compras`) is a thin UI client.
- Test mode runs the full pipeline, including `preview_cart_changes`, but **never** calls a cart-mutating MCP tool (decision 37).
- Continente credentials and the session exist only on the server (decision 11).
- Code, comments, docs and commits in English. UI in European Portuguese by default, all user-facing strings in i18n files (decision 24).
- Each repo keeps a root `README.md` and a Keep a Changelog `CHANGELOG.md`, updated with every feature.

## 2. Feasibility spike: ARM (Raspberry Pi 5)

Target host (read-only check via the HA API, 2026-10-29): Home Assistant OS 18.2, board `rpi5-64`, arch `aarch64`, Docker 29.6.2, 57.3 GB disk (13.1 GB used).

Findings:
- `continentept-mcp` 0.12.1 (andredelgado/continente-mcp) is Node.js ≥ 22 + Playwright 1.64.1 driving Chromium. **Transport is stdio only**; it is also importable as a library (`dist/index.js`).
- Playwright 1.64.1 ships Chromium 156.0.8078.4 for `debian12-arm64` and `debian13-arm64` (Chrome for Testing builds). There is **no build for Alpine/musl**.
- `https://cdn.playwright.dev/builds/cft/156.0.8078.4/linux-arm64/chrome-headless-shell-linux-arm64.zip` downloads (125.7 MB); the binary is glibc aarch64 (`NEEDED ld-linux-aarch64.so.1`, `libc.so.6`, nss, glib, X11 libs, gbm, asound).
- Home Assistant publishes `ghcr.io/home-assistant/aarch64-base-debian:bookworm` and `:trixie`.

Verdict: **feasible, with a Debian base image (not the default Alpine base)**. Not yet verified: an actual run on aarch64 (the planning box has no Docker/QEMU), so task T1 is a gate: build the image for `linux/arm64` in CI (QEMU) and run a headless smoke test (`search_products`), then confirm RAM/CPU on the Pi.

Consequences:
- Base image `ghcr.io/home-assistant/{arch}-base-debian:trixie`, Node 22 from NodeSource, `npx playwright install --with-deps chromium` at **build time** (no runtime download; `PLAYWRIGHT_BROWSERS_PATH=/opt/pw`).
- Supported arches: `aarch64`, `amd64` only (no armv7: no Chromium build).
- One shared Chromium process, contexts closed after each job; cap via the job queue (decision 17).

### CAPTCHA ("Não sou um robô")
The MCP cannot solve it and, without a display, tells you to run `continentept-mcp login --show-browser`. Design: the add-on runs **Xvfb + x11vnc + noVNC** only while a login session is open; the add-on web page (HA ingress) embeds the noVNC view so the user ticks the box, then the session is saved to `CONTINENTE_DATA_DIR=/data/continente`. Credentials come from the add-on page and are written to `/data/continente/credentials.env` (0600).

## 3. Components (add-on container)

```
Android app ──HTTP+Bearer──► API server (Node 22, TypeScript, Fastify)
HA web page (ingress) ─────►   ├─ list service (SQLite, better-sqlite3, /data/app.db)
                               ├─ parser (text → qty/unit/description)
                               ├─ matcher + preferences
                               ├─ basket service (preview/apply, job queue, test-mode guard)
                               ├─ MCP client (@modelcontextprotocol/sdk, stdio child process)
                               │      └─ continentept-mcp ─► Playwright Chromium ─► continente.pt
                               ├─ vision service (pluggable provider: OpenAI / Gemini / none)
                               ├─ login service (Xvfb + noVNC, on demand)
                               └─ HA integration (Supervisor API: sensors, notifications)
```

Modules (`server/src/`):

| Module | Responsibility |
| --- | --- |
| `config` | Add-on options (`/data/options.json`): `test_mode`, `vision_provider`, `vision_api_key`, `log_level`, language |
| `db` | SQLite schema + migrations; tables `lists`, `items`, `tokens`, `preferences`, `history_runs`, `history_items`, `product_cache` |
| `auth` | Per-phone/per-app bearer tokens (hashed, revocable), ingress trust for the web page |
| `lists` | CRUD, last-write-wins via `updated_at` + client `base_version`, "in cart" state, new list/clear |
| `parser` | Free text → items (`2 kg batata`, `leite x6`, `1 l azeite`); units un/kg/g/l/ml |
| `mcp` | Spawn and supervise `continentept-mcp`, typed wrappers per tool, session-expired detection |
| `habits` | Cache of `list_frequently_bought_products`, `list_favorites`, `list_orders` (refresh daily) |
| `matcher` | Item → ranked candidates: learned preference > frequent > favourite > search; 2–4 options when generic; promo and out-of-stock alternatives (≤3) |
| `basket` | Build proposal → `preview_cart_changes` → confirm → `add_cart_item`/`set_cart_item_quantity` (and `clear_cart` if "empty first") → `get_cart` verify; `unknown` outcome stops and re-reads |
| `queue` | Single-worker job queue (one MCP job at a time); offline/expired-session queueing |
| `vision` | Barcode lookup (EAN from phone) → OCR/vision provider → candidate products; photo deleted, thumbnail kept |
| `ha` | Sensors `sensor.continente_server_status`, `binary_sensor.continente_session_valid`, `sensor.continente_list_items`, `sensor.continente_last_sync`; persistent notification on expired session |
| `web` | Ingress page: login/CAPTCHA, tokens, test mode indicator, JSON export, status; i18n `web/i18n/pt-PT.json`, `en.json` |
| `discovery` | mDNS `_continente-basket._tcp` announce (decision 21) |

Test-mode guard: the `mcp` module exposes mutating tools only through a `CartWriter` that, in test mode, returns simulated results computed from the preview and logs them; a unit test asserts that no mutating tool name reaches the MCP transport while `test_mode=true`.

## 4. API contract (v1, JSON, `http://<ha>:8099/api/v1`)

Auth: `Authorization: Bearer <token>` (tokens created on the add-on page; the app stores it in Android Keystore). Errors: `{ "error": { "code": "...", "message_key": "..." } }` (message keys so the app localises them). The OpenAPI file `server/openapi.yaml` is the source of truth; the app generates its client from it.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | No auth. `{version, test_mode, session_valid, queue_length}` |
| `GET /lists/current` | Current list with items; `ETag`/`version` |
| `GET /lists/current/changes?since=<version>` | Delta sync |
| `POST /lists/current/items` | Add item `{name, quantity?, unit?, note?, client_id}` |
| `PATCH /items/{id}` | Edit (last write wins on `updated_at`) |
| `DELETE /items/{id}` | Delete |
| `POST /lists/current/parse` | `{text}` → proposed items (not saved) |
| `POST /lists/current/clear` | `{scope: "in_cart" \| "all"}` |
| `POST /lists` / `GET /lists/history` / `POST /lists/history/{id}/repeat` | New list, history, repeat (always via preview) |
| `POST /photos` | multipart image or `{barcode}` → candidates |
| `POST /basket/proposals` | Run matching → `{proposal_id, lines:[{item_id, selected, options[], promo?, out_of_stock?, quantity}]}` |
| `PATCH /basket/proposals/{id}` | User choices (product, quantity, skip, `empty_cart_first`) |
| `POST /basket/proposals/{id}/preview` | Recompute from current cart; `preview_cart_changes` → `{estimated_total, adds, refusals, warnings}` |
| `POST /basket/proposals/{id}/apply` | Requires `preview_id` from the latest preview → job id |
| `GET /jobs/{id}` | `queued \| running \| done \| needs_attention`, summary (added, failed, total, cart URL) |
| `GET /cart` | Read-only cart (`get_cart`) |
| `GET /session` | Continente session state |

Chosen products in `apply` are saved as shared preferences. Checkout is never exposed; the app's "Finish purchase" opens `https://www.continente.pt/checkout/carrinho/` in the browser.

## 5. Android app (`jpch/assistente-compras`)

Kotlin, Jetpack Compose, Material 3, Hilt, Retrofit/OkHttp + kotlinx.serialization (client from OpenAPI), Room (cache + offline queue), WorkManager (periodic sync while open + queued writes), ML Kit barcode scanning, CameraX, Android SpeechRecognizer, NSD for discovery, EncryptedSharedPreferences/Keystore for the token. All strings in `res/values/strings.xml` (pt-PT default) with `values-en`. Release: GitHub Actions builds a signed APK attached to releases (Obtainium).

Screens: Setup (discover/IP + token), List, Add (text/dictation/photo), Parse review, Matching choices, Preview, Sync summary, History, Settings, Disclaimer (unofficial MCP, no checkout).

## 6. Test strategy

- Server: Vitest unit tests (parser, matcher, LWW, test-mode guard), API tests with a **fake MCP server** (stdio, recorded fixtures) so CI never touches Continente; contract test `openapi.yaml` vs routes.
- Real MCP only in test mode, manually, on the Pi.
- Image: CI `docker buildx --platform linux/arm64,linux/amd64` + headless smoke test.
- App: JUnit + Compose UI tests against MockWebServer; lint for hardcoded strings (`HardcodedText` as error).

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Unofficial MCP breaks when the site changes | Pin version, update via Renovate, fake-MCP tests, clear error surfaced in app |
| Chromium on Pi 5: RAM/CPU, image size (~1 GB) | Single browser, queue, headless shell, T1 gate measures it |
| CAPTCHA requires a visible browser | Xvfb + noVNC on the ingress page, on demand |
| Session cookies in `/data` | 0600 files, included in HA backups (documented as sensitive) |
| Accidental real cart change in test mode | `CartWriter` guard + unit test + test-mode banner in app/web |
| `unknown` mutation outcome | Stop, `get_cart`, `needs_attention` job, no automatic retry |
| Vision AI costs/privacy | Optional, provider configurable, photos deleted after identification |
| Plain HTTP on LAN | Home network only, bearer tokens, revocable; HTTPS optional later |
