/**
 * The contract every agent adapter implements. The daemon only ever talks to
 * agents through {@link Adapter} and {@link Session}, and only sees the
 * normalized {@link AgentEvent} set. Nothing agent-specific (Claude message
 * shapes, Codex item types) may appear here.
 *
 * The shape mirrors Agent Client Protocol v1 so an ACP-backed adapter stays a
 * thin mapping (see docs/decisions.md, Step 0.2):
 *
 * | here                         | ACP v1                                   |
 * | ---------------------------- | ---------------------------------------- |
 * | `Adapter.spawn`              | `initialize` + `session/new` (or `load`) |
 * | `Session.send`               | `session/prompt`                         |
 * | `message.chunk`, `tool.*`    | `session/update` notifications           |
 * | `approval.requested`/approve | `session/request_permission`             |
 * | `Session.interrupt`          | `session/cancel`                         |
 * | `turn.ended.stopReason`      | `session/prompt` response `stopReason`   |
 *
 * Exported from `@agentcats/protocol/adapter`, not the package root, because
 * the UI never needs it.
 */
import { z } from 'zod';

import {
  ApprovalDecision,
  Billing,
  Id,
  MessageChannel,
  PermissionMode,
  ShortText,
  ToolKind,
  Usage,
} from './common.js';
import type { ModelTier } from './hiring.js';

// ---------------------------------------------------------------------------
// Normalized agent events
// ---------------------------------------------------------------------------

/**
 * First event of every session. `resumeId` is the agent's own session handle,
 * to pass back as {@link SpawnOptions.resumeId} later; `null` if the agent
 * cannot resume.
 */
export const SessionStartedEvent = z.strictObject({
  type: z.literal('session.started'),
  resumeId: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  /** Version of the agent CLI actually running, for the decisions log and board warnings. */
  agentVersion: z.string().min(1).nullable(),
  /** How this session is paid for; decides whether dollar budgets are enforced. */
  billing: Billing,
});

/** The agent started working on a message passed to {@link Session.send}. */
export const TurnStartedEvent = z.strictObject({
  type: z.literal('turn.started'),
});

/** Streamed agent output. Chunks sharing a `messageId` concatenate in order. */
export const MessageChunkEvent = z.strictObject({
  type: z.literal('message.chunk'),
  messageId: Id,
  channel: MessageChannel,
  text: z.string().max(100_000),
});

export const ToolStartedEvent = z.strictObject({
  type: z.literal('tool.started'),
  toolCallId: Id,
  /** The agent's own tool name, shown as-is. `kind` is the normalized category. */
  toolName: z.string().min(1).max(200),
  kind: ToolKind,
  /** One line for the bubble, e.g. a file path or a command. Never the full input. */
  inputSummary: ShortText,
});

export const ToolFinishedEvent = z.strictObject({
  type: z.literal('tool.finished'),
  toolCallId: Id,
  status: z.enum(['success', 'error']),
  outputSummary: ShortText.nullable(),
});

/**
 * The agent is blocked until {@link Session.approve} is called with this
 * `requestId`. When the agent announced the call first, `toolCallId` links
 * the request to that earlier `tool.started`.
 */
export const ApprovalRequestedAgentEvent = z.strictObject({
  type: z.literal('approval.requested'),
  requestId: Id,
  toolCallId: Id.nullable(),
  toolName: z.string().min(1).max(200),
  kind: ToolKind,
  inputSummary: ShortText,
});

/** Cumulative for the whole session, never a delta. */
export const UsageAgentEvent = z.strictObject({
  type: z.literal('usage'),
  usage: Usage,
});

export const StopReason = z.enum([
  /** The agent finished its answer. */
  'end_turn',
  'max_tokens',
  'max_turns',
  'refusal',
  /** {@link Session.interrupt} or {@link Session.kill} stopped the turn. */
  'cancelled',
  /** The turn failed; an `error` event precedes this. */
  'error',
]);
export type StopReason = z.infer<typeof StopReason>;

export const TurnEndedEvent = z.strictObject({
  type: z.literal('turn.ended'),
  stopReason: StopReason,
});

