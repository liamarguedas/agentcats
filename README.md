# agentcats

A local whiteboard where coding agents are cats.
You give a cat a task, and you watch it think, work, ask for permission and finish, while a real agent edits your project.

Status: **milestone M0**.
One cat, driven by your own Claude Code, or by a built-in mock that needs no agent and spends nothing.
Orchestration, parallel workers, memory and hiring arrive in M1 to M5 (see `docs/milestones/`).

## Requirements

- Node.js 22 or newer, and pnpm 11.
- For real runs: [Claude Code](https://code.claude.com) installed and logged in (`claude` on your PATH).

## Quick start

```bash
pnpm install
pnpm build
pnpm agentcats --project /path/to/your/repo
```

The board opens in your browser.
Type a task such as "add a hello function" and press Enter.

To try it without Claude Code, add `--adapter mock`.
In mock mode, a prompt starting with `/approval`, `/error`, `/crash` or `/hang` plays that scenario.

## Configuration

Optional: `<your repo>/.agentcats/agentcats.config.json`. Every field has a default.

```json
{
  "adapter": "claude",
  "defaultModel": null,
  "permissionMode": "accept_edits",
  "approvalTimeoutMs": 300000,
  "port": 0,
  "claude": { "executablePath": null }
}
```

- `permissionMode`: `ask` (approve everything that changes something), `accept_edits` (file edits in the project run without asking), or `auto` (Claude decides what is safe). Anything not allowed shows up as an approval bubble on the cat. There is no bypass mode.
- `defaultModel`: `null` uses your Claude Code default; any Claude model name or alias (for example `haiku`) works.

## Authentication and terms

agentcats uses whatever auth your Claude Code is configured with.
You are responsible for using it in line with Anthropic's terms.
An API key works the same way.
agentcats never stores, reads or asks for Claude credentials.

The Claude adapter depends on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), which is not open source and is governed by [Anthropic's Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms).
agentcats itself is MIT licensed and does not redistribute the SDK; your package manager installs it.

## Security model

- The daemon listens on `127.0.0.1` only.
- A random token is generated at every start and passed to the browser in the URL fragment, which never reaches server logs. The UI then removes it from the address bar.
- Every API call needs the token. The WebSocket must also come from the daemon's own origin.
- Requests with a foreign `Host` header are rejected (DNS rebinding protection).
- Agents run under a small guardian process, so they die with the daemon, even if the daemon is killed hard.

## Development

```bash
pnpm dev        # mock daemon + Vite dev server with hot reload
pnpm check      # format, lint, typecheck, tests (no tokens)
pnpm test:e2e   # browser tests against the mock
```

See `CLAUDE.md` for all commands and repository rules, and `docs/decisions.md` for every technical decision and why it was made.

| Package                    | What it is                                                      |
| -------------------------- | --------------------------------------------------------------- |
| `packages/protocol`        | The contract: event, command, config and adapter types (zod).   |
| `packages/kit`             | Process helpers: guarded spawn, process tree kill, async queue. |
| `packages/daemon`          | Owns agents, the event log, REST and WebSocket API, security.   |
| `packages/adapters/mock`   | Scripted agent for development and tests.                       |
| `packages/adapters/claude` | Claude through the Agent SDK, running your installed `claude`.  |
| `packages/ui`              | React whiteboard, served by the daemon.                         |
| `packages/cli`             | The `agentcats` command.                                        |

## License

MIT. See `LICENSE`.
