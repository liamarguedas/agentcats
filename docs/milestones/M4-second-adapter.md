# M4: Second adapter

Prerequisite: M3 acceptance criteria met.

## Goal

Prove the architecture is agent-agnostic. Add a Codex adapter against the same interface, fix whatever leaks, and allow mixed teams (for example a Claude orchestrator with Codex workers). Do this before polishing art: abstraction leaks are cheapest to find now.

## Scope

### 1. Re-verify the landscape (half a day)
Record in `docs/decisions.md`:
- Current Codex headless and streaming options, and whether it supports MCP servers, permission callbacks and session resume.
- Whether Agent Client Protocol support now exists for Codex and Kiro. If yes, consider implementing a single generic ACP adapter instead of one per CLI.
- Kiro status: decide whether Kiro is a second adapter now or deferred. Do not build both in this milestone.
- Pin the tested CLI versions.

### 2. Adapter conformance suite
Before writing the adapter, write a reusable test suite in `packages/adapters/conformance/` that any adapter must pass:
- spawn and receive normalized events
- send a follow-up message
- permission request round trip (allow and deny)
- kill leaves no orphan process
- usage and cost reporting, or an explicit "unknown" value
- working directory respected
- crash is reported as an error event, not a hang

Run it against the mock and Claude Code adapters first. Fix failures there. This is where the leaks show up.

### 3. Capability flags
Adapters differ. Add a `capabilities` object to the adapter interface (supports MCP, supports permission callbacks, supports resume, reports cost, supports model selection). The daemon and UI adapt:
- No MCP support: that adapter cannot be an orchestrator, only a worker.
- No permission callback: restrict to a sandbox-only policy and show a warning on the cat.
- No cost reporting: show "cost unknown" and enforce a time budget instead of a cost budget.

### 4. Codex adapter
Implement `packages/adapters/codex/` to the interface. Normalize its events to `AgentEvent`. Keep Codex-specific types inside the package.

### 5. Mixed teams
- Per-cat adapter and model in profile and config.
- Hiring flow lets you choose the adapter per candidate, so an interview can compare a Claude candidate to a Codex candidate on the same task.
- Prompts: check that the worker prompt works for both; fork a prompt variant only if needed, with a note in the changelog.
- UI shows the adapter as a small badge on each cat.

### 6. Fixing leaks
Expected trouble spots: prompt injection of learnings, permission modes, cost accounting, session resume, tool name normalization in the activity bubbles. Each fix goes through the protocol or adapter interface, never as a special case in daemon code. Log each leak found and how it was resolved.

## Acceptance criteria
- [x] Conformance suite passes for mock, Claude Code and Codex adapters.
- [ ] A task runs end to end with a Claude orchestrator and a Codex worker, producing a reviewable branch.
- [x] An interview compares one Claude and one Codex candidate on the same sample task with a score breakdown.
- [x] A cat on an adapter without cost reporting shows "cost unknown" and respects a time budget.
- [x] No Codex-specific type appears outside `packages/adapters/codex`.
- [x] `docs/decisions.md` lists every abstraction leak found and the fix.

## Out of scope
Kiro (unless the ACP route makes it nearly free), art, replay.

## Handoff notes for the next milestone
List the adapter docs a contributor would need to add a third adapter. M5 turns that into a contributor guide.
