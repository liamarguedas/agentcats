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

/**
 * Task states. The full M1 set is defined now so the event log never needs a
 * breaking change; M0 only uses `queued`, `running`, `done`, `failed` and
 * `cancelled`. Allowed transitions arrive with the M1 state machine.
 */
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
