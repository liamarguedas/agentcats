# Security

agentcats runs coding agents on your machine, in your repositories, with your agent logins.
This page says what it protects, how, and where the protection ends.

## What it protects against

- **Other websites in your browser** reaching the board or the daemon.
- **Other users and programs on the network** reaching the daemon.
- **Agents doing more than you allowed**: writing outside their own worktree, pushing, reaching the network or installing packages without asking.
- **Secrets leaking** into the board, its database, its logs or a session you share.
- **Agent processes outliving agentcats**, or two agentcats instances fighting over one project.

It does not protect against a malicious agent CLI, or against code that you, or a cat with your approval, run on purpose.

## Defaults

- **Local only.** The daemon listens on `127.0.0.1`, never on a network interface.
- **A token per run.** A random token is made at every start and given to the browser in the URL fragment, which never reaches server logs; the board then removes it from the address bar. Every API call and the WebSocket need it.
- **Same origin.** Requests from another origin are refused, even with the token, and a foreign `Host` header is refused (DNS rebinding).
- **The lead has its own token.** It reaches the daemon through an MCP endpoint with a per-session token, separate from the browser's, and it has no edit or shell tools: it only reads and delegates.
- **Worktrees outside your repo.** Each worker works in its own git worktree under `~/.agentcats/worktrees/`, on its own branch. Your checkout is never touched, and agentcats never merges or pushes.
- **Guarded processes.** Every agent runs under a small guardian process that kills it when the daemon goes away, even after a hard kill. Their PIDs are also recorded, so the next start, or `agentcats cleanup`, stops leftovers after checking each PID still belongs to the process that was started.
- **One daemon per project.** A second `agentcats` on the same project is refused, so it cannot kill the first one's agents or share its database.
- **No credentials handled.** agentcats never reads, stores or asks for Claude or Codex credentials; the agents use your own logins.

## What workers may do

| | Claude cats | Codex cats |
| --- | --- | --- |
| Read the project | yes | yes |
| Edit files in their own worktree | yes (or ask, in `ask` mode) | yes |
| Commit to their own branch | yes | yes |
| Run `workers.allowedCommands` and what their level unlocks | yes | runs any command in its sandbox |
| Network access, package installs, destructive commands | always ask, at every level | blocked by the Codex sandbox, not asked about |
| Push, or write outside their worktree | never | blocked by the Codex sandbox |

Claude cats are checked action by action before each one runs.
Codex cats rely on Codex's own sandbox, and carry a ⚠ badge on the board saying so.
The level rules are in `packages/protocol/src/levels.ts`; the [guide](guide.md#memory-and-levels) explains them.

## Secrets

Everything that enters the event log passes through one function that redacts secrets: API keys of the common providers (Anthropic, OpenAI, GitHub, GitLab, AWS, Slack, Google, Stripe, npm), JWTs, private key blocks, `Authorization` headers, passwords in URLs, and `name = value` assignments whose value looks random.
That covers the database, the board, the logs and exported sessions.
Streamed agent text is held back until a line ends, so a key split across chunks is caught too.

Consequence: a key you type into a task reaches the agent as `[redacted]`.
Give agents secrets through their environment, not through the board.

## Shared sessions

An exported session always has secrets redacted, and your project path and home directory replaced by `<project>` and `~`.
Unless you tick **Include file contents and long outputs**, agent messages are also cut to 200 characters and task descriptions and summaries shortened, so file contents an agent printed do not travel with the file.
Read an export before posting it publicly: redaction catches common secret formats, not every secret.

## Known gaps

- **Allowed commands run code the worker can change.** A worker can edit the tests or scripts that `npm test` runs, and from level 3 it runs your scripts without asking. A script whose own text fetches, installs or deletes still asks; code those scripts call does not. On native Windows there is no operating-system sandbox around it. If that matters, keep `workers.allowedCommands` empty and keep cats below level 3 (`"xp": { "accepted": 0 }`).
- **Interview checks run candidate code** without asking, in throwaway copies and with a time limit, once you started the interview.
- **Codex on Windows** runs in the `unelevated` sandbox, which is weaker than `elevated` (see `codex.windowsSandbox` in [configuration](configuration.md)).

## Reporting a vulnerability

Please report it privately through GitHub's **Report a vulnerability** button on the repository's Security tab, not in a public issue.
