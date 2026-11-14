# Contributing

Thank you for helping. This page gets you from a fresh clone to a pull request.

## Setup

You need Node.js 22.13 or newer, pnpm 11 (the exact version is pinned in `package.json`) and git.

```sh
pnpm install
pnpm check                                         # format, lint, typecheck, tests
pnpm -F @agentcats/ui exec playwright install chromium
pnpm test:e2e                                      # browser tests
pnpm dev                                           # mock daemon and the board with hot reload
pnpm agentcats --project <path> --adapter mock     # the CLI from sources
```

Nothing above needs an agent login or spends tokens.
Live tests that use real agents are gated behind `AGENTCATS_LIVE_CLAUDE=1` and `AGENTCATS_LIVE_CODEX=1`, and do spend.

## How the code is organized

Read [architecture](docs/architecture.md) first.
`CLAUDE.md` lists every command and the repository rules, and `docs/decisions.md` explains why things are the way they are.

## Rules

- **Protocol first.** A new event, command or config key goes into `packages/protocol` before the daemon or the UI use it.
- **Agent code stays in its adapter.** No agent SDK outside its adapter package; ESLint enforces it. New adapters pass the conformance suite ([writing an adapter](docs/adapters.md)).
- **Tests use the mock.** New behavior gets a test that runs on the mock adapter, with no login and no tokens. A bug fix starts with a test that reproduces it as a user would meet it.
- **No flaky tests.** A test that fails sometimes is a bug: fix the cause, not the timeout.
- **The UI is checked by eye.** Look at the Playwright screenshots in `packages/ui/test-results/screenshots/` after a UI change, in light and dark.
- **Dependencies** are pinned to exact versions at least two weeks old.
- **Prompts** in `packages/daemon/prompts/` carry a version and a changelog in their header; bump both on any change.
- **Decisions that change the plan** get a dated entry in `docs/decisions.md`.
- **Changesets:** a user-facing change adds one with `pnpm changeset`.

## Pull requests

1. `pnpm check` passes, and `pnpm test:e2e` too for UI changes.
2. The description says what changed and why, and how you tested it.
3. One topic per pull request; small commits that each pass `pnpm check`.

## Reporting bugs

Open an issue with the template.
A session export (**Replay**, then **Export…**) shows exactly what happened; read it before you attach it.
Report security problems privately, as described in [security](docs/security.md#reporting-a-vulnerability).

## Code of conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
