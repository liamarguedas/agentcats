import { describe, expect, it } from 'vitest';

import { AgentcatsConfig } from './config.js';
import {
  layeredConfig,
  mergeConfigLayers,
  SaveSettingsRequest,
  settingsOf,
  withSettings,
} from './settings.js';

const builtIn = settingsOf(AgentcatsConfig.parse({}));

describe('settings', () => {
  it('reads the defaults a user can change from a config', () => {
    expect(builtIn).toMatchObject({
      adapter: 'claude',
      orchestrator: { adapter: null, model: null },
      workers: { max: 3, autoHire: true, permissionMode: 'accept_edits' },
      budget: { perCatUsd: 2, perCatMinutes: 60, globalUsd: 10, enforce: 'metered' },
      captions: { enabled: true },
    });
  });

  it('lays the project over the user defaults over the built-in ones', () => {
    const config = layeredConfig(
      { adapter: 'codex', workers: { max: 5, allowedCommands: ['npm test'] } },
      { workers: { max: 2 } },
    );
    expect(config.adapter).toBe('codex');
    expect(config.workers).toMatchObject({ max: 2, allowedCommands: ['npm test'] });
    expect(mergeConfigLayers({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it('saves only what differs from the layer below, and keeps other keys', () => {
    const inherited = { ...builtIn, adapter: 'codex' as const };
    const file = { port: 4545, workers: { max: 6, allowedCommands: ['npm test'] } };
    const next = withSettings(
      file,
      { ...inherited, adapter: 'claude', workers: { ...inherited.workers, max: 3 } },
      inherited,
    );
    // Back to the inherited worker limit: no longer pinned. The default agent differs: pinned.
    expect(next).toEqual({
      port: 4545,
      adapter: 'claude',
      workers: { allowedCommands: ['npm test'] },
    });
    // Saving what is inherited empties the settings out of the file.
    expect(
      withSettings({ adapter: 'claude', captions: { enabled: false } }, builtIn, builtIn),
    ).toEqual({});
  });

  it('checks what the board sends', () => {
    expect(SaveSettingsRequest.parse({ scope: 'global', settings: builtIn }).moveCats).toEqual([]);
    expect(
      SaveSettingsRequest.safeParse({ scope: 'global', settings: { ...builtIn, adapter: 'gpt' } })
        .success,
    ).toBe(false);
    expect(
      SaveSettingsRequest.safeParse({
        scope: 'project',
        settings: { ...builtIn, workers: { ...builtIn.workers, max: 40 } },
      }).success,
    ).toBe(false);
  });
});
