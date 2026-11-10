// Starts a daemon with the mock adapter in "real process" mode and prints its
// connection details as one JSON line. Used to hard-kill a daemon in tests.
//
// Usage: run-daemon.ts <projectPath> <worktreesDir>
import { createMockAdapter } from '@agentcats/adapter-mock';
import { AgentcatsConfig } from '@agentcats/protocol';

import { startDaemon } from '../../src/index.js';

const [projectPath, worktreesDir] = process.argv.slice(2);
if (!projectPath || !worktreesDir)
  throw new Error('usage: run-daemon.ts <projectPath> <worktreesDir>');

const daemon = await startDaemon({
  projectPath,
  adapter: createMockAdapter({
    timeScale: 0,
    scenario: 'hang',
    spawnProcess: true,
    realFiles: true,
  }),
  config: AgentcatsConfig.parse({ adapter: 'mock', worktreesDir }),
});
console.log(JSON.stringify({ url: daemon.url, token: daemon.token }));