/**
 * Something went wrong. With `fatal: false` the session continues (for
 * example a failed API retry); with `fatal: true` a `session.ended` follows.
 */
export const AgentErrorEvent = z.strictObject({
  type: z.literal('error'),
  message: ShortText,
  fatal: z.boolean(),
});

/** Last event of every session, emitted exactly once however the session ends. */
export const SessionEndedEvent = z.strictObject({
  type: z.literal('session.ended'),
  reason: z.enum(['exited', 'killed', 'crashed']),
  exitCode: z.int().nullable(),
});

export const AgentEvent = z.discriminatedUnion('type', [
  SessionStartedEvent,
  TurnStartedEvent,
  MessageChunkEvent,
  ToolStartedEvent,
  ToolFinishedEvent,
  ApprovalRequestedAgentEvent,
  UsageAgentEvent,
  TurnEndedEvent,
  AgentErrorEvent,
  SessionEndedEvent,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent['type'];

// ---------------------------------------------------------------------------
// Adapter and session
// ---------------------------------------------------------------------------

/** What an adapter can do. The daemon and UI hide or refuse what is missing. */
export interface AdapterCapabilities {
  /** Accepts {@link SpawnOptions.mcpServers}. Required to be an orchestrator (M1). */
  readonly mcp: boolean;
  /** Emits `approval.requested` and honors {@link Session.approve}. */
  readonly approvals: boolean;
  /** Honors {@link SpawnOptions.resumeId}. */
  readonly resume: boolean;
  /** Fills `usage.costUsd` with `costSource: 'reported'`. */
  readonly reportsCost: boolean;
  /** Honors {@link SpawnOptions.model}. */
  readonly modelSelection: boolean;
  /** {@link Session.interrupt} stops a turn without ending the session. */
  readonly interrupt: boolean;
  /** Modes {@link Adapter.spawn} accepts. */
  readonly permissionModes: readonly PermissionMode[];
  /**
   * How {@link SpawnOptions.policy} is enforced.
   *
   * - `hooks`: every tool call is checked against the policy before it runs,
   *   so allowed commands, the level gates and the always-ask rules apply
   *   exactly (Claude).
   * - `sandbox`: the agent's own sandbox keeps writes in `cwd` and the network
   *   off, and it asks for anything beyond that. Commands inside `cwd` may run
   *   without asking, whatever the policy says (Codex).
   * - `none`: neither; only `access` is honored.
   *
   * The board warns on cats whose adapter is not `hooks`.
   */
  readonly policyEnforcement: 'hooks' | 'sandbox' | 'none';
  /** {@link Adapter.complete} works. Without it, debriefs and consolidations are skipped. */
  readonly complete: boolean;
}

/** What the board shows about an adapter. */
export interface AdapterInfo {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
}

/** An MCP server the agent should connect to for this session only. */
export type McpServerSpec =
  | {
      readonly type: 'http';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    };

/**
 * What the agent may do, enforced by the adapter with the agent's own
 * permission mechanism. Agent-neutral on purpose.
 */
export interface AgentPolicy {
  /**
   * `read_only`: read and search only, plus the MCP tools in
   * {@link SpawnOptions.mcpServers}. No edits, no shell. Used for the
   * orchestrator. `workspace`: edit inside `cwd`, run commands subject to
   * approval. Used for workers.
   */
  readonly access: 'read_only' | 'workspace';
  /** Shell commands that run without asking, matched as a prefix (e.g. `npm test`). */
  readonly allowedCommands: readonly string[];
  /** Paths the agent must never write to, such as the main checkout. */
  readonly protectedPaths: readonly string[];
  /**
   * Paths outside `cwd` the agent may read and search without asking (still
   * never write). Omitted means none.
   */
  readonly readablePaths?: readonly string[];
}

/**
 * One prompt, one answer, no tools: used for debriefs and consolidations.
 * Runs through the same agent and login as the cats.
 */
export interface CompleteOptions {
  /** Working directory for the agent process. Nothing is read from it. */
  readonly cwd: string;
  /** `null` uses the agent's own default. */
  readonly model: string | null;
  /** Replaces the agent's system prompt entirely: there are no tools to describe. */
  readonly systemPrompt: string;
  readonly prompt: string;
  /** Default 120 s. */
  readonly timeoutMs?: number;
}

export interface Completion {
  readonly text: string;
  readonly usage: Usage;
}

export interface SpawnOptions {
  readonly catId: string;
  /** Working directory. The agent must not be granted writes outside it. */
  readonly cwd: string;
  /** `null` uses the agent's own default. */
  readonly model: string | null;
  /** Appended to the agent's own system prompt, never replacing it. `null` adds nothing. */
  readonly systemPrompt: string | null;
  readonly permissionMode: PermissionMode;
  /** Only these servers are loaded; the user's own MCP config is ignored. */
  readonly mcpServers?: Readonly<Record<string, McpServerSpec>>;
  /** Continue an earlier session, from its `session.started.resumeId`. */
  readonly resumeId?: string;
  /** Omitted means the agent's normal behavior under `permissionMode`. */
  readonly policy?: AgentPolicy;
  /**
   * Whether the agent may add its own attribution (for example a
   * `Co-Authored-By` trailer) to commits and pull requests. Omitted means the
   * agent's default.
   */
  readonly attribution?: boolean;
}

export interface Adapter {
  /** Stable id stored on the cat, e.g. `claude` or `mock`. */
  readonly id: string;
  /** Name shown on the board, e.g. "Claude". */
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  /** Model names for the hiring tiers; `null` uses the agent's default for that tier. */
  readonly modelTiers: Readonly<Record<ModelTier, string | null>>;
  /**
   * Expected cost of one interview candidate on a tier, in API-equivalent
   * dollars, for the estimate shown before an interview. `null` when the
   * adapter cannot know (it reports no cost).
   */
  estimateUsd(tier: ModelTier): number | null;

  /**
   * Start an agent session. Resolves once the agent process is running; the
   * first event on {@link Session.events} is then `session.started`.
   *
   * @throws AdapterError `spawn_failed` if the agent cannot start (for example
   *   its CLI is not installed), `unsupported` for a permission mode or option
   *   the capabilities do not cover.
   */
  spawn(options: SpawnOptions): Promise<Session>;

  /**
   * Answer one prompt without tools and without keeping a session.
   *
   * @throws AdapterError `spawn_failed` if the agent cannot start or does not
   *   answer in time.
   */
  complete(options: CompleteOptions): Promise<Completion>;
}

/**
 * One live agent session.
 *
 * Event stream guarantees, checked by the conformance suite in M4:
 * - `session.started` comes first and `session.ended` comes last, exactly once,
 *   including after {@link kill} or a crash. The iterable then completes.
 * - Every `turn.started` is matched by one `turn.ended`. Turns never overlap.
 * - Every `tool.started` is matched by one `tool.finished` with the same id
 *   before its turn ends.
 * - `usage` values never decrease.
 */
export interface Session {
  /** agentcats' id for this session. */
  readonly id: string;
  /**
   * OS process id of the agent's root process, so the daemon can record it
   * and kill the tree if the daemon itself dies. `null` for in-process agents.
   */
  readonly pid: number | null;

  /**
   * Start a turn with a user message. Resolves when the agent has accepted it,
   * not when the turn ends.
   *
   * @throws AdapterError `busy` if a turn is already running, `closed` after
   *   the session ended. The daemon decides whether to queue.
   */
  send(text: string): Promise<void>;

  /** The event stream. Call once; a second call throws. */
  events(): AsyncIterable<AgentEvent>;

  /**
   * Answer an `approval.requested`.
   *
   * @throws AdapterError `not_found` for an unknown or already answered
   *   `requestId`, `closed` after the session ended.
   */
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;

  /**
   * Stop the current turn. It ends with `stopReason: 'cancelled'` and the
   * session stays usable. Pending approvals are denied. No-op when idle.
   */
  interrupt(): Promise<void>;

  /**
   * Terminate the agent and its whole process tree. Resolves after the
   * processes have exited. Idempotent.
   */
  kill(): Promise<void>;
}

export type AdapterErrorCode = 'spawn_failed' | 'unsupported' | 'busy' | 'not_found' | 'closed';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';

  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export { checkSessionInvariants } from './session-invariants.js';
