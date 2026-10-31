# Security review: Cesto 1.0.0

Reviewed 2026-10-31 (add-on `cesto` 1.0.0, app `app.cesto` 1.0.0) before release. Verdict: **no Critical or High findings; release allowed.** Medium/Low findings below are accepted or tracked.

## Threat model

Assets: the supermarket account and session (in the add-on only), the household list and history, device tokens, the HA long-lived token on phones. Actors: household members (trusted), other LAN devices (untrusted), non-admin HA users (list only), internet attackers (only through HA ingress, if HA is exposed). Out of scope: a compromised HA host.

## Findings

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | Checkout/payment | Tool calls go through an explicit allowlist (11 read, 4 cart tools) plus a denylist regex; anything else, including future checkout/payment/order/slot/voucher tools, is refused. Test mode simulates every mutating call. Covered by tests. | None | OK |
| 2 | Authn | Device tokens are 256-bit random (`cesto_` + base64url), stored only as SHA-256, revocable per device; legacy `cmh_` tokens still verify. Pairing response is `no-store`. | None | OK |
| 3 | Authz / ingress | Admin routes (tokens, pair, credentials, login, export, import) answer only from the Supervisor ingress address, and reject HA users not in `system-admin`. Remote (ingress) callers reach only `REMOTE_ROUTE` (health, me, connectors, list API); everything else is `403 error.remote_forbidden` (tested against the OpenAPI `remote` tags). | None | OK |
| 4 | Authz / ingress | The admin check is fail-open when the Supervisor sends no `X-Remote-User-*` headers (only very old Supervisors). | Medium | Accepted; revisit by requiring the header |
| 5 | Transport | LAN API is plain HTTP with bearer tokens on port 8099 (decision 4); the app permits cleartext. A LAN attacker who can sniff traffic could capture a device token (list + cart preview/apply, never checkout). Remote access uses HTTPS via HA. | Medium | Accepted by design; revoke tokens on the add-on page |
| 6 | Injection | SQLite access uses prepared statements; inputs validated (store ids against enabled connectors, product ids by pattern, pairing address must be a bare http(s) origin). QR is server-generated SVG shown via `<img>` (no script execution). Import accepts only the two export formats into an empty DB, in one transaction. | None | OK |
| 7 | Secrets/PII | Git history rewritten to remove real IPs, hostnames, names and e-mails; no secrets in code. Supermarket credentials only in the add-on data dir; keystore only in Actions secrets. Old IP remains in read-only `refs/pull/*` on GitHub (needs GitHub Support to purge). | Low | Tracked |
| 8 | Android | Only the launcher activity is exported; no deep-link intent filter (QR is scanned in-app and strictly parsed). `allowBackup=false`; tokens encrypted with Android Keystore keys. Cleartext see #5. | Low | OK |
| 9 | Dependencies | `npm audit`: 0 vulnerabilities (prod and dev). New dependency `qrcode-generator` 2.0.4 (MIT, no deps). Gradle dependencies are recent stable releases; no automated scanner in CI yet. | Low | Add Dependabot |
| 10 | GitHub Actions | App workflow default `contents: read`; only the tag-only release job has `contents: write`; keystore decoded to the runner temp dir and deleted. cesto-releases publishing uses an optional fine-grained `RELEASES_TOKEN` scoped to that repo. Add-on workflow: `packages: write` needed to push images, pushes only on `main`/tags. Actions pinned by major tag, not SHA. | Low | Accepted |

## Cesto 1.1.0 (add-on `cesto` 1.1.0, app `app.cesto` 1.1.0)

Reviewed 2026-10-31 before release. Scope: product thumbnails in candidate lists and editable list items. Verdict: **no Critical or High findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 11 | SSRF | Thumbnails are not proxied: the add-on only rewrites the connector's image URL (`thumbnailUrl`) and returns it when it is https, on an allowlisted store image host (`www.continente.pt`), without credentials or a custom port; otherwise `null`. The add-on makes no new outbound request, so there is no SSRF surface. Covered by `test/thumbnails.test.ts` (other hosts, look-alike hosts, IPs, `.local`, http, `file:`, userinfo, ports). | None | OK |
| 12 | Privacy | The phone now loads thumbnails directly from the store CDN (as the photo search already did), so the CDN sees the phone's IP and the product images viewed. No token or cookie is sent: the image loader is a separate client without the API auth interceptor, and the app also refuses non-https or non-allowlisted thumbnail hosts. | Low | Accepted |
| 13 | Android cache | Thumbnails are cached in the app's private cache dir (Coil disk cache, 50 MB, evictable by the OS); no list data is written there. | None | OK |
| 14 | Item edits | Edits reuse the existing `PATCH /items/:id` (last write wins, `client_id`/`updated_at`); the linked product is validated server-side (`linkedProduct`: product id pattern, https-only image, length limits). Offline edits are queued in Room and replayed in order; a queued create carries the latest local state. No new route, no cart call: editing never touches the supermarket cart. | None | OK |
| 15 | Dependencies | No new dependencies (server or app). `npm audit` unchanged. | None | OK |

## Cesto 1.2.0 (add-on `cesto` 1.2.0, app `app.cesto` 1.2.0)

Reviewed 2026-10-31 before release. Scope: product search from outside home and the add-on slug in pairing/health. Verdict: **no Critical or High findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 18 | Remote surface | `POST /catalog/search` joins `REMOTE_ROUTE`. It only calls the connector's read-only `search_products`/barcode lookup inside the add-on (stdio MCP child, never exposed); the cart, basket, jobs, photos, promotions, preferences and habits stay 403 through ingress. Authentication is unchanged (HA session/token via ingress). `test/remote.test.ts` keeps the openapi `remote` tags equal to the allowlist and asserts no cart call. | Low | Accepted |
| 19 | Abuse / cost | A leaked HA token could drive searches (headless browser load, store traffic). Mitigated by a per-user in-memory limit (10/min, keyed by HA user id or add-on token id; 429 with `Retry-After`) and the existing serial job queue. Limiter memory is bounded by the number of users/tokens. | Low | Mitigated |
| 20 | Information disclosure | `GET /health` (unauthenticated) now returns `addon_slug`. The slug is derivable from the public repository URL and grants nothing without an HA token. Validated against `^[a-z0-9]+_[a-z0-9_]+$`; anything else is `null`. | None | OK |
| 21 | Pairing | The QR adds `&slug=`; the app validates it with the same pattern before storing it or putting it into a Supervisor endpoint path, so a crafted QR cannot point the WebSocket call at another Supervisor endpoint. | None | OK |
| 22 | Dependencies | No new dependencies. | None | OK |

## Cesto 1.2.1 (add-on `cesto` 1.2.1, app `app.cesto` 1.2.1)

Reviewed 2026-10-31 before release. Scope: access log (add-on), sync fix and error messages (app). Verdict: **no Critical or High findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 23 | Logging | The access log writes method, path without query string, status, path kind (lan/ingress), token id or `ha-user`, and a fixed auth-failure reason. Never the bearer token, cookies, `X-Remote-*` values, IP addresses or bodies; covered by `test/remote.test.ts`. Successes only at `debug`, so the log does not grow with the 30 s poll. | None | OK |
| 24 | Dependencies | No new dependencies. | None | OK |
