# Contributing to Cesto

- Code, comments, docs and commit messages are in English. User-facing text lives only in the i18n files
  (`cesto/server/web/i18n/*.json`, `cesto/translations/*.yaml`); European Portuguese is the default language.
- Never add code that can check out, pay or place an order. The tool allowlist/denylist in
  `cesto/server/src/mcp/tools.ts` and its tests must keep passing with test mode off.
- No personal data or secrets: no real IP addresses, hostnames, names, e-mails, accounts or tokens in code, tests,
  docs or commit messages. Use documentation placeholders (`192.0.2.x`, `example.org`).
- A new supermarket is a connector (`cesto/server/src/connectors/`): it must provide product search, cart read/add
  and its own sign-in, and declare its optional capabilities.
- Run `cd cesto/server && npm ci && npm test` and update `CHANGELOG.md` and `README.md` with every change.
