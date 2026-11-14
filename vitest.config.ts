import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript sources under this condition,
// so tests run against src/ without a build step.
const SOURCE_CONDITION = '@agentcats/source';

export default defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/test/**/*.test.ts'],
    // Daemon tests run real git, worktrees and mock agents through HTTP. On a
    // loaded machine (the whole suite in parallel, CI) they outgrow the 5 s
    // default; their own waits have explicit, shorter limits.
    testTimeout: 30_000,
    // Never read or write the user's own defaults (~/.agentcats/agentcats.config.json).
    env: { AGENTCATS_HOME: join(tmpdir(), 'agentcats-vitest-home') },
  },
});
