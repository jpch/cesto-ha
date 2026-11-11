# Architecture: Cesto (2.x)

Cesto is the Home Assistant add-on behind the Cesto Android app: a shared shopping list that prepares a
supermarket cart and **never checks out or pays**. Since 2.0.0 it does not talk to Continente itself: the generic
[Continente MCP add-on](https://github.com/jpch/continente-mcp-ha) owns the Continente account, session, sign-in
(noVNC), Chromium and the unofficial `continentept-mcp` package, and serves MCP over streamable HTTP to any agent.
Cesto is one of those agents, with its own priority token.

The 1.x design (one image with Chromium, Xvnc/noVNC and a stdio `continentept-mcp` child) is in the git history
before 2.0.0.

## 1. Constraints

- All server-side logic (parsing, matching, preview, cart orchestration, preferences, history) lives in this add-on.
  The Android app is a thin client of `cesto/server/openapi.yaml`.
- The real cart is changed (add, set quantity, remove, clear) only when `test_mode` is off. Checkout, payment,
  orders, delivery slots, vouchers, coupons, billing and cards are refused by a hard tool policy that no option
  turns off (`server/src/mcp/tools.ts`), independently of the Continente MCP add-on's own `allow_checkout`.
- Cesto stores no Continente password or browser session. 2.0.2 deletes the copy left by 1.x once the Continente
  MCP add-on has its own (see 4).
- Code, comments, docs and commits in English; user-facing strings in `server/web/i18n/*.json` (pt-PT default) and
  `translations/*.yaml`.

## 2. Components

```
Android app ──HTTP + Bearer (LAN :8099) ──────────┐
Android app ──HA ingress (remote, HA auth) ───────┤
HA web page (ingress, admins) ────────────────────┤
                                                  ▼
                         Cesto add-on (Node 22, TypeScript, Fastify, node:sqlite /data/app.db)
                           ├─ lists, parser, matcher, proposals, basket, promotions, sent history
                           ├─ connectors/continente ─► CachedCatalog ─► ContinenteMcp ─► TestModeGuard
                           │                                              └─► HttpMcpTransport (allowlist)
                           ├─ continente-link (discovery, token request, hand-off, legacy purge, /health poll)
                           └─ ha (Core API through the Supervisor: 4 entities + session notification)
                                                  │ streamable HTTP, Bearer cmcp_… (priority lane)
                                                  ▼
                         Continente MCP add-on (jpch/continente-mcp-ha)
                           └─ continentept-mcp (pinned) ─► Playwright Chromium ─► continente.pt
```

| Module (`server/src/`) | Responsibility |
| --- | --- |
| `config` | Add-on options (`/data/options.json`), own slug (container host name), `/share/continente-mcp` path |
| `db` | SQLite schema and ordered migrations (`PRAGMA user_version`) |
| `auth`, `pairing` | Per-device bearer tokens (SHA-256 hashes, revocable), QR pairing links |
| `app`, `web` | Fastify routes, LAN/ingress split, remote allowlists (`REMOTE_ROUTE`, `REMOTE_CART_ROUTE`, `NEVER_REMOTE`), rate limits, access log, static ingress page |
| `lists`, `parser`, `export` | Shared list with last-write-wins sync, pt-PT text parsing, export/import |
| `matcher`, `proposals`, `habits`, `basket`, `sent` | Item → product matching (preference > frequent > favourite > search), proposals, preview/apply jobs with cart read-back, "Produtos já enviados" |
| `promotions`, `search`, `thumbnails`, `vision`, `ai` | Promotion suggestions, catalogue search, allowlisted store thumbnails, photo hints (provider `none`), optional AI ranking |
| `connectors/*` | Supermarket connector interface; `continente` is the only one |
| `mcp/client` | `HttpMcpTransport`: streamable HTTP to the Continente MCP add-on, Bearer token, reads retried once on a dropped connection, cart changes never |
| `mcp/continente`, `mcp/tools`, `mcp/upstream` | Typed tool wrappers, test-mode guard, tool allowlist/denylist, the only reader of upstream result shapes |
| `queue`, `cache`, `keepalive`, `metrics` | One MCP job at a time with priorities, TTL caches for catalogue reads, read-only session keep-alive, timing summaries |
| `continente-link` | Link to the Continente MCP add-on (below) |
| `ha` | `sensor.continente_*`/`binary_sensor.continente_session_valid` and the session-expired notification |

## 3. Link to the Continente MCP add-on (`continente-link.ts`)

- **Endpoint:** option `continente_mcp_url`, else `/share/continente-mcp/endpoint.json` written by that add-on at
  start. Only a Supervisor add-on host `<hash>-continente-mcp` (or `localhost`) is accepted.
- **Token:** option `continente_mcp_token`, else Cesto generates `cmcp_…` once (`/data/continente-mcp/token`, 0600)
  and writes only its SHA-256 hash to `/share/continente-mcp/requests/cesto.json`. An HA admin approves it on the
  Continente MCP page, comparing the fingerprint shown on both pages. A 401 turns the state back to "waiting for
  approval" and re-writes the request.
- **Health:** every 30 s Cesto reads the public `GET /health` of that add-on (version, `addon_slug`,
  `session_valid`, `signing_in`, `credentials_configured`) and shows it on its page and in `GET /api/v1/health`.
  The slug is used for the "Open Continente MCP" links and for the HA notification link.

## 4. Migration from 1.x and the legacy data

1. **Hand-off (2.0.0, re-run once by 2.0.1):** when `endpoint.json` exists and the marker
   `/data/continente-mcp/handed-off` is not `v2`, Cesto copies `/data/continente` (account file and browser
   profile, no symbolic links) to `/share/continente-mcp/import/` and writes `READY` last. The Continente MCP add-on
   imports it only when it has no account or valid session of its own, and deletes the folder either way.
2. **Purge (2.0.2):** Cesto deletes `/data/continente` only when the marker is `v2`, the `import/` folder is gone
   (consumed), and the last health check reports `credentials_configured: true` or `session_valid: true`.
   Otherwise it keeps the data and tries again on the next poll. Older Cesto backups still contain the 1.x data.

## 5. Session and Home Assistant

- A `not_authenticated` tool result marks the session invalid; a session change seen in the Continente MCP
  add-on's health is adopted with a read-only `get_cart`. The keep-alive reads the cart every 20–30 min when idle.
- The `ha` module publishes four entities through the Supervisor's Core API proxy (`homeassistant_api`; Cesto does
  not use the Supervisor API itself) and raises one persistent notification while the session is invalid. It links
  to `/hassio/ingress/<Continente MCP slug>`, where the sign-in happens, or to the add-ons page while the slug is
  unknown. The entity ids keep their pre-rename `continente_` prefix so existing dashboards and automations work.

