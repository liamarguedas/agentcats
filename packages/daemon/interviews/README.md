# Interview samples

Each `<id>.md` here is one sample task for hiring interviews. Candidates all do the same task, each in their own copy of the repo, and the daemon then checks their work itself.

```markdown
---
title: Add a slugify function
repo: fixture
check: node --test
lint: node scripts/lint.js
typecheck:
---

The task, exactly as candidates read it.
```

- `repo`: `fixture` copies `fixture/` (this folder's tiny sample library) for each candidate; `project` gives each candidate a worktree of your own repo.
- `check`: the command that decides pass or fail. Passing it is required to be hired.
- `lint`, `typecheck`: optional; a clean run raises the quality score.
- `<id>/setup/`: files copied over the repo before candidates start.
- `<id>/hidden/`: files copied over each candidate's work before the checks run, such as tests candidates never saw. They overwrite whatever the candidate wrote at the same path.

Add your own samples the same way in your project's `.agentcats/interviews/`.

Hidden tests must check only what the task text asks for. A hidden test that expects a behavior the text leaves open fails good candidates: the first live interview found one (the slugify sample expected `ÜBER` to lose its `Ü`, though the task says to keep letters).
