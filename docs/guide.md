# Guide

How to work with your cats, from the first request to hiring and retiring.
Settings are in [configuration](configuration.md), and the most used ones are under **Settings** on the board; safety is in [security](security.md).

## The board

The office fills the screen, on a canvas you can pan and zoom, like a drawing in Excalidraw.
It has rooms, spread over the canvas:

- **The lead's office:** Tux, the lead, plans here at the whiteboard.
- **The workspace:** a cat that is thinking or working sits at its own desk, with a laptop.
- **The meeting room:** cats that need you go there. They are waiting for an approval, blocked, paused, or in trouble.
- **The break room:** idle cats and cats that just finished rest on cushions.
- **Out of office:** retired cats wait in their boxes. Point at one and click **Bring back** to rehire it. The room is there once a cat is retired.

Each room grows on its own: a row of desks per four workers, a table per two cats waiting for you, a row of cushions per three idle cats.
Cats walk between the rooms as their status changes.

Moving around the canvas:

| Do | To |
| --- | --- |
| Drag the floor, scroll, or the arrow keys | Pan |
| Ctrl or Cmd and scroll, Ctrl or Cmd and + or -, pinch, + and -, or the buttons at the bottom left | Zoom |
| **Fit**, F, or Ctrl or Cmd and 0 | Frame the whole office |

The board keeps your view of each project in the browser until you press Fit.
Until you move it, the view follows the team as it grows.

Names, bubbles and cards float above the canvas at a readable size, whatever the zoom.
A bubble never covers another bubble or a cat: when there is no room over its cat, it moves aside and a line joins it to its cat.
Zoomed far out, an approval becomes a **?** badge; click it to zoom in on the cat.

**Needs you** in the header counts the cats waiting for you; click it to bring them all into view, or press N to go through them one at a time.
A cat that needs you while it is out of view shows as a marker at the edge of the canvas, pointing its way; click the marker to go there.

Hover over a cat, or Tab to it, for its card: status, agent, level and XP, current task, spend, and Pause and Stop.
Tab goes through the cats in order and brings each one into view.
An interview candidate has no Pause or Stop: Cancel interview stops the whole trial.
Click a cat for its panel with its learnings, history and properties; it opens on the left, and the canvas stays live beside it.
A cat takes its meme's name when it is free; rename it under Properties.
The name is unique on the board and names its folder, `.agentcats/cats/<name>/`, which moves with it.
The lead is told the new name; a running session uses it from its next start.
A candidate is renamed once hired.

On a focused cat:

| Key | Does |
| --- | --- |
| A | Allow its pending approval |
| D | Deny its pending approval |
| P | Pause it, or resume it (not a candidate) |
| Enter | Open its panel |

The chat with the lead, the tasks and the event log are panels on the right, behind the tabs at the top.
Click a tab to open its panel, and the open one to close it; the board remembers which was open.
The chat is open on your first visit.
On a narrow screen, such as a phone, the panels slide up from the bottom.
The ◐ button in the header switches between the system theme, light and dark.

## A request, start to finish

1. Tell Tux what you want in the chat, for example "Add a login endpoint and write tests for it".
2. Tux reads your project and splits the request into independent tasks.
3. Each task goes to a worker cat, which works in its own git worktree on a branch called `agentcats/<cat>/<task>`. The worktrees live outside your repo, under `~/.agentcats/worktrees/`, so your checkout is never touched.
4. When a worker needs permission, it goes to the meeting table with a bubble: what it wants to do, Allow and Deny.
5. Finished work goes to **review**. Open the task card for the worker's summary, the diff stat and the branch. Review the branch with git and merge it yourself if you like it, then Accept or Reject it on the board. agentcats never merges or pushes.

A failed or interrupted task can be re-run from its card.
A worker that shows no activity for five minutes is marked blocked, so you can nudge or stop it.

## Memory and levels

Every worker has a folder, `.agentcats/cats/<name>/`:

- `learnings.md`: what the cat has learned about your repo, one line each, with the task it came from. This file is the source of truth. Edit it on the board or in your editor; the board picks up either.
- `profile.md`: role, model, look and creation date, plus a **Persona** section you may write in. Anything you write there goes into the cat's prompt.
- `stats.json`: XP, level and task counts.
- `history/`: earlier versions of `learnings.md`, for undo.

Only `learnings.md`, `profile.md` and the config are meant to be committed; `.agentcats/.gitignore` keeps the rest local.

**Debrief.** After you accept a task, a short call to a cheap model (`haiku` by default) proposes up to three learnings from the task, the worker's summary and your verdict.
After a rejection, it runs only if you wrote a note saying why.
Nothing is written until you click **Keep** on the suggestion in the cat's panel.

**Consolidation.** When a cat levels up, or its learnings would go over the limit (30 lines), a second call proposes a shorter list.
You see it as a diff and apply or discard it; **Undo last change** puts the old version back.

**XP** comes from your verdicts only:
- +10 for an accepted result;
- +5 more if the worker reported passing tests on its first attempt;
- +3 more if it cost less than the team's recent median;
- -10 for a rejection.

Failures earn nothing.
XP never goes below 0, and the level follows the XP down as well as up.

