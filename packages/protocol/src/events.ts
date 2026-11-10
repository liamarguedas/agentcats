import { z } from 'zod';

import {
  ApprovalDecision,
  CatStatus,
  Id,
  MessageChannel,
  PermissionMode,
  ShortText,
  TaskStatus,
  Timestamp,
  ToolCallStatus,
  ToolKind,
  Usage,
} from './common.js';

/**
 * Fields every event carries. `seq` starts at 1 and increases by exactly 1 per
 * event, so a client that sees `seq !== lastSeq + 1` knows it missed events and
 * must refetch the snapshot.
 */
const envelope = {
  id: Id,
  seq: z.int().positive(),
  ts: Timestamp,
  catId: Id.optional(),
  taskId: Id.optional(),
};

/** Events about one cat carry its `catId` in the envelope. */
const catScoped = { ...envelope, catId: Id };
/** Events about one task carry its `taskId` in the envelope. */
const taskScoped = { ...envelope, taskId: Id };

export const CatCreatedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.created'),
  payload: z.strictObject({
    name: z.string().min(1).max(64),
    adapter: z.string().min(1).max(64),
    model: z.string().min(1).nullable(),
    permissionMode: PermissionMode,
  }),
});

export const CatStatusChangedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.status_changed'),
  payload: z.strictObject({
    status: CatStatus,
    reason: ShortText.nullable(),
  }),
});

export const TaskCreatedEvent = z.strictObject({
  ...taskScoped,
  type: z.literal('task.created'),
  payload: z.strictObject({
    title: z.string().min(1).max(200),
    description: z.string().max(20_000),
    status: TaskStatus,
    assigneeCatId: Id.nullable(),
  }),
});

export const TaskUpdatedEvent = z.strictObject({
  ...taskScoped,
  type: z.literal('task.updated'),
  payload: z
    .strictObject({
      status: TaskStatus.optional(),
      assigneeCatId: Id.nullable().optional(),
      summary: z.string().max(20_000).nullable().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, 'task.updated must change at least one field'),
});

/**
 * One tool call. Emitted with `status: 'running'` when the call starts and
 * again with the same `toolCallId` and a final status when it finishes.
 */
export const ToolCalledEvent = z.strictObject({
  ...catScoped,
  type: z.literal('tool.called'),
  payload: z.strictObject({
    toolCallId: Id,
    toolName: z.string().min(1).max(200),
    kind: ToolKind,
    inputSummary: ShortText,
    status: ToolCallStatus,
  }),
});

export const ApprovalRequestedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('approval.requested'),
  payload: z.strictObject({
    approvalId: Id,
    toolCallId: Id.nullable(),
    toolName: z.string().min(1).max(200),
    kind: ToolKind,
    inputSummary: ShortText,
  }),
});

export const ApprovalResolvedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('approval.resolved'),
  payload: z.strictObject({
    approvalId: Id,
    decision: ApprovalDecision,
    /** `session_ended` means the agent went away before anyone decided. */
    resolvedBy: z.enum(['user', 'timeout', 'session_ended']),
  }),
});

/** A chunk of agent output. Chunks with the same `messageId` concatenate in `seq` order. */
export const MessageAgentEvent = z.strictObject({
  ...catScoped,
  type: z.literal('message.agent'),
  payload: z.strictObject({
    messageId: Id,
    channel: MessageChannel,
    text: z.string().max(100_000),
  }),
});

/** Cumulative usage for the cat's current session. */
export const UsageUpdatedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('usage.updated'),
  payload: Usage,
});

export const DaemonErrorEvent = z.strictObject({
  ...envelope,
  type: z.literal('daemon.error'),
  payload: z.strictObject({
    code: z.string().min(1).max(64),
    message: ShortText,
  }),
});

/** Every event the daemon can send, discriminated by `type`. */
export const AgentcatsEvent = z.discriminatedUnion('type', [
  CatCreatedEvent,
  CatStatusChangedEvent,
  TaskCreatedEvent,
  TaskUpdatedEvent,
  ToolCalledEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  MessageAgentEvent,
  UsageUpdatedEvent,
  DaemonErrorEvent,
]);
export type AgentcatsEvent = z.infer<typeof AgentcatsEvent>;

export type EventType = AgentcatsEvent['type'];
export type EventOfType<T extends EventType> = Extract<AgentcatsEvent, { type: T }>;
export type EventPayload<T extends EventType> = EventOfType<T>['payload'];

export const EVENT_TYPES = AgentcatsEvent.options.map(
  (o) => o.shape.type.value,
) as readonly EventType[];
