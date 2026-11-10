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
 *
 * Values here are defaults for new cats. Each cat's model, permission mode and
 * budget can then be changed on the board.
 */
export const AgentcatsConfig = z.strictObject({
  $schema: z.string().optional(),
  /** Which adapter runs the cats. `mock` needs no agent CLI and spends no tokens. */
  adapter: z.enum(['claude', 'mock']).default('claude'),
  orchestrator: z
    .strictObject({
      /** `null` uses the agent's own default model. */
      model: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  workers: z
    .strictObject({
      /** How many workers may run at the same time. */
      max: z.int().min(1).max(16).default(3),
      model: z.string().min(1).nullable().default('sonnet'),
      permissionMode: PermissionMode.default('accept_edits'),
      /**
       * Commands workers may run without asking, usually the project's test
       * and lint commands, e.g. `"npm test"`. Matched as a prefix.
       */
      allowedCommands: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  budget: z
    .strictObject({
      perCatUsd: z.number().positive().nullable().default(2),
      globalUsd: z.number().positive().nullable().default(10),
      perCatTokens: z.int().positive().nullable().default(null),
      /**
       * `metered` enforces budgets only for cats billed per use (API key,
       * Bedrock, Vertex). `always` also enforces them on subscription plans,
       * where cost is an API-equivalent estimate. `never` only shows totals.
       */
      enforce: z.enum(['metered', 'always', 'never']).default('metered'),
    })
    .prefault({}),
  /** A worker with no events for this long is marked `blocked`. */
  stuckTimeoutMs: z
    .int()
    .positive()
    .default(5 * 60_000),
  /** How long an approval waits before it is auto-denied. */
  approvalTimeoutMs: z
    .int()
    .positive()
    .default(5 * 60_000),
  /** Daemon listen port on 127.0.0.1. `0` picks a free port. */
  port: z.int().min(0).max(65_535).default(0),
  /** Where worktrees go. `null` is `~/.agentcats/worktrees/<project>`, outside the repo. */
  worktreesDir: z.string().min(1).nullable().default(null),
  claude: z
    .strictObject({
      /** Path to the `claude` executable. `null` resolves `claude` on PATH. */
      executablePath: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  mock: z
    .strictObject({
      /** Scenario mock workers play. */
      scenario: z.string().min(1).default('happy-path'),
    })
    .prefault({}),
});
/** Config after defaults are applied. */
export type AgentcatsConfig = z.infer<typeof AgentcatsConfig>;
/** Config as written in the file. */
export type AgentcatsConfigInput = z.input<typeof AgentcatsConfig>;
