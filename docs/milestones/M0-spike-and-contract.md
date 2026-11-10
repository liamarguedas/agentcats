# M0: Spike and contract

Time box: one weekend plus half a day for verification.

## Goal

Prove the plumbing and fix the contract between backend and UI. At the end, one real Claude Code session drives one animated cat on the board, and the UI can also run entirely against a mock agent with no tokens spent.

## Step 0: verify decisions (do before writing code)

Answer each question, then record the answer, date and tool version in `docs/decisions.md`. Do not pick silently.

1. **Headless Claude Code.** Compare the Claude Agent SDK (TypeScript) with `claude -p` using stream-json output. Required: streamed tool events, a permission callback or equivalent, session resume, ability to set working directory and model. Default to the SDK if it covers all four.
2. **Agent Client Protocol.** Check whether ACP is supported by Codex and Kiro. If yes, mirror it in the adapter interface. If unclear, keep our own interface and note it.
3. **Rendering references.** Check licenses of Pixel Agents and Claude Office. Decide: fork, study only, or write fresh. Record the license in the decision.
4. **Orchestrator to daemon link.** Confirm a Claude Code session can be pointed at a local MCP server per session via config (stdio vs HTTP). This decides M1.

## Scope

### 1. Repo scaffold
- pnpm workspace, TypeScript strict, ESLint, Prettier, Vitest.
- Packages: `protocol`, `daemon`, `adapters/claude-code`, `adapters/mock`, `ui`, `cli`.
- Root `CLAUDE.md` (see below), `docs/decisions.md`, MIT license.

### 2. Protocol package (the contract)
zod schemas plus inferred types, imported by daemon and UI.

**Events** (daemon to UI, over WebSocket, append-only):
- `cat.created`, `cat.status_changed` (idle, thinking, working, blocked, waiting_approval, done, error)
- `task.created`, `task.updated` (status, assignee, summary)
- `tool.called` (tool name, short input summary, result status)
- `approval.requested`, `approval.resolved`
- `message.agent` (text chunks from the agent)
- `usage.updated` (tokens, estimated cost, per cat)
- `daemon.error`

**Commands** (UI to daemon, REST):
- `POST /tasks` create and assign, `POST /approvals/:id` approve or deny, `POST /cats/:id/kill`, `POST /chat` send message to the active cat.
- `GET /snapshot` returns current cats, tasks and last N events, so a reconnecting UI can rebuild state.

**Envelope:** `{ id, seq, ts, type, catId?, taskId?, payload }`. `seq` is monotonic so the UI can detect gaps and refetch the snapshot.

Write the protocol first, review it, then build both sides against it.

### 3. Adapter interface
```ts
interface Adapter {
  spawn(opts: { catId, cwd, model, systemPrompt, mcpServers? }): Promise<Session>
}
interface Session {
  id: string
  send(message: string): Promise<void>
  events(): AsyncIterable<AgentEvent>   // normalized, adapter-specific details stripped
  approve(requestId: string, decision: 'allow' | 'deny'): Promise<void>
  kill(): Promise<void>
}
```
`AgentEvent` is a small normalized set that the daemon maps to protocol events. Keep it free of Claude-specific fields; this is what Codex must also satisfy in M4.

### 4. Mock adapter
Emits scripted event sequences with realistic delays: thinking, tool calls, an approval request, success, and an error case. Selectable by scenario name. Used for UI development, daemon tests and CI. This is not optional.

### 5. Claude Code adapter (minimal)
Spawn one session in a scratch git repo, map raw events to `AgentEvent`, support `send` and `kill`. Approvals can be auto-deny in M0 if the permission callback is not yet wired.

### 6. Daemon
- Event bus, in-memory event log with `seq`.
- WebSocket server and the REST endpoints above.
- **Security from day one:** bind to `127.0.0.1` only, generate a random token at startup, require it on REST and WebSocket (passed to the UI via the URL fragment), reject WebSocket connections whose `Origin` is not the daemon's own origin.
- `agentcats.config.json` loader (project path, default model, adapter, budget limits). Schema in protocol package.

### 7. UI
- Vite and React. WebSocket client with reconnect and snapshot refetch.
- One cat component with states idle, thinking, working, blocked. Placeholder shapes are fine.
- A prompt box. A scrolling event log panel for debugging.

### 8. CLI
`agentcats --project <path>` starts the daemon, serves the built UI, opens the browser with the token.

## `CLAUDE.md` contents (root of the repo)
- Package manager and the commands for install, dev, test, lint, typecheck.
- Rule: every event or command change goes through `packages/protocol` first.
- Rule: no Claude-specific types outside `adapters/claude-code`.
- Rule: new behavior needs a test using the mock adapter.
- Definition of done for a milestone: acceptance criteria met, tests green, decisions logged.
- Pointer to `docs/milestones/` and the instruction to work on one milestone at a time.

## Acceptance criteria
- [x] `docs/decisions.md` answers all four verification questions.
- [x] Protocol package has all events and commands above, with tests that validate sample payloads.
- [x] UI runs fully against the mock adapter: cat changes state, approval bubble appears (display only), error state renders.
- [x] With the Claude Code adapter, typing "add a hello function to a scratch repo" makes the cat animate while a real file changes.
- [x] Daemon rejects a WebSocket connection with a wrong token and one with a foreign Origin (tested).
- [x] Killing the daemon leaves no orphan agent process (checked manually and with a test for the mock).

## Out of scope
Multiple cats, orchestrator, MCP tools, SQLite, worktrees, budgets, memory. Do not start these.

## Handoff notes for the next milestone
Record in `docs/decisions.md`: the chosen headless approach, the MCP wiring method, and any places where the normalized `AgentEvent` felt too thin or too thick.
