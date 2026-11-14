import { z } from 'zod';

import { PermissionMode } from './common.js';
import { ModelTier } from './hiring.js';

/** Adapters agentcats ships with. */
export const AdapterId = z.enum(['claude', 'codex', 'mock']);
export type AdapterId = z.infer<typeof AdapterId>;

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
  /**
   * The default adapter for every cat. `mock` needs no agent CLI and spends
   * no tokens. The lead and workers can each use another one.
   */
  adapter: AdapterId.default('claude'),
  orchestrator: z
    .strictObject({
      /** An adapter id; `null` uses the default `adapter`. It must support MCP. */
      adapter: z.string().min(1).max(64).nullable().default(null),
      /** `null` uses the agent's own default model. */
      model: z.string().min(1).nullable().default(null),
    })
    .prefault({}),
  workers: z
    .strictObject({
      /** How many workers may run at the same time. */
      max: z.int().min(1).max(16).default(3),
      /** An adapter id; `null` uses the default `adapter`. */
      adapter: z.string().min(1).max(64).nullable().default(null),
      /** `null` uses the adapter's balanced tier (`sonnet` for Claude). */
      model: z.string().min(1).nullable().default(null),
      permissionMode: PermissionMode.default('accept_edits'),
      /**
       * Commands workers may run without asking, usually the project's test
       * and lint commands, e.g. `"npm test"`. Matched as a prefix.
       */
      allowedCommands: z.array(z.string().min(1)).default([]),
      /**
       * Hire a new worker automatically when a task waits and there is room.
       * `false` leaves hiring to interviews.
       */
      autoHire: z.boolean().default(true),
    })
    .prefault({}),
  interviews: z
    .strictObject({
      /** Candidates per interview, 1 to 3. */
      candidates: z.int().min(1).max(3).default(2),
      tier: ModelTier.default('balanced'),
      /** API-equivalent dollars one interview may spend, enforced like `budget`. */
      budgetUsd: z.number().positive().nullable().default(3),
      /** How long a candidate may work before it is stopped and fails. */
      candidateTimeoutMs: z
        .int()
        .positive()
        .default(15 * 60_000),
      /** How long the daemon lets one check, lint or typecheck command run. */
      checkTimeoutMs: z.int().positive().default(120_000),
      /**
       * The check for interviews that re-run a task on the project. `null`
       * uses the `package.json` test script.
       */
      projectCheck: z.string().min(1).nullable().default(null),
      /** Weights of the score parts. Passing the check is a gate, not a weight. */
      weights: z
        .strictObject({
          diff: z.number().nonnegative().default(0.4),
          cost: z.number().nonnegative().default(0.25),
          time: z.number().nonnegative().default(0.15),
          quality: z.number().nonnegative().default(0.2),
        })
        .prefault({}),
    })
    .prefault({}),
  budget: z
    .strictObject({
      perCatUsd: z.number().positive().nullable().default(2),
      globalUsd: z.number().positive().nullable().default(10),
      perCatTokens: z.int().positive().nullable().default(null),
      /**
       * Minutes of agent working time per cat, for adapters that cannot
       * report cost (Codex). Warning at 80 percent, pause at 100.
       */
      perCatMinutes: z.number().positive().nullable().default(60),
      /**
       * `metered` enforces budgets only for cats billed per use (API key,
       * Bedrock, Vertex). `always` also enforces them on subscription plans,
       * where cost is an API-equivalent estimate. `never` only shows totals.
       */
      enforce: z.enum(['metered', 'always', 'never']).default('metered'),
    })
    .prefault({}),
  /** XP per outcome. Failures and timeouts earn nothing. Level thresholds are in `levels.ts`. */
  xp: z
    .strictObject({
      accepted: z.int().nonnegative().default(10),
      /** Extra when the worker reported passing tests on the first attempt. */
      testsFirstTry: z.int().nonnegative().default(5),
      /** Extra when the task cost less than the median of the team's recent accepted tasks. */
      underCost: z.int().nonnegative().default(3),
      /** Taken away when the user rejects a result. XP never goes below 0. */
      rejectedPenalty: z.int().nonnegative().default(10),
    })
    .prefault({}),
  memory: z
    .strictObject({
      /** Run a debrief after each reviewed task to propose learnings. */
      debrief: z.boolean().default(true),
      /** Model for debrief and consolidation calls; `null` is the agent's default. */
      /** `null` uses the default adapter's fast tier (`haiku` for Claude). */
      model: z.string().min(1).nullable().default(null),
      /** Most lines a cat's `learnings.md` may hold; going over proposes a consolidation. */
      cap: z.int().min(5).max(200).default(30),
      /**
       * Accept debrief proposals without asking once a cat has this many
       * accepted tasks. `null` always asks. Consolidations always ask.
       */
      autoAcceptAfter: z.int().positive().nullable().default(null),
    })
    .prefault({}),
  /**
   * Let agents add their own attribution to the commits and pull requests
   * they write, such as Claude Code's `Co-Authored-By` trailer. Off by default:
   * the commits are the user's.
   */
  attribution: z.boolean().default(false),
  /**
   * Meme captions on failures, promotions, budgets, retirements and
   * rejections, from `.agentcats/captions.json`. `enabled: false` is the
   * serious mode.
   */
  captions: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
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
  codex: z
    .strictObject({
      /**
       * Windows sandbox for Codex cats. `unelevated` (the default) is the one
       * codex-acp's bundled Codex build can start; it is weaker than
       * `elevated`. `codex_config` uses `~/.codex/config.toml` as is, which
       * only works if codex-acp's build supports the sandbox set up there.
       * Ignored on macOS and Linux.
       */
      windowsSandbox: z.enum(['unelevated', 'codex_config']).default('unelevated'),
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
      /** Scenario mock workers play. */
      scenario: z.string().min(1).default('happy-path'),
    })
    .prefault({}),
});
/** Config after defaults are applied. */
export type AgentcatsConfig = z.infer<typeof AgentcatsConfig>;
/** Config as written in the file. */
export type AgentcatsConfigInput = z.input<typeof AgentcatsConfig>;
