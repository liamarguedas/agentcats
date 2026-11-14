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

describe('docs/configuration.md', () => {
  it('documents every config key', async () => {
    const { readFile } = await import('node:fs/promises');
    const doc = await readFile(new URL('../../../docs/configuration.md', import.meta.url), 'utf8');
    const keys: string[] = [];
    const walk = (shape: Record<string, unknown>, prefix: string) => {
      for (const [key, value] of Object.entries(shape)) {
        const path = `${prefix}${key}`;
        let node: unknown = value;
        // Unwrap defaults and prefaults down to an object, if there is one.
        for (let i = 0; i < 4 && node && !(node as { shape?: unknown }).shape; i++) {
          node = (node as { def?: { innerType?: unknown } }).def?.innerType;
        }
        const nested = (node as { shape?: Record<string, unknown> } | undefined)?.shape;
        if (nested) walk(nested, `${path}.`);
        else keys.push(path);
      }
    };
    walk(AgentcatsConfig.shape, '');
    expect(keys.length).toBeGreaterThan(40);
    const missing = keys.filter((k) => !doc.includes(`\`${k}\``));
    expect(missing).toEqual([]);
  });
});
