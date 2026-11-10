// A daemon with the mock adapter, for UI development and the browser tests.
// No agent CLI, no API key, no tokens spent.
//
// Env: AGENTCATS_PORT (default 4545), AGENTCATS_TOKEN (default random),
// AGENTCATS_TIME_SCALE (default 1), AGENTCATS_UI_DIR (default: serve no UI;
// set it to packages/ui/dist to serve the built UI).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { consoleLogger, startDaemon } from '@agentcats/daemon';
import { AgentcatsConfig } from '@agentcats/protocol';

const env = process.env;
const projectPath = await mkdtemp(join(tmpdir(), 'agentcats-mock-'));
const daemon = await startDaemon({
  projectPath,
  adapter: createMockAdapter({ timeScale: Number(env['AGENTCATS_TIME_SCALE'] ?? 1) }),
  config: AgentcatsConfig.parse({ adapter: 'mock', port: Number(env['AGENTCATS_PORT'] ?? 4545) }),
  uiDir: env['AGENTCATS_UI_DIR'] ?? null,
  ...(env['AGENTCATS_TOKEN'] && { token: env['AGENTCATS_TOKEN'] }),
  logger: consoleLogger,
});

const fragment = daemon.uiUrl.slice(daemon.uiUrl.indexOf('#'));
console.log(`Mock daemon on ${daemon.url}`);
console.log(`Vite dev UI: http://localhost:5173/${fragment}`);
if (env['AGENTCATS_UI_DIR']) console.log(`Built UI:    ${daemon.uiUrl}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon
      .close()
      .then(() => rm(projectPath, { recursive: true, force: true, maxRetries: 5 }))
      .then(() => process.exit(0));
  });
}
