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
- **Authentication.** The SDK overview says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead." So agentcats must document API key (or Bedrock / Vertex) auth as the supported path. This is an open product question, see "Open questions" below.
- **Branding.** Products built on the SDK may say "Claude Agent", "Claude", or "<Name> Powered by Claude", but not "Claude Code" or "Claude Code Agent". User-visible adapter labels must follow this. The internal directory name `adapters/claude-code` is under review, see "Open questions".
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

## M1 handoff notes

To be filled in at the end of M0: chosen headless approach, MCP wiring method, and where `AgentEvent` felt too thin or too thick.
