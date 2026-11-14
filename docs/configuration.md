# Configuration

agentcats reads `<your repo>/.agentcats/agentcats.config.json` when it starts.
The file is optional, and every key has a default, so `{}` is a valid config.
Values for cats are defaults for new cats; each cat's agent, model, permission mode and budget can then be changed in its panel on the board.

A file that is not valid JSON, or that has an unknown key or a wrong value, stops agentcats with the file path and one line per problem:

```text
/repo/.agentcats/agentcats.config.json is invalid:
✖ Invalid input: expected number, received string
  → at workers.max
```

`agentcats doctor` checks the file without starting anything.
The schema, with these defaults, is `AgentcatsConfig` in `packages/protocol/src/config.ts`; a test keeps this page in step with it.

## Example

```json
{
  "adapter": "claude",
  "workers": { "max": 3, "allowedCommands": ["npm test", "npm run lint"] },
  "budget": { "perCatUsd": 2, "globalUsd": 10 },
  "captions": { "enabled": true }
}
```

## Agents

| Key                    | Default  | What it does                                                                                                                                              |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapter`              | `claude` | The agent every cat runs on unless set otherwise: `claude`, `codex` or `mock`. `--adapter` on the command line overrides it.                              |
| `orchestrator.adapter` | `null`   | The lead's agent; `null` uses `adapter`. It must support MCP (Claude and Codex do).                                                                       |
| `orchestrator.model`   | `null`   | The lead's model; `null` uses the agent's own default.                                                                                                    |
| `claude.executablePath`| `null`   | Path to the `claude` executable; `null` finds `claude` on your PATH.                                                                                      |
| `codex.windowsSandbox` | `unelevated` | On Windows: `unelevated` is the sandbox codex-acp's bundled Codex can start (weaker than `elevated`); `codex_config` uses your `~/.codex/config.toml` as it is. Ignored elsewhere. |
| `mock.scenario`        | `happy-path` | What mock workers act out. For development; the scenarios are in `packages/adapters/mock/src/scenarios.ts`.                                          |

## Workers

| Key                       | Default        | What it does                                                                                                                                                       |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workers.max`             | `3`            | How many workers may work at the same time (1 to 16).                                                                                                              |
| `workers.adapter`         | `null`         | The workers' agent; `null` uses `adapter`.                                                                                                                         |
| `workers.model`           | `null`         | The workers' model; `null` uses the agent's balanced tier (`sonnet` for Claude, `gpt-5.4` for Codex).                                                              |
| `workers.permissionMode`  | `accept_edits` | `ask` asks before anything that changes something; `accept_edits` lets file edits in the worktree run without asking; `auto` lets the agent decide. There is no bypass mode. |
| `workers.allowedCommands` | `[]`           | Commands workers may run without asking, matched as a prefix, usually your test and lint commands. Committing to their own branch is always allowed.              |
| `workers.autoHire`        | `true`         | Hire a worker straight away when a task waits and there is room. `false` leaves hiring to interviews.                                                             |

## Budgets

| Key                    | Default   | What it does                                                                                                                                         |
| ---------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budget.perCatUsd`     | `2`       | Dollars each cat may spend; `null` for no limit. Warning at 80 percent, pause at 100 until you raise it and resume the cat.                          |
| `budget.globalUsd`     | `10`      | Dollars the whole team may spend; `null` for no limit.                                                                                               |
| `budget.perCatTokens`  | `null`    | Tokens each cat may use; `null` for no limit.                                                                                                        |
| `budget.perCatMinutes` | `60`      | Working time per cat for agents that report no cost (Codex).                                                                                         |
| `budget.enforce`       | `metered` | `metered` enforces dollar budgets only for cats billed per use (an API key, Bedrock, Vertex); `always` also on a subscription, where cost is an API-equivalent estimate; `never` only shows totals. |

## Interviews

| Key                             | Default    | What it does                                                                                                 |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `interviews.candidates`         | `2`        | Candidates per interview, 1 to 3.                                                                            |
| `interviews.tier`               | `balanced` | Model tier for candidates: `fast`, `balanced` or `best`.                                                     |
| `interviews.budgetUsd`          | `3`        | API-equivalent dollars one interview may spend, enforced like `budget`. An estimate over it is refused.     |
| `interviews.candidateTimeoutMs` | `900000`   | How long a candidate may work before it is stopped and fails (15 minutes).                                   |
| `interviews.checkTimeoutMs`     | `120000`   | How long one check, lint or typecheck command may run.                                                       |
| `interviews.projectCheck`       | `null`     | The check for an interview that re-runs one of your tasks; `null` uses your `package.json` test script.      |
| `interviews.weights.diff`       | `0.4`      | Weight of a small diff in the score. Passing the check is a gate, not a weight.                              |
| `interviews.weights.cost`       | `0.25`     | Weight of a low cost.                                                                                        |
| `interviews.weights.time`       | `0.15`     | Weight of a short time.                                                                                      |
| `interviews.weights.quality`    | `0.2`      | Weight of clean lint and typecheck.                                                                          |

## XP and memory

| Key                      | Default | What it does                                                                                                   |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------- |
| `xp.accepted`            | `10`    | XP for an accepted result.                                                                                     |
| `xp.testsFirstTry`       | `5`     | Extra XP when the worker reported passing tests on its first attempt.                                          |
| `xp.underCost`           | `3`     | Extra XP when the task cost less than the median of the team's recent accepted tasks.                          |
| `xp.rejectedPenalty`     | `10`    | XP taken away for a rejected result. XP never goes below 0; the level thresholds are fixed in `levels.ts`.     |
| `memory.debrief`         | `true`  | After a review, propose learnings for the cat.                                                                 |
| `memory.model`           | `null`  | Model for debriefs and consolidations; `null` uses the default agent's fast tier (`haiku` for Claude).         |
| `memory.cap`             | `30`    | Most lines a cat's `learnings.md` may hold; going over proposes a consolidation (5 to 200).                    |
| `memory.autoAcceptAfter` | `null`  | Keep a cat's suggestions without asking once it has this many accepted tasks; `null` always asks.              |

## Everything else

| Key                 | Default  | What it does                                                                                                                         |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `captions.enabled`  | `true`   | Meme captions on failures, promotions, budgets, retirements and rejections. `false` is the serious mode. The lines are in `.agentcats/captions.json`, which you can edit. |
| `attribution`       | `false`  | Let agents add their own attribution, such as Claude Code's `Co-Authored-By` trailer, to the commits they make in your repo.        |
| `stuckTimeoutMs`    | `300000` | A worker with no activity for this long (5 minutes) is marked blocked, so you can nudge or stop it.                                  |
| `approvalTimeoutMs` | `300000` | How long an approval waits before it is denied on its own.                                                                           |
| `port`              | `0`      | The port on `127.0.0.1`; `0` picks a free one. `--port` overrides it.                                                                |
| `worktreesDir`      | `null`   | Where workers' worktrees go; `null` is `~/.agentcats/worktrees/<project>-<hash>`, outside your repo.                                 |
| `$schema`           | none     | Ignored; lets an editor point at a schema.                                                                                           |

## Other files in `.agentcats/`

- `captions.json`: the caption lines, written from the defaults on first run. Placeholders: `{cat}`, `{task}`, `{level}`, `{cats}`.
- `cats/<name>/learnings.md` and `profile.md`: each cat's memory and persona (see the [guide](guide.md#memory-and-levels)).
- `interviews/`: your own interview tasks (format in `packages/daemon/interviews/README.md`).
- `agentcats.db`, `run/`, `cats/<name>/stats.json` and `history/`: local state, ignored by git through `.agentcats/.gitignore`.