**Levels** change two things, both defined in `packages/protocol/src/levels.ts`:

| Level | XP  | Learnings in the prompt | Runs without asking, on top of the defaults |
| ----- | --- | ----------------------- | ------------------------------------------- |
| 1     | 0   | the 5 most relevant     | nothing more |
| 2     | 30  | the 10 most relevant    | nothing more |
| 3     | 80  | all                     | your `package.json` scripts (`npm test`, `pnpm lint`, ...), except ones that fetch, install or delete |
| 4     | 150 | all                     | also local tools run directly (`tsc`, `vitest`, `eslint`, `pytest`, ...), and reading your main checkout |

At every level, network access, package installs and destructive commands ask for your approval, and pushing is refused.

## Agents

Every cat runs on an agent, shown as a badge in its card:

- **Claude**, through your installed Claude Code. agentcats checks every action before it runs, so allowed commands, level gates and the always-ask rules apply exactly.
- **Codex**, through [codex-acp](https://github.com/zed-industries/codex-acp), with your own Codex login and config. It works differently in three ways:
  - **A sandbox instead of checks.** Codex edits files and runs commands in its worktree without asking; its sandbox keeps the network and the rest of your disk out of reach. Its cats carry a ⚠ badge that says so.
  - **No cost.** Codex reports no dollar cost, so its cats show "cost unknown" and get a time budget instead: 60 minutes of working time each by default.
  - **On Windows**, it runs in the `unelevated` sandbox, which is weaker; see `codex.windowsSandbox` in [configuration](configuration.md).
- **Mock**: scripted cats that spend nothing, for trying agentcats and for development.

The lead and the workers can run on different agents, and any cat can move to another agent in its panel.
The lead needs an agent with MCP support; Claude and Codex both have it.
If your Codex login uses an API key, OpenAI bills Codex cats per token.

## Hire and fire

**Hiring.** Click **Hire a cat**, describe the role, and pick:
- a model tier: fast, balanced or best;
- 1 to 3 candidates;
- an interview task.

The estimated cost shows first; nothing runs until you click **Start interview**.

- Every candidate does the same task in its own throwaway copy of a repo, at the same time.
- When a candidate finishes, agentcats measures its diff, copies in hidden tests the candidates never saw, and runs the task's check, lint and typecheck itself. It does not trust what the candidate says about its own work.
- Passing the check is required to be hired. Among those who pass, the score weighs diff size, cost, time and clean lint and typecheck. The raw numbers sit next to the score, so you can disagree with it.
- You pick the winner. It joins as a worker, with your role description as its persona. The others get a kind note and are cleaned up.

Three interview tasks ship with agentcats: add a function with tests, fix a failing test, and a small refactor.
Add your own in `.agentcats/interviews/` (format in `packages/daemon/interviews/README.md`), or re-run one of your recent accepted tasks.
When a task waits and there is room on the team, a worker is still hired straight away, unless `workers.autoHire` is off.

**Retiring.** Click **Retire…** in a worker's panel.
If it is working, let it finish first or cancel the task now.
Its folder moves to `.agentcats/retired/`, and it waits in its box in the **Retired** list; **Bring back** restores it with its learnings, XP and level.
The lead can suggest a retirement or an interview; both wait on the board for you to confirm.

## Replay and sharing

Click **Replay** in the header for every past session: one run of agentcats each.
A replay plays the session on the board at 1× to 16×, with a scrub bar and pause (Space).
It is read-only: nothing is sent to the cats.
Pauses longer than three seconds are shortened, so a cat waiting an hour for you does not replay as an hour.

**Export…** in the replay bar saves the session as a JSON file, for a bug report or a demo.
Secrets are always redacted, and your project path and home directory replaced.
Long agent output, task descriptions and summaries are cut short unless you tick **Include file contents and long outputs**.
**Import a session file…** in the same dialog replays a file someone sent you.

## Cost

**Team spend** in the header opens the cost meter:

- the total spent, and what is left of the team budget;
- each cat's cost over time;
- each cat's spend, budget left, working time and tokens;
- the tasks that cost the most.

On a Claude subscription, costs are API-equivalent estimates (marked ≈) and are not enforced unless `budget.enforce` is `always`.
Cats whose agent reports no cost are counted by working time, never as $0.

## Captions

When a task fails, a cat is promoted, hits its budget or is retired, or candidates lose an interview, a meme caption appears on the cat for a few seconds.
The lines come from `.agentcats/captions.json`, which you can edit; use `{cat}`, `{task}`, `{level}` and `{cats}` in them.
`"captions": { "enabled": false }` turns them off.

## Commands

| Command | Does |
| --- | --- |
| `agentcats` | Run the board for the current directory (`--project <path>` for another). |
| `agentcats --demo` | Scripted cats in a throwaway project: no agent, no tokens. |
| `agentcats doctor` | Check Node, git, the config, the Claude and Codex logins, and leftovers. Changes nothing. |
| `agentcats cleanup` | Stop agent processes and remove worktrees left by earlier runs. Keeps branches and anything with uncommitted changes. |

Options: `--adapter claude|codex|mock`, `--port <number>`, `--no-open`.
