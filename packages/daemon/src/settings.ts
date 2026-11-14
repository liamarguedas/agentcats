import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  type AgentcatsConfig,
  layeredConfig,
  type SaveSettingsRequest,
  type Settings,
  settingsOf,
  type SettingsResponse,
  withSettings,
} from '@agentcats/protocol';

import { ApiError } from './errors.js';
import type { CatManager } from './cat-manager.js';
import { ConfigError, configPath, globalConfigPath, readConfigFile } from './config.js';
import type { EventLog } from './event-log.js';
import { writeFileAtomic } from './fs-util.js';

/**
 * The board's Settings: reads the two config files, saves one of them, and
 * applies the result to the running team. What settings change takes effect
 * at once for new cats, the team size, budgets and captions; existing cats
 * keep their agent unless the user moves them.
 */
export class SettingsService {
  constructor(
    private readonly o: {
      readonly projectPath: string;
      /** The daemon's live config; settings are written into it in place. */
      readonly config: AgentcatsConfig;
      readonly manager: CatManager;
      readonly log: EventLog;
    },
  ) {}

  async read(): Promise<SettingsResponse> {
    const global = await readConfigFile(globalConfigPath());
    return {
      settings: settingsOf(this.o.config),
      inherited: settingsOf(layeredConfig(global, {})),
      builtIn: settingsOf(layeredConfig({}, {})),
      files: { project: configPath(this.o.projectPath), global: globalConfigPath() },
    };
  }

  /**
   * Save to the project's file or the user's, then apply.
   *
   * @throws ApiError `bad_request` if the result names an agent this run does
   *   not have, or a lead agent without MCP; nothing is written then.
   */
  async save(request: SaveSettingsRequest): Promise<SettingsResponse> {
    const globalFile = globalConfigPath();
    const projectFile = configPath(this.o.projectPath);
    const global = await readConfigFile(globalFile);
    const project = await readConfigFile(projectFile);
    const builtIn = settingsOf(layeredConfig({}, {}));
    const nextGlobal =
      request.scope === 'global' ? withSettings(global, request.settings, builtIn) : global;
    // The project file pins only what differs from what it inherits.
    const inherited = settingsOf(layeredConfig(nextGlobal, {}));
    const nextProject =
      request.scope === 'project' ? withSettings(project, request.settings, inherited) : project;
    let next: AgentcatsConfig;
    try {
      next = layeredConfig(nextGlobal, nextProject);
    } catch (error) {
      throw new ApiError(
        'bad_request',
        `Those settings do not make a valid config: ${String(error)}`,
      );
    }
    const settings = settingsOf(next);
    this.o.manager.checkSettings(settings);

    const file = request.scope === 'global' ? globalFile : projectFile;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFileAtomic(
        file,
        `${JSON.stringify(request.scope === 'global' ? nextGlobal : nextProject, null, 2)}\n`,
      );
    } catch (error) {
      throw new ConfigError(`Cannot write ${file}: ${(error as Error).message}`);
    }
    apply(this.o.config, settings);
    this.o.log.append({
      type: 'notice',
      payload: {
        level: 'info',
        code: 'settings_saved',
        message:
          request.scope === 'global'
            ? 'Settings saved as your defaults for every project.'
            : 'Settings saved for this project.',
      },
    });
    await this.o.manager.settingsChanged(request.moveCats);
    return this.read();
  }
}

/** Write the settings into the live config object, which the team reads as it goes. */
function apply(config: AgentcatsConfig, settings: Settings): void {
  config.adapter = settings.adapter;
  Object.assign(config.orchestrator, settings.orchestrator);
  Object.assign(config.workers, settings.workers);
  Object.assign(config.budget, settings.budget);
  Object.assign(config.captions, settings.captions);
}
