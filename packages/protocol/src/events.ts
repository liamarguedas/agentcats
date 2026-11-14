import { z } from 'zod';

import {
  ApprovalDecision,
  Billing,
  Budget,
  CatRole,
  CatStatus,
  Id,
  LearningsChangeReason,
  MessageChannel,
  PauseReason,
  PermissionMode,
  ProposalTrigger,
  ShortText,
  TaskReasonCode,
  TaskStatus,
  Timestamp,
  ToolCallStatus,
  ToolKind,
  Usage,
  XpReason,
} from './common.js';
import { Learning, LearningDraft, TaskResult } from './entities.js';
import { CandidateResult, CandidateScore, HireRole, InterviewSample } from './hiring.js';
import { TransitionActor } from './task-machine.js';

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
    role: CatRole,
    adapter: z.string().min(1).max(64),
    model: z.string().min(1).nullable(),
    permissionMode: PermissionMode,
    budget: Budget,
  }),
});

/** A cat's properties changed: edited by the user, or billing learned at session start. */
export const CatUpdatedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.updated'),
  payload: z
    .strictObject({
      adapter: z.string().min(1).max(64).optional(),
      model: z.string().min(1).nullable().optional(),
      permissionMode: PermissionMode.optional(),
      budget: Budget.optional(),
      billing: Billing.optional(),
    })
    .refine((p) => Object.keys(p).length > 0, 'cat.updated must change at least one field'),
});

export const CatPausedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.paused'),
  payload: z.strictObject({ reason: PauseReason }),
});

export const CatResumedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.resumed'),
  payload: z.strictObject({}),
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
      /** Who asked for a status change; kept for the history drawer and M2 XP. */
      actor: TransitionActor.optional(),
      statusReason: ShortText.nullable().optional(),
      reasonCode: TaskReasonCode.nullable().optional(),
      assigneeCatId: Id.nullable().optional(),
      attempt: z.int().positive().optional(),
      branch: z.string().min(1).max(250).nullable().optional(),
      worktreePath: z.string().min(1).nullable().optional(),
      result: TaskResult.nullable().optional(),
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

/** Something the user said to a cat in the chat panel. */
export const MessageUserEvent = z.strictObject({
  ...catScoped,
  type: z.literal('message.user'),
  payload: z.strictObject({ text: z.string().min(1).max(20_000) }),
});

/** Cumulative usage of the cat, across all its sessions. */
export const UsageUpdatedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('usage.updated'),
  payload: Usage,
});

/** A worker earned or lost XP. `xp` is the new total, so replaying is idempotent. */
export const XpChangedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('xp.changed'),
  payload: z.strictObject({
    delta: z.int(),
    reason: XpReason,
    xp: z.int().nonnegative(),
  }),
});

/** A cat moved up or down a level. What each level allows is in `levels.ts`. */
export const CatLevelChangedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.level_changed'),
  payload: z.strictObject({
    from: z.int().positive(),
    to: z.int().positive(),
  }),
});

/**
 * The cat's `learnings.md` changed. Carries the whole new content (the file
 * is small and capped), so the log keeps the history of every version.
 * `backup` names the copy in the cat's `history/` folder that undoes it.
 */
export const LearningsChangedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('learnings.changed'),
  payload: z.strictObject({
    learnings: z.array(Learning).max(500),
    reason: LearningsChangeReason,
    backup: z.string().min(1).max(200).nullable(),
  }),
});

/** A debrief or consolidation suggested learnings; nothing is written until the user accepts. */
export const LearningsProposedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('learnings.proposed'),
  payload: z.strictObject({
    proposalId: Id,
    kind: z.enum(['add', 'rewrite']),
    trigger: ProposalTrigger,
    lines: z.array(LearningDraft).max(500),
    /** For a rewrite, the ids of the learnings it was made from; empty for an add. */
    base: z.array(Id).max(500).default([]),
  }),
});

export const LearningsProposalResolvedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('learnings.proposal_resolved'),
  payload: z.strictObject({
    proposalId: Id,
    /** `superseded`: a newer rewrite replaced it, or the cat is gone. */
    decision: z.enum(['accepted', 'discarded', 'superseded']),
    /** `auto`: accepted by the `memory.autoAcceptAfter` setting. */
    resolvedBy: z.enum(['user', 'auto', 'system']),
  }),
});

/** The lead suggests retiring a cat. Nothing happens until the user confirms. */
export const CatRetireProposedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.retire_proposed'),
  payload: z.strictObject({ reason: ShortText }),
});

export const CatRetireDismissedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.retire_dismissed'),
  payload: z.strictObject({}),
});

