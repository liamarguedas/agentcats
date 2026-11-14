import { z } from 'zod';

import { ApprovalDecision, Budget, Id, LearningText, PermissionMode, Timestamp } from './common.js';
import { Cat, LearningDraft, Task } from './entities.js';
import { HireRole, Interview, InterviewSample } from './hiring.js';
import { AgentcatsEvent } from './events.js';
import { BoardState } from './projection.js';
import { SessionSummary } from './session.js';
import { API_PREFIX } from './transport.js';

/** How many recent events `GET /api/snapshot` returns. */
export const SNAPSHOT_EVENT_LIMIT = 500;

/**
 * Assign a task straight to a worker, bypassing the orchestrator. Without
 * `catId`, the daemon picks an idle worker or hires a new one up to the limit.
 */
export const CreateTaskRequest = z.strictObject({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(''),
  catId: Id.optional(),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequest>;

export const CreateTaskResponse = z.strictObject({ task: Task });
export type CreateTaskResponse = z.infer<typeof CreateTaskResponse>;

export const ResolveApprovalRequest = z.strictObject({ decision: ApprovalDecision });
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

export const ResolveApprovalResponse = z.strictObject({
  approvalId: Id,
  decision: ApprovalDecision,
});
export type ResolveApprovalResponse = z.infer<typeof ResolveApprovalResponse>;

export const ChatRequest = z.strictObject({
  /** Cat to talk to. Defaults to the orchestrator. */
  catId: Id.optional(),
  text: z.string().min(1).max(20_000),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Edit a cat's properties on the board. Takes effect from its next session. */
export const UpdateCatRequest = z
  .strictObject({
    /** Applies from the cat's next session. */
    adapter: z.string().min(1).max(64).optional(),
    model: z.string().min(1).nullable().optional(),
    permissionMode: PermissionMode.optional(),
    budget: Budget.optional(),
  })
  .refine((p) => Object.keys(p).length > 0, 'Change at least one property');
export type UpdateCatRequest = z.infer<typeof UpdateCatRequest>;

export const CatResponse = z.strictObject({ cat: Cat });
export type CatResponse = z.infer<typeof CatResponse>;

/** Poke a blocked worker. Without `text` the daemon sends a standard "report your status". */
export const NudgeRequest = z.strictObject({ text: z.string().min(1).max(20_000).optional() });
export type NudgeRequest = z.infer<typeof NudgeRequest>;

/** The user's verdict on a worker result in `review`. */
export const ReviewTaskRequest = z.strictObject({
  decision: z.enum(['accept', 'reject']),
  /**
   * Why the result was rejected (or anything worth remembering about it). A
   * rejection only turns into a learning when the user wrote a note.
   */
  note: z.string().trim().max(2_000).optional(),
});
export type ReviewTaskRequest = z.infer<typeof ReviewTaskRequest>;

export const TaskResponse = z.strictObject({ task: Task });
export type TaskResponse = z.infer<typeof TaskResponse>;

/** Add a line to a cat's learnings, or replace one line's text. */
export const LearningTextRequest = z.strictObject({ text: LearningText });
export type LearningTextRequest = z.infer<typeof LearningTextRequest>;

export const ResolveProposalRequest = z.strictObject({ decision: z.enum(['accept', 'discard']) });
export type ResolveProposalRequest = z.infer<typeof ResolveProposalRequest>;

/** A saved copy of a cat's learnings file, from before a consolidation or restore. */
export const LearningsVersion = z.strictObject({
  /** File name in the cat's `history/` folder. */
  id: z.string().min(1).max(200),
  createdAt: Timestamp,
  lines: z.array(LearningDraft).max(500),
});
export type LearningsVersion = z.infer<typeof LearningsVersion>;

export const LearningsHistoryResponse = z.strictObject({
  versions: z.array(LearningsVersion),
});
export type LearningsHistoryResponse = z.infer<typeof LearningsHistoryResponse>;

export const RestoreLearningsRequest = z.strictObject({ versionId: z.string().min(1).max(200) });
export type RestoreLearningsRequest = z.infer<typeof RestoreLearningsRequest>;

/** Retire a cat. With an open task the user chooses to cancel it now or retire after it. */
export const RetireCatRequest = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  openTask: z.enum(['cancel', 'after_task']).default('cancel'),
});
export type RetireCatRequest = z.input<typeof RetireCatRequest>;

export const RetireCatResponse = z.strictObject({
  /** `false` when the cat retires later, after its task. */
  retired: z.boolean(),
});
export type RetireCatResponse = z.infer<typeof RetireCatResponse>;

/** What retiring a cat would leave behind, for the confirmation dialog. */
export const RetireCheckResponse = z.strictObject({
  /** The task it is working on, if any. */
  openTask: Task.nullable(),
  /** Worktrees of its tasks that have uncommitted changes; they are kept, not deleted. */
  uncommittedWork: z.array(z.string()),
});
export type RetireCheckResponse = z.infer<typeof RetireCheckResponse>;

export const InterviewSamplesResponse = z.strictObject({ samples: z.array(InterviewSample) });
export type InterviewSamplesResponse = z.infer<typeof InterviewSamplesResponse>;

/** Plan an interview. It waits as `proposed`, with its estimate, until the user starts it. */
export const ProposeInterviewRequest = z.strictObject({
  role: HireRole,
  sampleId: z.string().min(1).max(200),
  candidates: z.int().min(1).max(3).optional(),
  /**
   * Adapter per candidate, in order, to compare agents on the same task.
   * Missing entries use the workers' adapter.
   */
  adapters: z.array(z.string().min(1).max(64)).max(3).optional(),
});
export type ProposeInterviewRequest = z.input<typeof ProposeInterviewRequest>;

export const InterviewResponse = z.strictObject({ interview: Interview });
export type InterviewResponse = z.infer<typeof InterviewResponse>;

export const PickCandidateRequest = z.strictObject({ catId: Id });
export type PickCandidateRequest = z.infer<typeof PickCandidateRequest>;

/** Every stored event about one task, oldest first, for the task drawer. */
export const TaskEventsResponse = z.strictObject({ events: z.array(AgentcatsEvent) });
export type TaskEventsResponse = z.infer<typeof TaskEventsResponse>;

/** A cat's cumulative usage at one moment, from a `usage.updated` event. */
export const UsagePoint = z.strictObject({
  ts: Timestamp,
  catId: Id,
  /** `null` when the cat's agent reports no cost. */
  costUsd: z.number().nonnegative().nullable(),
  activeMs: z.int().nonnegative(),
  tokens: z.int().nonnegative(),
});
export type UsagePoint = z.infer<typeof UsagePoint>;

/** Spending over time, for the cost meter. */
export const UsageResponse = z.strictObject({
  /** Oldest first; at most one point per cat per minute, plus each cat's latest. */
  points: z.array(UsagePoint),
  /** The team budget (`budget.globalUsd`), `null` for none. */
  globalBudgetUsd: z.number().positive().nullable(),
  /** Every cat's name, including candidates no longer on the board. */
  names: z.record(Id, z.string()),
});
export type UsageResponse = z.infer<typeof UsageResponse>;

/** Every session in the log, oldest first, for replay. */
export const SessionsResponse = z.strictObject({ sessions: z.array(SessionSummary) });
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/**
 * Every stored event of one session, for replay and export. The paths let
 * the UI hide them in an export (`prepareExport`).
 */
export const SessionEventsResponse = z.strictObject({
  /** The board when the session started. */
  initialBoard: BoardState,
  events: z.array(AgentcatsEvent),
  projectPath: z.string().min(1),
  homeDir: z.string().min(1),
});
export type SessionEventsResponse = z.infer<typeof SessionEventsResponse>;

/** Response for commands whose effect shows up later as events. */
export const AcceptedResponse = z.strictObject({ accepted: z.literal(true) });
export type AcceptedResponse = z.infer<typeof AcceptedResponse>;

/** An adapter as the board needs it: its name, and what it can and cannot do. */
export const AdapterInfo = z.strictObject({
  id: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  capabilities: z.strictObject({
    mcp: z.boolean(),
    approvals: z.boolean(),
    resume: z.boolean(),
    reportsCost: z.boolean(),
    modelSelection: z.boolean(),
    interrupt: z.boolean(),
    permissionModes: z.array(PermissionMode),
    policyEnforcement: z.enum(['hooks', 'sandbox', 'none']),
    complete: z.boolean(),
  }),
});
export type AdapterInfo = z.infer<typeof AdapterInfo>;

export const Snapshot = z.strictObject({
  protocolVersion: z.int().positive(),
  board: BoardState,
  /** The adapters this daemon can run cats on. */
  adapters: z.array(AdapterInfo),
  /** The most recent events, oldest first, at most {@link SNAPSHOT_EVENT_LIMIT}. */
  events: z.array(AgentcatsEvent),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Body of every non-2xx response. */
export const ErrorResponse = z.strictObject({
  error: z.strictObject({ code: ErrorCode, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

export interface RouteSpec {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Full path including {@link API_PREFIX}; `:name` segments are path params. */
  readonly path: string;
  readonly body: z.ZodType | null;
  readonly response: z.ZodType;
  readonly successStatus: 200 | 201 | 202;
}

/**
 * Every REST command. Both the daemon router and the UI client are built from
 * this table, so a path or schema can only change in one place.
 */
export const routes = {
  createTask: {
    method: 'POST',
    path: `${API_PREFIX}/tasks`,
    body: CreateTaskRequest,
    response: CreateTaskResponse,
    successStatus: 201,
  },
  resolveApproval: {
    method: 'POST',
    path: `${API_PREFIX}/approvals/:approvalId`,
    body: ResolveApprovalRequest,
    response: ResolveApprovalResponse,
    successStatus: 200,
  },
  killCat: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/kill`,
    body: null,
    response: AcceptedResponse,
    successStatus: 202,
  },
  updateCat: {
    method: 'PATCH',
    path: `${API_PREFIX}/cats/:catId`,
    body: UpdateCatRequest,
    response: CatResponse,
    successStatus: 200,
  },
  pauseCat: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/pause`,
    body: null,
    response: AcceptedResponse,
    successStatus: 202,
  },
  resumeCat: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/resume`,
    body: null,
    response: AcceptedResponse,
    successStatus: 202,
  },
  nudgeCat: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/nudge`,
    body: NudgeRequest,
    response: AcceptedResponse,
    successStatus: 202,
  },
  reviewTask: {
    method: 'POST',
    path: `${API_PREFIX}/tasks/:taskId/review`,
    body: ReviewTaskRequest,
    response: TaskResponse,
    successStatus: 200,
  },
  rerunTask: {
    method: 'POST',
    path: `${API_PREFIX}/tasks/:taskId/rerun`,
    body: null,
    response: TaskResponse,
    successStatus: 200,
  },
  cancelTask: {
    method: 'POST',
    path: `${API_PREFIX}/tasks/:taskId/cancel`,
    body: null,
    response: TaskResponse,
    successStatus: 200,
  },
  taskEvents: {
    method: 'GET',
    path: `${API_PREFIX}/tasks/:taskId/events`,
    body: null,
    response: TaskEventsResponse,
    successStatus: 200,
  },
  addLearning: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/learnings`,
    body: LearningTextRequest,
    response: CatResponse,
    successStatus: 200,
  },
  editLearning: {
    method: 'PATCH',
    path: `${API_PREFIX}/cats/:catId/learnings/:learningId`,
    body: LearningTextRequest,
    response: CatResponse,
    successStatus: 200,
  },
  deleteLearning: {
    method: 'DELETE',
    path: `${API_PREFIX}/cats/:catId/learnings/:learningId`,
    body: null,
    response: CatResponse,
    successStatus: 200,
  },
  consolidateLearnings: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/learnings/consolidate`,
    body: null,
    response: AcceptedResponse,
    successStatus: 202,
  },
  learningsHistory: {
    method: 'GET',
    path: `${API_PREFIX}/cats/:catId/learnings/history`,
    body: null,
    response: LearningsHistoryResponse,
    successStatus: 200,
  },
  restoreLearnings: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/learnings/restore`,
    body: RestoreLearningsRequest,
    response: CatResponse,
    successStatus: 200,
  },
  resolveProposal: {
    method: 'POST',
    path: `${API_PREFIX}/proposals/:proposalId`,
    body: ResolveProposalRequest,
    response: CatResponse,
    successStatus: 200,
  },
  retireCheck: {
    method: 'GET',
    path: `${API_PREFIX}/cats/:catId/retire-check`,
    body: null,
    response: RetireCheckResponse,
    successStatus: 200,
  },
  retireCat: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/retire`,
    body: RetireCatRequest,
    response: RetireCatResponse,
    successStatus: 200,
  },
  dismissRetire: {
    method: 'POST',
    path: `${API_PREFIX}/cats/:catId/retire/dismiss`,
    body: null,
    response: AcceptedResponse,
    successStatus: 202,
  },
  resurrectCat: {
    method: 'POST',
    path: `${API_PREFIX}/retired/:catId/resurrect`,
    body: null,
    response: CatResponse,
    successStatus: 200,
  },
  interviewSamples: {
    method: 'GET',
    path: `${API_PREFIX}/interviews/samples`,
    body: null,
    response: InterviewSamplesResponse,
    successStatus: 200,
  },
  proposeInterview: {
    method: 'POST',
    path: `${API_PREFIX}/interviews`,
    body: ProposeInterviewRequest,
    response: InterviewResponse,
    successStatus: 201,
  },
  startInterview: {
    method: 'POST',
    path: `${API_PREFIX}/interviews/:interviewId/start`,
    body: null,
    response: InterviewResponse,
    successStatus: 200,
  },
  cancelInterview: {
    method: 'POST',
    path: `${API_PREFIX}/interviews/:interviewId/cancel`,
    body: null,
    response: InterviewResponse,
    successStatus: 200,
  },
  pickCandidate: {
    method: 'POST',
    path: `${API_PREFIX}/interviews/:interviewId/pick`,
    body: PickCandidateRequest,
    response: InterviewResponse,
    successStatus: 200,
  },
  chat: {
    method: 'POST',
    path: `${API_PREFIX}/chat`,
    body: ChatRequest,
    response: AcceptedResponse,
    successStatus: 202,
  },
  usage: {
    method: 'GET',
    path: `${API_PREFIX}/usage`,
    body: null,
    response: UsageResponse,
    successStatus: 200,
  },
  sessions: {
    method: 'GET',
    path: `${API_PREFIX}/sessions`,
    body: null,
    response: SessionsResponse,
    successStatus: 200,
  },
  sessionEvents: {
    method: 'GET',
    path: `${API_PREFIX}/sessions/:index/events`,
    body: null,
    response: SessionEventsResponse,
    successStatus: 200,
  },
  snapshot: {
    method: 'GET',
    path: `${API_PREFIX}/snapshot`,
    body: null,
    response: Snapshot,
    successStatus: 200,
  },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof routes;

/**
 * Fill `:name` segments of a route path. Values are URI-encoded.
 *
 * @throws Error if a param in the path has no value.
 */
export function buildPath(path: string, params: Readonly<Record<string, string>> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Missing path param "${name}" for ${path}`);
    return encodeURIComponent(value);
  });
}

/** Usage over time: the last point of each cat in each minute, so a long log stays small. */
export function usagePoints(events: readonly AgentcatsEvent[]): UsagePoint[] {
  const byBucket = new Map<string, UsagePoint>();
  for (const event of events) {
    if (event.type !== 'usage.updated') continue;
    const u = event.payload;
    byBucket.set(`${event.catId}:${String(Math.floor(event.ts / 60_000))}`, {
      ts: event.ts,
      catId: event.catId,
      costUsd: u.costUsd,
      activeMs: u.activeMs,
      // As on the cat card: cache reads and writes are not counted.
      tokens: u.inputTokens + u.outputTokens,
    });
  }
  return [...byBucket.values()].sort((a, b) => a.ts - b.ts);
}

/** Every cat's name from its `cat.created` event, so cats gone from the board keep theirs. */
export function catNames(events: readonly AgentcatsEvent[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const event of events) {
    if (event.type === 'cat.created') names[event.catId] = event.payload.name;
  }
  return names;
}
