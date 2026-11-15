# Decisions

Running log of technical decisions for agentcats.
Each entry has a date, the decision, the evidence, and the tool versions it was verified against.
Anything that changes a decision gets a new dated entry; old entries are not rewritten.

## Environment at time of M0 verification (2026-11-10)

| Tool | Version |
| - | - |
| OS | Windows 11 Pro 10.0.26200 |
| Node.js | 26.13.0 |
| pnpm | 11.17.0 |
| git | 2.51.0.windows.1 |
| Claude Code CLI (installed globally) | 2.1.302 |
| `@anthropic-ai/claude-agent-sdk` (probed) | 0.3.321, bundles Claude Code 2.1.321 |

The SDK publishes almost daily (0.3.316 on 2026-10-31 through 0.3.322 on 2026-11-10).

---

## 2026-11-10 - Step 0.1: Headless Claude Code - use the Agent SDK

**Decision:** The Claude Code adapter uses `@anthropic-ai/claude-agent-sdk` (`query()` in streaming input mode), not a hand-rolled `claude -p --output-format stream-json` subprocess.

**Evidence** (from `sdk.d.ts` of 0.3.321 and https://code.claude.com/docs/en/agent-sdk/typescript):

| Requirement | SDK | `claude -p` stream-json |
| - | - | - |
| Streamed tool events | `Query` is `AsyncGenerator<SDKMessage>`; assistant messages carry `tool_use` blocks, user messages carry `tool_result`, plus `SDKToolProgressMessage`, `SDKPartialAssistantMessage` with `includePartialMessages` | Same messages as NDJSON on stdout |
| Permission callback | `canUseTool(toolName, input, { signal, suggestions, blockedPath, ... }) => Promise<PermissionResult>`, result is `{ behavior: 'allow', updatedInput? } \| { behavior: 'deny', message, interrupt? }` | Only via `--permission-prompt-tool`, which must be an MCP tool, so the daemon would need an MCP server just for approvals |
| Session resume | `resume`, `continue`, `forkSession`, `resumeSessionAt` | `--resume`, `--continue`, `--fork-session` |
| Working directory and model | `cwd`, `model`, plus `setModel()` mid-session | process cwd, `--model` |

Additional useful facts:

- `prompt` accepts `AsyncIterable<SDKUserMessage>`, which gives multi-turn `send()` on one live process, and enables `interrupt()` and `setPermissionMode()`.
- `close()` terminates the underlying process.
- `settingSources: []` and `strictMcpConfig: true` isolate a session from the user's `~/.claude` and project settings.
- `PermissionMode` is `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`.
- `canUseTool` is only invoked when the permission flow falls through to a prompt; calls auto-approved by `allowedTools`, allow rules or `permissionMode` never reach it.

**Verified how:** type definitions and docs only.
The runtime behavior of `canUseTool` and `resume` has **not** been exercised yet, because that needs a real model call.
It will be exercised with one cheap run when the Claude Code adapter is built, and this entry will be updated.

**Caveats that matter for an MIT open source project:**

- **License.** The SDK is not open source. `LICENSE.md` says "All rights reserved", and use is governed by Anthropic's Commercial Terms of Service. agentcats can depend on it, but must not vendor or redistribute it, and the README must say so.
- **Authentication.** The SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." So agentcats must document API key (or Bedrock / Vertex) auth as the supported path. Resolved below in "Auth is inherited from the user's Claude Code setup".
- **Branding.** Products built on the SDK may say "Claude Agent", "Claude", or "<Name> Powered by Claude", but not "Claude Code" or "Claude Code Agent". User-visible adapter labels must follow this. Resolved below: the adapter is `adapters/claude`, labeled "Claude".
- **Install size.** The SDK pulls a per-platform native binary as an optional dependency. `@anthropic-ai/claude-agent-sdk-win32-x64` is 331 MB on disk. This matters for `npx agentcats` in M5. `pathToClaudeCodeExecutable` can point at a user's existing `claude` instead.
- **Version pinning.** Pin an exact SDK version in `package.json`, chosen to be at least two weeks old at the time of pinning, and record it here. Do not use a caret range.

---

## 2026-11-10 - Step 0.2: Agent Client Protocol - mirror ACP semantics, keep our own interface

**Findings:**

- ACP v1 is the stable protocol version. The agent registry launched 2026-01-28, run jointly by Zed and JetBrains. Sources: https://agentclientprotocol.com/get-started/agents, https://kiro.dev/blog/one-agent/.
- **Kiro:** native. `kiro-cli acp` runs Kiro as an ACP agent over stdio JSON-RPC, since Kiro CLI 1.25.0 (2026-02-04). Kiro adds ~20+ `_kiro/`-namespaced extension methods on top. Source: https://kiro.dev/changelog/cli/1-25/.
- **Codex:** not native. ACP support is through the adapter `@agentclientprotocol/codex-acp`, which wraps the Codex App Server. The earlier `zed-industries/codex-acp` was archived 2026-07-22. A native-support feature request (openai/codex#30052, opened 2026-06-25) is still open. Source: https://github.com/agentclientprotocol/codex-acp.
- **Claude:** through the third-party adapter `zed-industries/claude-agent-acp`, which itself wraps the Agent SDK.

**Decision:** Keep our own `Adapter` / `Session` / `AgentEvent` interface for M0, but shape it so that each concept maps 1:1 to an ACP concept.
That keeps a single generic ACP adapter a cheap option in M4 without making Claude go through a third-party ACP bridge now.

| agentcats | ACP v1 |
| - | - |
| `Adapter.spawn()` | `initialize` + `session/new` |
| `Session.send()` | `session/prompt` |
| `AgentEvent` text / thought / tool call / tool update | `session/update` variants `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` |
| approval request + `Session.approve()` | `session/request_permission` with options |
| `Session.interrupt()` | `session/cancel` |
| turn end with stop reason | `session/prompt` response `stopReason` |

**Not verified:** I did not run `kiro-cli acp` or `codex-acp`. The mapping table is from the published protocol, not from a live session.

---

## 2026-11-10 - Step 0.3: Rendering references - study only, write fresh

**Findings:**

- **Pixel Agents** (https://github.com/pixel-agents-hq/pixel-agents, formerly pablodelucca/pixel-agents): code is MIT, "Copyright (c) 2026 Pablo De Lucca". TypeScript, VS Code webview plus a standalone CLI. Observes Claude Code passively through hooks, with JSONL transcript scanning as a fallback. Character art is "based on" the JIK-A-4 Metro City pack, whose license I did **not** verify. Some forks credit a separately purchased Donarg tileset.
- **Claude Office** names two unrelated projects:
  - https://github.com/paulrobello/claude-office: MIT per the repo badge. Python FastAPI backend plus Next.js, PixiJS 8 and Zustand. Art license is not stated.
  - https://github.com/W17ant/Claude-Office: MIT, but `NOTICE.md` excludes the Dunder Mifflin fan art sprites, props and quotes from the grant. Express plus React, fed by Claude Code hooks.

**Decision:** Study only, write fresh.

- Both observe Claude Code passively via hooks or transcripts. agentcats owns the agent processes and renders from its own event log, so their data layer does not transfer.
- Our subjects are cats, so their character art does not fit anyway, and the asset provenance in both is partly unverified or explicitly excluded.
- The code is MIT, so if a specific technique (sprite sheet animation loop, tile layering) is worth copying later, it can be copied with attribution. Any such copy gets its own entry here with the source file and license.

---

## 2026-11-10 - Step 0.4: Orchestrator to daemon MCP link - per-session config works, both stdio-free options verified

**Verified empirically** on 2026-11-10 with SDK 0.3.321, with zero model calls.
A probe opened one `query()` in streaming input mode with a prompt iterable that never yields, `settingSources: []`, `strictMcpConfig: true`, and two servers in `mcpServers`:

1. An in-process server from `createSdkMcpServer()` (`type: 'sdk'`).
2. A minimal HTTP MCP server on `127.0.0.1:<random port>` (`type: 'http'`, `headers: { Authorization: 'Bearer ...' }`).

`q.mcpServerStatus()` reported both as `status: "connected"` with their tools listed (`list_cats`, `ping`).
The HTTP server logged `initialize`, `notifications/initialized`, a GET for the SSE stream and `tools/list`, all carrying the bearer header.
Nothing was written to user or project settings.

The CLI equivalent is `claude -p --strict-mcp-config --mcp-config <file.json>`, with the same `mcpServers` JSON shape, and `type` must be set for remote servers.

**Options for M1:**

| Option | Pros | Cons |
| - | - | - |
| In-process `type: 'sdk'` | No port, no auth, tool handlers call daemon code directly | Only works for SDK-based adapters. A Codex orchestrator in M4 cannot use it |
| HTTP on the daemon (`/mcp` on the existing 127.0.0.1 server, per-session bearer token) | Any MCP-capable agent can use it, the token identifies which cat is calling | One more authenticated surface on the daemon |
| stdio shim | Universally supported | Needs a shim process that talks back to the daemon anyway, plus another process to track for orphans |

**Recommendation:** HTTP on the daemon, with a per-session token that maps to a `catId`. The choice is final in M1, recorded here.

---

## 2026-11-10 - Auth is inherited from the user's Claude Code setup

**Verified empirically** with zero model calls: a `query()` with `settingSources: []` reported `accountInfo()` as `apiProvider: "firstParty"`, `subscriptionType: "Claude Pro"`.
This held for both the SDK's bundled binary (2.1.321) and the globally installed `claude` (2.1.302, via `pathToClaudeCodeExecutable`).
Both read the credentials the user already set up in Claude Code (`/login`, `ANTHROPIC_API_KEY`, or Bedrock / Vertex env).

**Consequence:** agentcats never handles, stores or prompts for Claude credentials, and never offers a login.
How a user authenticates is configured in Claude Code itself.
agentcats is software the user installs and runs locally on top of their own Claude Code, not a hosted service.

## 2026-11-10 - Run the user's installed `claude`, not the SDK's bundled copy

**Decision:** The Claude adapter resolves `claude` on `PATH` (overridable with `claude.executablePath` in `agentcats.config.json`) and passes it as `pathToClaudeCodeExecutable`.
The user's own Claude Code version and setup is what runs.

**Consequences:**

- The installed version can be older or newer than the one the pinned SDK was built against (today: installed 2.1.302, SDK expects 2.1.321). The adapter reads `claude --version` at spawn, records it on the cat, and warns on the board when it falls outside the range listed here as tested. Only initialization has been verified across this skew so far; a streamed turn is verified when the adapter is built.
- If `claude` is not found, the adapter fails with a clear message. The mock adapter still works without it.
- The SDK still installs its 331 MB bundled binary as an optional dependency. Avoiding that for `npx agentcats` is an M5 packaging task.

**README note:** "agentcats uses whatever auth your Claude Code is configured with. You are responsible for using it in line with Anthropic's terms. An API key works the same way."

## 2026-11-10 - Permissions are per cat, set by the user

Each cat has a `permissionMode` in config: `acceptEdits` or `auto`. `bypassPermissions` is rejected by the config schema.
Anything the mode does not allow becomes an `approval.requested` event shown as a bubble on the cat.
In M0 there is one cat, default `acceptEdits`, scoped to the scratch repo, and the mode is set in the config file.
Editing a cat's permissions by clicking it on the board, and role presets (orchestrator, developer, QA), are M1 work.
Whether `auto` is available on a Pro plan is unverified; it gets tested when the adapter is built.

## 2026-11-10 - Answers to the M0 planning round

- **Adapter naming:** `packages/adapters/claude/`, npm `@agentcats/adapter-claude`, UI label "Claude". Other packages are `@agentcats/protocol`, `@agentcats/daemon`, `@agentcats/adapter-mock`, `@agentcats/ui`, and the CLI package `agentcats` with bin `agentcats`.
- **Token transport:** REST uses `Authorization: Bearer <token>`. The WebSocket carries the token as a `Sec-WebSocket-Protocol` value, never in the query string. The daemon also rejects a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding) and a foreign `Origin` on REST. Each rule has a test.
- **Orphans:** agent PIDs go to `.agentcats/run/pids.json`. Graceful shutdown kills each process tree (`taskkill /T /F` on Windows). On startup, leftover PIDs are killed. The mock adapter has a child-process mode so the automated test hard-kills a real daemon and checks no child survives.
- **Interface additions now rather than in M4:** `Session.interrupt()`, a terminal end-of-turn / end-of-session `AgentEvent` with a stop reason, optional `resume` id in `spawn` options, `Adapter.capabilities`. Approvals stay `allow | deny`.
- **Node baseline:** `engines.node >=22`. CI on 22 and 24.
- **Repo:** https://github.com/liamarguedas/agentcats, branch `main`. Commits carry no AI co-author trailer.
- **Housekeeping:** dropped the dangling `PLAN.md` reference from the milestones README. `POST /chat` takes `{ catId?, text }`, defaulting to the only cat in M0.

## 2026-11-10 - Toolchain pins

TypeScript 6.0.3, not 7.0.2: typescript-eslint 8.72.1 requires `typescript <6.1.0`, and type-aware linting is worth more than the TS 7 compiler speed.
Revisit when typescript-eslint supports 7.x.
Other pins: zod 4.6.7, vitest 4.1.12, vite 8.3.5, eslint 10.13.0, typescript-eslint 8.72.1, prettier 3.9.10, `@types/node` 22.20.5 (matches the Node 22 baseline).
Every pin was at least two weeks old on 2026-11-10.

## 2026-11-10 - Protocol design choices

These refine the M0 plan; none changes its intent.

- **REST paths live under `/api`** (`/api/tasks`, `/api/snapshot`, WebSocket `/api/events`). The daemon also serves the static UI, which must load without the token, so a prefix separates authenticated routes cleanly.
- **The REST route table is in the protocol package** (`routes`), so the daemon router and the UI client are built from one definition.
- **Permission modes are agent-neutral:** `ask`, `accept_edits`, `auto`. `acceptEdits` and `bypassPermissions` are Claude terms and would break the no-Claude-types rule. The Claude adapter maps them. A bypass mode does not exist in the schema.
- **`ts` is epoch milliseconds**, `seq` starts at 1 and increases by exactly 1, so a gap is `seq !== lastSeq + 1`.
- **Schemas are strict** (unknown fields rejected), for both commands from the network and events. `PROTOCOL_VERSION` in the snapshot is the compatibility signal.
- **Snapshot returns the projected board, not only events.** The plan said "current cats, tasks and last N events". A truncated event window cannot rebuild state, so the snapshot carries `board` (cats, tasks, pending approvals, usage, `lastSeq`) plus the last 500 events for the log panel.
- **One shared reducer**, `applyEvent`, in the protocol package. The daemon builds the snapshot with it and the UI applies live events with it, so both sides compute the same state.
- **`tool.called` is emitted twice per call**, with `status: 'running'` and then a final status, correlated by `toolCallId`. This keeps the plan's single event type.
- **Usage is cumulative per session** and carries `costSource: reported | estimated | unknown`, so the board can flag estimated or missing cost instead of showing a guess as fact.
- **Task status enum is the full M1 set now**; M0 uses only part of it. Transitions arrive with the M1 state machine.
- **`projectPath` is not in the config file.** It is the directory containing `.agentcats/`, passed by the CLI.

## 2026-11-10 - Adapter interface

The adapter contract lives in `@agentcats/protocol/adapter` (a subpath export, so the UI never imports it).
Changes from the M0 sketch, all agreed in the planning round or required to make it implementable:

- `Adapter` has `id`, `displayName` and `capabilities` (planned for M4, added now).
- `Session` has `pid` (for orphan tracking; the Claude SDK's `spawnClaudeCodeProcess` hook makes it available) and `interrupt()`.
- `SpawnOptions` has `permissionMode` and optional `resumeId`. `systemPrompt` is appended to the agent's own prompt, never replacing it, so built-in tool guidance survives.
- `send()` rejects with `busy` while a turn runs. Queuing is the daemon's decision, which matches ACP's one-prompt-at-a-time model.
- `AgentEvent` is ten types: `session.started`, `turn.started`, `message.chunk`, `tool.started`, `tool.finished`, `approval.requested`, `usage`, `turn.ended`, `error`, `session.ended`. Stream guarantees are documented on `Session` and checked by `checkSessionInvariants`, which the mock tests use now and the M4 conformance suite will reuse.
- `ToolKind` and `StopReason` mirror ACP's enums, so tool-name normalization across agents is solved in the type, not in daemon special cases.

## 2026-11-10 - Orphan prevention: a guardian process per agent, plus the PID file

**Changes the plan.** A PID file alone only cleans up on the *next* daemon start, so a hard-killed daemon would leave agents running until then.
On Windows, children never die with their parent, and on POSIX a SIGKILL runs no cleanup code.

**Decision:** every agent process is started through `@agentcats/kit`'s `spawnGuarded`, which runs a ~60-line plain-JS guardian (`packages/kit/bin/guardian.mjs`) between the daemon and the agent.
The agent inherits the guardian's stdio, so the daemon still talks to the agent directly.
The guardian polls its owner every 500 ms (and on POSIX also watches for re-parenting) and kills the agent's whole tree when the owner is gone.
Tree kill is `taskkill /T /F` on Windows and a process-group SIGKILL on POSIX (the guardian leads its own group).

The PID file `.agentcats/run/pids.json` stays as the second line of defense, for example if the guardian itself is killed.
On startup the daemon kills recorded processes only if the OS start time matches the recorded time within 10 s, so an unrelated process that reused a PID is never killed.

Tested on Windows locally and on Linux in CI: graceful shutdown, a SIGKILLed daemon (agent gone within the poll interval), and startup reaping that kills a real leftover but spares a reused PID.

## 2026-11-10 - Daemon structure

- `EventLog` is the single source of truth. It validates every event against the protocol schema before storing it (a daemon bug fails loudly instead of reaching the UI), projects the board with the shared `applyEvent`, then broadcasts. M1 swaps storage for SQLite behind the same methods.
- `CatRunner` owns the one M0 cat. The cat is created at daemon start, but its agent session only starts with the first task, so starting agentcats spends nothing.
- Adapters are injected into `startDaemon`. The daemon package depends on no adapter, so the CLI does the wiring and tests inject the mock.
- Chat turns are not tied to a task. A task's outcome comes from the turn that the task started.
- `tsx` 4.23.15 is a dev dependency, for `pnpm dev` and for the test that runs a daemon in a separate process. pnpm 11 blocks install scripts by default, so `pnpm-workspace.yaml` allows exactly one: esbuild's.

## 2026-11-10 - UI

- React 19.1.10 and Vite 8.3.5, no state library. `BoardClient` holds the view and React reads it with `useSyncExternalStore`. Board state comes only from the snapshot and the shared `applyEvent`, as the milestones require.
- Sync: open the WebSocket, buffer, fetch the snapshot, apply buffered events newer than it; any `seq` gap repeats this. Browsers hide why a WebSocket upgrade failed, so a socket that closes before opening triggers one REST call to tell "token rejected" (stop, show it) from "daemon down" (retry with backoff).
- The token is moved from the URL fragment into `sessionStorage` and removed from the address bar.
- **Beyond M0 scope, on purpose:** the approval bubble has working Allow / Deny buttons and the cat has a Stop button. M0 asked for a display-only bubble, but with the real Claude adapter an approval would otherwise sit until the 5-minute timeout. Both call REST commands that already exist in the M0 protocol. Editing permissions and pause/resume stay in M1.
- The prompt box always creates a task (`POST /api/tasks`), so every request shows up in the task list. `POST /api/chat` exists for API use; the board does not need it yet.
- Failure reasons show the agent's own last error message (for example "Build failed: ..."), not a generic "turn ended".
- The mock adapter plays the scenario named by a `/name` prompt prefix (`/approval`, `/error`, `/crash`, `/hang`), so the browser tests and demos reach every state without restarting the daemon.
- Browser tests use Playwright 1.64.1 against the built UI served by a real daemon with the mock adapter, so the CSP, token handling and WebSocket path are the production ones. They run in a separate CI job (`pnpm test:e2e`).
- `pnpm dev` runs a mock daemon on port 4545 and the Vite dev server on 5173. Vite proxies `/api` and rewrites `Origin` to the daemon's own, because the daemon rejects foreign origins.

## 2026-11-10 - Step 0.1 follow-up: runtime verification with real Claude

Verified live with Claude Code 2.1.302 (installed, WinGet), SDK 0.3.311, model `haiku`, on Windows 11:

- **Streamed tool events:** `tool_use` / `tool_result` blocks arrive as complete assistant and user messages and map cleanly to `tool.started` / `tool.finished`.
- **Permission callback:** `canUseTool` fires for a state-changing Bash command (`git commit ...`) and passes `toolUseID`, so the approval links to its tool call. Deny is honored and the turn continues.
- **Resume:** a new session spawned with `resume: <sessionId>` remembered the file created in the earlier session.
- **cwd and model:** honored.
- **Usage:** `total_cost_usd` and `modelUsage` are running totals across turns of one `query()`, as the SDK docs say. The adapter reads, never sums, and clamps so values never decrease.

Tests: `packages/adapters/claude/test/live.test.ts` and `packages/ui/e2e/live-claude.spec.ts`, both skipped unless `AGENTCATS_LIVE_CLAUDE=1`.

## 2026-11-10 - Claude adapter

- SDK pinned at **0.3.311** (built against Claude Code 2.1.311), the newest release at least two weeks old. It runs the user's `claude` via `pathToClaudeCodeExecutable`, and `spawnClaudeCodeProcess` starts it under the guardian. `TESTED_CLAUDE_VERSIONS` is `2.1.302`; other versions run with a warning on the board.
- The session id is chosen by the adapter (`sessionId` option), so `session.started.resumeId` is known before the first turn.
- `systemPrompt` is appended to the `claude_code` preset, never replacing it.
- `strictMcpConfig: true`: only servers passed in `SpawnOptions.mcpServers` load.
- Setting sources are the SDK default, so the user's own Claude Code settings and CLAUDE.md apply ("a layer on top of your Claude Code"). The live run showed this: Claude picked Python because of the user's global CLAUDE.md. Our explicit `permissionMode` overrides the user's `defaultMode`.
- Messages are taken whole (`includePartialMessages` off), so text arrives per content block rather than token by token.
- On Windows, npm's `claude.cmd` shim is followed to the script it runs. This path is unit tested but **not verified live**, because this machine has WinGet's `claude.exe`.

## M1 handoff notes

**Headless approach.** Agent SDK in streaming input mode, one long-lived `query()` per cat session, driving the user's installed `claude` under the guardian. Works end to end (see the follow-up entry above).

**MCP wiring.** Per-session config is verified (Step 0.4). Recommended for M1: an HTTP MCP endpoint on the daemon's existing 127.0.0.1 server, passed as `SpawnOptions.mcpServers` with a per-session bearer token that maps to a `catId`. The adapter already maps `McpServerSpec` (`http` and `stdio`) to the SDK. Two details for M1:

- That endpoint must accept the per-session agent token, not the UI token.
- Agents are not browsers, so it must not require an `Origin`. The Host check still applies.

**Where `AgentEvent` felt too thin:**

1. **Permission policy cannot rely on `canUseTool` alone.** Claude Code auto-approves commands it considers read-only before the callback runs: `node --version` ran without asking in `accept_edits` mode. M1's "always ask for network access" rule needs a stricter hook (SDK `PreToolUse` hooks), or the risk that some commands never reach the board must be accepted and documented.
2. **No "allow always" decision.** Approvals are `allow | deny`. M1's policy work will likely want ACP's `allow_always` / `reject_always`, which the SDK supports through `updatedPermissions`.
3. **Subagent activity is folded into the parent `Task` call.** For workers that use subagents, the board shows one long tool call. Consider a `parentToolCallId` on tool events if that hides too much.
4. **Coarse text streaming.** Text arrives per content block. If the board needs live typing, enable `includePartialMessages`; `message.chunk` already supports it.
5. **Tool outputs are not carried**, only status and a short error summary. That is deliberate (bubbles stay small); M1's `get_task_result` should get diffs and test results from git and the worker's summary, not from `AgentEvent`.

**Where it felt right or slightly thick:** cumulative `usage` with `costSource` worked without special cases. `session.started.agentVersion` is used for the untested-version warning. Nothing in the set went unused.

**Other notes for M1:**

- The full task status enum is in the protocol; the M1 transition table goes next to it.
- `EventLog` validates every event against the schema before it is stored; keep that when SQLite replaces it.
- Each cat should get an explicit `settingSources` decision. Workers in worktrees may want `['project']` only, so a user's global allow rules cannot widen a worker's permissions.
- `auto` permission mode on a Pro plan was **not** tested.
- Not verified: macOS, and Linux with the real Claude CLI. CI covers Linux and Windows with the mock only.

## 2026-11-10 - M1 planning answers

- **Orchestrator access:** read-only (Read, Grep, Glob) plus the agentcats MCP tools. No Edit, Write or Bash. It delegates; it never edits code.
- **Worktrees live outside the repo**, under `~/.agentcats/worktrees/<project>/<task>`, so the user's test runners and linters never see the copies. Branches (`agentcats/<cat>/<task-id>`) live in the user's repo.
- **Permission policy:** workers edit freely inside their worktree and run the configured test and lint commands without asking. Every other non-read-only Bash command and every web fetch raises an approval. Hooks hard-deny `git push` and writes outside the worktree. Limit, to be stated in the README: on native Windows there is no OS sandbox, so code run by an allowed command can still reach the network.
- **Storage:** Node's built-in `node:sqlite` behind a small store interface. Minimum Node becomes 22.13 (first version without the flag). Chosen over `better-sqlite3` to avoid native compilation on install.
- **Worker model:** `sonnet` by default, orchestrator uses the user's Claude Code default. Both editable per cat.
- **Budgets:** in dollars, as reported by the agent. Default $2 per cat and $10 overall, enforced for cats billed through an API (API key, Bedrock, Vertex). On a subscription plan the cost is shown as an API-equivalent estimate and not enforced unless the user turns it on. Warn at 80 percent, pause at 100 percent, resume only by the user. Each cat's budget, model and permission mode are editable in its properties on the board.
- **Pause, resume, retry:** pause interrupts the turn and the task goes `blocked`. Resume continues the same agent session. An automatic retry after a crash resumes the same session in the same worktree, and starts fresh only if resuming fails.

## 2026-11-11 - Merge strategy

Workers commit to their own branch, `agentcats/<cat>/<task>`, in a worktree outside the repo.
The orchestrator reports each branch with its diff stat and the worker's summary.
The user reviews and merges; agentcats never merges, rebases or pushes, and the worker policy blocks `git push`.
Accepting or rejecting a task on the board only records the user's verdict (it feeds XP in M2) and removes the worktree if it has no uncommitted work. The branch always stays.

## 2026-11-11 - M1 implementation decisions

- **Task state machine** in `packages/protocol/src/task-machine.ts`: one table of allowed transitions and who may make each. The daemon checks every status change against it; an illegal request is a 409. Killing a worker is the user's action and makes its task `failed` (re-runnable, reason `killed`); cancelling makes it `cancelled` (final).
- **Storage:** the event log in SQLite (`.agentcats/agentcats.db`, `node:sqlite`, WAL) is the only source of truth; the board is rebuilt by replaying it on start. One more table keeps each task's agent session id for resuming. Every event is written before it is broadcast.
- **Restart recovery:** on start, queued, running and blocked tasks become `interrupted` (`daemon_restarted`), pending approvals are resolved as `session_ended`, and cats go idle. Worktrees are kept, so a re-run continues in the same one.
- **Worktrees** are created from the main checkout's HEAD at the time the task starts. They are removed when a task is accepted, rejected or cancelled, never while they have uncommitted work (a warning notice is shown instead), and kept during review so the user can try the branch in place.
- **Scheduling:** a task goes to a free worker, or a new worker is hired up to `workers.max` (default 3). Workers keep their identity across tasks; each task gets a fresh agent session in its own worktree.
- **Retry:** one automatic retry after a crash, spawn failure or failed turn, resuming the agent session when the adapter supports it, with a note in the prompt that the previous attempt stopped. A turn that ends on a fatal agent error is treated as a crash.
- **Stuck watchdog:** no agent event for `stuckTimeoutMs` (default 5 min) while running moves the task to `blocked` (`stuck`) with a warning notice; waiting for an approval does not count. Any later activity moves it back to running. Nudge interrupts the turn and asks for a status report.
- **Budgets:** a cat's usage is cumulative across its sessions. Enforced per `budget.enforce` (default `metered`: only cats billed per use). 80 percent gives one warning notice, 100 percent pauses the cat and blocks its task; resume is refused while still over budget. Reaching the team budget pauses every busy enforced cat.
- **MCP link (final):** stateless Streamable HTTP at `/mcp` on the daemon's own server, using the official MCP SDK 1.32.2. Each orchestrator session gets its own bearer token, which is never the UI token; a foreign `Origin` is rejected.
- **Orchestrator notifications:** when a task reaches review or fails, or the user accepts or rejects one, the daemon sends the lead a message starting with `[agentcats]`, right away if it is idle, otherwise after its turn. Nothing is sent before the user has talked to the lead.
- **Worker permissions:** `git add` and `git commit` run without asking, plus `workers.allowedCommands`. A PreToolUse hook denies `git push` and writes outside the worktree or into the main checkout, and forces an approval for web fetches and network-style commands (curl, installs, git fetch and so on), even where Claude Code would otherwise auto-approve. The lead has no edit or shell tools; a hook approves its agentcats tools.
- **Protocol additions during M1:** `message.user` (the chat is a projection of the log too), reason `killed`, and `AgentPolicy` in `SpawnOptions`.
- **Names:** the lead is Tux; workers are Mochi, Miso, Tofu, Nori and so on, in hiring order.
- **The mock adapter's real file writes are opt-in** (`realFiles`). A test once ran a mock with the agentcats repo as its working directory and committed into it; the commits were local, were undone, and the option now defaults to off. `--adapter mock` on a real project never writes.

## 2026-11-11 - M1 live verification

Real Claude Code 2.1.302 on Windows 11, agentcats CLI from sources, a small Node sample repo, request typed in the browser.

- **Acceptance run** (`packages/ui/e2e/live-team.spec.ts`, models `sonnet`): "Add a login endpoint and write tests for it" became two tasks, implementation and tests, run by two workers at the same time in separate worktrees. Both reached review with one commit each (3 files +80/-4, and 1 file +112). The main checkout stayed clean. The lead reported both branches, the merge order and the open issues. The run took 54 s and cost about $0.34 (API-equivalent estimate, Pro plan).
- **Worker policy** (`packages/adapters/claude/test/live-policy.test.ts`, `haiku`): `curl` raised an approval and the deny held; `git push` and a write into the protected checkout were blocked without asking. This confirms a hook's `ask` reaches the board's approval flow.
- **Lead MCP approval by hook**, smoke run on `haiku`: every agentcats tool call ran without an approval prompt, and the SDK's shadowing warning no longer appears. On `haiku` the lead put implementation and tests into one task, so the split depends on the model.

## M2 handoff notes

**Prompts that changed most during real runs.** Both moved to version 2 after the first live run; each file's header has the changelog.

- Worker: it appended to `README.md` with a shell heredoc, which needed an approval. v2 says to edit files with the file tools, and that committing needs no approval.
- Orchestrator: it offered to "run the combined suite", which it cannot do. v2 says plainly that it cannot run commands, and that the user should merge the implementation before the tests.

**What worker summaries look like.** Workers follow the requested shape reliably:

```
## Summary

- Changed: `src/app.js` (handle takes a body and routes POST /login; ...), new `src/users.js` (...), and a README section.
- Tests: passed (`npm test`, 1 test; I added none because `test/` belongs to the other worker). ...
- Open issues: none. A request body on a route other than `/login` is still parsed, ...
```

- Real summaries run 500 to 900 characters, and the three fields often carry reasoning, not just facts.
- `Tests:` is parsed into `passed`, `failed`, `not_run` or `unknown`. A tests-only branch honestly reports `not run`, because its tests need the implementation branch.
- For the M2 debrief, parse these three fields rather than free text, and consider asking for a fourth line, for example `- Learned: ...`, instead of mining open issues.

**Other notes for M2:**

- The user's accept or reject decisions are in the log as `task.updated` with `actor: 'user'` and status `done` or `rejected`: the XP signal M2 needs, with history kept in SQLite.
- Cats keep their identity across tasks and sessions, and usage is cumulative per cat, so per-cat stats can be built from the log.
- Known limits:
  - On native Windows nothing stops code run by an allowed command from reaching the network.
  - The chat shows only what is in the last 500 events after a reload.
  - Whether the lead splits work depends on the model.

## 2026-11-11 - No agent attribution in the user's commits

**Decision (the user's):** agentcats asks agents not to add their own attribution to the commits and pull requests they write in the user's project. In the first live team run, Claude Code's default put a `Co-Authored-By: Claude …` trailer on every worker commit.

- Config `attribution` (default `false`) is passed to every cat as `SpawnOptions.attribution`, an agent-neutral option.
- The Claude adapter maps `false` to the session setting `attribution: { commit: "", pr: "" }` (the object form, which older Claude Code versions also accept). `true` keeps Claude Code's default.
- Verified live (Claude Code 2.1.302, `haiku`): a worker's commit had no trailer and no mention of Claude.

## 2026-11-11 - PID file writes on Windows

**Bug found by CI.** Replacing `pids.json` with a write-then-rename failed with `EPERM` on Windows whenever another process had the file open: a reader, an editor, or an antivirus scan of the freshly written file, which can hold it for seconds. One failed write also blocked every later write, so a worker's PID could go unrecorded.

- **Fix:** the rename is retried on `EPERM`, `EBUSY` and `EACCES` for up to 10 s with backoff (the same approach as npm's graceful-fs). A failed write no longer blocks later ones. If a PID still cannot be recorded, the cat logs a warning and keeps working; the guardian process is the primary orphan protection, the PID file is the backup.
- **Tests:** a stress test that writes 90 times while another task reads the file every 10 ms. It failed 3 out of 3 before the fix and passed 20 out of 20 after.

## 2026-11-11 - M2 planning answers

- **Cost bonus:** the XP bonus for a cheap task compares the task's cost with the median of the team's last 20 accepted tasks, and is skipped until there are 5 of them. M1 tasks have no cost estimate, and an estimate written by the lead would be noise. Known bias: small tasks get the bonus more often, so its weight stays small.
- **Levels follow XP both ways.** A cat that keeps getting rejected loses levels and the autonomy that came with them. The event is `cat.level_changed` with `from` and `to` (the plan's `cat.leveled_up` is the upward case).
- **Gate ladder as proposed:** level 3 runs the project's own scripts without asking, level 4 also runs local dev tools directly and reads outside the worktree. Network, installs and destructive commands ask at every level.
- **Live runs on the user's Pro login, not an API key.** agentcats only drives the installed `claude`, which is signed in to the user's plan. Dollar figures on a plan are Claude Code's API-equivalent estimates and count against plan limits, not money.
- **"Tests passed on first attempt" is self-reported** by the worker's summary, so it can be claimed without being true. Its bonus stays small; M3's interview scoring runs tests itself, and M2 can reuse that later.

## 2026-11-11 - Step 0 for M2: one-shot calls and reads outside the worktree

Verified against Claude Code 2.1.302 on the user's Pro login, model `haiku`.

- **One-shot calls work through the CLI.** `query()` with a string prompt, `tools: []`, `maxTurns: 1`, `settingSources: []`, a plain string system prompt and `persistSession: false` answered in 1.5 s for an estimated $0.0003 (589 input tokens). Without the Claude Code preset prompt and tools there is almost no overhead, so the debrief and consolidation calls go through the user's own `claude` like everything else. The adapter contract gets an agent-neutral `complete()` for them.
- **Claude Code asks before reading outside the working directory**, even in `acceptEdits` mode: both `Read` and `Grep` on a sibling folder reached `canUseTool`. So the level 4 read gate is an explicit allow (a hook), not the default. It is scoped to the project's main checkout (`AgentPolicy.readablePaths`), because "anywhere outside the worktree" would include `~/.ssh` and other secrets.

## 2026-11-11 - M2 implementation decisions

**Learnings are files first.** `.agentcats/cats/<name>/learnings.md` is the source of truth.
Every change is written to the file first and then logged as `learnings.changed` carrying the whole new list, so SQLite keeps the history of every version without owning the content.
Hand edits are picked up by a file watcher and by a re-read before every use (prompt, edit, debrief).
A line's id is a hash of its text and source, so an edit made against a stale copy of the file finds nothing and is refused (409) instead of changing the wrong line.
The file format is a Markdown bullet per learning, `- text (task <id>)`; headings, comments and prose are ignored, so the user can annotate the file.
Only workers have folders; the lead earns no XP.
`.agentcats/.gitignore` is written once, if missing: `learnings.md`, `profile.md` and the config may be committed, everything else is local.

**Debrief.**
- Runs after the user accepts a task, or rejects one with a note (a new optional field on the review request and a note box in the UI). Never on an unreviewed outcome.
- One `Adapter.complete()` call with the debrief prompt (v1). It sees the task, the outcome and note, the diff stat, tests and attempt, the worker's summary, and the current learnings.
- Up to 3 lines of at least 15 characters. A line is a duplicate if it matches an existing line after normalizing case and punctuation, shares at least 70 percent of its keywords (Jaccard), or all of its keywords (at least three) appear in another line.
- What is left becomes an `add` proposal. When it would go over the cap (30), it becomes a consolidation that includes the new lines instead, and the level-up consolidation is skipped for that review, so one review never runs two.
- `memory.autoAcceptAfter` (default off) accepts `add` proposals once the cat has that many accepted tasks. Consolidations always need the user.
- The call's cost is charged to the cat's usage, so it counts against its budget.

**Consolidation.** Triggered by a level-up (when the cat has at least two learnings), by the cap, or by the user.
The answer must have 1 to `cap` lines, or nothing is proposed and a notice says why.
A new rewrite supersedes a pending one.
Applying it saves the current file to `history/` first; the event carries that backup's id, and **Undo** restores it. A restore also saves the current file first, so it can itself be undone.
History file names are checked against a pattern, so a restore request cannot read outside `history/`.

**XP.** Pure function, table-tested (`packages/daemon/src/xp.ts`).
Accepted +10, tests reported passing on attempt 1 +5, cheaper than the median of the team's last 20 accepted tasks (needs 5) +3, rejected -10, never below 0.
A task's cost is the cat's spending since the task first started; after a daemon restart in the middle of a task it is unknown, and that task gets no cost bonus.
`xp.changed` carries the new total, so replaying is idempotent; `cat.level_changed` fires in both directions.

**Levels and gates** are in `packages/protocol/src/levels.ts`, agent-neutral, so M4's adapter reuses them:
- The curve (0, 30, 80, 150 XP), the memory limit per level, and the selection rule (most shared keywords with the task, newer first on a tie, file order kept).
- Autonomy per level: `package.json` scripts at level 3 (lifecycle scripts and scripts whose body fetches, installs, deletes or pushes are left out), local dev tools at level 4. Tools that can download on their own (`npx`, `npm exec`, `go test`, `cargo test`) are never on the list.
- The always-ask rules: network, installs, and destructive commands (new in M2: `rm -r`/`-f`, `git reset --hard`, `git clean`, `git checkout --`, `git restore`, `git branch -D`, `find -delete`, ...). `git push` stays refused.
- The daemon turns the level into `AgentPolicy.allowedCommands` and the new `AgentPolicy.readablePaths` (the main checkout at level 4) when a task starts.
- The Claude adapter checks the always-ask rules in its PreToolUse hook before any allow rule. It also reads the worktree's `package.json` when a script runs, because the worker can edit it: an allowed `npm test` still asks if the `test` script now fetches or deletes. Code those scripts call is not checked; the README says so next to the Windows sandbox limit, and how to keep cats below level 3.

**Adapter contract.** `Adapter.complete(options)` is new and required: one prompt, one answer, no tools, no session.
The Claude adapter runs it through the user's `claude` with `tools: []`, `maxTurns: 1`, `settingSources: []`, a plain system prompt and `persistSession: false`, under the guardian.
The mock answers from a script: a debrief proposes the worker's `- Learned:` line, a consolidation returns the list unchanged, and tests can pass their own answers.
The mock also learned the policy: `run` and `read` steps raise an approval exactly when a real agent's policy would, and a `routine` scenario runs the same commands at any level, for the gating tests.

**Prompts.** Worker v3: a "What you have learned" section, the cat's name, an optional persona, and a `- Learned:` line in the summary, which the debrief treats as a hint. Debrief v1 and consolidation v1 are new.

**Fixes found during M2:**
- The push rule matched any git command containing the word "push", so a worker could not commit with a message like "Add push notifications". Only the push subcommand counts now, after any git global options.
- Closing the daemon while a task was starting could spawn a session after all sessions had been ended; that session then wrote to the closed database. `close()` now repeats until no session is left, and a starting task stops once the manager is closed.
- Daemon integration tests outgrew Vitest's 5 s default under full-suite load (one M1 test waited 15 s inside a 5 s test). The suite timeout is now 30 s; individual waits keep their own shorter limits.
- The e2e mock daemon never cleaned its temp folders on Windows (Playwright stops it without a signal). It now records them and removes the previous run's on start.

## 2026-11-12 - M2 live verification

Real Claude Code 2.1.302 on the user's Pro login, Windows 11, workers on `sonnet`, debriefs on `haiku`.
The runs are `packages/cli/test/live-m2.test.ts`, on a small notes API the test creates (routes table, `makeNote` test fixture, a lint script that checks `docs/API.md`).

- **First learning run** (worker v3, debrief v1): 9 of 10 tasks accepted, then the plan's session limit stopped task 10. It found three problems, all fixed and covered by mock tests: commentary lines from the debrief, a level-up rewrite that deleted three newer lines, and a retry into the usage limit.
- **First level comparison:** 4 approvals at level 1 against 3 at level 4. The test and lint prompts disappeared at level 4 as designed, but the worker kept writing files through `python` heredocs and `cat >`, each of which asks. Worker prompt v4 fixed that.
- **Second level comparison** (worker v4): **3 approvals at level 1, 1 at level 4** on the same two tasks. The one left at level 4 is the `curl`, which asks at every level. No shell writes.
- **Second learning run** (worker v4, debrief v2): 10 of 10 accepted in about 5 minutes of agent time, $1.09 API-equivalent (plan usage, not billed). Level 4 at task 10 (156 XP). Approvals per task went from 1 to 2 at levels 1 and 2 to 0 at levels 3 and 4. The final `learnings.md` has 11 lines, each tied to a task. One debrief still produced a commentary line and a `Learned:` label; a consolidation merged them away, and the filter now catches both.

## M3 handoff notes

**When learnings felt useful.** After the first task the file already held the three things a newcomer needs (where routes go, how tests call the app, run lint separately). From task 4 or 5 it held facts that are not in the docs and that changed later work: `query` is a `URLSearchParams`, filters go before pagination, `/notes/search` must come before `/notes/:id`, the store hands out live objects. So: one task to be helpful, about five to be worth more than the README.

**XP weights.**
- With the defaults, ten good tasks take a cat to level 4 (156 XP), level 3 at task 6. That pace felt right; no weight needed tuning in these runs.
- `tests_first_try` fired on every task, because it trusts the worker's own summary. As a signal it adds almost nothing. M3's interview scoring runs the tests itself; reuse that to verify this bonus.
- `under_cost` needs five accepted tasks before it can fire and fired once in ten. Keep it small.
- The rejection penalty and level-down were only exercised with the mock; no live task was rejected.

**For M3's lifecycle code:**
- A cat's identity on disk is its name (`.agentcats/cats/<name>/`). Retiring should move that folder; resurrecting under a different name must rename it and regenerate `profile.md` and the file header.
- XP, level and stats are projected from the log (`xp.changed`, `cat.level_changed`, `task.updated`). `stats.json` is only a copy, so a resurrected cat needs either its events or a seeding event; do not trust `stats.json` as the source.
- Pending proposals belong to a cat; retiring one should resolve them as `superseded`.

## 2026-11-12 - M2 accepted

The user read the learnings file from the second live run and accepted it: all five M2 acceptance criteria are met.

## 2026-11-12 - M3 planning answers

- **Quick hires stay.** A worker is still hired automatically when a task waits and there is room (it starts at level 1 with no learnings); `workers.autoHire` (default `true`) turns that off. Interviews are how the user picks a better cat.
- **The daemon runs the checks itself.** After a candidate finishes, the daemon copies the interview's hidden tests in and runs its check, lint and typecheck commands in the candidate's throwaway worktree, with a time limit and without an approval prompt. The user confirmed the interview first. This runs agent-written code unsandboxed (on Windows), the same risk class as allowed commands; the README says so. It also gives M3 a verified test result, which the M2 handoff notes asked for.
- **Interview defaults:** 2 candidates on the balanced tier (`sonnet` for Claude), and $3 per interview, enforced like the other budgets (`budget.enforce`).
- **Archive path:** retired cats go to `.agentcats/retired/<name>-<id8>/`, not `retired/<name>/` as the plan says, because a retired name can be reused by a new hire and two retired cats with the same name would collide.
- **Model tiers** (`fast`, `balanced`, `best`) are mapped to model names by each adapter, so hiring stays agent-neutral for M4.

## 2026-11-12 - M3 implementation decisions

**Lifecycle.**
- A retired cat keeps its id. Its XP, level, stats and learnings stay in the log. `cat.retired` moves the whole cat into `board.retired`, and `cat.resurrected` moves it back, so bringing a cat back needs no reconstruction.
- The folder moves to `.agentcats/retired/<name>-<id8>/` with `retired.json` (the id suffix is logged in the planning answers). The file watcher is closed first, because Windows cannot move a watched folder.
- A cat with an open task retires after the task (it gets no new tasks meanwhile), or after the task is cancelled; the user chooses. Its pending learning suggestions are superseded.
- `GET /cats/:id/retire-check` lists the open task and any worktrees with uncommitted changes, so the dialog can warn before anything happens. Those worktrees are kept, not deleted.
- A cat comes back under its old name unless another cat has it now.
- XP for a task reviewed after its cat retired is not awarded, because the cat is not on the board.

**Interviews.**
- Candidates are cats with the new `candidate` role. The scheduler never gives them tasks, and their turn and session ends go to the interview manager, not to task review.
- Each candidate gets its own fresh git copy of the fixture (`<worktreesDir>/interviews/<interview>/<cat>`), or a throwaway worktree for project samples.
- Candidates start one after another, in hiring order, each start being a quick copy, so mock tests are deterministic.
- After a candidate finishes, the daemon measures its diff against the base, copies the hidden files in, and runs the check, lint and typecheck under the guardian with `checkTimeoutMs`. The candidate's own claims are never used.
- Partial results are logged as they arrive (`score: null`). Once every candidate is done, all are scored together, because the parts are relative to the best passing candidate.
- The estimate is the median earlier cost for the same sample and tier (needs 2), or a default per tier.
- The budget refuses an interview whose estimate is over `interviews.budgetUsd`, and stops candidates whose combined spending reaches it. Unknown billing (no session yet) counts as enforced.
- A full team refuses new interviews and picks.
- The winner becomes a worker (`cat.hired`). Its role becomes the persona in `profile.md`, and its starting learnings are written. It starts idle.
- Losers leave the board with `interview.completed`. Their repos are deleted; a project interview's winner keeps its branch. A daemon restart cancels interviews that were running.

**Bundled samples** are verified to fail unsolved and pass with a reference solution. The first live interview found that a hidden test expected more than the task text said (`ÜBER` losing its `Ü`); it was removed, and the samples README now says hidden tests check only what the task asks.

**Protocol:** the `candidate` role, `hiring.ts`, nine events, nine routes, `interviews` and `workers.autoHire` config, `Adapter.modelTiers`.

**Fixes found on the way:**
- A UI crash: the hire toast called a function declared further down the component.
- A just-hired cat still showed its interview's "done".
- Empty check output read as "The check failed:".

## 2026-11-12 - M3 live verification

Real Claude Code 2.1.302 on the user's Pro login, `sonnet` candidates (balanced tier), bundled sample "Add a slugify function", `packages/cli/test/live-m3.test.ts`.

- The estimate ($0.50 for 2 candidates) was shown before anything started.
- Both candidates finished in about 23 s, at $0.08 each (API-equivalent, plan usage). Each raised one approval, for `npm test | tail; npm run lint | tail`: level 1 cats ask for scripts.
- Both passed the daemon's own check with clean lint and +17 -1 diffs, and scored 98.1 and 100. The winner was hired and appears as a worker.
- No candidate was left on the board, no interview folder on disk, and no agent process running.
- The first attempt had both candidates fail on the unfair hidden test above, which showed the hard gate working on real output: neither could be hired.

## M4 handoff notes

Where Claude-specific assumptions leaked into lifecycle code (M4 will expose these):

- **Default models in the protocol config:** `workers.model: "sonnet"` and `memory.model: "haiku"` are Claude names. Another adapter needs its own defaults, or these should become tiers resolved through `Adapter.modelTiers`.
- **Per-tier cost defaults** for interview estimates (`DEFAULT_CANDIDATE_USD` in `interviews.ts`: $0.05, $0.25, $1.25) are Claude prices. They should come from the adapter, or from history only.
- **Billing detection:** `metered` versus `subscription` comes from the Claude SDK's account info. An adapter that cannot tell reports `unknown`, which now counts as enforced for budgets. That is safe, but noisy on a flat plan.
- **`Adapter.complete()`** (debriefs and consolidation) is implemented with Claude Code's tool-less one-shot mode. A second adapter needs an equivalent; without one, debriefs fail with a notice and nothing else breaks.
- **Session resume** after a crash uses `capabilities.resume`. Interview candidates never resume; they fail and are scored as failed.
- **Cost reporting:** scoring treats an unknown cost as 50 out of 100, so an adapter that reports no cost is neither rewarded nor punished.
- **The worker summary format** (`## Summary` with Changed, Tests, Open issues, Learned) is parsed for the test result, which is self-reported, and for the debrief's hint. Interviews no longer depend on it. A different agent that ignores the format still works, but loses the hint.

## 2026-11-13 - M4 planning answers and Step 0

**Answers (the user's):**
- **A generic ACP adapter** (`packages/adapters/acp`), with Codex as a thin package on top (`packages/adapters/codex`) that starts Zed's `codex-acp` and maps its tiers and modes. Kiro and other ACP agents can plug in later.
- **Codex stays mock-only for now.** The user's Codex CLI is logged in with an OpenAI API key, so live runs are billed per token. Everything is built and tested against the mock and a scripted ACP agent; the live Codex checks wait for the user's go-ahead. Acceptance criteria 1 to 3 need them.
- **Time budget:** 60 minutes of agent working time per cat, for cats whose adapter reports no cost. Warning at 80 percent, pause at 100 percent, editable per cat.

**Landscape, verified 2026-11-13:**
- **Codex CLI:** 0.145.0 is installed (the latest is 0.169.0). `codex exec --json` has no approval callback. `codex app-server` (JSON-RPC, marked experimental) has threads, turns, approvals and resume, and reports tokens only.
- **ACP:** stable at v1. TypeScript SDK `@agentclientprotocol/sdk` 2.1.0 (2.6.0 is under two weeks old).
- **Codex over ACP:** `@zed-industries/codex-acp` 0.16.0 (2026-06-08). It bundles its own Codex build and uses the user's Codex login and config. This deviates from the M0 rule of running the user's installed CLI, accepted for the generic route.
- **Kiro:** `kiro-cli acp` is native ACP (since 1.25; the CLI is now 3.x). It is deferred: it is not installed here, and an orphaned-child-process bug was reported in early 2026.
- **Pinned:** codex-acp 0.16.0, tested against Codex CLI 0.145.0 config and auth.

**Free handshake with codex-acp** (`initialize` and `session/new` only, no prompt, no cost):
- **Capabilities:** `loadSession`, `sessionCapabilities.resume` and `close`, `mcpCapabilities.http: true`; an HTTP MCP server was accepted in `session/new`.
- **Modes:** `read-only`, `auto` ("read and edit files in the workspace, and run commands; approval is required to access the internet or edit other files") and `full-access`.
- **Models:** a `model` config option, `gpt-5.4-mini`, `gpt-5.4`, `gpt-5.5` and others.
- **Auth:** methods are ChatGPT or an API key; the client is not told which one is in use, so billing is `unknown`.
- **Version skew:** codex-acp logged an error reading the model cache written by the newer installed CLI (`unknown variant max`). It is harmless here, but it is the expected cost of a bundled build.

**Leaks found before writing the adapter** (resolutions in the M4 implementation entry):
1. **Policy enforcement.** Claude lets agentcats decide each tool call (PreToolUse hooks). ACP agents decide themselves what needs approval, and Codex relies on its sandbox: in `auto` it runs commands in the workspace without asking. The M2 level gates, push refusal and always-ask rules cannot be enforced the same way.
2. **No system prompt** in ACP. The worker prompt and learnings must travel another way.
3. **No cost reporting** in ACP.
4. **No one-shot call** (`complete()`) in ACP.
5. **Billing is unknown** for Codex.
6. **The Claude-specific defaults** from the M3 handoff notes.

## 2026-11-13 - M4 implementation decisions and the leaks found

**Architecture.**
- `packages/adapters/acp` drives any ACP agent over stdio, under the guardian, and maps:
  - `session/new` or `session/resume`, then `session/set_mode` and the model option;
  - `session/prompt`, one per turn, whose response ends the turn;
  - `session/update` to text, thoughts, tool calls and usage;
  - `session/request_permission` to approvals, `session/cancel` to interrupt.
- `packages/adapters/codex` only says how to start codex-acp and maps its modes and tiers.
- The daemon holds an adapter registry, and each cat runs on its own adapter: config `adapter` (default), `orchestrator.adapter`, `workers.adapter`, changeable per cat on the board. The CLI also offers Claude and Codex on a real project, so interviews can compare them; Codex starts only when a Codex cat does.
- `packages/adapters/conformance` is the contract suite. CI runs it against the mock, and against the ACP adapter driving a scripted ACP agent (`packages/adapters/acp/test/fake-agent.mjs`). Live runs are gated: Claude with `AGENTCATS_LIVE_CLAUDE=1`, Codex with its own `AGENTCATS_LIVE_CODEX=1`, because it bills per token on an API-key login.
- ESLint keeps each agent SDK (Claude, ACP, Codex) inside its own package, in one rule; separate blocks would override each other.

**Every abstraction leak found, and its fix** (each through the protocol or the adapter interface, never a daemon special case):

| #   | Leak | Fix |
| --- | ---- | --- |
| 1   | Policy enforcement assumed per-call hooks (Claude PreToolUse). ACP agents decide what needs approval; Codex relies on its sandbox and runs workspace commands without asking. | `AdapterCapabilities.policyEnforcement` (`hooks`, `sandbox`, `none`). Codex is `sandbox`; the board shows a warning badge on such cats explaining that allowed commands and level gates are not checked one by one. The lead uses `read-only` mode either way. |
| 2   | The worker prompt went in as a system prompt; ACP has none. | The ACP adapter sends it as standing instructions ahead of the first message only, and not again after a resume. One worker prompt serves both agents; no fork was needed. |
| 3   | Cost: budgets, scores and estimates assumed dollars. ACP and Codex report none. | `reportsCost: false` gives a cat "cost unknown" and a working-time budget (`Budget.maxMinutes`, `budget.perCatMinutes`, default 60). The daemon measures working time (`Usage.activeMs`, including the running turn, refreshed every 30 s). An unknown cost scores 50 in interviews; an interview with such a candidate has an unknown estimate. The ACP adapter still maps a `usage_update` cost whenever an agent sends one. |
| 4   | `Adapter.complete()` (debriefs) assumed a tool-less one-shot mode. | The ACP adapter runs it as a short read-only session. `capabilities.complete` lets an adapter opt out, and debriefs then fail with a notice. Debriefs run on the default adapter and charge only a cat on that same adapter. |
| 5   | Billing (metered or plan) came from a Claude account call. | ACP adapters report `unknown`, which counts as enforced for interview budgets; time budgets apply to cost-blind cats regardless of billing. |
| 6   | Claude names and prices in shared code: `workers.model: "sonnet"`, `memory.model: "haiku"`, $0.05, $0.25 and $1.25 per candidate in the daemon. | Model defaults are `null` and resolve to the adapter's tiers (`Adapter.modelTiers`); estimates come from `Adapter.estimateUsd(tier)` or history per adapter. |
| 7   | One adapter per daemon: `CatAgent` and the manager used `options.adapter` everywhere. | The registry, `Cat.adapter` per cat, `CatAgentDeps.adapterFor`. A cat from an earlier run on an adapter this run lacks falls back to the default, with a warning. |
| 8   | Kill was reported as a crash (mock, Claude and ACP adapters): the process exit handler ran before `kill()` finished. Found by the conformance suite. | Each adapter sets a killing flag before killing; an exit during a kill is `killed`. |
| 9   | A crash mid-turn in an ACP agent rejected the pending prompt before Node reported the exit, so it read as an ordinary turn error. | A prompt failure with the connection closed is a fatal error, followed by `session.ended: crashed`. |
| 10  | The role adapters in the config only accepted built-in ids. | Any adapter id; the daemon checks it exists at start. Built-in ids are still checked by the CLI. |
| 11  | Tool names in bubbles: ACP gives a title and a kind, not a tool name. | The title is the tool name; the ACP kinds map one to one onto ours (`switch_mode` becomes `other`). The input summary takes `command`, `path`, `url` or the first location. |
| 12  | Session resume: ACP has `session/load` (replays history) and `session/resume` (does not). | The ACP adapter uses `resume` when the agent offers it, so a resumed cat sees no replayed events. |

**Fixed on the way:**
- `stats.json` could be overwritten by a cat's state from when it was hired, and two writes could share a temp file. Writes are now serialized per cat and read the board at write time.
- Saving a cat's panel dropped its time budget: the budget was sent without `maxMinutes`, and the server filled in "no limit".
- The card's name row overflowed with a long adapter badge.
- A kill or cancel while a worker was starting left the worker with a live session for a task that was over, so a rerun stayed queued forever (a CI flake, reproduced under load). The start now ends that session and reschedules, and `endSession` waits for a session still starting instead of killing it before it is installed.

## 2026-11-13 - M4 live verification

- **Claude, conformance suite live** (`claude.live.test.ts`, `haiku`, the user's Pro plan): 8 of 8 passed. Valid turn, follow-up, approval allow and deny (the network hook), kill with no process left, cost reported, working directory, crash reported.
- **Codex live, on a $0.50 prepaid API budget** (the user changed "mock only" to a few cheap runs; all on `gpt-5.4-mini`):
  - **Conformance suite:** 8 of 8 passed, in two runs. The first run passed 6; the two approval checks failed (see below). After the fixes, the two approval checks passed. The other six were not rerun with the sandbox fix, to save budget.
  - **Interview** (`live-m4.test.ts`, add-function sample, fast tier): both candidates passed with a full score breakdown. Claude (haiku): +26 -1, $0.006, 24 s, score 86.7 (diff 66.7, cost 100, time 100, quality 100). Codex: +16 -2, cost unknown, 71 s, score 77.5 (diff 100, cost 50, time 33.2, quality 100). The estimate showed "cost unknown". Codex asked before `git commit`, a write outside its worktree (the git directory).
  - **Mixed-team task: not run live.** The user asked for one run only, to stay within budget.
- **Leak 13, found live: version skew and the Windows sandbox.** codex-acp bundles its own, older Codex build. It could not start the `elevated` Windows sandbox set up by the user's Codex CLI 0.145, so every command failed ("windows sandbox: spawn setup refresh"). Fix: the Codex adapter passes `-c windows.sandbox="unelevated"` on Windows, weaker but working; `codex.windowsSandbox: "codex_config"` keeps the user's setting.
- **Finding: Codex does not ask before network commands.** The network approval check assumed it would. On Windows a network command runs and fails in the sandbox. The README and the ⚠ badge no longer say it asks. The approval check now asks for a file edit in read-only mode (`approvalMode: 'ask'` in the suite), which Codex does ask about.
- **Spend:** Codex reports no cost; estimated about $0.05 to $0.20 for all Codex runs, to be confirmed on the user's OpenAI usage page.

## 2026-11-13 - M4 criterion 2 accepted on mock coverage

- **Deviation:** the criterion "a task runs end to end with a Claude orchestrator and a Codex worker" was not run live. The user accepted the mock coverage instead, to keep within a $0.50 OpenAI API budget.
- **What covers it:**
  - the daemon's mixed-team tests on two mock adapters (a lead on one, a worker on the other, producing a reviewable branch);
  - real Codex doing worker-shaped work live: the conformance suite, and the interview, where the Codex candidate edited, tested and committed on a branch that passed the hidden tests.
- **Not covered:** a real Claude lead handing a task to a real Codex worker through the lead's MCP tools. The live test is ready: `AGENTCATS_LIVE_CLAUDE=1 AGENTCATS_LIVE_CODEX=1 pnpm exec vitest run packages/cli/test/live-m4.test.ts -t "Codex worker"`, about $0.05 to $0.20 on `gpt-5.4-mini`.

## M5 handoff notes

What a contributor needs to add a third adapter, for M5's contributor guide:

1. **The contract:** `packages/protocol/src/adapter.ts` (`Adapter`, `Session`, `AgentEvent`, `AdapterCapabilities`, `AgentPolicy`, `CompleteOptions`). The event stream guarantees are listed on `Session` and checked by `checkSessionInvariants`.
2. **For an ACP agent** (Kiro, Gemini CLI and others): usually no new adapter, only a package like `packages/adapters/codex`. That means an `AcpAgentConfig` with the start command, the capabilities (be honest about `policyEnforcement` and `reportsCost`), `modelTiers`, `modeFor` and `modelOption`. Kiro's `kiro-cli acp` is the obvious next one; check the orphaned-process report first.
3. **For a non-ACP agent:** implement `Adapter` directly, like `packages/adapters/claude`. Keep its SDK inside the package and add it to `AGENT_SDKS` in `eslint.config.js`.
4. **Start every process with `spawnGuarded`** from `@agentcats/kit`, and kill the whole tree. Set a killing flag before killing, so the exit is not reported as a crash (leak 8).
5. **Pass the conformance suite:** a `describeConformance` target in `packages/adapters/conformance/test/`. Scripted or mock targets run in CI; live targets are gated by their own environment variable.
6. **Register it:** an id in `AdapterId` (`packages/protocol/src/config.ts`) and creation in `createAdapters` in `packages/cli/src/main.ts`.
7. **Document** its policy model and cost behavior in the README's agents section, and record its verification in `docs/decisions.md`.

## 2026-11-13 - Step 0 for M5: name, packaging, licenses, tooling

- **Name:** `agentcats` is free on npm (404 on the registry). The GitHub repo `liamarguedas/agentcats` exists and is **private**. npm is not logged in on this machine; publishing needs the user's account.
- **Packaging today:** only `agentcats` (the CLI) is meant to ship; it depends on eight `workspace:*` packages, and the UI is `private`. `npx agentcats` needs either a single bundled package or every `@agentcats/*` package published under an npm scope.
- **SQLite:** the daemon uses `node:sqlite` (built in), so there is no native module to ship. Node >= 22.13 stays the floor.
- **Licenses of what we would ship:**
  - `@anthropic-ai/claude-agent-sdk`: "SEE LICENSE IN README.md", which points to Anthropic's Commercial Terms. Not an open source license, so it must stay an npm dependency the user installs, never bundled into our package. Its platform binaries are optional dependencies.
  - `@agentclientprotocol/sdk` and `@zed-industries/codex-acp`: Apache-2.0.
  - All our packages: MIT.
- **Art:** the cats are SVG placeholders (`packages/ui/src/components/Cat.tsx`). Step 0.3 decided to study the reference projects only and draw fresh, so no third-party art is in the repo.
- **Theme:** the UI follows `prefers-color-scheme` but has no switch.
- **CLI:** no `doctor`, `cleanup` or `--demo` yet.
- **CI:** Linux and Windows, Node 22 and 24. M5 asks for Linux and macOS. On a private repo, macOS minutes count ten times against the free quota.
- **Tools available, at least two weeks old:** `@changesets/cli` 3.0.3 (2026-09-14), `esbuild` 0.28.2 (2026-08-08), `gifenc` 1.0.3 (MIT, 2021). There is no ffmpeg on this machine, so a demo GIF would be encoded in Node from Playwright frames.

## 2026-11-13 - M5 planning answers

- **Art: meme cats, with the background removed.** The user will provide the source images. Deviation from Step 0.3's "draw fresh": accepted, on one condition. Only images with a clear license go in: CC0 or CC-BY (for example Wikimedia Commons), the user's own photos, or photos used with permission. Meme photos are usually copyrighted by the photographer, and "widely shared" is not a license. Each image gets its source, author and license in `docs/assets.md`; one without them is not shipped.
- **Packaging: one bundled `agentcats` package.** esbuild inlines our workspace packages and the built UI. The Claude Agent SDK (Anthropic Commercial Terms), the ACP SDK and codex-acp stay ordinary npm dependencies.
- **CI: Linux, macOS and Windows.** Windows stays because the user develops on it. The repo goes public at release; until then macOS runs only on pushes to `main`, to spare private-repo minutes.
- **Adapter criterion:** tested by a fresh agent given only the docs and a blank folder, run when that step comes.
- **Publishing, tagging and making the repo public** are outward-facing: each waits for the user's explicit go-ahead.

## 2026-11-13 - M5 hardening decisions

- **One daemon per project** (`.agentcats/run/daemon.json`, an exclusive create checked against the OS start time). Before, a second `agentcats` on the same project started fine, killed the first one's agents as orphans and shared its database.
- **Readiness through the adapter contract:** an optional `Adapter.preflight()` (no session, no tokens). Claude asks `claude auth status`; Codex looks for `$CODEX_HOME/auth.json` or `CODEX_API_KEY`/`OPENAI_API_KEY`. An agent the config needs must be ready to start; one only offered for interviews is left out quietly and shown by `agentcats doctor`. The conformance suite checks the preflight of any adapter that has one.
- **`agentcats cleanup`** removes only clean worktrees of tasks and interviews that are over, keeps branches (a failed task can still be re-run), keeps anything with uncommitted changes, and refuses while a daemon runs.
- **Secrets are redacted at the one door into the event log** (`EventLog.append`) and in console logs, with patterns in `packages/protocol/src/redact.ts`, so the database, the board and exports never hold them. Two consequences:
  - A key typed into a task description reaches the agent as `[redacted]`. Secrets go to agents through their environment, not the board.
  - Streamed agent text is held back until a line ends (or 2,000 characters), so a key split across chunks is still caught. Codex text therefore appears on the board a line at a time; Claude sends whole messages and is unaffected.
- **Port in use and an old Node** now get a one-line explanation instead of a stack trace. The Node check runs in plain JavaScript before any module an old Node lacks is loaded.

## 2026-11-13 - M5 replay and export decisions

- **A session is one run of agentcats**, marked by a new `daemon.started` event. A log from before M5 is one session.
- **Replay runs in the browser**, on the same projection as the live board, from the board as it stood when the session began (`initialBoard`), so cats from earlier sessions are there. It never writes to the daemon: actions are hidden or refused with a message.
- **Idle gaps longer than 3 seconds play as 3 seconds**, so a cat waiting an hour for an approval does not replay as an hour. The bar says so in its tooltip.
- **Export is built in the browser** with `prepareExport` from the protocol. It always redacts secrets and replaces the project path and the home directory. Without the "Include file contents and long outputs" box, which is off by default, it also cuts the following:
  - agent messages, to 200 characters each;
  - task descriptions, to 200;
  - summaries, to 500;
  - user messages, to 500.
- **Import never touches the daemon**: a file is validated against `SessionExport` and replayed locally.

## 2026-11-13 - M5 cost meter decisions

- **Opened from "Team spend" in the header.** Stat tiles show what was spent, the team budget left, and the working time of cats whose cost is unknown. Below them come a chart of cost over time per cat, a per-cat table (also the chart's table view), and the most expensive tasks.
- **"Cost unknown" is never drawn as $0.** A cat counts as cost-unknown by the same rule as its card: its agent reports no cost. Such cats are counted by working time, their budgets are time budgets, and their tasks are ranked by working time. Tasks now record that time (`TaskResult.activeMs`).
- **History comes from the event log** (`GET /api/usage`), thinned to the last point per cat per minute, with names for cats no longer on the board. A replay builds the same view from its own events.
- **Colors:** the data-viz reference palette, run through its validator on our light and dark surfaces. Both pass. Three light slots sit below 3:1 contrast, which is why the chart always has a legend and the table, and direct labels when there are up to four lines. Past seven cats, the cheapest fold into "Other".

## 2026-11-13 - M5 caption decisions

- **The daemon picks the caption and records it** as a `caption` event, so every viewer and every replay shows the same line. It watches the log and answers five moments: a task fails, a cat is promoted, a cat hits its budget, a cat is retired, an interview rejects candidates.
- **Templates live in `.agentcats/captions.json`**, copied from `packages/daemon/captions/default.json` on first run. Placeholders: `{cat}`, `{task}`, `{level}`, `{cats}`. A kind missing from the file uses the defaults. An invalid file falls back to the defaults, with a warning on the board. The default lines are original.
- **Serious mode:** `"captions": { "enabled": false }` stops captions at the source.
- **On the board:** a caption sits on the cat's card in meme lettering for a few seconds. One about a cat no longer on the board, such as a retirement or rejected candidates, is a toast.

## 2026-11-14 - M5 packaging decisions

- **One package, built into `packages/cli/pack/`** by `pnpm -F agentcats pack:build`. esbuild bundles all agentcats code into `dist/main.js`. The built UI and the files the code reads at runtime (prompts, interview samples, captions, the guardian) sit where their `import.meta.url` paths expect them. Third-party packages stay npm dependencies, at the single exact version every workspace package pins. The Claude Agent SDK has to stay one: its license does not allow bundling it. The tarball is about 650 KB.
- **The workspace `package.json` is not the published one:** the pack writes its own manifest, so development keeps `workspace:*` links.
- **CI tests what a stranger gets.** On Linux, macOS and Windows, with the oldest supported Node (22.13), it packs the package and installs it with plain npm in an empty folder. It then runs `npx agentcats --demo` until the scripted cats deliver a task for review (`packages/cli/scripts/smoke.mjs`). macOS runs on pushes to `main` only while the repo is private.
- **A demo stopped without Ctrl+C** (a closed terminal) leaves its temp project. The next demo removes such leftovers, keeping any whose daemon still runs.
- **Fixed on the way:** a process-cleanup test hung on a CI Windows runner because `processStartTime` called PowerShell with no timeout. Every process call in the kit now has a timeout. A PowerShell timeout is retried once. Leftover PIDs are checked in parallel.

## 2026-11-14 - M5 versioning and license check

- **Changesets 3.0.3** versions `agentcats` and writes `packages/cli/CHANGELOG.md`. The other packages are now `private` and are never published; they keep versions only because Changesets requires it of a published package's dependencies. The first changeset is a minor bump to 0.1.0. Steps are in `docs/releasing.md`.
- **Dependency licenses** (`pnpm licenses list --prod`, 2026-11-14):
  - 90 MIT, 7 ISC, 5 Apache-2.0, 3 BSD and 1 Unlicense, all compatible with our MIT license.
  - The Claude Agent SDK and its platform binaries list no SPDX license. They are under Anthropic's Commercial Terms, so they stay npm dependencies and are never bundled.

## 2026-11-14 - M5 art decision

- **The cats are meme cats from the Kaggle dataset "Cats from memes"**, labeled Apache 2.0, with backgrounds removed. The user chose this over two alternatives: original drawn cats, or a local import tool that would keep the photos off npm.
- **The risk was raised before deciding:** the uploader says the photos were "collected from memes", so the label may not hold. It is recorded in `docs/assets.md` with what to do if a rights holder objects.
- **17 looks, 212 KB in total.** They were picked by hand from contact sheets of the 2,283 images: one clear cat each, no captions. `tools/cat-art/cutout.py` rebuilds them from the picks. BiRefNet-lite was used because ISNet left half-transparent bodies on close-up faces.
- **A look is picked when a cat is created**: the one the fewest cats have, recorded on `cat.created` and in `profile.md`. The lead always gets the boss look (`buff-cat`). Cats from older logs get a stable look derived from their id.
- **Names from file names:** a pack whose files name their memes gives cats those names when they are free. This dataset's files are `cat (N).jpg`, so it changes nothing yet. **Renaming a cat on the board is deferred:** cat folders are keyed by name, so a rename has to move the folder with it.

## 2026-11-14 - M5 board decisions

- **The office scene** (the user's choice over big cards in zones):
  - **Areas:** the lead stands at the whiteboard, where idle and finished cats also wait. Working and thinking cats sit at their own desk, kept for as long as they are on the team. Cats that need you (an approval, blocked, paused, an error) go to the meeting table.
  - **Movement:** cats slide between spots in 900 ms with a short walk.
- **Details on demand:** hovering or focusing a cat opens its card: status, adapter, level and XP, task, spend, Pause and Stop. Clicking the cat opens its drawer. On a focused cat, A allows, D denies, P pauses or resumes; the card lists the keys that apply. Only one card shows at a time.
- **Few bubbles in the office:** approvals, errors, blocks and thinking. Working and done are shown by props (a laptop, a check), not text.
- **States as props on the photo:** a laptop for working, a thought badge, a pulsing "?" when it needs you, desaturated with "z" when blocked, a check and a hop for done, a red "!" and a shake for an error, confetti when promoted, a box when retired.
- **Theme:** system, light or dark, switched from the header and remembered in the browser. Each dark palette block applies under the OS setting unless light is pinned, and under `data-theme='dark'`.
- **Narrow screens:** the office keeps its proportions (minimum 760 px) and scrolls sideways. The header wraps instead of breaking button labels.
- **Laptop screen:** at 1280×800 the whole office and the first row of tasks fit without scrolling.

## 2026-11-14 - M5 documentation

- **The README reads in a minute:** the pitch, the demo GIF, `npx agentcats --demo`, the real setup, what it does, safety, known limitations, links. The details moved to `docs/guide.md`, `docs/configuration.md`, `docs/security.md`, `docs/architecture.md` and `docs/adapters.md`.
- **`docs/configuration.md` cannot fall behind the schema:** a test walks `AgentcatsConfig` and fails for any key the page does not mention.
- **The demo GIF is recorded from the product:** `packages/ui/scripts/record-demo.mjs` runs `--demo` and does what a person would: answers the approval, looks at a cat, opens the cost meter. It captures frames with Playwright and encodes them in Node with gifenc (MIT), because there is no ffmpeg dependency. The GIF is 800×450, 60 s in real time, 5.4 MB. Rerun the script when the board changes.
- **The npm README's links point to GitHub:** the pack rewrites relative links and images, since npm shows the README without the repository.
- **The code of conduct is short and original,** based on the Contributor Covenant's ideas, with reports going privately to the maintainer. Security reports use GitHub's private advisories.

## 2026-11-14 - M5 criterion 6: a fresh contributor writes an adapter

- **Test:** a separate agent, in its own git worktree, was given only the docs. Its task was a skeleton adapter (`echo`, a Node child process that echoes prompts and asks before commands) with a conformance target. It was told not to study the existing adapters' code.
- **Result:** the suite passed, 9 of 9, on its first run, after about 15 steps. Its code was not kept; it was a test of the docs.
- **Gaps it found, now fixed in `docs/adapters.md`:**
  - **`ConformanceTarget`:** the page now points to it, and says the crash check needs a real `pid`, approvals are skipped without `capabilities.approvals`, and the interrupt check needs `prompts.long`.
  - **Kit helpers:** how `spawnGuarded`, `killProcessTree` and `AsyncQueue` are used, and that `Session.pid` is the guardian's.
  - **Imports:** which come from `@agentcats/protocol/adapter` and which from `@agentcats/protocol`, and `isPush`.
  - **Dependencies:** a direct adapter's, and how a runtime file survives bundling.
  - **What to send:** `billing`, usage without a cost, a crash mid-turn, `interrupt`, and when to declare `hooks` or `sandbox`.
  - **What the suite does not cover.**
- **The suite got stronger from it:** it now checks that `interrupt()` cancels a running turn and leaves the session usable (the board's Pause relies on that), and that a session allows one `events()` iterator. The mock, the scripted ACP agent and live Claude give it a long prompt.

## 2026-11-14 - M5 criterion 2: live Claude run of the M1 flow

- **First run** (`live-team`, `haiku`, the user's Pro plan, the final office art, captions on):
  - Tux planned the work; a worker built `POST /login` with tests on its own branch (4 files, +406, 19 tests passing). The task reached review, at 3 cents API-equivalent.
  - The test failed only on parallelism: Tux made one task instead of two. Its reason was that the endpoint and its tests touch the same files, so one task avoids merge conflicts. That is a model's judgment call, not a fault in the flow; the M1 run split the same request in two. No caption fired, because nothing failed.
- **Removed `packages/ui/e2e/live-claude.spec.ts`,** the M0 single-cat spike. It had not worked since M1: its config keys no longer exist (`defaultModel`, a top-level `permissionMode`), its repo had no commit, and it expected one cat to do the work itself. `live-team.spec.ts` covers the real flow.

## 2026-11-14 - M5 criterion 2 accepted

- **Rerun** (`live-team`, `haiku`, the user's plan): the result was the same. Tux made one task, which reached review with a commit on its branch, at 2 cents API-equivalent.
- **Accepted on the user's decision:** a real run with Claude Code completes the M1 flow on the final art, with captions on. Tux choosing one task for an endpoint and its tests is a model's judgment. Parallel workers are covered by the mock team tests and were shown live in M1.
- **The live test's parallelism assertion stays** as the record of what M1 asked for. Its failure now means the model kept the work in one task, not that the flow broke.

## 2026-11-14 - Release 0.1.0: the repository is public

- **The repository is public.** With macOS minutes free, macOS joins the `check` matrix (Node 22 and 24) on every push and pull request, and the package job runs it on pull requests too. The separate `check-macos` job, which ran on pushes to `main` only, is gone.


## 2026-11-14 - Renaming cats, and no Pause or Stop on candidates

- **Renaming,** deferred earlier because a cat's folder is keyed by its name, is in:
  - `updateCat` takes `name`, checked by `CatName` in the protocol: 1 to 32 characters, letters, digits, spaces and `' . _ -`, starting and ending with a letter or digit, and no name Windows reserves (`NUL`, `COM1`, ...). It names a folder, so it must be safe on every system.
  - Names are unique on the board, whatever their case, because the lead finds cats by name.
  - A worker's folder moves under the cat's memory lock, then its `learnings.md` header and `profile.md` are rewritten and watched again, the same path a resurrection under a new name takes.
  - The lead is told. Running sessions keep the old name in their prompt until their next start; restarting a busy cat for a name was not worth the lost work.
  - Candidates are refused: their trial branch carries the name. They can be renamed once hired.
  - `catNames` (cost meter, replay) follows renames.
- **The drawer's "Saved" now means saved.** `run()` swallowed API errors, so a refused save still said "Saved". It now resolves to whether the request worked.
- **Interview candidates have no Pause or Stop** on their card, and P does nothing on them. Pausing one candidate would skew the comparison; Cancel interview stops the trial as a whole. Before, the buttons showed disabled.
- **No changeset:** 0.1.0 is not on npm yet, so these ship in it; its changelog entry describes the whole first release. The `v0.1.0` tag goes on the commit that is published.

## 2026-11-14 - agentcats 0.1.0 is published; M5 is done

- **Published** `agentcats@0.1.0` to npm from `packages/cli/pack`, built from 7bcd56c. The user published it from their own terminal, because npm asks for a second factor in the browser; an automated `npm login` earlier got the account briefly blocked for bot activity, so logins and publishes stay manual.
- **Checked from the registry:** the published package, installed into an empty folder, passed `smoke.mjs` (a demo board whose scripted cats deliver a task for review).
- **Tagged** `v0.1.0` on 7bcd56c and created the GitHub release with the changelog entry.
- **Repository settings:** private vulnerability reporting is on (`docs/security.md` sends reports there); the description, homepage and topics are set.
- **M5 is done.** Every acceptance criterion is checked and CI is green on Linux, macOS and Windows.

### Handoff

- There is no milestone after M5. Next releases follow `docs/releasing.md`: a changeset per user-facing change, `pnpm changeset version`, `pnpm release:build`, the smoke test, then a manual `npm publish`.
- Open items after release: see "The open items after 0.1.0" below.

## 2026-11-14 - The open items after 0.1.0

- **Cat picture rights: accepted, not open.** Clearing them is not possible; these photos have circulated as memes for years and their photographers are mostly unknown. `docs/assets.md` keeps the disclosure and the way to remove an image, since a long history of sharing is not a license.
- **Straight edges on cropped cats: fixed.** `cutout.py` fades the cat out over 22% of its size toward any side of the photo the cat touches along more than 4% of that side (`FADE`, `TOUCH`). 14% still showed a vertical end on `tabby-loaf`. 13 of the 17 pictures changed; the set is 179 KB, down from 212 KB. The manifest is now written with LF line endings on Windows.
- **The live team test asks for two specified features.** M1's sentence left the split to the lead, and haiku twice kept the endpoint and its tests in one task, a fair call. With "two separate features" but a bare "POST /login", the lead queued the version endpoint and rightly held login back to ask what it should check. With both features specified, the run passed: two tasks, two workers at once, a commit on each branch, $0.02 API-equivalent, with the lead warning about the merge conflict in `src/app.js`. The test now checks what agentcats owns (the lead follows a requested split, workers run in parallel), not a model's judgment on how to split.
- **The mock dry run of that test works again.** The CLI's mock never commits, so in mock mode the test skips the commit check; it had failed before this change too.

## 2026-11-14 - README banner, badges and social preview

- **Banner:** rendered by `packages/ui/scripts/render-banner.mjs` from the real cut-outs and the board's palette, in light and dark, shown with `<picture>` so GitHub picks the one matching the reader's theme. It replaces the README's `# agentcats` heading, since the wordmark is in it. Cats whose photo was cropped look boxy on the dark ground even faded, so the lineup uses ones that were not, or barely, cropped.
- **Badges:** npm version, CI, license and Node version.
- **npm README:** the pack now also rewrites relative `src`, `srcset` and `href` attributes in HTML, not only Markdown links, so the banner and the license link work on npmjs.com.
- **Social preview** (1280 x 640): GitHub's API cannot set it; the maintainer uploads `docs/media/social-preview.png` under Settings.
- **Demo GIF re-recorded** with the faded cut-outs, so it still matches the product.

## 2026-11-14 - Bubbles never cut off at the top of the office

- **Bug, reported with a screenshot:** the lead's approval bubble was cut off at the top of the office when the request was long (a UUID wrapping to two lines). The office sits in a sideways-scrolling container, and `overflow-x: auto` also clips vertically, so anything above the office's top edge disappears. The fixed headroom (`420px` plus a row per three workers) is not enough for a tall bubble over the lead, who stands high at the whiteboard.
- **Reproduced first** in the browser tests: the mock lead now understands `/lead-asks` and waits for an approval with a long argument. The new test checks that the bubble's top is inside the office.
- **Fix:** after each render, the office measures, for every cat with a bubble, the distance from its feet to the top of its bubble, and grows to the height where all of them fit with 12 px to spare. Cats stand at a share of the height, so one division per cat gives the answer. Layout offsets are used, not screen positions, so a walking cat or a bubble still popping in measures the same. The office shrinks back when the bubble goes.
- **Rejected:** flipping the bubble below the cat (it would collide with the hover card, which opens below), and clamping the request text (it hides what the user is approving).
- **Also fixed, a flake:** the daemon tests that wait for interview candidates (in `hiring.test.ts` and `adapters.test.ts`) waited 15 s for their trials. Alone they take about 5 s, but during `pnpm check`, with every package's tests in parallel, they took 18 s once. The wait for the trials is now 45 s, with a 60 s test timeout.

## 2026-11-14 - Settings on the board, and user-wide defaults

- **Reported:** the user started agentcats expecting Claude and the lead ran on Codex. The event log showed why: Tux was created on 2026-11-13 with `adapter: "codex"` during an earlier run, and a cat keeps the agent it was created with. Nothing said so, and the defaults could only be changed by editing JSON.
- **Settings dialog** (header, next to Hire a cat): the default agent, the lead's and workers' agent and model, workers at once, auto-hire, worker permission mode, budgets for new cats and the team, captions. The protocol's `Settings` schema is that subset of `AgentcatsConfig`; routes `settings` and `saveSettings`.
- **Two layers, as the user chose:** `~/.agentcats/agentcats.config.json` (every project, `AGENTCATS_HOME` moves it) under the project's file, over the built-in defaults. Saving writes only what differs from what that file inherits (`withSettings`), so a project does not pin the user's defaults, and other keys are kept. Saving goes through the same schema and is refused, writing nothing, for an agent this run does not have or a lead without MCP.
- **Applied live:** the daemon's config object is updated in place; the default agent, captions and the team budget, which were read once at start, are now read as they are used.
- **Existing cats, as the user chose:** the dialog lists the cats on another agent than their role's new one, checked; the checked ones move from their next session. At start, one notice on the board and one line in the terminal name any cat on another agent.
- **The dialog shows what the run uses,** including `--adapter`; saving makes that the default. Showing only the files' values would offer an agent the run may not have.
- **Tests never touch the real home:** Vitest and the browser tests set `AGENTCATS_HOME` to a temp folder.
- **Also:** the board's `attempt` helper was a copy of `run` since `run` started reporting success; they are one now.
- **Also fixed, a CI failure on macOS:** a session that ended as a test closed its daemon removed its PID from `pids.json` in the background (`void pids.remove(...)`); the test then deleted the project between the temp write and the rename, and the rejection went unhandled. The removal now warns on failure, like the add, and `daemon.close()` waits for pending PID-file writes (`PidRegistry.settled()`).

## 2026-11-14 - Cards open where they fit

- **Bug, reported with a screenshot:** hovering a cat in the bottom row (cats waiting at the whiteboard, the second desk row, the front meeting seats) opened its details card below the cat, past the office's bottom edge, where the sideways-scrolling office cuts it off.
- **Reproduced first** in the browser tests: a finished worker waits in the bottom row; its card must end inside the office.
- **Fix:** cards are now hidden with `visibility` instead of `display: none`, so they keep their size and can be measured. After each render the office compares each cat's card with the room below and above it and opens it above (`data-open="up"`) when it does not fit below. Measured rather than a fixed row rule, since the lead and the back meeting seats sit mid-height and a card's height depends on its contents.

## 2026-11-14 - Next: the board as a canvas (M6); nested orchestration parked

- **M6 planned** at the user's request: the office as a full-screen canvas with pan and zoom, the chat, tasks, event log and details in panels from the sides, Excalidraw style. The three zones stay, laid out by the board, because where a cat stands is information. Plan: `docs/milestones/M6-canvas.md`, starting with a prototype and a go or no-go. The user chose a pan-and-zoom library over our own code, the chat as the only panel open on first load, and the desks in the middle with the whiteboard above and the meeting table to the side.
- **Parked: workers that run their own sub-agents.** Raised by the user, deferred together. Against it for now: it multiplies sessions, cost and approvals the user did not ask for, layers branches into merges of merges, and Claude Code and Codex workers can already use their own subagents inside one reviewable session. Before it: a worker asking the lead to split its task, and larger waves within `workers.max`. Trigger to revisit: a real request that one lead with 16 workers cannot handle; then at most one more level, with a sub-lead budget taken from the lead's.

## 2026-11-14 - M6 Step 0: the canvas prototype

- **Built on the branch `spike/m6-canvas`:** the office as a room of fixed size in canvas px, sized for the team (`layoutFor`), with the desks in the middle (four columns), the whiteboard above them and the meeting tables to their side, two seats per table. It is panned and zoomed by `react-zoom-pan-pinch`, with the chat, tasks and event log in a dock on the right. Only the chat is open at first. Bubbles and cards are scaled back up when zoomed out (`--counter-scale`), as a stand-in for the overlay in section 6. `packages/ui/scripts/canvas-spike.mjs` stages a team on the mock daemon, takes the screenshots and measures the frames. The mock daemon takes `AGENTCATS_MAX_WORKERS`.
- **The library checks out:** `react-zoom-pan-pinch` 4.2.0, MIT, no dependencies, published 2026-09-03. A plain wheel pans and Ctrl or Cmd with the wheel zooms, like Excalidraw. A pinch zooms. The arrow keys and + and - are built in, opt-in, and skip text fields. `setTransform`, `zoomToElement` and `contentToClient` cover Fit, Needs you and the overlay's anchoring, and `onTransform` fires on every frame without a React render. It has no reduced-motion setting, so we pass an animation time of 0 ourselves. Its fit has no margin and does not know about our panels, so Fit is our own: about 20 lines, framing the office in the space the open panels leave free, never past 100%. It adds 48.7 kB to the bundle, 14.4 kB gzipped (from 393.1 kB to 441.9 kB, and from 115.9 kB to 130.3 kB gzipped).
- **Screenshots, current board next to the prototype:** `docs/media/m6-step0/side-by-side-{3,12}-{1280x800,1920x1080}.jpg`, and `canvas-16-cats-1280x800.jpg`. At 12 cats the current board shows half the team and needs scrolling. The prototype shows everyone at 54% (1280 x 800). At 16 cats the prototype fits everyone at 42%.
- **Frame times** while panning and zooming with 16 cats, half of them walking. Chromium headless at 1280 x 800, 60 Hz, so one frame is 16.7 ms. Frames over 20 ms count as dropped.

  | Run | p50 | p95 | p99 | Dropped |
  | --- | --- | --- | --- | --- |
  | As built, full CPU | 16.7 ms | 16.8 ms | 16.8 ms | 1 of 474 |
  | As built, CPU slowed 4x | 16.7 ms | 33.4 ms | 66.7 ms | 27 of 491 |
  | 4x, no drop shadows | 16.7 ms | 16.8 ms | 66.7 ms | 22 of 491 |
  | 4x, no counter-scaled bubbles | 16.7 ms | 16.8 ms | 66.7 ms | 15 of 493 |

  At full CPU nothing is dropped. With a slow CPU, the cost is mostly re-rasterizing the counter-scaled bubbles on every zoom frame, then the drop shadows. The screen-space overlay of section 6 draws bubbles at their own size and removes the first cost. Two runs of the 4x case gave a p95 of 33 ms and 50 ms, so single numbers at 4x are noisy.
- **Found, and what the full build must do about it:**
  - **Counter-scaling in the room is not enough.** Zoomed out to 42 to 54%, the scaled-up approval bubbles at the meeting tables cover each other and their cats (see the 16-cat screenshot). The overlay of section 6 must keep bubbles apart, not only inside the screen. Below a zoom threshold an approval collapses to a small badge on its cat, and the Needs you button leads to it.
  - **Names are unreadable below about 60%.** The cats' name labels move to the overlay too, at a fixed size, or are hidden below the threshold.
  - **Fit must leave room for the open panels,** or the meeting zone ends up under the chat. Done in the prototype. Until the user moves the view, it refits as the team grows and when a panel opens or closes.
  - **The whiteboard is sized for the whole team waiting at once**, so desks never move when a cat goes idle. At 16 workers that makes it three rows tall and mostly empty. Better: the idle row sits beside the board and wraps, and the whiteboard grows only by the rows actually used, with the desks animating down.
  - **Panels must stay mounted when collapsed** (they are hidden, not removed), so the chat keeps its draft and scroll position.
  - **Browser tests:** the suite runs in order and stops at test 2 of 24, which reads the Tasks list that now sits in a closed panel. As planned, the tests need a helper that opens a panel before reading it, and position checks against the canvas.
- **Changed in the plan, the frame-time criterion:** "under 16 ms at the 95th percentile" cannot pass at 60 Hz, where a frame is 16.7 ms. It now reads: p95 at most 17 ms, and fewer than 5% of frames over 20 ms, with 16 cats walking while panning and zooming. It is measured in the browser test on CI and checked locally with the CPU slowed 4x.
- **Recommendation: go**, with the overlay of section 6 (including the badges below the zoom threshold) built before the panels, since it decides whether a large team is readable. **Waiting for the user's go.**

## 2026-11-14 - M6 built: the board as a canvas

- **Go:** the user gave the go on Step 0 the same day; the build continued from the prototype on `feat/m6-canvas`.
- **The screen-space layer** (`.canvas__overlay`): every cat has an anchor at its feet, placed with CSS from the view (`--ox`, `--oy`, `--s`, set on each frame by `onTransform`) and its spot (`--wx`, `--wy`, registered with `@property` so they walk in step with the cat). Moving the view renders nothing in React. The name tag, bubble, details card, captions and XP pops are drawn there at their own size; the cat's photo stays on the canvas. `CatCard` takes `part: 'token' | 'overlay'` for the two halves.
- **Bubbles never cover a bubble or a cat.** After each render and when the view settles, the office tries spots for each bubble, nearest first: over the cat, lifted, to either side, below it. It takes the first that is in the visible canvas (clear of the panels) and covers no bubble and no cat, its own included. A moved bubble gets a line to its cat instead of its tail. Fallbacks: in view and apart from other bubbles, then just in view. A cat's own photo counts as covered because, in the browser tests, a bubble placed over it took the click meant for the cat.
- **Badges below 45%**, not 60% as Step 0 suggested: at 1280 x 720 with the chat open, Fit lands at about 54%, and approvals have to be answerable there. With the placement above, bubbles do not pile up at that zoom. Below 45% an approval is a **?** badge beside the cat; clicking it zooms in on the cat.
- **The card** opens below the cat, or above it when there is more room there, and never over the cat's own bubble (an approval is answered there). The card of a cat whose details panel is open stays closed.
- **A card with room on neither side** (zoomed far in on a short screen) slides into view, over its cat if it must. Found by CI: Linux fonts make the card 230 px tall, which no longer fit at 200% on 1280 x 800. The test now runs at 1280 x 680, and reproduces it locally.
- **No hover card on touch:** a tap opens the cat's details. A card sliding in under the finger took the tap.
- **Needs you** (header) counts the cats waiting for an approval, blocked, paused or in error, and frames them all; N steps through them, framing each and giving it focus for A and D. Out-of-view cats that need you get markers on the edge of the visible canvas, stacked when several point the same way, drawn under the bubbles so they never hide an Allow or Deny.
- **The room grows with the team** (`layoutFor`): four desk columns, a row per four workers; a meeting table per two cats waiting; the whiteboard grows by the rows of cats actually waiting at it, which moves the desks down. The meeting zone is 480 px wide with one table to start, and waiting cats stand 150 px apart so their name tags do not touch at Fit.
- **Zone labels** scale back up when zoomed out (`scale: max(1, 1 / var(--s))`), so they read at every zoom.
- **Fit** frames the office in the area the open panels leave, never past 100%. It is instant on load and animated after a panel opens or closes. Until the user moves the view, it refits as the office grows. On a phone, where the office does not fit even at 30%, it starts at the left, where the lead is.
- **The view is remembered** per project in the browser, keyed by the lead's id (the board has no project id; the lead is the project's own), and forgotten by Fit.
- **Zoom buttons** zoom by 25% about the middle of the visible canvas, from where the current animation is heading. With the library's own `zoomIn`, quick clicks restarted from mid-animation, and 12 clicks reached 91%.
- **F** works anywhere on the board except in a text field or a dialog; the canvas viewport is focusable with an accessible name, so the arrow keys and + and - work on it. Focus follows a cat into view only for keyboard focus (`:focus-visible`): a click that panned the view moved the cat between mouse down and up and lost the click.
- **Panels:** chat, tasks (with the retired cats) and the event log in a dock on the right, hidden rather than unmounted when closed, so the chat keeps its draft. The open one is remembered (`agentcats:panel`). A cat's or a task's details are a non-modal panel on the left. Under 640 px both are bottom sheets over 55% of the screen. Toasts moved to the bottom middle, clear of both.
- **Browser tests:** `e2e/canvas.spec.ts` runs against a second mock daemon with `AGENTCATS_MAX_WORKERS=16`, so the 3-worker suite stays as it was. It covers Needs you and N with 12 cats, edge markers, every cat's card and bubble in view at 30% and 200% with a panel open, 16 cats apart at 1280 x 800 and 1920 x 1080, frame times, Enter and P from the keyboard, panels and the view remembered, and a 400 px touch screen. The shared helpers are in `e2e/helpers.ts`. Frames measured locally: p95 16.7 ms, 0 to 0.5% over 20 ms.
- **Media:** the README GIF is re-recorded from the canvas. The banner and the social preview are compositions of the cut-outs, not screenshots of the board, so they stay.
- **Removed:** `scripts/canvas-spike.mjs` (the browser test measures frames now), and styles left unused by the old layout.
- **Also fixed, a flake on macOS:** the rename test's hand edit was sometimes never picked up. Opening a cat's folder wrote its files, wrote its stats, synced, and only then started watching, so an edit made in between was missed until the next sync. The watcher now starts right after the folder exists, before the sync.
- **Also fixed, cats that never stopped walking** (older than M6): the walk effect depended on the spot object, which is new on every render. A render during a walk ran its cleanup, which cancelled the timer that ends the walk, and the re-run returned early because the spot had not moved. On a busy board a cat kept its walking state for good. The effect now depends on the coordinates. Found by the 16-cat test on CI; the keyboard test now checks that a cat stops walking after it pauses and resumes, and fails without the fix.
- **Handoff:** nested orchestration stays parked (see above). Possible next steps: a minimap once teams exceed 16 workers; letting the user drag a panel's width.

## 2026-11-14 - Rooms on the canvas, and Ctrl + and Ctrl -

- **Reported by the user, with a screenshot:** on the canvas the office was one small rectangle with everything in it and empty canvas all around. The canvas gives room; use it.
- **Rooms instead of zones,** each with its own walls, floor and a sign on the wall: the lead's office (the lead and the whiteboard) above the workspace (the desks), and the meeting room and the break room beside them (`layoutFor`). The user asked for a CEO office, a workspace and a meeting room. The CEO office is called the lead's office, since the board calls that cat the lead.
- **A break room, not asked for:** idle and finished workers used to wait at the whiteboard; in the lead's office they would crowd the lead. They rest on cushions in a break room instead. `Area` is now `office`, `desks`, `meeting` or `lounge`.
- **Out of office,** as the user asked: retired cats sit in their boxes in a room below the break room, with **Bring back** on each. The room exists only while someone is retired and does not move the others. The retired list in the Tasks panel stays, for the reasons and dates.
- **Each room grows on its own:** a desk row per four workers, a table per two cats in the meeting room, a cushion row per three idle cats. The meeting room is 640 px wide with 320 px between tables, so at Fit on 1920 x 1080 four approvals sit around their tables without covering a cat.
- **Ctrl or Cmd with + and -** zoom the canvas instead of the page, as the user asked, and **with 0** fit it, like a browser's reset. + and - without Ctrl now work anywhere on the board, not only with the canvas focused; the library's own keyboard zoom is off, so a focused canvas does not zoom twice.
- **Fixed along the way:** the layers that hold the cats and the furniture covered the whole office and took the clicks meant for things under them (the out-of-office buttons); they now pass clicks through except on the cats. Toasts moved to the bottom left, above the zoom controls (beside the details panel when it is open, at the top on a phone): in the bottom middle they covered the rooms. Edge markers are back above the bubbles, which they now avoid once the view settles, and line up along the edge both ways. Fit keeps the office above the zoom controls.
- **Ctrl or Cmd and the wheel** (and a trackpad pinch, which browsers send as the same) zoom the canvas about the pointer, in our own wheel handler, and never the page over the canvas. Asked by the user. A browser test showed it did nothing before: the library only zoomed with the wheel while it had seen Ctrl go down, which it missed. Over the panels the browser's own zoom still works.
- **Found by the same test:** a plain wheel never panned, though the guide said it did. The library ships with wheel panning off (`trackPadPanning.disabled`); it is on now, and the test checks it.

## 2026-11-15 - Release 0.2.0

- **Two changesets dropped before versioning:** "cards open where they fit" and "the lead's bubble fits". Both fixed the fixed-size office that 0.2.0 replaces with the canvas, so their changelog lines would have described a board that no longer exists; the canvas entry covers bubbles and cards staying in view. Removed from `.changeset/` rather than edited out of the changelog, which is never edited by hand.
- **The first `npm publish` was refused (an expired login), and that saved the release:** npm 11.20 also "auto-corrected" the manifest by dropping the `agentcats` bin, because its path started with `./`, so `npx agentcats` would have broken. 0.1.0 was published with an older npm that kept it. The path is `bin/agentcats.mjs` now, and the CI package job runs `npm publish --dry-run` with that npm (pinned to 11.20.0) and fails if npm has anything to correct.

## 2026-11-15 - Bubbles under CSS zoom on the page

- **Found while re-shooting the launch video,** which renders the board at 2560 x 1440 with CSS `zoom` on the page (the screencast ignores the device scale factor): an approval bubble was thrown off the left edge with a long line to its cat. The office's layout pass took client rects, which are zoomed, and compared them with the visible area, which comes from `clientWidth` and is not. It now divides the rects by the layer's zoom (its client width over its layout width). Browser zoom is unaffected either way, since it does not change either measure.
- **Reproduced first:** a browser test zooms the page by 1.5 and expects every approval bubble in view; it fails without the fix (a bubble at x = -71) and passes with it.

