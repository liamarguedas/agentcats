# Changesets

Each user-facing change adds a file here with `pnpm changeset`: the bump (patch, minor, major) for `agentcats` and one line for the changelog.
`pnpm changeset version` turns them into the version and `packages/cli/CHANGELOG.md`; never edit that file by hand.
Only `agentcats` is published; the other packages are private and bundled into it.
