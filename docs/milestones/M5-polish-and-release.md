# M5: Polish and release

Prerequisite: M4 acceptance criteria met.

## Goal

Make it look like the idea in your head and make it easy for strangers to install, run and contribute to. Ship `npx agentcats` and an open source repo that people can understand in a minute.

## Scope

### 1. Art
- One sprite set for each cat state: idle, thinking, working, blocked, waiting for approval, done, error, fired, promoted.
- A small set of cat variants (colors or breeds) so cats are distinguishable; assigned at creation, stored in `profile.md`.
- Level badges and an orchestrator visual that reads as the boss.
- Keep it to what you listed here. Resist adding states. Use consistent pixel size and palette.
- Source and license for every asset recorded in `docs/assets.md`. Prefer original or openly licensed art, and check any reference you derived from.

### 2. Whiteboard experience
- Smooth movement between desk, whiteboard and meeting areas based on status.
- Hover cards with the cat's current task, level, XP and cost.
- Click a cat to open its detail drawer (learnings, history, adapter).
- Keyboard shortcuts for approve, deny and pause on the focused cat.
- Responsive layout down to a laptop screen; dark and light theme.

### 3. Meme layer
- Caption templates for events: task failed, cat promoted, budget hit, cat fired, interview rejected.
- A setting to turn captions off for a serious mode.
- Captions come from a local template file users can edit.

### 4. Session replay
The UI is a projection of the event log, so replay is a read-only view over stored events.
- Replay a past session at 1x to 16x, with scrub bar and pause.
- Export a session as a JSON file and import it for sharing bug reports or demos.
- Strip file contents and long outputs from exports by default; show a checkbox to include them.

### 5. Cost and usage meter
- Per-cat and total cost over time, current budget remaining, and which tasks were most expensive.
- Handles "cost unknown" from adapters that cannot report it.

### 6. Hardening
- Review the security model once more: localhost binding, token, Origin check, no secrets in events or logs, redact common secret patterns in exported sessions.
- Make orphan process cleanup and worktree cleanup commands available (`agentcats doctor`, `agentcats cleanup`).
- Clear error messages for the common failures: Claude or Codex CLI not installed, not logged in, not a git repo, port in use, wrong Node version.
- Add `agentcats.config.json` validation with readable errors and a documented example.

### 7. Packaging and CI
- Publish to npm so `npx agentcats` works on a clean machine. Bundle the built UI into the CLI package.
- CI: lint, typecheck, unit and integration tests on the mock adapter, build, on Linux and macOS.
- Versioning and changelog (Changesets or similar). Tag a first release.
- A `--demo` flag that runs the board against the mock adapter with a scripted scenario, so someone can try it without any agent CLI or tokens.

### 8. Documentation
- README: one-paragraph pitch, 60 second demo GIF, quick start with `npx agentcats --demo`, then the real setup, feature list, safety notes, license.
- `docs/architecture.md`: the diagram, event flow, adapter interface.
- `docs/adapters.md`: how to write a new adapter, including the conformance suite and capability flags.
- `docs/security.md`: threat model in plain terms and defaults.
- `docs/configuration.md`: every config key.
- `CONTRIBUTING.md`, issue templates, code of conduct.
- A short "known limitations" section, including what each adapter does not support.

### 9. Release checklist
- Fresh machine test: clone nothing, run `npx agentcats --demo`, then a real run with Claude Code on a sample repo.
- License file and dependency license check.
- Remove any personal paths, tokens or project names from fixtures and docs.
- Decide on the final project name, check the npm name and the repo name before publishing.
- Announce wherever you want to share it; optional.

## Acceptance criteria
- [ ] On a clean machine, `npx agentcats --demo` shows a working board with no agent CLI installed.
- [ ] A real run with Claude Code completes the M1 sample flow with the final art and captions.
- [x] Replay of a recorded session works, and an exported session has no file contents unless the box was checked.
- [ ] CI is green on Linux and macOS; first tagged release is published.
- [x] README demo GIF matches the actual product.
- [x] Someone else, given only the docs, can write a skeleton adapter and pass the conformance suite (test this on a friend if you can). (A fresh agent with only the docs, 2026-11-14; see `docs/decisions.md`.)

## After release (not part of this milestone)
Kiro or an ACP generic adapter, shareable team configs, cat personalities affecting prompts, a plugin system for custom interviews and caption packs.
