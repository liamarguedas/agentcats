import { fileURLToPath } from 'node:url';

import { createAcpAdapter } from '@agentcats/adapter-acp';

import { describeConformance } from '../src/index.js';

const FAKE_AGENT = fileURLToPath(new URL('../../acp/test/fake-agent.mjs', import.meta.url));

// The generic ACP adapter against a scripted ACP agent: the same code path a
// real ACP agent (Codex through codex-acp) takes, without spending anything.
describeConformance({
  name: 'acp (scripted agent)',
  create: () =>
    createAcpAdapter({
      id: 'fake',
      displayName: 'Fake ACP agent',
      command: process.execPath,
      args: [FAKE_AGENT],
      capabilities: {
        mcp: true,
        approvals: true,
        resume: true,
        reportsCost: false,
        modelSelection: true,
        interrupt: true,
        permissionModes: ['ask', 'accept_edits', 'auto'],
        policyEnforcement: 'sandbox',
        complete: true,
      },
      modelTiers: { fast: 'fake-fast', balanced: 'fake-balanced', best: 'fake-best' },
      modeFor: (policy) => (policy?.access === 'read_only' ? 'read-only' : 'auto'),
      modelOption: 'model',
    }),
  prompts: { reply: 'say hello', approval: 'approve the tests', write: 'write the file' },
});
