# M2: Memory and levels

Prerequisite: M1 acceptance criteria met.

## Goal

Cats get better over time and it shows. Each worker keeps a small, human-readable learnings file. XP comes from real outcomes. Levels change behavior, not just the badge.

## Scope

### 1. Cat folder on disk
```
.agentcats/cats/<name>/
  profile.md     role, persona, model, created date
  learnings.md   one line per learning, with source task id
  stats.json     xp, level, tasks done, accepted, rejected
```
Markdown is the source of truth for learnings. SQLite keeps history only. Files are readable and git-friendly. Decide in `decisions.md` whether `learnings.md` is committed or ignored by default (suggested: ignore `stats.json`, allow committing `learnings.md`).

### 2. Debrief loop
After a task is moved to `done` or `rejected` by the user:
1. A short, cheap-model call receives: task description, worker's final summary, diff stat, test result, user outcome (accepted or rejected, plus optional rejection note), and the cat's current learnings.
2. It proposes 0 to 3 new learnings, each one line, specific and actionable ("use the repo's `makeUser` test fixture, not raw inserts").
3. Dedupe against existing lines (exact and near-duplicate check).
4. Append with source task id.

Rules:
- Debrief on accepted outcomes by default. On rejection, only record a learning if the user supplied a note.
- Hard cap on `learnings.md` (start at 30 lines). Over the cap triggers consolidation (below).
- Never auto-write learnings from unreviewed outcomes.

### 3. Learnings in the UI
- Panel per cat showing its learnings with the source task.
- One-click delete and inline edit. Edits write to the markdown file immediately.
- Pending learnings from a debrief are shown as a diff the user can accept or discard (setting: auto-accept after N accepted tasks, default off).

### 4. XP
Computed from real signals, logged as events (`xp.changed` with reason):
- Task accepted: +base
- Tests passed on first attempt: +bonus
- Task completed under the cost estimate: +small bonus
- Task rejected or bounced back: penalty
- Failure or timeout: no XP

Keep weights in config. Level thresholds are a simple curve in the protocol package.

### 5. Levels that gate real behavior
Implement these two, nothing more:
- **Memory loaded:** low levels load only the top K learnings into the prompt; higher levels load the full file. Selection rule documented and tested.
- **Autonomy:** higher levels skip approval prompts for a defined low-risk set (for example, running the project's own test command outside the default, reading outside the worktree). Never skip approvals for network, installs or destructive actions at any level.

Level changes fire `cat.leveled_up`. Gating rules live in one file so they are easy to audit.

### 6. Consolidation at level-up
When a cat levels up or learnings exceed the cap, run a consolidation call that merges overlapping lines and drops stale ones. Show the proposed rewrite as a diff for user approval. Keep the previous version in `.agentcats/cats/<name>/history/` so it is reversible.

### 7. Prompt updates
- Worker prompt gains a "What you have learned" section populated from `learnings.md`.
- New debrief prompt and consolidation prompt, versioned like the others, each with a changelog.

### 8. Tests
- Debrief parsing, dedupe and cap logic with a mocked model.
- XP calculation table tests.
- Gating tests: a level 1 cat prompts for approval where a level 4 cat does not, and both prompt for network.
- Consolidation keeps a backup and is reversible.

## Acceptance criteria
- [ ] After 10 real tasks, a worker's learnings file is visibly useful when you read it, and none of the lines are junk you would not keep.
- [x] A higher-level cat raises fewer approval prompts than a new cat on the same sample tasks, and still asks for network and installs.
- [x] You can edit or delete a learning from the UI and the file changes.
- [x] Consolidation produces a diff, requires approval, and can be undone.
- [x] XP events appear on the board with their reason.

## Out of scope
Hiring flow, retirement, new adapters.

## Risks specific to this milestone
- Memory rot: a wrong learning misleads future runs. Mitigate with the cap, visibility and one-click delete.
- Gimmick levels: if you cannot feel the difference between level 1 and level 4 in real use, revisit the gates before moving on.

## Handoff notes for the next milestone
Record how many tasks it took before learnings felt useful, and which XP weights needed tuning. M3's eval scoring reuses these signals.
