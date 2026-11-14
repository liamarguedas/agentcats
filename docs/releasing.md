# Releasing

Only `agentcats` is published to npm. The other packages are private and bundled into it (see `docs/decisions.md`, M5 packaging decisions).

## Every change

A user-facing change adds a changeset: `pnpm changeset`, pick `agentcats`, the bump, and one line for the changelog.

## A release

1. On an up-to-date `main` with green CI, run `pnpm changeset version`.
   This sets the new version in `packages/cli/package.json` and writes `packages/cli/CHANGELOG.md`.
   Never edit the changelog by hand.
2. Run `pnpm format`, then `pnpm check`, then commit as `release: agentcats <version>`.
3. Build the package: `pnpm release:build`.
   This writes `packages/cli/pack/`.
4. Smoke test it the way CI does:
   ```sh
   mkdir /tmp/try && (cd packages/cli/pack && npm pack --pack-destination /tmp/try)
   cd /tmp/try && npm init -y && npm install ./agentcats-*.tgz
   node <repo>/packages/cli/scripts/smoke.mjs /tmp/try
   ```
5. Publish from the pack directory: `npm publish packages/cli/pack` (needs an npm login with rights to `agentcats`).
6. Tag and push: `git tag v<version> && git push origin main v<version>`, then create the GitHub release from the tag with the changelog entry.

## Checks before the first release

- The name `agentcats` is still free on npm, and the repository is public.
- `pnpm licenses list --prod` shows only licenses compatible with MIT, apart from the Claude Agent SDK. That SDK is under Anthropic's Commercial Terms and stays an npm dependency, never bundled.
- No personal paths, tokens or project names in fixtures and docs.
