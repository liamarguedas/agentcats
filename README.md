# agentcats

A local whiteboard where coding agents are cats.
You tell the lead cat what you want built. It splits the work and hands it to worker cats, who each code on their own git branch, in parallel. You watch them think, work and ask for permission, then you review their branches and merge what you like.

Status: **milestone M4** (Codex verified with scripted tests; its live runs are pending).
A lead cat and up to three workers, driven by your own Claude Code, or by a built-in mock that needs no agent and spends nothing.
Workers remember what they learn in your repo, earn XP from your reviews, and get more autonomy as they level up.
You hire new cats through an interview and retire the ones you no longer need.
Cats can run on Claude Code or Codex, and one team can mix them.
Polish and release arrive in M5 (see `docs/milestones/`).

## Requirements

- Node.js 22.13 or newer, and pnpm 11.
- Your project must be a git repository with at least one commit. Workers branch from it.
- For real runs: [Claude Code](https://code.claude.com) installed and logged in (`claude` on your PATH), and/or a Codex login (`codex login`) for Codex cats.

## Quick start

```bash
pnpm install
pnpm build
pnpm agentcats --project /path/to/your/repo
```

The board opens in your browser.
Tell Tux, the lead cat, what you want in the chat, for example "Add a login endpoint and write tests for it".

What happens next:

1. Tux reads your project and splits the request into independent tasks.
2. Each task goes to a worker cat, which works in its own git worktree on a branch called `agentcats/<cat>/<task>`. The worktrees live outside your repo, under `~/.agentcats/worktrees/`, so your checkout is never touched.
3. When a worker needs permission (network access, installing packages, any other command), an approval bubble appears on the cat. Allow or Deny it.
4. Finished work goes to **review**. Open the task card to see the worker's summary, the diff stat and the branch. Review the branch with git, merge it yourself if you like it, then Accept or Reject it on the board. agentcats never merges or pushes.

Each cat has Pause, Resume and Stop buttons, and a ⚙ panel with its level, its learnings and its properties (model, permission mode, budget).
A task that failed or was interrupted can be re-run from its card.

To try it without Claude Code, add `--adapter mock`.
In mock mode nothing is written to your repo; the cats only act it out.

## Memory and levels

Every worker has a folder, `.agentcats/cats/<name>/`:

- `learnings.md`: what the cat has learned about your repo, one line each, with the task it came from. This file is the source of truth. Edit it on the board or in your editor; the board picks up either.
- `profile.md`: role, model and creation date, plus a **Persona** section you may write in. Anything you write there goes into the cat's prompt.
- `stats.json`: XP, level and task counts.
- `history/`: earlier versions of `learnings.md`, for undo.

`.agentcats/.gitignore` is written once so that only `learnings.md`, `profile.md` and the config can be committed; the rest is local state.

**Debrief.** After you accept a task, a short call to a cheap model (`haiku` by default) proposes up to three learnings from the task, the worker's summary and your verdict. After a rejection, it only runs if you wrote a note saying why. Duplicates of what the cat already knows are dropped. Nothing is written until you click **Keep** on the suggestion in the cat's panel.

**Consolidation.** When a cat levels up, or its learnings would go over the limit (30 lines), a second call proposes a merged, shorter list. You see it as a diff and apply or discard it. The old version is saved in `history/`, and **Undo last change** puts it back.

**XP** comes from your verdicts only: +10 for an accepted result, +5 more if the worker reported passing tests on its first attempt, +3 more if it cost less than the team's recent median, and -10 for a rejection. Failures earn nothing. XP never goes below 0, and the level always follows the XP, down as well as up.

**Levels** change two things, defined in one file, `packages/protocol/src/levels.ts`:

| Level | XP  | Learnings in the prompt | Runs without asking, on top of the defaults                                                                                  |
| ----- | --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1     | 0   | the 5 most relevant     | nothing more                                                                                                                 |
| 2     | 30  | the 10 most relevant    | nothing more                                                                                                                 |
| 3     | 80  | all                     | your `package.json` scripts (`npm test`, `pnpm lint`, ...), except ones that fetch, install or delete                        |
| 4     | 150 | all                     | also local tools run directly (`tsc`, `vitest`, `jest`, `eslint`, `prettier`, `pytest`, ...), and reading your main checkout |

"Most relevant" means the lines that share the most words with the task, newer lines first on a tie.
At every level, network access, package installs and destructive commands (`rm -rf`, `git reset --hard`, `git clean`, ...) ask for your approval, and pushing is refused.

## Agents

Every cat runs on an agent, shown as a small badge on its card:

- **Claude** (Claude Code, through your installed `claude`). agentcats checks every action before it runs, so allowed commands, level gates and the always-ask rules apply exactly.
- **Codex**, through [codex-acp](https://github.com/zed-industries/codex-acp) over the Agent Client Protocol, with your own Codex login and config (`~/.codex`). Two differences:
  - **Sandbox instead of per-action checks.** Codex lets an agent edit files and run commands in its worktree without asking; its sandbox is what keeps the network and the rest of your disk out of reach. agentcats cannot check each command, so its allowed commands, level gates and always-ask rules do not apply one by one, and a network command is not asked about: on Windows it runs and fails in the sandbox. Codex cats carry a ⚠ badge that says so.
  - **Windows sandbox.** codex-acp bundles its own, older Codex build, which cannot start the `elevated` Windows sandbox a newer Codex CLI sets up. agentcats therefore runs Codex with the `unelevated` sandbox on Windows, which is weaker. Set `"codex": { "windowsSandbox": "codex_config" }` to use your Codex config as it is.
  - **No cost.** Codex reports no dollar cost, so its cats show "cost unknown" and get a **time budget** instead: 60 minutes of working time per cat by default (`budget.perCatMinutes`), with a warning at 80 percent and a pause at 100.
- **Mock**: plays scripted cats, spends nothing.

The default agent is `adapter` in the config, or `--adapter claude|codex|mock`. The lead and the workers can use different ones (`orchestrator.adapter`, `workers.adapter`), and any cat can be moved to another agent in its ⚙ panel; the lead needs an agent with MCP support (both Claude and Codex have it). In the hire dialog, each candidate can run on a different agent, so one interview can compare Claude and Codex on the same task.

If your Codex login uses an API key, Codex cats are billed per token by OpenAI. A ChatGPT login uses your plan instead.

## Hire and fire

**Hiring.** Click **Hire a cat**, describe the role, pick a model tier (fast, balanced or best), the number of candidates (1 to 3) and an interview task. agentcats shows the estimated cost first; nothing runs until you click **Start interview**.

- Every candidate does the same task in its own throwaway copy of a repo, at the same time.
- When a candidate finishes, agentcats measures its diff, copies in hidden tests the candidates never saw, and runs the task's check, lint and typecheck commands itself. It does not trust what the candidate says about its own work.
- Passing the check is required to be hired. Among those who pass, the score weighs diff size, cost, time and clean lint and typecheck against the best candidate. The raw numbers are shown next to the score, so you can disagree with it.
- You pick the winner. It joins as a worker, with your role description as its persona and any starting learnings you gave. The others get a kind note and are cleaned up: no repos or processes are left.

Three interview tasks ship with agentcats, on a tiny sample library: add a function with tests, fix a failing test, and a small refactor. Add your own in `.agentcats/interviews/` (the format is in `packages/daemon/interviews/README.md`), or re-run one of your recent accepted tasks on your project.

**Quick hires.** When a task waits and there is room on the team, a worker is still hired straight away, without an interview, unless you set `"workers": { "autoHire": false }`.

**Retiring.** Open a worker's ⚙ panel and click **Retire…**. If it is working on a task, choose to let it finish first or cancel the task now; worktrees with uncommitted changes are listed and kept. Its folder moves to `.agentcats/retired/<name>-<id>/`, and it appears in the **Retired** list on the board. **Bring back** restores it with its learnings, XP and level.

The lead cat can suggest a retirement or an interview. Both wait on the board for you to confirm.

**Limit: interview checks run candidate code.** The check, lint and typecheck commands run the code candidates wrote, without an approval prompt, in throwaway copies and with a time limit, after you started the interview. On native Windows there is no sandbox around them.

## Configuration

Optional: `<your repo>/.agentcats/agentcats.config.json`. Every field has a default.

```json
{
  "adapter": "claude",
  "orchestrator": { "adapter": null, "model": null },
  "workers": {
    "max": 3,
    "adapter": null,
    "model": null,
    "permissionMode": "accept_edits",
    "allowedCommands": ["npm test", "npm run lint"]
  },
  "budget": {
    "perCatUsd": 2,
    "globalUsd": 10,
    "perCatTokens": null,
    "perCatMinutes": 60,
    "enforce": "metered"
  },
  "interviews": { "candidates": 2, "tier": "balanced", "budgetUsd": 3, "projectCheck": null },
  "xp": { "accepted": 10, "testsFirstTry": 5, "underCost": 3, "rejectedPenalty": 10 },
  "memory": { "debrief": true, "model": null, "cap": 30, "autoAcceptAfter": null },
  "attribution": false,
  "stuckTimeoutMs": 300000,
  "approvalTimeoutMs": 300000,
  "worktreesDir": null,
  "port": 0,
  "claude": { "executablePath": null }
}
```

- `workers.allowedCommands`: commands workers may run without asking, usually your test and lint commands. Committing to their own branch is always allowed.
- `workers.permissionMode`: `ask` (approve everything that changes something), `accept_edits` (file edits in the worktree run without asking), or `auto` (Claude decides what is safe). There is no bypass mode.
- `budget`: dollar limits, from the cost Claude reports. With `"enforce": "metered"` they apply only to cats billed per use (an API key, Bedrock or Vertex). At 80 percent you get a warning; at 100 percent the cat pauses until you raise its budget and resume it. On a subscription plan the cost shown is an API-equivalent estimate and is not enforced unless you set `"enforce": "always"`.
- `interviews.budgetUsd`: what one interview may spend, enforced like `budget`. An interview whose estimate is over it is refused. `interviews.projectCheck`: the check for re-running one of your tasks as an interview; by default your `package.json` test script. Score weights are in `interviews.weights`.
- `xp`: XP per outcome. The level thresholds are fixed in `levels.ts`.
- `memory.debrief`: turn the debrief off. `memory.model`: the model for debriefs and consolidations. `memory.cap`: the most lines a learnings file may hold. `memory.autoAcceptAfter`: keep a cat's suggestions without asking once it has this many accepted tasks (`null`, the default, always asks; consolidations always ask).
- `attribution`: whether agents may add their own attribution, such as Claude Code's `Co-Authored-By` trailer, to the commits they make in your repo. Off by default.
- `stuckTimeoutMs`: a worker that shows no activity for this long is marked blocked, so you can nudge or stop it.
- `adapter`, `orchestrator.adapter`, `workers.adapter`: which agent runs cats (`claude`, `codex` or `mock`; `null` means the default `adapter`).
- `budget.perCatMinutes`: the working-time budget for cats whose agent reports no cost (Codex).
- Models: `null` for workers means the agent's balanced tier (`sonnet` for Claude, `gpt-5.4` for Codex), for the lead the agent's own default, and for debriefs the fast tier (`haiku` for Claude).

## What workers may and may not do

- Without asking: read the project, edit files in their own worktree, commit to their own branch, run `workers.allowedCommands`, and whatever their level unlocks (see the table above).
- Only with your approval: any other command, web fetches, and, at every level, anything that looks like network access, a package install or a destructive command. An allowed script still asks if its body in the worker's `package.json` does one of those things.
- Never: push, or write outside their worktree (including your main checkout).
- The lead cat only reads and delegates. It has no edit or shell tools.

**Limit: allowed commands run code the worker can change.** A worker can edit the tests or source files that `npm test` runs, and from level 3 it runs your scripts without asking. The checks above catch a script whose own text fetches, installs or deletes, but not code those scripts call. On native Windows there is no operating-system sandbox to stop such code from reaching the network. On macOS and Linux a sandbox option may close this gap in a later version. If that matters for a project, keep `workers.allowedCommands` empty and do not let cats level past 2 (set `"xp": { "accepted": 0, ... }`).

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
- The lead cat reaches the daemon through an MCP endpoint with its own per-session token, separate from the browser's.
- Agents run under a small guardian process, so they die with the daemon, even if the daemon is killed hard.
- History is kept in `.agentcats/agentcats.db`. After a crash or restart, unfinished tasks show as interrupted and can be re-run.

## Development

```bash
pnpm dev        # mock daemon + Vite dev server with hot reload
pnpm check      # format, lint, typecheck, tests (no tokens)
pnpm test:e2e   # browser tests against the mock
```

See `CLAUDE.md` for all commands and repository rules, and `docs/decisions.md` for every technical decision and why it was made.

| Package                    | What it is                                                                 |
| -------------------------- | -------------------------------------------------------------------------- |
| `packages/protocol`        | The contract: events, commands, config, task state machine, adapter types. |
| `packages/kit`             | Process helpers: guarded spawn, process tree kill, async queue.            |
| `packages/daemon`          | The team: cat manager, worktrees, SQLite log, REST, WebSocket and MCP.     |
| `packages/adapters/mock`   | Scripted agent for development and tests.                                  |
| `packages/adapters/claude` | Claude through the Agent SDK, running your installed `claude`.             |
| `packages/ui`              | React whiteboard, served by the daemon.                                    |
| `packages/cli`             | The `agentcats` command.                                                   |

## License

MIT. See `LICENSE`.
