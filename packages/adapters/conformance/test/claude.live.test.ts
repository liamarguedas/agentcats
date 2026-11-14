// The conformance suite against the real Claude Code CLI, on the user's own
// login. Spends plan usage (or tokens), so it runs only with AGENTCATS_LIVE_CLAUDE=1.
//
//   AGENTCATS_LIVE_CLAUDE=1 pnpm exec vitest run packages/adapters/conformance/test/claude.live.test.ts
import { createClaudeAdapter } from '@agentcats/adapter-claude';
import { describe } from 'vitest';

import { describeConformance } from '../src/index.js';

const LIVE = process.env['AGENTCATS_LIVE_CLAUDE'] === '1';

describe.runIf(LIVE)('live', () => {
  describeConformance({
    name: 'claude (live)',
    create: () => createClaudeAdapter(),
    model: process.env['AGENTCATS_LIVE_MODEL'] ?? 'haiku',
    prompts: {
      reply: 'Reply with the single word: ok',
      // The worker policy forces an approval for network commands.
      approval:
        'Run exactly this with the Bash tool: curl -sI https://example.com . If it is denied, reply "denied" and stop.',
      write: 'Use the Write tool to create conformance.txt in the current directory containing: ok',
      long: 'Count from 1 to 400, one number per line, with no other text.',
    },
    timeoutMs: 180_000,
  });
});
