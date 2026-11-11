# continentept-mcp contract and updates

Since 2.0.0 Cesto does not install the unofficial [`continentept-mcp`](https://www.npmjs.com/package/continentept-mcp)
package. The [Continente MCP add-on](https://github.com/jpch/continente-mcp-ha) installs it, and Cesto calls that
add-on over streamable HTTP. The two add-ons share the pinned package version and split the work like this:

| Where | What |
|---|---|
| `jpch/continente-mcp-ha` `continente_mcp/Dockerfile` | **The pin**: `ARG CONTINENTEPT_MCP_VERSION`. The package is used as published, never forked or patched. |
| `jpch/continente-mcp-ha` `continente_mcp/server/contract/upstream-tools.json` | The reviewed `tools/list` snapshot of the pinned version (names, input and output schemas). |
| `jpch/continente-mcp-ha` `continente_mcp/server/scripts/upstream-tools.mjs --check` | **Live check**: starts the installed package over stdio with an empty data directory (no credentials, cookies or sign-in) and fails on any added, removed or changed tool. Runs in CI and in the image build. |
| `jpch/continente-mcp-ha` `.github/workflows/upstream-bump.yaml` | **Daily update**: opens a PR when npm has a newer version (72-hour cooldown), and only auto-merges when the tool contract is unchanged. See that repository's README. |
| `cesto/server/src/mcp/upstream.ts` (here) | The only module that reads upstream result shapes: products, favourites, frequent products, cart lines and quantities, preview problems and cost, mutation outcomes, session state. |
| `cesto/server/test/contract/upstream-tools.json` (here) | Cesto's copy of the reviewed snapshot of the newest version it supports (0.13.0). |
| `cesto/server/test/contract/upstream-tools-<version>.json` (here) | Older reviewed snapshots Cesto still reads (0.12.1), so it keeps working with an add-on that has not moved yet. Drop one when no released add-on pins it any more. |
| `cesto/server/test/contract/fixtures/*.json` (here) | Recorded, anonymised `structuredContent` results for all 15 allowlisted tools (11 read, 4 cart), including signed-out errors, unknown quantities, bags, unavailable and refused preview lines, and `unknown`/`not_applied` mutation outcomes. |
| `cesto/server/test/contract/upstream.test.ts` (here) | Every kept snapshot has all allowlisted tools and every other tool in it is forbidden; every fixture validates against its tool's output schema in every kept snapshot (Ajv, JSON Schema 2020-12; `FIXTURE_SINCE` in `support.ts` marks fixtures only newer versions can produce); every adapter gives the expected values on the fixtures; every call Cesto sends validates against the tool's input schema in every kept snapshot; fixtures contain no e-mail, phone, IP, token or non-store host. |
| `cesto/server/test/contract/pinned.test.ts` (here) | **Cesto against the pinned version**: reads `ARG CONTINENTEPT_MCP_VERSION` from the Continente MCP add-on's `continente_mcp/Dockerfile` and its snapshot (a checkout in `CONTINENTE_MCP_HA_DIR`; CI checks out `jpch/continente-mcp-ha` `main`, or the `continente_mcp_ha_ref` input of a manual run). Fails if Cesto has no reviewed snapshot for that version, if the two snapshots differ, or if Cesto's calls or fixtures do not fit it. Skipped locally without the variable. |
| `cesto/server/test/contract/snapshot.mjs` (here) | Shape-only snapshot comparison (`normalise`, `diff`), for comparing Cesto's snapshot with another one. |

The `contract` job in `.github/workflows/build.yaml` runs the contract tests and the link tests
(`test/continente-link.test.ts`) on every push and pull request; `npm test` in the Docker build runs them too.
Nothing in CI signs in to Continente.

## When the Continente MCP add-on moves to a new continentept-mcp version

Release order matters: Cesto must never run against a schema it cannot read.

1. In `jpch/continente-mcp-ha`, review the upstream change (`npm diff --diff=continentept-mcp@<old> --diff=continentept-mcp@<new>`)
   and refresh its snapshot (`npm run contract:write` there, after the review). Do not release it yet.
2. Here, rename the current snapshot to `test/contract/upstream-tools-<old>.json` (if Cesto must still read the old
   version), copy the new snapshot to `test/contract/upstream-tools.json`, update `src/mcp/upstream.ts` and the fixtures
   until the contract tests pass, and decide about each new tool: anything that checks out, pays, places an order or
   books a slot stays forbidden (`FORBIDDEN_TOOL` in `src/mcp/tools.ts`); a harmless tool joins the allowlist only if
   Cesto needs it. If Cesto can read both the old and the new shapes, release Cesto first.
   Before releasing, run the pinned test against the add-on's branch:
   `CONTINENTE_MCP_HA_DIR=<checkout of that branch> npx vitest run test/contract/pinned.test.ts` (or a manual run of the
   Build workflow with `continente_mcp_ha_ref`).
3. Release the Continente MCP add-on, then check on Home Assistant that Cesto still lists, matches and fills the cart.

Even before such a review, Cesto cannot call a new upstream tool: it only calls allowlisted tools, enforced on the
HTTP transport, in `TestModeGuard` and in `ContinenteMcp`. New fixtures are recorded by hand from a real session and
anonymised (fake product ids `20000xx`, no names, addresses, order numbers, e-mails or tokens) before they are
committed.
