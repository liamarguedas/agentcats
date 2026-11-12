import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Task } from '@agentcats/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { CatManager } from './cat-manager.js';
import { ApiError } from './errors.js';

/** Path of the MCP endpoint on the daemon's server. */
export const MCP_PATH = '/mcp';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
  isError: true,
});

/** Run a tool body, turning daemon errors into MCP tool errors the agent can read. */
async function guard(body: () => unknown): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (error) {
    if (error instanceof ApiError) return fail(error.message);
    throw error;
  }
}

const taskView = (task: Task) => ({
  id: task.id,
  title: task.title,
  status: task.status,
  reason: task.statusReason,
  assignee: task.assigneeCatId,
  attempt: task.attempt,
  branch: task.branch,
});

/** The orchestrator's tools, bound to the manager. */
function buildServer(manager: CatManager): McpServer {
  const server = new McpServer({ name: 'agentcats', version: '0.0.0' });

  server.registerTool(
    'list_cats',
    { description: 'List the cats on the team, their role, status and current task.' },
    () =>
      guard(() => ({
        cats: manager.cats().map((cat) => ({
          id: cat.id,
          name: cat.name,
          role: cat.role,
          status: cat.status,
          paused: cat.pausedReason !== null,
          current_task_id: manager.activeTaskOf(cat.id)?.id ?? null,
        })),
      })),
  );

  server.registerTool(
    'list_tasks',
    { description: 'List all tasks with their status, assignee and branch.' },
    () => guard(() => ({ tasks: manager.tasks().map(taskView) })),
  );

  server.registerTool(
    'assign_task',
    {
      description:
        'Create a task for a worker. A free worker picks it up, or a new worker is hired up to the limit. Each worker works alone on its own git branch.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short imperative title'),
        description: z
          .string()
          .max(20_000)
          .describe(
            'Everything the worker needs: what to change, where, how to verify, which test command to run',
          ),
        cat: z
          .string()
          .optional()
          .describe('Id of a specific worker, from list_cats. Usually leave empty.'),
      },
    },
    ({ title, description, cat }) =>
      guard(() => {
        const task = manager.createTask(title, description, {
          actor: 'orchestrator',
          ...(cat !== undefined && { catId: cat }),
        });
        return { task_id: task.id, status: task.status };
      }),
  );

  server.registerTool(
    'get_task_status',
    {
      description: 'Status of one task.',
      inputSchema: { task_id: z.string() },
    },
    ({ task_id }) => guard(() => taskView(manager.task(task_id))),
  );

  server.registerTool(
    'get_task_result',
    {
      description:
        "A task's result once it is in review: branch, diff stat, the worker's test outcome and summary.",
      inputSchema: { task_id: z.string() },
    },
    ({ task_id }) =>
      guard(() => {
        const task = manager.task(task_id);
        if (!task.result) {
          throw new ApiError('conflict', `Task ${task_id} is ${task.status}; it has no result yet`);
        }
        return { ...task.result, status: task.status };
      }),
  );

  server.registerTool(
    'cancel_task',
    {
      description: 'Cancel a task that is no longer needed. Its worker stops.',
      inputSchema: { task_id: z.string() },
    },
    ({ task_id }) =>
      guard(async () => {
        const task = await manager.cancelTask(task_id, 'orchestrator');
        return { task_id: task.id, status: task.status };
      }),
  );

  server.registerTool(
    'retire_cat',
    {
      description:
        'Suggest retiring a worker cat, for example one whose work keeps getting rejected. The user confirms or dismisses it on the board; nothing happens before that.',
      inputSchema: { cat: z.string().describe('The cat name or id'), reason: z.string().min(1) },
    },
    ({ cat, reason }) =>
      guard(() => {
        const found = manager
          .cats()
          .find((c) => c.id === cat || c.name.toLowerCase() === cat.toLowerCase());
        if (!found) throw new ApiError('not_found', `No cat named ${cat}`);
        manager.proposeRetire(found.id, reason);
        return { proposed: true, cat: found.name, note: 'The user will confirm or dismiss this.' };
      }),
  );

  server.registerTool(
    'list_interview_samples',
    { description: 'List the sample tasks a hiring interview can use.' },
    () => guard(() => manager.interviewSamples()),
  );

  server.registerTool(
    'propose_hire',
    {
      description:
        'Suggest hiring a new worker through an interview: candidates do the same sample task and are scored. The user sees the cost estimate and starts it; nothing runs before that.',
      inputSchema: {
        role: z.string().min(1).describe('What the new cat is for, in a sentence or two'),
        tier: z.enum(['fast', 'balanced', 'best']).optional(),
        sample: z.string().optional().describe('A sample id from list_interview_samples'),
        candidates: z.number().int().min(1).max(3).optional(),
      },
    },
    ({ role, tier, sample, candidates }) =>
      guard(async () => {
        const sampleId = sample ?? (await manager.interviewSamples())[0]?.id;
        if (!sampleId) throw new ApiError('not_found', 'There are no interview samples');
        const interview = await manager.proposeInterview(
          { description: role, tier: tier ?? 'balanced', learnings: [] },
          sampleId,
          candidates,
          'orchestrator',
        );
        return {
          interview_id: interview.id,
          estimate_usd: interview.estimateUsd,
          note: 'The user will see the estimate and start or cancel the interview.',
        };
      }),
  );

  return server;
}

/**
 * Handle one MCP request (Streamable HTTP, stateless: no session id and a
 * fresh server per request). Authentication is done by the caller.
 */
export async function handleMcpRequest(
  manager: CatManager,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const server = buildServer(manager);
  const transport = new StreamableHTTPServerTransport({});
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
