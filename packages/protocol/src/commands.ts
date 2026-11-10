import { z } from 'zod';

import { ApprovalDecision, Id } from './common.js';
import { Task } from './entities.js';
import { AgentcatsEvent } from './events.js';
import { BoardState } from './projection.js';
import { API_PREFIX } from './transport.js';

/** How many recent events `GET /api/snapshot` returns. */
export const SNAPSHOT_EVENT_LIMIT = 500;

export const CreateTaskRequest = z.strictObject({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(''),
  /** Cat to assign. Optional while there is only one cat. */
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
  /** Cat to talk to. Optional while there is only one cat. */
  catId: Id.optional(),
  text: z.string().min(1).max(20_000),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

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
  readonly method: 'GET' | 'POST';
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
