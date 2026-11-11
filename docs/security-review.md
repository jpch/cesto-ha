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

## Cesto 1.3.0 (add-on `cesto` 1.3.0)

Reviewed 2026-10-31 before release. Scope: continentept-mcp contract tests, adapter module and the automated update workflow. Verdict: **no Critical or High findings open; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 25 | CI token exposure | First draft ran the new upstream package (`tools/list`) in the job holding a `contents: write` token persisted in `.git/config`; a malicious release could have pushed to `main`. Fixed: upstream code runs only in jobs with `contents: read` and `persist-credentials: false` (`check`, `contract`); the writing jobs (`prepare`, `merge`, `release`) never install or run it. Top-level `permissions: {}`. | High | Fixed |
| 26 | Supply chain | Auto-merge ships a new upstream release without a human reading its code. A compromised release with unchanged tool shapes would be built into the image (where the Continente session lives). Mitigations: 72-hour cooldown after the npm publish on scheduled runs (most malicious releases are pulled sooner), `--ignore-scripts` wherever CI runs it outside the image, the PR links the npm diff, every change is a reviewable PR/release, and Home Assistant only installs add-on updates when the user does (unless auto-update is enabled for the add-on). | Medium | Accepted (residual) |
| 27 | Allowlist bypass | A new upstream tool (e.g. checkout or payment) cannot be reached: calls are limited to the static allowlist plus `FORBIDDEN_TOOL`, on three layers. The contract check fails CI and the image build on any new tool and the update PR is not merged; names matching the checkout/payment pattern are flagged in the PR. A test keeps the script's pattern equal to `FORBIDDEN_TOOL`. *2.0.2: the contract check and update workflow live in the Continente MCP add-on; Cesto tests `FORBIDDEN_TOOL`/`isForbidden` directly (finding 48).* | None | OK |
| 28 | Workflow injection | Version strings from npm or `workflow_dispatch` are validated as `x.y.z` before use; all untrusted values reach shell through environment variables, never `${{ }}` in scripts. Tool names in the PR body are restricted to identifier characters or shown escaped. `actionlint` clean. | None | OK |
| 29 | Repository setting | The update needs "Allow GitHub Actions to create and approve pull requests". Any workflow with `pull-requests: write` could then open or approve PRs; only `upstream-bump.yaml` requests it, and `main` has no required-review rule that approval could bypass. | Low | Accepted |
| 30 | Secrets and personal data | The live check uses an empty temporary data directory and a minimal environment, so no credentials, cookies or sessions are read. Fixtures are anonymised and a test rejects e-mails, phone numbers, IPs, tokens, long opaque strings and non-store hosts. | None | OK |
| 31 | Dependencies | New dev dependencies `ajv` 8.20.0 and `ajv-formats` 3.0.1 (tests only, pinned, not in the image). New action `actions/setup-node` pinned by SHA. `npm audit`: 0 vulnerabilities. | None | OK |

## Cesto 1.3.1 (add-on `cesto` 1.3.1)

Reviewed 2026-10-31 before release. Scope: asynchronous basket proposals. Verdict: **no Critical or High findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 32 | Exposure | Async proposals use the existing LAN-only `/basket/proposals` routes; the remote allowlist is unchanged. Matching is read-only (search, favourites, order history); no cart write, checkout or payment is added. | None | OK |
| 33 | Resource use | A client could start runs repeatedly; only one async run exists at a time (a new request joins it), runs are serialized on the single MCP queue, and failed entries expire after 10 minutes. Requires a valid token. | Low | Accepted |
| 34 | Information leak | A failed run reports only a fixed message key and HTTP status, never the raw upstream error text. | None | OK |


## Cesto 1.3.2 (add-on `cesto` 1.3.2)

Reviewed 2026-10-31 before release. Scope: logging of slow requests. Verdict: **no findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 35 | Logging | Slow successful requests use the existing access-line format (method, path without query, status, LAN/ingress, token id, duration); no token, body or personal data is written. | None | OK |

## Cesto 1.4.0 (add-on `cesto` 1.4.0)

Reviewed 2026-10-31 before release. Scope: async promotion search and unit-price alternatives. Verdict: **no Critical or High findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 36 | Exposure | The new `/promotions/searches` routes are not in the remote allowlist (LAN only, like `/promotions`); they need a phone token. | None | OK |
| 37 | Cart safety | The search only calls `search_products`; it never reads or writes the cart, and no checkout or payment path exists. Adding an alternative uses the existing proposal line edit, which only changes the proposal. | None | OK |
| 38 | Resource use | One search at a time (a new request joins it), at most 20 items, one queued MCP call per item; cancel stops after the current item; results expire after 30 minutes. | Low | Accepted |

