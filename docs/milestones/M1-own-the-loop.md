# M1: Own the loop

Prerequisite: M0 acceptance criteria met.

## Goal

An orchestrator cat you chat with delegates to worker cats that run in parallel git worktrees. Approvals, budgets and failures are all handled on the board. The end state is a reviewable branch you merge yourself.

## Scope

### 1. Persistence
- SQLite store (better-sqlite3 or similar) for cats, tasks and the event log. Events written before broadcast.
- Restart recovery: on daemon start, mark every in-flight task `interrupted`, kill or reconcile orphan processes by tracked PID, rebuild state from the DB. The user can re-run interrupted tasks from the board.

### 2. Task state machine
States: `queued`, `running`, `blocked`, `review`, `done`, `rejected`, `failed`, `interrupted`, `cancelled`.

Define allowed transitions in one place in the protocol package and test them. Failure rules:
- Worker crash or adapter error: retry once automatically, then `failed` and surface on the board.
- No events for the configured timeout (default 5 minutes): mark `blocked`, notify on the board, offer kill or nudge.
- Budget hit: pause the cat, task goes `blocked` with reason `budget`.
- A worker marked done goes to `review` first. Only the user moves it to `done` or `rejected` (these signals feed XP in M2).

### 3. Cat manager
- Create a git worktree and branch per worker task, `agentcats/<cat>/<task-id>`.
- Spawn, kill, and clean up the worktree on completion or crash. Never delete a worktree with uncommitted work without a board warning.
- Concurrency limit from config (default 3 workers).

### 4. MCP server for the orchestrator
Exposed by the daemon, wired into the orchestrator session using the method recorded in M0.

Tools:
- `list_cats`, `list_tasks`
- `assign_task(title, description, cat?)`: creates a task and spawns or reuses a worker
- `get_task_status(task_id)`
- `get_task_result(task_id)`: summary, branch name, diff stat, test result
- `cancel_task(task_id)`

The orchestrator never edits code itself. Its system prompt says so.

### 5. Prompt templates
Store in `packages/daemon/prompts/` as versioned markdown files, loaded at spawn.
- **Orchestrator prompt:** role, the tools above, how to break work into independent tasks, how to avoid file conflicts between parallel workers, when to ask the user, report format.
- **Worker prompt:** role, scope limited to its worktree, must run tests before declaring done, must end with a structured summary (what changed, tests run, open issues).
Expect to iterate on these with real runs. Keep a short changelog at the top of each file.

### 6. Permissions
Define the default worker policy in config and enforce it through the adapter's permission mechanism.
- Allowed without asking: read files, edit inside its own worktree, run the project's test and lint commands.
- Always ask: network access, package installs, writes outside the worktree, git operations other than commit on its branch, deleting files outside the task scope.
- Never: touching the main checkout, pushing to remotes.
Approval requests flow through `approval.requested` and appear as a speech bubble on the cat.

### 7. Budgets
- Per-cat and global ceilings (tokens or estimated cost) in config.
- Warn at 80 percent, pause at 100 percent. Resume requires a user action.
- Show running totals on the board.
- Default worker model is the cheaper tier; configurable per cat.

### 8. Merge strategy
Workers commit to their branch. The orchestrator reports the branch and diff summary. The user merges. No auto-merge in M1. Record this in `decisions.md`.

### 9. UI
- Whiteboard layout: orchestrator at the top, workers below, task cards linked to cats, activity bubbles from `tool.called` and `message.agent`.
- Chat panel to talk to the orchestrator.
- Approve and deny controls on the bubble. Kill button per cat. Pause and resume per cat.
- Task detail drawer: status history, result summary, branch name, diff stat.
- Interrupted and failed tasks show a re-run action.

### 10. Tests
- State machine tests, including illegal transitions.
- Daemon integration tests entirely on the mock adapter: parallel tasks, crash and retry, timeout, budget pause, restart recovery.
- One end-to-end test on a small sample repo with the real Claude Code adapter, run manually and documented (not in CI).

## Acceptance criteria
- [ ] "Add a login endpoint and write tests for it" produces two workers running in parallel worktrees and a branch you can review and merge.
- [ ] A forced worker crash retries once, then shows `failed` on the board.
- [ ] A stuck worker is flagged after the timeout.
- [ ] Hitting the budget pauses the cat and resumes only on user action.
- [ ] Killing and restarting the daemon mid-task leaves tasks `interrupted`, no orphan processes, and no data loss.
- [ ] A worker attempting a network call raises an approval on the board; deny blocks it.
- [ ] All integration tests green on the mock adapter.

## Out of scope
Learnings, XP, levels, hiring, retirement, second adapter.

## Handoff notes for the next milestone
Record which prompts changed most during real runs and what the workers' final summaries look like. M2's debrief depends on that structure.
