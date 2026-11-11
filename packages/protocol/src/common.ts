import { z } from 'zod';

/** Version of the wire contract. Bump on any breaking change to events or commands. */
export const PROTOCOL_VERSION = 1;

/** Opaque identifier for cats, tasks, events, approvals, messages and tool calls. */
export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

/** Short human-readable text shown in bubbles and the event log. */
export const ShortText = z.string().max(500);

/** What a cat does. The orchestrator delegates; workers change code in worktrees. */
export const CatRole = z.enum(['orchestrator', 'worker']);
export type CatRole = z.infer<typeof CatRole>;

/**
 * How the agent's usage is paid for. `metered` is pay per use (API key,
 * Bedrock, Vertex), where dollar budgets are enforced by default.
 * `subscription` is a flat plan, where reported cost is an API-equivalent
 * estimate.
 */
export const Billing = z.enum(['metered', 'subscription', 'unknown']);
export type Billing = z.infer<typeof Billing>;

/** Spending ceiling for one cat. `null` means no limit of that kind. */
export const Budget = z.strictObject({
  maxUsd: z.number().positive().nullable(),
  maxTokens: z.int().positive().nullable(),
});
export type Budget = z.infer<typeof Budget>;

/** Why a cat is paused. Only the user resumes either kind. */
export const PauseReason = z.enum(['user', 'budget']);
export type PauseReason = z.infer<typeof PauseReason>;

/** Machine-readable cause of a task's current status, for board actions. */
export const TaskReasonCode = z.enum([
  'stuck',
  'budget',
  'paused',
  'crashed',
  'agent_error',
  'spawn_failed',
  'killed',
  'daemon_restarted',
  'cancelled_by_user',
  'cancelled_by_orchestrator',
]);
export type TaskReasonCode = z.infer<typeof TaskReasonCode>;

/** Lifecycle of a cat as drawn on the board. */
export const CatStatus = z.enum([
  'idle',
  'thinking',
  'working',
  'blocked',
  'waiting_approval',
  'done',
  'error',
]);
export type CatStatus = z.infer<typeof CatStatus>;

/** Task states. Allowed transitions are defined in `task-machine.ts`. */
export const TaskStatus = z.enum([
  'queued',
  'running',
  'blocked',
  'review',
  'done',
  'rejected',
  'failed',
  'interrupted',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Agent-neutral permission modes. Adapters map them to their own mechanism and
 * declare which ones they support. There is deliberately no "bypass" mode.
 *
 * - `ask`: every tool call that can change anything needs an approval.
 * - `accept_edits`: file edits inside the working directory run without asking.
 * - `auto`: the agent's own safety classifier decides; the rest asks.
 */
export const PermissionMode = z.enum(['ask', 'accept_edits', 'auto']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** Normalized tool category, mirroring ACP `ToolKind`. Drives bubble icons. */
export const ToolKind = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other',
]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ToolCallStatus = z.enum(['running', 'success', 'error']);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const ApprovalDecision = z.enum(['allow', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/** Whether `costUsd` came from the agent, was computed by us, or is not known. */
export const CostSource = z.enum(['reported', 'estimated', 'unknown']);
export type CostSource = z.infer<typeof CostSource>;

/** `thought` is reasoning text the agent exposes; `text` is its answer. */
export const MessageChannel = z.enum(['text', 'thought']);
export type MessageChannel = z.infer<typeof MessageChannel>;

/**
 * Cumulative token and cost counters. Values only grow within one session, so
 * a repeated or reordered update can never make totals go backwards.
 */
export const Usage = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  cacheWriteTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  costSource: CostSource,
});
export type Usage = z.infer<typeof Usage>;

/**
 * Why a cat's XP changed. Weights are in the config's `xp` section. Failures
 * and timeouts earn nothing, so they have no reason of their own.
 */
export const XpReason = z.enum([
  /** The user accepted the result. */
  'accepted',
  /** Accepted, and the worker reported passing tests on the first attempt. */
  'tests_first_try',
  /** Accepted, and it cost less than the team's median accepted task. */
  'under_cost',
  /** The user rejected the result. */
  'rejected',
]);
export type XpReason = z.infer<typeof XpReason>;

/** One line of a cat's `learnings.md`. */
export const LearningText = z.string().trim().min(1).max(300);

/** What changed a cat's learnings file. `external` is a hand edit of the file. */
export const LearningsChangeReason = z.enum([
  'added',
  'edited',
  'deleted',
  'debrief',
  'consolidation',
  'restored',
  'external',
]);
export type LearningsChangeReason = z.infer<typeof LearningsChangeReason>;

/**
 * Why learnings were proposed. `debrief` adds lines after a reviewed task;
 * the others propose a consolidated rewrite of the whole file.
 */
export const ProposalTrigger = z.enum(['debrief', 'level_up', 'cap', 'user']);
export type ProposalTrigger = z.infer<typeof ProposalTrigger>;
