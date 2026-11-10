import { z } from 'zod';

import {
  CatStatus,
  Id,
  PermissionMode,
  ShortText,
  TaskStatus,
  Timestamp,
  ToolKind,
} from './common.js';

export const Cat = z.strictObject({
  id: Id,
  name: z.string().min(1).max(64),
  /** Adapter id, for example `claude` or `mock`. */
  adapter: z.string().min(1).max(64),
  /** `null` means the agent's own default model. */
  model: z.string().min(1).nullable(),
  permissionMode: PermissionMode,
  status: CatStatus,
  /** Why the cat entered its current status, if there is something to say. */
  statusReason: ShortText.nullable(),
  createdAt: Timestamp,
});
export type Cat = z.infer<typeof Cat>;

export const Task = z.strictObject({
  id: Id,
  title: z.string().min(1).max(200),
  description: z.string().max(20_000),
  status: TaskStatus,
  assigneeCatId: Id.nullable(),
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
