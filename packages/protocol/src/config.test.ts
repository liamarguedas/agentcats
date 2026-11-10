import { describe, expect, it } from 'vitest';

import { AgentcatsConfig } from './config.js';

describe('AgentcatsConfig', () => {
  it('fills every default from an empty file', () => {
    expect(AgentcatsConfig.parse({})).toEqual({
      adapter: 'claude',
      defaultModel: null,
      permissionMode: 'accept_edits',
      approvalTimeoutMs: 300_000,
      port: 0,
      budget: { perCatUsd: null, globalUsd: null },
      claude: { executablePath: null },
      mock: { scenario: 'happy-path' },
    });
  });

  it('keeps explicit values', () => {
    const config = AgentcatsConfig.parse({
      adapter: 'mock',
      permissionMode: 'auto',
      mock: { scenario: 'error' },
      budget: { perCatUsd: 2 },
    });
    expect(config).toMatchObject({
      adapter: 'mock',
      permissionMode: 'auto',
      mock: { scenario: 'error' },
      budget: { perCatUsd: 2, globalUsd: null },
    });
  });

  it.each(['bypassPermissions', 'bypass', 'acceptEdits'])(
    'rejects permission mode %s',
    (permissionMode) => {
      expect(AgentcatsConfig.safeParse({ permissionMode }).success).toBe(false);
    },
  );

  it('rejects unknown keys, so typos surface', () => {
    expect(AgentcatsConfig.safeParse({ adaptor: 'mock' }).success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(AgentcatsConfig.safeParse({ port: 70_000 }).success).toBe(false);
  });
});
