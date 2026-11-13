# M3: Hire and fire

Prerequisite: M2 acceptance criteria met.

## Goal

Cats have a lifecycle. Retiring a cat archives it safely. Hiring runs a real interview: candidates do a sample task and are scored, then you pick.

## Scope

### 1. Retire (fire)
- Button on the board and an MCP tool `retire_cat(cat, reason)` for the orchestrator (the orchestrator proposes, the user confirms in the UI).
- Behavior: finish or cancel the current task (user chooses), kill the session, remove the worktree if clean, move the folder to `.agentcats/retired/<name>/` with a `retired.json` (date, reason, final level and XP).
- Warn if the cat has uncommitted work or an open task.
- Firing animation and a `cat.retired` event. Retired cats disappear from the board but appear in a "retired" list.

### 2. Resurrect
- From the retired list, restore a cat with its learnings, XP and level intact.
- Reuse the original name unless taken.
- Emits `cat.resurrected`.

### 3. Hire: the interview
Flow:
1. User (or orchestrator, then user confirms) defines a role: a short description, preferred model tier, optional starting learnings or persona.
2. Daemon spawns 2 to 3 candidates, each in its own worktree, with the same role prompt.
3. Each runs the same sample task. Sample tasks come from a small library in `.agentcats/interviews/*.md` (task, repo setup, pass criteria), plus an option to use a recent real task re-run in a throwaway worktree.
4. Score each candidate and show a comparison on the board.
5. User picks one. The chosen candidate becomes a worker cat; the others get a rejection and are cleaned up.

### 4. Scoring
Computed, not vibes:
- Tests pass (required, hard gate)
- Diff size relative to the smallest passing candidate
- Cost and time
- Lint and typecheck clean
- Optional: a judge-model comment on readability, shown but not scored

Weights live in config. The board shows raw numbers next to the score so the user can disagree with it.

### 5. Budgets for interviews
Interviews multiply cost. Add a separate interview budget in config, a cost estimate shown before starting ("about X for 3 candidates"), and a required confirmation click. Default candidates: 2.

### 6. Sample task library
Ship 3 starter interviews that work on a tiny fixture repo bundled with the project (for example: add a pure function with tests, fix a failing test, small refactor). Document the format so users can add their own.

### 7. Events and protocol
Add `cat.retired`, `cat.resurrected`, `interview.started`, `interview.candidate_scored`, `interview.completed`, `cat.hired`. Update the protocol package first, then daemon and UI.

### 8. UI
- Hire dialog: role, model tier, number of candidates, cost estimate.
- Interview view: candidates side by side with status, score breakdown and diff link.
- Retire confirmation dialog with warnings.
- Retired list with resurrect action.
- Light humor is fine (rejection letter text, firing animation), but placeholder art is still acceptable.

### 9. Tests
- Retire and resurrect round trip preserves learnings and stats (mock adapter, filesystem fixture).
- Interview run on the mock adapter with scripted outcomes for 3 candidates; scoring picks the expected winner, hard gate excludes a failing candidate.
- Cleanup test: losing candidates leave no worktrees or processes behind.

## Acceptance criteria
- [x] Retiring a cat with an open task warns, then archives cleanly; no worktree or process left behind.
- [x] Resurrecting restores learnings, XP and level.
- [x] A real interview with 2 candidates on a bundled sample task completes, shows a score breakdown, and lets you pick a winner who then appears on the board.
- [x] The cost estimate is shown and confirmed before candidates start.
- [x] A candidate whose tests fail cannot win regardless of other scores.

## Out of scope
New adapters, polish, replay.

## Handoff notes for the next milestone
Note anywhere the Claude-specific behavior leaked into lifecycle code (spawn options, session resume, cost reporting). M4 will expose it.