## 6. Remote access

Remote callers come through HA ingress with HA authentication. They reach only `REMOTE_ROUTE` (list API, catalogue
search, session check, sent history, connectors, health) and, with the `remote_cart` option, `REMOTE_CART_ROUTE`
(proposals, preview, apply, jobs, promotions, photos), with per-device rate limits. Checkout, payment, order and
address paths are always refused. Details: [remote-access.md](remote-access.md).

## 7. Tests

- Vitest unit and API tests (`npm test`, also inside the Docker build on both architectures), against a fake
  Continente MCP add-on over streamable HTTP (`server/test/fake-mcp.mjs`) so CI never reaches Continente.
- Contract tests (`server/test/contract/`): reviewed `tools/list` snapshot, anonymised fixtures, adapters and input
  schemas; see [upstream-updates.md](upstream-updates.md).
- Container smoke test: the API starts in test mode, refuses unauthenticated calls, reports the Continente MCP
  add-on as unavailable and bundles no MCP, browser or VNC.

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| The unofficial MCP breaks when the site changes | Pinned in the Continente MCP add-on, contract tests on both sides, release order in [upstream-updates.md](upstream-updates.md) |
| A new upstream tool could check out or pay | Allowlist on the transport, in `TestModeGuard` and `ContinenteMcp`; denylist by name; no option disables it |
| Accidental real cart change in test mode | `CartWriter` and `TestModeGuard`, tests with test mode on, banner on the page and in the app |
| `unknown` mutation outcome | Stop, read the cart back, `needs_attention`; mutations are never retried automatically |
| A fake token request in `/share` | Gives nothing without an admin approving it; the fingerprint is shown on both pages |
| Plain HTTP on the LAN | Home network only, bearer tokens, revocable; remote access only through HA ingress |
