# T14: installation on the Home Assistant Pi

Date: 2026-10-30 (Europe/Lisbon). Done remotely through the Home Assistant MCP connector; no other add-on or HA configuration was changed.

## Host before installing

- Raspberry Pi 5 (`rpi5-64`), Home Assistant OS 18.2, Core 2026.10.2, Supervisor 2026.10.5, healthy and supported.
- RAM: 8.3 GB total. The 7 running add-ons used about 0.4 GB together, which leaves several GB free (the Supervisor API does not report host free RAM directly).
- Disk: 13.1 GB used of 57.3 GB.

## Steps done

1. Added the repository `https://github.com/jpch/continente-mcp-ha` (store slug `75545ee1`).
2. Installed **Continente MCP 0.1.0** (`75545ee1_continente_mcp`) from the published `ghcr.io/jpch/aarch64-continente-mcp:0.1.0` image.
3. Kept the default options: `test_mode: true`, `log_level: info`. Boot `auto`, watchdog off, auto-update off.
4. Started it.

## Results

| Check | Result |
|---|---|
| Logs | `[continente-mcp] API listening on 8099 (test_mode=true)`, no errors (only Node's SQLite experimental warning) |
| `GET /api/v1/health` (ingress) | 200 `{"version":"0.1.0","test_mode":true,"session_valid":null,"queue_length":0}` |
| `sensor.continente_server_status` | `test_mode` |
| `binary_sensor.continente_session_valid` | `unknown` (no Continente login yet) |
| `sensor.continente_list_items` | `0` |
| `sensor.continente_last_sync` | `unknown` |
| Memory, idle | 35 MB (CI smoke peak with Chromium running: about 0.7 GB) |

## Still to do by hand

1. In HA: **Settings → Add-ons → Continente MCP → Open web UI**. Optionally turn on "Show in sidebar".
2. On the page, save the Continente email and password, then **Log in** and tick "Não sou um robô" in the browser view. When it finishes, `binary_sensor.continente_session_valid` turns `on`.
3. Create a token for each phone on the same page (Tokens). The phones talk to `http://192.168.200.250:8099`.
4. Try a proposal and preview from the API or the app, still in test mode. Only then, if wanted, set `test_mode: false` in the add-on Configuration tab and restart it. The add-on never checks out or pays.
5. If the session expires, HA shows a notification with a link back to this page.
