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
