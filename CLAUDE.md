# agentcats

Local whiteboard where coding agents are cats.
TypeScript pnpm monorepo: `packages/protocol`, `packages/kit`, `packages/daemon`, `packages/adapters/{claude,mock}`, `packages/ui`, `packages/cli`.

## Commands

Package manager is pnpm (version pinned in `package.json`). Node >= 22.13.

| Task                     | Command                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Install                  | `pnpm install`                                                                                              |
| Dev (mock daemon + Vite) | `pnpm dev`, then open the printed `http://localhost:5173/#token=` link                                      |
| Run from sources         | `pnpm agentcats --project <path> [--adapter mock]`                                                          |
| Build everything         | `pnpm build`                                                                                                |
| Test                     | `pnpm test` (Vitest, all packages, mock only, no tokens)                                                    |
| Browser tests            | `pnpm test:e2e` (Playwright; first `pnpm -F @agentcats/ui exec playwright install chromium`)                |
| Live Claude tests        | `AGENTCATS_LIVE_CLAUDE=1 pnpm test` and `AGENTCATS_LIVE_CLAUDE=1 pnpm test:e2e` (spend tokens, use `haiku`) |
| Lint                     | `pnpm lint`                                                                                                 |
| Typecheck                | `pnpm typecheck`                                                                                            |
| Format                   | `pnpm format`                                                                                               |
| Everything CI runs       | `pnpm check`                                                                                                |

Packages export their TypeScript sources under the `@agentcats/source` condition, so tests and typecheck need no build.
Pin dependencies to exact versions at least two weeks old.

## Rules

- Every event or command change goes through `packages/protocol` first. The daemon and UI import types and schemas from there and never redefine them.
- No Claude-specific types outside `packages/adapters/claude`. ESLint blocks `@anthropic-ai/*` imports elsewhere. The adapter contract is `@agentcats/protocol/adapter`.
- New behavior needs a test that uses the mock adapter. Tests never need an API key or spend tokens, except the live tests gated by `AGENTCATS_LIVE_CLAUDE=1`.
- Agent processes are always started with `spawnGuarded` from `@agentcats/kit`, so they cannot outlive the daemon.
- Run `pnpm check` before every commit and read its exit status; never hide it behind a pipe. CI runs on a fresh checkout where the UI is not built, so a test must not depend on local build output. After pushing, confirm CI went green.
- Any decision that changes the plan gets a dated entry in `docs/decisions.md`. Do not deviate silently.
- Commits carry no AI co-author trailer.

## Milestones

The build plan is in `docs/milestones/`. Read `README.md` there first.
Work on one milestone at a time, in order. Read later milestones only to keep the architecture compatible.

A milestone is done when every acceptance criterion is checked, `pnpm check` is green, and `docs/decisions.md` has the decisions and the handoff notes for the next milestone.
