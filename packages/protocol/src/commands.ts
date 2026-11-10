import { z } from 'zod';

import { ApprovalDecision, Budget, Id, PermissionMode } from './common.js';
import { Cat, Task } from './entities.js';
import { AgentcatsEvent } from './events.js';
import { BoardState } from './projection.js';
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
export const ReviewTaskRequest = z.strictObject({ decision: z.enum(['accept', 'reject']) });
export type ReviewTaskRequest = z.infer<typeof ReviewTaskRequest>;

export const TaskResponse = z.strictObject({ task: Task });
export type TaskResponse = z.infer<typeof TaskResponse>;

/** Every stored event about one task, oldest first, for the task drawer. */
export const TaskEventsResponse = z.strictObject({ events: z.array(AgentcatsEvent) });
export type TaskEventsResponse = z.infer<typeof TaskEventsResponse>;

/** Response for commands whose effect shows up later as events. */
export const AcceptedResponse = z.strictObject({ accepted: z.literal(true) });
export type AcceptedResponse = z.infer<typeof AcceptedResponse>;

export const Snapshot = z.strictObject({
  protocolVersion: z.int().positive(),
  board: BoardState,
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
  readonly method: 'GET' | 'POST' | 'PATCH';
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
  chat: {
    method: 'POST',
    path: `${API_PREFIX}/chat`,
    body: ChatRequest,
    response: AcceptedResponse,
    successStatus: 202,
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
