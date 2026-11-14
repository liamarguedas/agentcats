import { describe, expect, it } from 'vitest';

import {
  AcceptedResponse,
  buildPath,
  catNames,
  ChatRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  ErrorResponse,
  ResolveApprovalRequest,
  ReviewTaskRequest,
  routes,
  Snapshot,
  UpdateCatRequest,
  usagePoints,
} from './commands.js';
import { PROTOCOL_VERSION } from './common.js';
import { sampleLog } from './fixtures.test-util.js';
import { applyEvent, emptyBoard } from './projection.js';

describe('command schemas', () => {
  it('takes a safe, trimmed cat name', () => {
    expect(UpdateCatRequest.parse({ name: '  Buff Cat ' })).toEqual({ name: 'Buff Cat' });
    expect(UpdateCatRequest.parse({ name: "Señor O'Malley-2" }).name).toBe("Señor O'Malley-2");
    for (const name of ['', '   ', '../x', 'a/b', 'cat.', '-cat', 'NUL', 'com1', 'x'.repeat(33)]) {
      expect(UpdateCatRequest.safeParse({ name }).success, name).toBe(false);
    }
  });

  it('accepts a task with only a title and defaults the description', () => {
    expect(CreateTaskRequest.parse({ title: 'Add hello' })).toEqual({
      title: 'Add hello',
      description: '',
    });
  });

  it('rejects an empty task title and unknown fields', () => {
    expect(CreateTaskRequest.safeParse({ title: '' }).success).toBe(false);
    expect(CreateTaskRequest.safeParse({ title: 'x', priority: 1 }).success).toBe(false);
  });

  it('validates a create-task response', () => {
    const task = {
      id: 'task-1',
      title: 'Add hello',
      description: '',
      status: 'queued',
      assigneeCatId: null,
      statusReason: null,
      reasonCode: null,
      attempt: 1,
      branch: null,
      worktreePath: null,
      result: null,
      summary: null,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(CreateTaskResponse.parse({ task })).toEqual({ task });
  });

  it('accepts allow and deny only', () => {
    expect(ResolveApprovalRequest.safeParse({ decision: 'allow' }).success).toBe(true);
    expect(ResolveApprovalRequest.safeParse({ decision: 'deny' }).success).toBe(true);
    expect(ResolveApprovalRequest.safeParse({ decision: 'allow_always' }).success).toBe(false);
  });

  it('accepts chat with and without a cat id, but not empty text', () => {
    expect(ChatRequest.safeParse({ text: 'hi' }).success).toBe(true);
    expect(ChatRequest.safeParse({ catId: 'cat-1', text: 'hi' }).success).toBe(true);
    expect(ChatRequest.safeParse({ text: '' }).success).toBe(false);
  });

  it('requires a cat edit to change something, and only known properties', () => {
    expect(UpdateCatRequest.safeParse({}).success).toBe(false);
    expect(UpdateCatRequest.safeParse({ budget: { maxUsd: 3, maxTokens: null } }).success).toBe(
      true,
    );
    expect(UpdateCatRequest.safeParse({ role: 'orchestrator' }).success).toBe(false);
  });

  it('accepts only accept or reject as a review decision', () => {
    expect(ReviewTaskRequest.safeParse({ decision: 'accept' }).success).toBe(true);
    expect(ReviewTaskRequest.safeParse({ decision: 'merge' }).success).toBe(false);
  });

  it('validates accepted and error responses', () => {
    expect(AcceptedResponse.safeParse({ accepted: true }).success).toBe(true);
    expect(
      ErrorResponse.safeParse({ error: { code: 'unauthorized', message: 'bad token' } }).success,
    ).toBe(true);
    expect(ErrorResponse.safeParse({ error: { code: 'teapot', message: '' } }).success).toBe(false);
  });

  it('validates a snapshot built from the sample log', () => {
    const snapshot = {
      protocolVersion: PROTOCOL_VERSION,
      board: sampleLog.reduce(applyEvent, emptyBoard()),
      events: sampleLog,
      adapters: [],
    };
    expect(Snapshot.parse(snapshot)).toEqual(snapshot);
  });
});

describe('routes', () => {
  it('exposes every command under /api', () => {
    expect(Object.values(routes).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/tasks',
      'POST /api/approvals/:approvalId',
      'POST /api/cats/:catId/kill',
      'PATCH /api/cats/:catId',
      'POST /api/cats/:catId/pause',
      'POST /api/cats/:catId/resume',
      'POST /api/cats/:catId/nudge',
      'POST /api/tasks/:taskId/review',
      'POST /api/tasks/:taskId/rerun',
      'POST /api/tasks/:taskId/cancel',
      'GET /api/tasks/:taskId/events',
      'POST /api/cats/:catId/learnings',
      'PATCH /api/cats/:catId/learnings/:learningId',
      'DELETE /api/cats/:catId/learnings/:learningId',
      'POST /api/cats/:catId/learnings/consolidate',
      'GET /api/cats/:catId/learnings/history',
      'POST /api/cats/:catId/learnings/restore',
      'POST /api/proposals/:proposalId',
      'GET /api/cats/:catId/retire-check',
      'POST /api/cats/:catId/retire',
      'POST /api/cats/:catId/retire/dismiss',
      'POST /api/retired/:catId/resurrect',
      'GET /api/interviews/samples',
      'POST /api/interviews',
      'POST /api/interviews/:interviewId/start',
      'POST /api/interviews/:interviewId/cancel',
      'POST /api/interviews/:interviewId/pick',
      'POST /api/chat',
      'GET /api/usage',
      'GET /api/sessions',
      'GET /api/sessions/:index/events',
      'GET /api/snapshot',
    ]);
  });

  it('fills and encodes path params', () => {
    expect(buildPath(routes.killCat.path, { catId: 'cat 1' })).toBe('/api/cats/cat%201/kill');
  });

  it('throws when a path param is missing', () => {
    expect(() => buildPath(routes.resolveApproval.path)).toThrow(/approvalId/);
  });
});

describe('usagePoints and catNames', () => {
  const usage = (seq: number, ts: number, catId: string, costUsd: number | null) =>
    ({
      id: `u${String(seq)}`,
      seq,
      ts,
      type: 'usage.updated',
      catId,
      payload: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        costUsd,
        costSource: 'reported',
        activeMs: seq * 1000,
      },
    }) as const;

  it('keeps each cat’s last point per minute, oldest first, without cache tokens', () => {
    const points = usagePoints([
      usage(1, 1_000, 'a', 0.1),
      usage(2, 30_000, 'a', 0.2),
      usage(3, 61_000, 'a', 0.3),
      usage(4, 2_000, 'b', null),
    ]);
    expect(points).toEqual([
      { ts: 2_000, catId: 'b', costUsd: null, activeMs: 4_000, tokens: 15 },
      { ts: 30_000, catId: 'a', costUsd: 0.2, activeMs: 2_000, tokens: 15 },
      { ts: 61_000, catId: 'a', costUsd: 0.3, activeMs: 3_000, tokens: 15 },
    ]);
  });

  it('names every created cat, by its latest name', () => {
    expect(catNames(sampleLog)).toMatchObject({ 'cat-1': 'Mochi' });
    const renamed = [
      ...sampleLog,
      {
        id: 'rename',
        seq: 1_000,
        ts: 1_000_000,
        type: 'cat.updated' as const,
        catId: 'cat-1',
        payload: { name: 'Grumpy' },
      },
    ];
    expect(catNames(renamed)).toMatchObject({ 'cat-1': 'Grumpy' });
  });
});
