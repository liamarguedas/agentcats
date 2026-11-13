// The conformance suite against real Codex through codex-acp, on the user's
// own Codex login. On an API-key login this is billed per token, so it runs
// only with AGENTCATS_LIVE_CODEX=1 (separate from the Claude gate on purpose).
//
//   AGENTCATS_LIVE_CODEX=1 pnpm exec vitest run packages/adapters/conformance/test/codex.live.test.ts
import { createCodexAdapter } from '@agentcats/adapter-codex';
import { describe } from 'vitest';

import { describeConformance } from '../src/index.js';

const LIVE = process.env['AGENTCATS_LIVE_CODEX'] === '1';

describe.runIf(LIVE)('live', () => {
  describeConformance({
    name: 'codex (live)',
    create: () => createCodexAdapter(),
    model: process.env['AGENTCATS_LIVE_CODEX_MODEL'] ?? 'gpt-5.4-mini',
    prompts: {
      reply: 'Reply with the single word: ok',
      // Codex does not ask before network commands (its sandbox blocks them,
      // verified in M4); it asks before edits in its read-only mode.
      approval:
        'Create a file named approval.txt in the current directory containing: ok . If that is denied, reply "denied" and stop.',
      approvalMode: 'ask',
      write: 'Create a file named conformance.txt in the current directory containing: ok',
    },
    timeoutMs: 180_000,
  });
});
