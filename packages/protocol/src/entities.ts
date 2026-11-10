import { z } from 'zod';

import {
  Billing,
  Budget,
  CatRole,
  CatStatus,
  Id,
  PauseReason,
  PermissionMode,
  ShortText,
  TaskReasonCode,
  TaskStatus,
  Timestamp,
  ToolKind,
} from './common.js';

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
  createdAt: Timestamp,
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
