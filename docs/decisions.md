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
Open: whether to run the bundled or the installed binary by default, and the README wording about Anthropic's terms for subscription use.

## 2026-11-10 - Answers to the M0 planning round

- **Adapter naming:** `packages/adapters/claude/`, npm `@agentcats/adapter-claude`, UI label "Claude". Other packages are `@agentcats/protocol`, `@agentcats/daemon`, `@agentcats/adapter-mock`, `@agentcats/ui`, and the CLI package `agentcats` with bin `agentcats`.
- **Token transport:** REST uses `Authorization: Bearer <token>`. The WebSocket carries the token as a `Sec-WebSocket-Protocol` value, never in the query string. The daemon also rejects a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` (DNS rebinding) and a foreign `Origin` on REST. Each rule has a test.
- **Orphans:** agent PIDs go to `.agentcats/run/pids.json`. Graceful shutdown kills each process tree (`taskkill /T /F` on Windows). On startup, leftover PIDs are killed. The mock adapter has a child-process mode so the automated test hard-kills a real daemon and checks no child survives.
- **Interface additions now rather than in M4:** `Session.interrupt()`, a terminal end-of-turn / end-of-session `AgentEvent` with a stop reason, optional `resume` id in `spawn` options, `Adapter.capabilities`. Approvals stay `allow | deny`.
- **Node baseline:** `engines.node >=22`. CI on 22 and 24.
- **Repo:** https://github.com/liamarguedas/agentcats, branch `main`. Commits carry no AI co-author trailer.
- **Housekeeping:** dropped the dangling `PLAN.md` reference from the milestones README. `POST /chat` takes `{ catId?, text }`, defaulting to the only cat in M0.

## M1 handoff notes

To be filled in at the end of M0: chosen headless approach, MCP wiring method, and where `AgentEvent` felt too thin or too thick.
