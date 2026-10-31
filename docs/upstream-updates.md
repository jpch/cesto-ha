# continentept-mcp contract and automated updates

The add-on bundles the unofficial [`continentept-mcp`](https://www.npmjs.com/package/continentept-mcp) package, pinned by `ARG CONTINENTEPT_MCP_VERSION` in `cesto/Dockerfile`. It is used as published; it is never forked or patched.

## Contract tests

| Piece | Where | What it checks |
|---|---|---|
| Adapters | `cesto/server/src/mcp/upstream.ts` | The only module that reads upstream result shapes: products, favourites, frequent products, cart lines and quantities, preview problems and cost, mutation outcomes, session state. |
| Snapshot | `cesto/server/test/contract/upstream-tools.json` | The reviewed `tools/list` of the pinned package: tool names, input schemas and output schemas (description text is ignored). |
| Fixtures | `cesto/server/test/contract/fixtures/*.json` | Recorded, anonymised `structuredContent` results for all 15 allowlisted tools (11 read, 4 cart), including signed-out errors, unknown quantities, bags, unavailable and refused preview lines, and `unknown`/`not_applied` mutation outcomes. |
| Tests | `cesto/server/test/contract/upstream.test.ts` | The snapshot lists exactly the allowlist; every fixture validates against its tool's output schema (Ajv, JSON Schema 2020-12); every adapter gives the expected values on the fixtures; every call the add-on sends validates against the tool's input schema; session tracking and test mode behave on recorded results; fixtures contain no e-mail, phone, IP, token or non-store host. |
| Live check | `cesto/server/scripts/upstream-tools.mjs --check` | Starts the installed package over stdio with an empty temporary data directory (no credentials, cookies or sign-in) and compares its `tools/list` with the snapshot. Any added, removed or changed tool fails. |

Where it runs:

- `npm test` (also inside the Docker build) runs the fixture and adapter tests.
- The `contract` job in `.github/workflows/build.yaml` installs the pinned version (`--ignore-scripts`, no browser) and runs the live check on every push, pull request and update run. The image build depends on it.
- The Docker build runs the live check against the package actually installed in the image, so an image can never ship with an unreviewed upstream tool set.

Nothing in CI signs in to Continente. Tests that would need a real account are not part of CI; new fixtures are recorded by hand from a real session and anonymised (fake product ids `20000xx`, no names, addresses, order numbers, e-mails or tokens) before they are committed.

## Automated updates

`.github/workflows/upstream-bump.yaml` runs daily (and on demand):

1. **check** (read-only token, no git credentials): finds the latest npm version; on scheduled runs waits until it has been published for 72 hours; installs it without install scripts and diffs `tools/list` against the snapshot.
2. **prepare**: on a branch `deps/continentept-mcp-<version>`, sets the Dockerfile ARG, bumps the add-on patch version (`config.yaml`, `package.json`, `package-lock.json`, `openapi.yaml`), adds a CHANGELOG section and opens a PR whose body lists any new, removed or changed tools.
3. **test**: runs the normal build (contract job, unit tests in the Docker build, both architectures, smoke test) on the branch.
4. **merge, publish, release**: only when the contract is unchanged and the build is green: squash-merges, publishes the images and creates the `v<version>` tag and GitHub release from the CHANGELOG section.

If any tool was added, removed or changed, auto-merge is blocked and the PR stays open. To accept it:

1. Read the upstream change (`npm diff --diff=continentept-mcp@<old> --diff=continentept-mcp@<new>`).
2. Decide about each new tool. Anything that checks out, pays, places an order or books a slot stays forbidden (`FORBIDDEN_TOOL`); a harmless tool is only added to the allowlist in `src/mcp/tools.ts` if the add-on needs it.
3. Update `src/mcp/upstream.ts` and the fixtures, refresh the snapshot with `npm run contract:write` (with the new version installed or `MCP_COMMAND` pointing at it), fix the CHANGELOG wording, push, merge and release by hand.

Even without the gate, a new upstream tool can never be called: the add-on only calls allowlisted tools, enforced on the stdio transport, in `TestModeGuard` and in `ContinenteMcp`.

### Why a scheduled workflow

- Dependabot cannot update an npm package pinned by a Dockerfile `ARG` (its Docker support covers base images only), and adding the package to a manifest just for Dependabot would install it into the server's dependencies.
- Renovate could bump the `ARG` with a regex manager, but it needs a third-party app with write access to the repository (or a self-hosted runner and token), and it cannot put the tool diff in the PR body or gate the merge on it without a workflow like this one anyway.
- A workflow in the repository uses only `GITHUB_TOKEN`, pinned first-party actions and code under review, and can gate on the contract.

### Repository settings it relies on

- "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General) must be on so the workflow can open the PR.
- PRs opened with `GITHUB_TOKEN` do not trigger `pull_request` runs, which is why the workflow calls `build.yaml` itself (`workflow_call`) and publishes the images itself after merging. Pushing a commit to an update PR runs the normal checks on it.
- Home Assistant does not install add-on updates unless auto-update is turned on for the add-on; a released update still waits for you to install it.
