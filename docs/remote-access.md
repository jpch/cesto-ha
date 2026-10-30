# Remote access (list API only)

Replaces spec decision 9. Away from home the Android app reaches **only the shared list API**, through the
external Home Assistant URL, authenticated by Home Assistant with a long-lived access token. The Continente
MCP, the cart, basket proposals, previews, apply jobs, photos, promotions, preferences and habits are never
reachable this way.

## Design: Home Assistant ingress

Home Assistant already proxies add-ons through ingress (`/api/hassio_ingress/<token>/...`) on its own URL,
including the external one (Nabu Casa or the Cloudflared add-on). The add-on port 8099 is **not** forwarded
to the internet.

- Every request that arrives through ingress comes from the Supervisor (`172.30.32.2`). For those requests the
  add-on applies a fixed allowlist (`REMOTE_ROUTE` in `src/app.ts`): health, openapi.yaml, `/me`, `/lists...`
  and `/items/{id}`. Anything else answers **403 `error.remote_forbidden`**, even with a valid add-on token.
  There is no option to change this.
- Ingress requests are authenticated by Home Assistant. The Supervisor strips any client-sent `X-Remote-User-*`
  headers and sets them from the session user, so the add-on uses the HA user's display name as author and
  needs no add-on token.
- `panel_admin: false` lets a **non-admin** HA user use ingress, so the phone does not need an admin token. The
  add-on page and its admin routes still require the `system-admin` group (403 `error.admin_only`).
- On the LAN (direct port 8099, add-on bearer token) the full API is unchanged.
- Ingress is local too: the list API through the HA URL behaves the same at home and away.

Tested in `test/remote.test.ts`: every non-list operation in `openapi.yaml` returns 403 through ingress, the
`remote` tags in `openapi.yaml` match the allowlist exactly, non-admin users cannot reach the admin page, and no
Continente call is made.

### Feasibility (checked 2026-10-30 against the installed versions)

Home Assistant Core 2026.10.2, Supervisor 2026.10.5:

- Core WebSocket `supervisor/api` allows non-admin users to call `/addons/<slug>/info` and
  `/ingress/session` / `/ingress/validate_session` (`WS_NO_ADMIN_ENDPOINTS` in `hassio/websocket_api.py`).
- Supervisor ingress accepts the `ingress_session` cookie, denies non-admins only when `panel_admin` is true,
  and forwards `X-Remote-User-Id/Name/Display-Name/Groups` after stripping client copies (`supervisor/api/ingress.py`).
- Ingress sessions expire after about 15 minutes of inactivity; `validate_session` extends them.

## App flow (OkHttp works for both steps)

1. Open `wss://<external-ha-url>/api/websocket`. Wait for `auth_required`, send
   `{"type":"auth","access_token":"<HA long-lived token>"}`, expect `auth_ok`.
2. `{"id":1,"type":"supervisor/api","endpoint":"/addons/75545ee1_continente_mcp/info","method":"get"}` and take
   `result.ingress_url` (e.g. `/api/hassio_ingress/AbC.../`). Cache it; it only changes if the add-on is reinstalled.
3. `{"id":2,"type":"supervisor/api","endpoint":"/ingress/session","method":"post"}` and take `result.session`.
4. Call `https://<external-ha-url><ingress_url>api/v1/lists/current` (and the other `remote` operations) with
   `Cookie: ingress_session=<session>`. No `Authorization` header is needed.
5. Every ~5 minutes while in use, send
   `{"type":"supervisor/api","endpoint":"/ingress/validate_session","method":"post","data":{"session":"<session>"}}`.
   On HTTP 401 from ingress, create a new session (step 3). On 403 `error.remote_forbidden`, the screen is LAN-only:
   hide it away from home.

## Setup for João

1. Make sure Home Assistant has an external URL that works (Cloudflared add-on or Nabu Casa), set in
   Settings > System > Network > Home Assistant URL > Internet.
2. Recommended: create a dedicated **non-admin** HA user for the phone(s) (Settings > People > Users > Add user,
   "Can only log in from the local network" off, Administrator off).
3. Log in as that user, open Profile > Security > Long-lived access tokens > Create token, and copy it.
4. In the app, enter the external HA URL and the token in the remote access settings.
5. Do not forward port 8099 in the router.
