import { z } from 'zod';

import { PermissionMode } from './common.js';

/** File name of the project config, inside the project's `.agentcats/` directory. */
export const CONFIG_FILE_NAME = 'agentcats.config.json';

/** Runtime directory created in the user's project. */
export const RUNTIME_DIR_NAME = '.agentcats';

/**
 * Schema of `.agentcats/agentcats.config.json`. Every field has a default, so
 * `{}` is a valid config. The project path is not stored here: it is the
 * directory that contains `.agentcats/`, passed by the CLI.
 */
export const AgentcatsConfig = z.strictObject({
  $schema: z.string().optional(),
  /** Which adapter runs the cat. `mock` needs no agent CLI and spends no tokens. */
  adapter: z.enum(['claude', 'mock']).default('claude'),
  /** Model for new cats. `null` uses the agent's own default. */
  defaultModel: z.string().min(1).nullable().default(null),
  /** Permission mode for new cats. Editable per cat from the board in M1. */
  permissionMode: PermissionMode.default('accept_edits'),
  /** How long an approval waits before it is auto-denied. */
  approvalTimeoutMs: z
    .int()
    .positive()
    .default(5 * 60_000),
  /** Daemon listen port on 127.0.0.1. `0` picks a free port. */
  port: z.int().min(0).max(65_535).default(0),
  /** Spending ceilings. Parsed in M0 but not enforced until M1. */
  budget: z
    .strictObject({
      perCatUsd: z.number().positive().nullable().default(null),
      globalUsd: z.number().positive().nullable().default(null),
    })
    .prefault({}),
  claude: z
    .strictObject({
      /** Path to the `claude` executable. `null` resolves `claude` on PATH. */
      executablePath: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  mock: z
    .strictObject({
      /** Scenario the mock adapter plays. */
      scenario: z.string().min(1).default('happy-path'),
    })
    .prefault({}),
});
/** Config after defaults are applied. */
export type AgentcatsConfig = z.infer<typeof AgentcatsConfig>;
/** Config as written in the file. */
export type AgentcatsConfigInput = z.input<typeof AgentcatsConfig>;
