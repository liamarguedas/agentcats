import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AgentcatsConfig,
  CONFIG_FILE_NAME,
  mergeConfigLayers,
  RUNTIME_DIR_NAME,
} from '@agentcats/protocol';
import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function configPath(projectPath: string): string {
  return join(projectPath, RUNTIME_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * The user's own defaults, for every project: `~/.agentcats/agentcats.config.json`.
 * `AGENTCATS_HOME` moves `~/.agentcats` (tests use it).
 */
export function globalConfigPath(): string {
  return join(process.env['AGENTCATS_HOME'] ?? join(homedir(), '.agentcats'), CONFIG_FILE_NAME);
}

/**
 * A config file's JSON, or `{}` if there is no file.
 *
 * @throws ConfigError if it cannot be read or is not a JSON object.
 */
export async function readConfigFile(file: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(`Cannot read ${file}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new ConfigError(`${file} must hold a JSON object`);
  }
  return json as Record<string, unknown>;
}

function parse(json: unknown, file: string): AgentcatsConfig {
  const parsed = AgentcatsConfig.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * Load a project's config: the built-in defaults, then the user's own
 * defaults (`~/.agentcats/agentcats.config.json`), then the project's
 * `.agentcats/agentcats.config.json`. Missing files add nothing.
 *
 * @throws ConfigError with the file path and a readable list of problems if
 *   a file is not valid JSON or does not match the schema.
 */
export async function loadConfig(projectPath: string): Promise<AgentcatsConfig> {
  const globalFile = globalConfigPath();
  const global = await readConfigFile(globalFile);
  parse(global, globalFile);
  const projectFile = configPath(projectPath);
  return parse(mergeConfigLayers(global, await readConfigFile(projectFile)), projectFile);
}
