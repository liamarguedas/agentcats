import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

export const E2E_PORT = 4599;
export const E2E_TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuvwxyz';
/** Where the mock daemon notes its temp project, so tests can read files in it. */
export const E2E_STATE_FILE = '.e2e-state.json';

/**
 * Browser tests against the built UI served by a real daemon running the mock
 * adapter, so the CSP, token handling and WebSocket path are the production ones.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(E2E_PORT)}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command:
      'vite build && node --conditions=@agentcats/source --import tsx scripts/mock-daemon.ts',
    url: `http://127.0.0.1:${String(E2E_PORT)}/`,
    env: {
      AGENTCATS_PORT: String(E2E_PORT),
      AGENTCATS_TOKEN: E2E_TOKEN,
      AGENTCATS_TIME_SCALE: '0.15',
      AGENTCATS_UI_DIR: 'dist',
      AGENTCATS_STATE_FILE: E2E_STATE_FILE,
      // Settings saved as "my defaults" go here, not to the user's real home.
      AGENTCATS_HOME: join(tmpdir(), 'agentcats-e2e-home'),
    },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
