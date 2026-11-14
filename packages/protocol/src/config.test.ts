import { describe, expect, it } from 'vitest';

import { AgentcatsConfig } from './config.js';

describe('AgentcatsConfig', () => {
  it('fills every default from an empty file', () => {
    expect(AgentcatsConfig.parse({})).toEqual({
      adapter: 'claude',
      orchestrator: { adapter: null, model: null },
      workers: {
        max: 3,
        adapter: null,
        model: null,
        permissionMode: 'accept_edits',
        allowedCommands: [],
        autoHire: true,
      },
      interviews: {
        candidates: 2,
        tier: 'balanced',
        budgetUsd: 3,
        candidateTimeoutMs: 900_000,
        checkTimeoutMs: 120_000,
        projectCheck: null,
        weights: { diff: 0.4, cost: 0.25, time: 0.15, quality: 0.2 },
      },
      budget: {
        perCatUsd: 2,
        globalUsd: 10,
        perCatTokens: null,
        perCatMinutes: 60,
        enforce: 'metered',
      },
      xp: { accepted: 10, testsFirstTry: 5, underCost: 3, rejectedPenalty: 10 },
      memory: { debrief: true, model: null, cap: 30, autoAcceptAfter: null },
      attribution: false,
      captions: { enabled: true },
      stuckTimeoutMs: 300_000,
      approvalTimeoutMs: 300_000,
      port: 0,
      worktreesDir: null,
      codex: { windowsSandbox: 'unelevated' },
      claude: { executablePath: null },
      mock: { scenario: 'happy-path' },
    });
  });

  it('keeps explicit values', () => {
    const config = AgentcatsConfig.parse({
      adapter: 'mock',
      workers: { permissionMode: 'auto', allowedCommands: ['npm test'] },
      mock: { scenario: 'error' },
      budget: { perCatUsd: 5, globalUsd: null },
    });
    expect(config).toMatchObject({
      adapter: 'mock',
      workers: { max: 3, permissionMode: 'auto', allowedCommands: ['npm test'] },
      mock: { scenario: 'error' },
      budget: { perCatUsd: 5, globalUsd: null, enforce: 'metered' },
    });
  });

  it.each(['bypassPermissions', 'bypass', 'acceptEdits'])(
    'rejects permission mode %s',
    (permissionMode) => {
      expect(AgentcatsConfig.safeParse({ workers: { permissionMode } }).success).toBe(false);
    },
  );

  it('rejects unknown keys, so typos surface', () => {
    expect(AgentcatsConfig.safeParse({ adaptor: 'mock' }).success).toBe(false);
  });

  it('rejects a worker limit outside 1 to 16', () => {
    expect(AgentcatsConfig.safeParse({ workers: { max: 0 } }).success).toBe(false);
    expect(AgentcatsConfig.safeParse({ workers: { max: 17 } }).success).toBe(false);
  });

  it('rejects the M0 top-level permissionMode, which moved under workers', () => {
    expect(AgentcatsConfig.safeParse({ permissionMode: 'ask' }).success).toBe(false);
  });

  it('rejects an out-of-range port', () => {
    expect(AgentcatsConfig.safeParse({ port: 70_000 }).success).toBe(false);
  });
});
