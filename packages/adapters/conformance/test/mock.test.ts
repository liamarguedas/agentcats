import { createMockAdapter } from '@agentcats/adapter-mock';

import { describeConformance } from '../src/index.js';

// The mock plays scenarios: `/approval` asks before a command, `/conformance-write`
// writes conformance.txt. A stand-in process gives it a pid to kill.
describeConformance({
  name: 'mock',
  create: () => createMockAdapter({ timeScale: 0, realFiles: true, spawnProcess: true }),
  prompts: {
    reply: 'say hello',
    approval: '/approval',
    write: '/conformance-write',
    long: '/hang',
  },
});
