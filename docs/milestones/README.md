# agentcats: milestones

A local, open source whiteboard where coding agents are cats. An orchestrator cat delegates to worker cats, workers learn from past tasks, and you hire and fire them from the UI. TypeScript, local-first, Claude Code first, other agent CLIs later through adapters.

## Order

| # | Document | Outcome |
|---|----------|---------|
| M0 | [M0-spike-and-contract.md](M0-spike-and-contract.md) | Decisions verified, protocol defined, mock adapter, one real cat animating on the board |
| M1 | [M1-own-the-loop.md](M1-own-the-loop.md) | Orchestrator plus parallel workers in worktrees, approvals, budgets, failure handling |
| M2 | [M2-memory-and-levels.md](M2-memory-and-levels.md) | Debrief loop, learnings, XP, levels that gate real behavior |
| M3 | [M3-hire-and-fire.md](M3-hire-and-fire.md) | Retire, resurrect, and hire through a real sample-task eval |
| M4 | [M4-second-adapter.md](M4-second-adapter.md) | Codex adapter, conformance suite, mixed teams |
| M5 | [M5-polish-and-release.md](M5-polish-and-release.md) | Art, memes, replay, docs, `npx agentcats` release |

Do them in order. Do not start a milestone until the previous one meets its acceptance criteria.

## Shared architecture

```
Browser UI (React + canvas)
   ^  WebSocket (typed events)       v REST (commands)
Daemon (Node, TypeScript)
   |- Event bus
   |- Cat manager (lifecycle, worktrees, budgets)
   |- MCP server (tools for the orchestrator cat)
   |- Adapters: claude-code (later: codex, kiro) + mock
   |- Store: SQLite (tasks, events, stats) + .agentcats/ markdown (cat memory)
```

Rules that hold in every milestone:

- The daemon owns agent processes. The UI never talks to agents directly.
- Every adapter implements the same interface (defined in M0).
- All event and command types live in `packages/protocol` and are imported by both daemon and UI. No duplicated types.
- Cat memory is plain markdown on disk. SQLite holds stats and history only.
- The UI is a projection of the event log. If the UI needs state, it comes from an event or the snapshot endpoint.

## Repo layout

```
packages/
  protocol/   shared event and command types (zod schemas)
  daemon/     process manager, MCP server, store
  adapters/   claude-code/, mock/ (later: codex/, kiro/)
  ui/         React app and whiteboard canvas
  cli/        `npx agentcats` entrypoint
docs/
  milestones/ these documents
  decisions.md  running log of technical decisions
.agentcats/    created in the user's project at runtime
  cats/<name>/profile.md, learnings.md, stats.json
  retired/<name>/
  agentcats.config.json
```

## How to use these with Claude Code

- Give Claude Code one milestone document at a time, not the whole folder.
- Ask it to restate the acceptance criteria and list the tasks before writing code.
- Review each milestone's diff before moving on. The adapter interface (M0) and the task state machine (M1) are the two places where a mistake gets expensive later.
- Anything that changes a decision gets a dated line in `docs/decisions.md`.

## Cross-cutting risks

- Cost: parallel agents burn tokens. Budget caps arrive in M1, mock adapter covers most development.
- Permissions: headless agents can do damage. Restricted defaults, worktree isolation, approvals on the board.
- Memory rot: bad learnings poison future runs. Small cap, visible, editable.
- Process leaks: crashed daemon leaves orphan agents. Track PIDs, clean up on start.
- Art scope creep: one sprite per state, placeholders until M5.
- Upstream CLI changes: keep adapters thin, pin tested versions, record the version in `docs/decisions.md`.
