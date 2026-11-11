# Cesto for Home Assistant

**Cesto** is a self-hosted shared shopping list that prepares your supermarket cart. This repository is the Home
Assistant add-on: the server behind the [Cesto Android app](https://github.com/jpch/cesto-releases). Each household
runs its own; nothing is hosted elsewhere.

**Cesto fills the cart and stops there: it can never check out, pay or place an order.**

It talks to Continente through the [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha), which holds
the Continente account and session and runs the unofficial
[`continentept-mcp`](https://www.npmjs.com/package/continentept-mcp). Cesto never stores a supermarket password.

## Features

- One shared household list in SQLite, synced with every phone (offline edits are replayed later).
- Text list parsing in European Portuguese (`2 kg batata`, `leite x6`, `meia dúzia de ovos`).
- Product matching: the household's previous choice, then products you buy often, favourites, then a catalogue
  search; generic names give 2–4 options; out-of-stock products get alternatives; quantities are converted to packs.
- Cart preview (add to the cart or replace it) before any change, then a read-back check that names missing lines.
- Promotions and products cheaper per kg or litre, read-only, optionally chosen by an AI provider.
- Test mode (on for new installs) that only simulates cart changes.
- Home Assistant sensors and a notification when the Continente session expires.

## Install

1. Install and set up the [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha) (account and sign-in).
2. Home Assistant → Settings → Add-ons → Add-on store → ⋮ → Repositories → add `https://github.com/jpch/cesto-ha`,
   then install **Cesto** and start it. Home Assistant pulls a prebuilt image (`aarch64`, `amd64`).
3. On the **Continente MCP** page, approve the token request named "Cesto" (its fingerprint matches the one on the
   Cesto page). Cesto finds that add-on through `/share/continente-mcp/endpoint.json`.
4. When you are ready to change the real cart, turn **Test mode** off in the Cesto options.

## Connect a phone

1. Open the Cesto page (sidebar → Cesto) → **Ligar um telemóvel**, enter a device name and check the home network
   address (port 8099).
2. Scan the QR code with the app. Each phone gets its own token, which you can revoke on the same page.

The app can also find the add-on on the home network, or you can type the address and token by hand.
For use away from home see [docs/remote-access.md](docs/remote-access.md).

## Use

1. Add items in the app; everyone in the household sees the same list.
2. **Preparar carrinho** in the app matches the pending items, shows promotions and a preview, and applies it as a
   job. Finish the order yourself on the Continente app or website.
3. When the Continente session expires, Home Assistant shows a notification linking to the Continente MCP page,
   where you sign in again.

The Cesto page shows the version, test mode, Continente session status and queue, manages phone tokens, and exports
or imports the household data (lists, items, purchase runs and preferences; no tokens or credentials; import only
into an empty add-on).

## Options

| Option | Default | |
|---|---|---|
| `test_mode` | `true` | Only simulate cart changes. |
| `remote_cart` | `false` | Also allow the cart, promotions and photos away from home through Home Assistant ingress. |
| `ai_provider`, `ai_api_key`, `ai_model` | `none` | Optional OpenAI or Anthropic for promotion suggestions. With `none` nothing leaves the server. |
| `connectors` | `continente` | Enabled supermarkets. |
| `continente_mcp_url`, `continente_mcp_token` | empty | Override the Continente MCP discovery or token request. |
| `log_level` | `info` | |

## Home Assistant entities

| Entity | State |
| --- | --- |
| `sensor.continente_server_status` | `online`, or `test_mode` (attributes: version, queue length) |
| `binary_sensor.continente_session_valid` | `on` / `off` / `unknown` |
| `sensor.continente_list_items` | Pending items in the current list (attribute: total items) |
| `sensor.continente_last_sync` | Time of the last list change |

## Security

- No checkout, payment or order code: only an allowlist of read tools and four cart tools of `continentept-mcp` can be
  called (`cesto/server/src/mcp/tools.ts`), and anything resembling checkout, payment, orders, delivery slots,
  vouchers, coupons, billing or cards is refused. No option turns this off; tests prove it with test mode off.
- Phone tokens are random and stored only as SHA-256 hashes; revoke them on the Cesto page. The LAN API is plain HTTP
  on port 8099: do not forward that port.
- The Cesto page and admin routes answer only through Home Assistant ingress, for Home Assistant administrators.
- Away from home only an allowlist of routes is reachable, through Home Assistant ingress with HTTPS.
- Security record: [docs/security-review.md](docs/security-review.md).

## API

Base URL `http://<home-assistant-address>:8099/api/v1`. The contract is [`cesto/server/openapi.yaml`](cesto/server/openapi.yaml),
also served at `/api/v1/openapi.yaml`. `GET /health` needs no token; every other call needs
`Authorization: Bearer <token>`. Errors are `{"error": {"code", "message_key"}}`; clients translate the key. Data
lives in `/data/app.db` and is included in Home Assistant backups.

## Development

```sh
cd cesto/server && npm ci && npm test
docker build -t cesto:test cesto
docker run --rm --entrypoint node -w /opt/smoke cesto:test smoke.mjs
```

- `cesto/server/`: Node.js 22, TypeScript, Fastify, `node:sqlite`; user-facing text in `web/i18n/*.json`.
- How Cesto stays compatible with the `continentept-mcp` version the Continente MCP add-on pins:
  [docs/upstream-updates.md](docs/upstream-updates.md).
- CI builds `aarch64` and `amd64`, runs the tests and the smoke test, and publishes `ghcr.io/jpch/{arch}-cesto`.
  Actions are pinned to commit SHAs; Dependabot proposes weekly updates.

Not affiliated with any supermarket. Licence: [MIT](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[CHANGELOG](CHANGELOG.md).
