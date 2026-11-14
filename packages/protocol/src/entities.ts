import { z } from 'zod';

import {
  Billing,
  Budget,
  CatRole,
  CatStatus,
  Id,
  LearningText,
  PauseReason,
  PermissionMode,
  ProposalTrigger,
  ShortText,
  TaskReasonCode,
  TaskStatus,
  Timestamp,
  ToolKind,
} from './common.js';

/**
 * One line of a cat's `learnings.md`. `id` is derived from the line's content
 * by the daemon, so an edit made against a stale copy of the file is refused.
 */
export const Learning = z.strictObject({
  id: Id,
  text: LearningText,
  /** Task the learning came from; `null` for lines the user wrote. */
  sourceTaskId: Id.nullable(),
});
export type Learning = z.infer<typeof Learning>;

/** A learning before it is in the file. */
export const LearningDraft = Learning.omit({ id: true });
export type LearningDraft = z.infer<typeof LearningDraft>;

/** Task outcomes per cat, counted from the log. */
export const CatStats = z.strictObject({
  /** Results handed in for review. */
  completed: z.int().nonnegative(),
  accepted: z.int().nonnegative(),
  rejected: z.int().nonnegative(),
});
export type CatStats = z.infer<typeof CatStats>;

/**
 * A name the user gives a cat. It names the cat's folder
 * (`.agentcats/cats/<name>/`), so it must be a safe file name on every
 * system: letters, digits, spaces and `' . _ -`, starting and ending with a
 * letter or digit, and not a name Windows reserves.
 */
export const CatName = z
  .string()
  .trim()
  .min(1, 'Give the cat a name')
  .max(32, 'Keep the name to 32 characters')
  .regex(
    /^[\p{L}\p{N}](?:[\p{L}\p{N} '._-]*[\p{L}\p{N}])?$/u,
    "Use letters, digits, spaces and ' . _ -, starting and ending with a letter or digit",
  )
  .refine((name) => !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name), 'That name is reserved');
export type CatName = z.infer<typeof CatName>;

export const Cat = z.strictObject({
  id: Id,
  name: z.string().min(1).max(64),
  role: CatRole,
  /** Adapter id, for example `claude` or `mock`. */
  adapter: z.string().min(1).max(64),
  /** `null` means the agent's own default model. */
  model: z.string().min(1).nullable(),
  permissionMode: PermissionMode,
  budget: Budget,
  /** Learned when the agent session starts. */
  billing: Billing,
  status: CatStatus,
  /** Why the cat entered its current status, if there is something to say. */
  statusReason: ShortText.nullable(),
  /** Set while the cat is paused; only the user resumes it. */
  pausedReason: PauseReason.nullable(),
  /** Never below 0. Only workers earn XP. */
  xp: z.int().nonnegative(),
  /** Follows `xp` through the curve in `levels.ts`. */
  level: z.int().positive(),
  stats: CatStats,
  /** Mirror of `.agentcats/cats/<name>/learnings.md`, which is the source of truth. */
  learnings: z.array(Learning).max(500),
  createdAt: Timestamp,
  /** Its look, from `CAT_VARIANTS`; `null` for a cat from before looks (the UI derives one). */
  variant: z.string().min(1).max(64).nullable().default(null),
});
export type Cat = z.infer<typeof Cat>;

/** What a worker hands back for review. */
export const TaskResult = z.strictObject({
  /** The worker's structured final summary: what changed, tests run, open issues. */
  summary: z.string().max(20_000),
  /** Branch with the worker's commits, for the user to review and merge. */
  branch: z.string().min(1).max(250),
  diffStat: z.strictObject({
    files: z.int().nonnegative(),
    insertions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
  }),
  /** As reported by the worker. `unknown` if its summary did not say. */
  tests: z.enum(['passed', 'failed', 'not_run', 'unknown']),
  /**
   * What the task cost, as the agent reported it. `null` when unknown, for
   * example after a daemon restart in the middle of the task.
   */
  costUsd: z.number().nonnegative().nullable().default(null),
  /** The worker's working time on the task, measured by the daemon. `null` when unknown. */
  activeMs: z.int().nonnegative().nullable().default(null),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const Task = z.strictObject({
  id: Id,
  title: z.string().min(1).max(200),
  description: z.string().max(20_000),
  status: TaskStatus,
  assigneeCatId: Id.nullable(),
  /** Why the task is in its status, in words. */
  statusReason: ShortText.nullable(),
  reasonCode: TaskReasonCode.nullable(),
  /** 1 for the first run; increases on automatic retry and on re-run. */
  attempt: z.int().positive(),
  /** Set once a worktree exists for the task. */
  branch: z.string().min(1).max(250).nullable(),
  worktreePath: z.string().min(1).nullable(),
  result: TaskResult.nullable(),
  /** Short summary shown on the card. In M1 the full result is in `result`. */
  summary: z.string().max(20_000).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Task = z.infer<typeof Task>;

/** An approval the agent is blocked on, shown as a bubble on its cat. */
export const PendingApproval = z.strictObject({
  id: Id,
  catId: Id,
  taskId: Id.nullable(),
  toolCallId: Id.nullable(),
  toolName: z.string().min(1).max(200),
  kind: ToolKind,
  inputSummary: ShortText,
  requestedAt: Timestamp,
});
export type PendingApproval = z.infer<typeof PendingApproval>;

/**
 * Learnings a debrief or consolidation suggested, waiting for the user. An
 * `add` proposal appends `lines`; a `rewrite` replaces the whole file with
 * them.
 */
export const LearningProposal = z.strictObject({
  id: Id,
  catId: Id,
  taskId: Id.nullable(),
  kind: z.enum(['add', 'rewrite']),
  trigger: ProposalTrigger,
  lines: z.array(LearningDraft).max(500),
  /**
   * For a rewrite: ids of the learnings it was made from. Lines added to the
   * file after it was proposed are kept when it is applied.
   */
  base: z.array(Id).max(500),
  createdAt: Timestamp,
});
export type LearningProposal = z.infer<typeof LearningProposal>;