## Cesto 2.0.0 (add-on `cesto` 2.0.0)

Reviewed 2026-11-03 before release (high risk: tokens and remote access). Scope: removal of the bundled MCP and
sign-in, the link to the Continente MCP add-on, the token request and the session hand-off. Verdict: **no
Critical or High findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 39 | Token | Cesto's token for the Continente MCP add-on is generated locally (32 random bytes), stored in `/data/continente-mcp/token` (0600) and sent only in the `Authorization` header to the discovered endpoint. `/share` gets only its SHA-256 hash; status and health show a 4+4 hex fingerprint, never the token. `test/continente-link.test.ts` checks it. | None | OK |
| 40 | Discovery | `endpoint.json` is written by any add-on that maps `/share`. Cesto accepts only an `http://<hash>-continente-mcp:<port>/mcp` host (or `localhost`), so another add-on cannot redirect the token to an arbitrary host; a hostile add-on would need a `continente_mcp` slug from another repository. The `continente_mcp_url` option overrides discovery. | Low | Accepted |
| 41 | Hand-off | The one-time copy of the 1.x session and account to `/share/continente-mcp/import/` (0700, READY last) is readable by other `/share` add-ons for a few seconds; see the Continente MCP add-on review, finding 8. The local copy stays for rollback. *2.0.2: the local copy is deleted once the Continente MCP add-on confirms its own account or session (finding 45).* | Medium | Accepted |
| 42 | API | No route changes its authentication. The removed account and sign-in routes answer 410; `remote_cart`, the remote allowlist and checkout/payment refusal are unchanged; the tool allowlist is now enforced on `HttpMcpTransport` before any request. Cart changes are never retried. | None | OK |
| 43 | Image | The image no longer contains Chromium, Xvnc, websockify or noVNC (smaller attack surface; the smoke test asserts they are absent). | None | OK |

## Cesto 2.0.2 (add-on `cesto` 2.0.2)

Reviewed 2026-11-11 (PR #45 @ 195b8d0, with continente-mcp-ha PR #5 @ 36839ac) by an independent reviewer before
release. Verdict: **no Critical, High or Medium findings; release allowed.**

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| 44 | Least privilege | `hassio_api` removed. The Supervisor was only used to read Cesto's own slug; the entities and the session notification use the Core API proxy (`homeassistant_api`). A test asserts every Supervisor call goes to `/core/api/`. | None | OK |
| 45 | Credential retention | The 1.x `/data/continente` (`credentials.env` with the Continente password, browser profile) is deleted only when the v2 hand-off marker exists, `/share/continente-mcp/import` and `import.tmp` are gone, and the Continente MCP add-on's last `/health` reports `credentials_configured === true` or `session_valid === true`. Fixed path (no traversal); `rmSync` does not follow symlinks; Cesto's token in `/data/continente-mcp/` is never touched; an unreachable or invalid `/health` deletes nothing. Backups taken before 2.0.2 still contain the 1.x credentials: delete old Cesto backups. Supersedes "the local copy stays for rollback" in finding 41. | None | OK |
| 46 | Spoofed confirmation | `/health` is unauthenticated. A hostile add-on that maps `/share` and runs as `<hash>-continente-mcp` (a `continente_mcp` slug from another repository) could remove `import/` and claim an account, so Cesto deletes its 1.x copy early (loss of rollback data, no disclosure). The same position already allows reading the hand-off (finding 41). Possible hardening: require `addon_slug` to match the endpoint hostname. | Low | Accepted |
| 47 | Notification and page link | The Continente MCP slug from `/health` is validated (`^[a-z0-9]+_[a-z0-9_]+$`) before it is used in `/hassio/ingress/<slug>` (notification) and is also URI-encoded on the page (`textContent` for text). Otherwise the link is `/hassio/dashboard`. No markdown injection, script URL or open redirect. | None | OK |
| 48 | Removed code | `StdioMcpTransport`, `MCP_COMMAND` and `scripts/upstream-tools.mjs` removed. The live contract check and pin live in the Continente MCP add-on; the test that compared the script's pattern with `FORBIDDEN_TOOL` (finding 27) is replaced by direct tests of `FORBIDDEN_TOOL`/`isForbidden`; the allowlist is still enforced on the HTTP transport. | None | OK |
| 49 | Dependencies | fastify 5.12.8, vitest 5.1.0 (dev), `actions/setup-node` 7.1.0 pinned by commit SHA (verified as the `v7.1.0` tag commit). Lockfile hunks identical to Dependabot's. Dependabot ignores major `@types/node` (runtime Node.js 22). `npm audit`: 0 vulnerabilities. | None | OK |
| 50 | Log noise | A persistent failure to delete the 1.x data is logged every 30 s. | Low | Accepted |
