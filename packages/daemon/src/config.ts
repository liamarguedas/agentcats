import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AgentcatsConfig, CONFIG_FILE_NAME, RUNTIME_DIR_NAME } from '@agentcats/protocol';
import { z } from 'zod';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function configPath(projectPath: string): string {
  return join(projectPath, RUNTIME_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Load `.agentcats/agentcats.config.json` from a project. A missing file means
 * all defaults.
 *
 * @throws ConfigError with the file path and a readable list of problems if
 *   the file is not valid JSON or does not match the schema.
 */
export async function loadConfig(projectPath: string): Promise<AgentcatsConfig> {
  const file = configPath(projectPath);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return AgentcatsConfig.parse({});
    throw new ConfigError(`Cannot read ${file}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = AgentcatsConfig.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
