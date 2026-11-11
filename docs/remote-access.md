# Remote access through Home Assistant ingress

Port 8099 is for the home network only and must not be forwarded. Away from home the app reaches Cesto through
Home Assistant's own ingress proxy on the external Home Assistant URL (Nabu Casa, the Cloudflared add-on or a
reverse proxy), authenticated by Home Assistant.

## What is reachable

- Always: health, `openapi.yaml`, `/me`, `/connectors`, the shared list (`/lists…`, `/items/{id}`), "Produtos já enviados"
  (`/history/products…`), the session check and the read-only product search (`POST /catalog/search`, at most
  10 searches per minute per user). This is `REMOTE_ROUTE` in `cesto/server/src/app.ts`, operations tagged `remote`
  in `openapi.yaml`.
- With the option `remote_cart` on: basket proposals, line edits, preview, apply, jobs, promotions and photos
  (`REMOTE_CART_ROUTE`, tagged `remote-cart`), at most 30 cart changes per device per minute, each logged once
  without ids or tokens.
- Never: checkout, payment, order or address paths, admin routes, preferences, habits. Anything else answers
  `403 error.remote_forbidden`.

Home Assistant strips client-sent `X-Remote-User-*` headers and sets them from the session user, so the add-on uses
the Home Assistant user as the author and needs no add-on token. A non-admin Home Assistant user is enough for the
list; the Cesto page and admin routes still require the `system-admin` group.

## Setup

1. Give Home Assistant a working external URL (Settings → System → Network → Home Assistant URL → Internet).
2. Recommended: create a dedicated **non-admin** Home Assistant user for the phones.
3. As that user, open Profile → Security → Long-lived access tokens → Create token.
4. In the app's Settings → "Acesso externo (HA)", enter the external URL and the token.
5. Optional: Settings → Add-ons → Cesto → Configuration → turn on **Remote cart**, save and restart the add-on.
   `GET /api/v1/health` then reports `"remote_cart": true`.

## Protocol (what the app does)

1. Open `wss://<external-ha-url>/api/websocket`, send `{"type":"auth","access_token":"<token>"}`, expect `auth_ok`.
2. `{"id":1,"type":"supervisor/api","endpoint":"/addons/<slug>/info","method":"get"}` → `result.ingress_url`.
   The slug is `<repository hash>_cesto`; the add-on reports it in the pairing QR (`&slug=`) and in `GET /health`
   (`addon_slug`).
3. `{"id":2,"type":"supervisor/api","endpoint":"/ingress/session","method":"post"}` → `result.session`.
4. Call `https://<external-ha-url><ingress_url>api/v1/…` with `Cookie: ingress_session=<session>`.
5. Every ~5 minutes in use, `{"type":"supervisor/api","endpoint":"/ingress/validate_session","method":"post","data":{"session":"<session>"}}`.
   Sessions expire after about 15 minutes of inactivity. On 401 create a new session; on 429 wait `Retry-After`.

## Timeouts

Home Assistant ingress does not cut long requests. A reverse proxy in front of Home Assistant (nginx based) often
closes an idle upstream read after 60 s; keep it at **60 s or more**. Long work (matching, preview, apply) runs as
jobs the app polls, so remote requests return quickly.
