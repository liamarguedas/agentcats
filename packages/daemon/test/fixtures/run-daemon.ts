// Starts a daemon with the mock adapter in "real process" mode and prints its
// connection details as one JSON line. Used to hard-kill a daemon in tests.
import { createMockAdapter } from '@agentcats/adapter-mock';
import { AgentcatsConfig } from '@agentcats/protocol';

import { startDaemon } from '../../src/index.js';

const projectPath = process.argv[2];
if (!projectPath) throw new Error('usage: run-daemon.ts <projectPath>');

const daemon = await startDaemon({
  projectPath,
  adapter: createMockAdapter({ timeScale: 0, scenario: 'hang', spawnProcess: true }),
  config: AgentcatsConfig.parse({ adapter: 'mock' }),
});
console.log(JSON.stringify({ url: daemon.url, token: daemon.token }));