/** The cat left the board; its folder moved to `.agentcats/retired/<archive>`. */
export const CatRetiredEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.retired'),
  payload: z.strictObject({
    reason: ShortText,
    archive: z.string().min(1).max(200),
  }),
});

/** A retired cat is back, with its learnings, XP and level; `name` may differ if its old one was taken. */
export const CatResurrectedEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.resurrected'),
  payload: z.strictObject({ name: z.string().min(1).max(64) }),
});

/** A candidate won its interview and is now a worker. */
export const CatHiredEvent = z.strictObject({
  ...catScoped,
  type: z.literal('cat.hired'),
  payload: z.strictObject({ interviewId: Id }),
});

/** An interview waiting for the user to confirm its estimate. */
export const InterviewProposedEvent = z.strictObject({
  ...envelope,
  type: z.literal('interview.proposed'),
  payload: z.strictObject({
    interviewId: Id,
    role: HireRole,
    sample: InterviewSample,
    candidateCount: z.int().min(1).max(3),
    estimateUsd: z.number().nonnegative().nullable(),
    candidateAdapters: z.array(z.string().min(1).max(64)).max(3).default([]),
    proposedBy: z.enum(['user', 'orchestrator']),
  }),
});

/** The user confirmed; the candidates (already created as cats) start. */
export const InterviewStartedEvent = z.strictObject({
  ...envelope,
  type: z.literal('interview.started'),
  payload: z.strictObject({
    interviewId: Id,
    candidateCatIds: z.array(Id).min(1).max(3),
  }),
});

/**
 * A candidate's measured result. `score` is `null` until every candidate is
 * done, because parts of it are relative to the others; then each candidate
 * is scored again with its final score.
 */
export const InterviewCandidateScoredEvent = z.strictObject({
  ...catScoped,
  type: z.literal('interview.candidate_scored'),
  payload: z.strictObject({
    interviewId: Id,
    result: CandidateResult,
    score: CandidateScore.nullable(),
  }),
});

/** The interview is over: a winner was hired, or it was cancelled. Losing candidates leave the board. */
export const InterviewCompletedEvent = z.strictObject({
  ...envelope,
  type: z.literal('interview.completed'),
  payload: z.strictObject({
    interviewId: Id,
    winnerCatId: Id.nullable(),
    outcome: z.enum(['hired', 'cancelled']),
  }),
});

export const DaemonErrorEvent = z.strictObject({
  ...envelope,
  type: z.literal('daemon.error'),
  payload: z.strictObject({
    code: z.string().min(1).max(64),
    message: ShortText,
  }),
});

/** The daemon started: the boundary between two sessions, for replay. */
export const DaemonStartedEvent = z.strictObject({
  ...envelope,
  type: z.literal('daemon.started'),
  payload: z.strictObject({
    /** agentcats version, `dev` when run from sources. */
    version: z.string().min(1).max(64),
  }),
});

/**
 * Something the user should see that is not an error of the daemon itself:
 * a budget warning, a worktree with uncommitted work, an untested agent version.
 */
export const NoticeEvent = z.strictObject({
  ...envelope,
  type: z.literal('notice'),
  payload: z.strictObject({
    level: z.enum(['info', 'warning']),
    code: z.string().min(1).max(64),
    message: ShortText,
  }),
});

/** Every event the daemon can send, discriminated by `type`. */
export const AgentcatsEvent = z.discriminatedUnion('type', [
  CatCreatedEvent,
  CatUpdatedEvent,
  CatPausedEvent,
  CatResumedEvent,
  CatStatusChangedEvent,
  TaskCreatedEvent,
  TaskUpdatedEvent,
  ToolCalledEvent,
  ApprovalRequestedEvent,
  ApprovalResolvedEvent,
  MessageAgentEvent,
  MessageUserEvent,
  UsageUpdatedEvent,
  XpChangedEvent,
  CatLevelChangedEvent,
  LearningsChangedEvent,
  LearningsProposedEvent,
  LearningsProposalResolvedEvent,
  CatRetireProposedEvent,
  CatRetireDismissedEvent,
  CatRetiredEvent,
  CatResurrectedEvent,
  CatHiredEvent,
  InterviewProposedEvent,
  InterviewStartedEvent,
  InterviewCandidateScoredEvent,
  InterviewCompletedEvent,
  NoticeEvent,
  DaemonErrorEvent,
  DaemonStartedEvent,
]);
export type AgentcatsEvent = z.infer<typeof AgentcatsEvent>;

export type EventType = AgentcatsEvent['type'];
export type EventOfType<T extends EventType> = Extract<AgentcatsEvent, { type: T }>;
export type EventPayload<T extends EventType> = EventOfType<T>['payload'];

export const EVENT_TYPES = AgentcatsEvent.options.map(
  (o) => o.shape.type.value,
) as readonly EventType[];
