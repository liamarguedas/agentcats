import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import {
  ACTIVE_TASK_STATUSES,
  type AgentcatsConfig,
  type ApprovalDecision,
  assertTransition,
  autonomousCommands,
  type Cat,
  type LearningsVersion,
  levelForXp,
  type PauseReason,
  readablePathsFor,
  RUNTIME_DIR_NAME,
  type Task,
  type TaskReasonCode,
  type TaskResult,
  type TaskStatus,
  type TransitionActor,
  type UpdateCatRequest,
} from '@agentcats/protocol';
import type { Adapter, SpawnOptions } from '@agentcats/protocol/adapter';

import { CatAgent, type CatAgentHooks, type TurnOutcome } from './cat-agent.js';
import { CatMemory } from './cat-memory.js';
import { ApiError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Logger } from './logger.js';
import { loadPrompt, Memory } from './memory.js';
import type { PidRegistry } from './pid-registry.js';
import { readProjectCommands } from './project.js';
import type { Store } from './store.js';
import type { WorktreeManager } from './worktrees.js';
import { medianCost, xpForVerdict } from './xp.js';

const ORCHESTRATOR_NAME = 'Tux';
const WORKER_NAMES = [
  'Mochi',
  'Miso',
  'Tofu',
  'Nori',
  'Pixel',
  'Biscuit',
  'Pepper',
  'Luna',
  'Ziggy',
  'Olive',
  'Peanut',
  'Sesame',
  'Ginger',
  'Pumpkin',
  'Toast',
  'Waffle',
];
/**
 * Commands every worker may run without asking: committing to its own branch
 * is part of the job. Every other git operation still asks (or, for push, is
 * blocked by the adapter's policy).
 */
const WORKER_GIT_COMMANDS = ['git add', 'git commit'];
const NUDGE_TEXT =
  'You have been quiet for a while. In one or two sentences, report where you are, then continue the task.';
const CONTINUE_TEXT = 'Continue the task where you left off.';
const WARN_RATIO = 0.8;
/** Agent errors that mean the user's plan or rate limit was hit. */
const USAGE_LIMIT = /rate.?limit|usage limit|session limit|hit your .{0,40}limit/i;

/** Task fields the manager sets besides `status` and `actor`. */
interface TaskFields {
  statusReason?: string | null;
  reasonCode?: TaskReasonCode | null;
  assigneeCatId?: string | null;
  attempt?: number;
  branch?: string | null;
  worktreePath?: string | null;
  result?: TaskResult | null;
  summary?: string | null;
}

/** Status reasons are short texts on the wire. */
function clipFields(fields: TaskFields): TaskFields {
  return typeof fields.statusReason === 'string'
    ? { ...fields, statusReason: fields.statusReason.slice(0, 500) }
    : fields;
}

/** Read `Tests: passed|failed|not run` from a worker's structured summary. */
export function testsFromSummary(text: string): TaskResult['tests'] {
  const match = /^[-*\s]*tests:\s*(passed|failed|not run)/im.exec(text);
  if (!match?.[1]) return 'unknown';
  return match[1].toLowerCase() === 'not run'
    ? 'not_run'
    : (match[1].toLowerCase() as 'passed' | 'failed');
}

export interface CatManagerOptions {
  readonly log: EventLog;
  readonly store: Store;
  readonly adapter: Adapter;
  readonly config: AgentcatsConfig;
  readonly projectPath: string;
  readonly pids: PidRegistry;
  readonly logger: Logger;
  readonly worktrees: WorktreeManager;
  /** URL of the daemon's MCP endpoint, known once the server listens. */
  readonly mcpUrl: () => string;
}

/**
 * Runs the team: one orchestrator and up to `workers.max` workers. Owns every
 * task decision (scheduling, worktrees, retry, stuck detection, budgets,
 * pause and resume, review) and enforces the task state machine on every
 * status change.
 */
export class CatManager {
  readonly #agents = new Map<string, CatAgent>();
  readonly #mcpTokens = new Map<string, string>();
  readonly #autoRetried = new Set<string>();
  readonly #starting = new Set<string>();
  readonly #stuckTimers = new Map<string, NodeJS.Timeout>();
  /** Workers whose activity resets (or clears) the stuck watchdog. */
  readonly #watching = new Set<string>();
  readonly #quiet = new Set<string>();
  readonly #warned = new Set<string>();
  readonly #baseCommits = new Map<string, string>();
  readonly #retryNotes = new Map<string, string>();
  /** The cat's total cost when a task first started, to get the task's own cost. */
  readonly #costBase = new Map<string, number | null>();
  #notifications: string[] = [];
  /** Work started from agent hooks; `close()` waits for it before the store closes. */
  readonly #background = new Set<Promise<unknown>>();
  #orchestratorId = '';
  #closed = false;
  readonly #prompts = { orchestrator: loadPrompt('orchestrator'), worker: loadPrompt('worker') };
  readonly #hooks: CatAgentHooks = {
    turnEnded: (agent, outcome) => {
      this.#onTurnEnded(agent, outcome);
    },
    sessionEnded: (agent, info) => {
      this.#onSessionEnded(agent, info);
    },
    activity: (agent) => {
      this.#onActivity(agent);
    },
    usage: (agent) => {
      this.#checkBudget(agent);
    },
  };

  readonly #memory: Memory;

  constructor(private readonly o: CatManagerOptions) {
    this.#memory = new Memory({
      log: o.log,
      adapter: o.adapter,
      config: o.config,
      projectPath: o.projectPath,
      files: new CatMemory(join(o.projectPath, RUNTIME_DIR_NAME)),
      logger: o.logger,
      chargeUsage: (catId, usage) => {
        this.#agents.get(catId)?.chargeUsage(usage);
      },
      track: (work) => {
        this.#track(work);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Start and stop
  // -------------------------------------------------------------------------

  /**
   * Restore cats from the event log, mark in-flight work `interrupted`, make
   * sure an orchestrator exists, and open the workers' folders.
   */
  async start(): Promise<void> {
    const { board } = this.o.log;
    for (const cat of Object.values(board.cats)) {
      this.#agents.set(cat.id, this.#newAgent(cat.id));
      if (cat.role === 'orchestrator') this.#orchestratorId = cat.id;
      if (cat.status !== 'idle') this.#agent(cat.id).setStatus('idle', 'daemon restarted');
    }
    for (const approval of Object.values(board.pendingApprovals)) {
      this.o.log.append({
        type: 'approval.resolved',
        catId: approval.catId,
        payload: { approvalId: approval.id, decision: 'deny', resolvedBy: 'session_ended' },
      });
    }
    for (const task of Object.values(board.tasks)) {
      if (ACTIVE_TASK_STATUSES.includes(task.status)) {
        this.#transition(task.id, 'interrupted', 'system', {
          reasonCode: 'daemon_restarted',
          statusReason: 'The daemon stopped while this task was in progress',
        });
      }
    }
    if (!this.#orchestratorId) this.#orchestratorId = this.#hire('orchestrator').catId;
    await this.#memory.start();
  }

  /**
   * End every session and wait for background work. Repeats until quiet: a
   * task that was already starting when `close()` began may still spawn a
   * session, which must not outlive the store.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#memory.close();
    for (const timer of this.#stuckTimers.values()) clearTimeout(timer);
    do {
      await Promise.all([...this.#agents.values()].map((agent) => agent.endSession()));
      while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
    } while ([...this.#agents.values()].some((agent) => agent.hasSession || agent.busy));
  }

  /** Run hook-triggered work in the background, tracked for `close()`. */
  #track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.o.logger.error(`Background task failed: ${errorMessage(error)}`);
    });
    this.#background.add(tracked);
    void tracked.finally(() => this.#background.delete(tracked));
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  get orchestratorId(): string {
    return this.#orchestratorId;
  }

  /** The cat a per-session MCP token belongs to. */
  catForMcpToken(token: string): string | null {
    return this.#mcpTokens.get(token) ?? null;
  }

  tasks(): Task[] {
    return Object.values(this.o.log.board.tasks).sort((a, b) => a.createdAt - b.createdAt);
  }

  task(taskId: string): Task {
    const task = this.o.log.board.tasks[taskId];
    if (!task) throw new ApiError('not_found', `No task ${taskId}`);
    return task;
  }

  cats(): Cat[] {
    return Object.values(this.o.log.board.cats).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The active task a worker is on, if any. */
  activeTaskOf(catId: string): Task | null {
    return (
      Object.values(this.o.log.board.tasks).find(
        (t) => t.assigneeCatId === catId && ['running', 'blocked'].includes(t.status),
      ) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Send a message, to the orchestrator unless `catId` names another cat.
   *
   * @throws ApiError `conflict` if the cat is busy, paused, or (a worker) has no session.
   */
  async chat(text: string, catId?: string): Promise<void> {
    const agent = this.#agent(catId ?? this.#orchestratorId);
    if (agent.cat.pausedReason) throw new ApiError('conflict', `${agent.cat.name} is paused`);
    if (agent.busy) throw new ApiError('conflict', `${agent.cat.name} is busy`);
    if (agent.cat.role === 'orchestrator' && !agent.hasSession) await this.#startOrchestrator();
    this.o.log.append({ type: 'message.user', catId: agent.catId, payload: { text } });
    await agent.send(text);
  }

  /**
   * Create a task and schedule it. Without `catId` any free worker takes it,
   * or a new one is hired up to the limit.
   */
  createTask(
    title: string,
    description: string,
    options: { catId?: string; actor: TransitionActor },
  ): Task {
    if (options.catId !== undefined && this.#agent(options.catId).cat.role !== 'worker') {
      throw new ApiError('bad_request', 'Tasks can only be assigned to workers');
    }
    const taskId = randomBytes(8).toString('hex');
    this.o.log.append({
      type: 'task.created',
      taskId,
      payload: { title, description, status: 'queued', assigneeCatId: options.catId ?? null },
    });
    this.#schedule();
    return this.task(taskId);
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const agent = [...this.#agents.values()].find((a) => a.hasApproval(approvalId));
    if (!agent) throw new ApiError('not_found', `No pending approval ${approvalId}`);
    await agent.resolveApproval(approvalId, decision, 'user');
  }

  /** Edit a cat's properties. Model and permission mode apply from its next session. */
  updateCat(catId: string, patch: UpdateCatRequest): Cat {
    this.#agent(catId);
    this.o.log.append({ type: 'cat.updated', catId, payload: patch });
    this.#warned.delete(catId);
    if (patch.model !== undefined) this.#track(this.#memory.writeProfile(catId));
    return this.#agent(catId).cat;
  }

  /**
   * Stop a cat. A worker's task becomes `failed` (re-runnable); the
   * orchestrator just loses its session.
   */
  async killCat(catId: string): Promise<void> {
    const agent = this.#agent(catId);
    const task = this.activeTaskOf(catId);
    this.#quiet.add(catId);
    try {
      await agent.endSession();
    } finally {
      this.#quiet.delete(catId);
    }
    this.#clearStuck(catId);
    if (task) {
      this.#transition(task.id, 'failed', 'user', {
        reasonCode: 'killed',
        statusReason: `Stopped by you`,
      });
      this.#notifyOrchestrator(`Task "${task.title}" (${task.id}) was stopped by the user.`);
    }
    agent.setStatus('idle', 'stopped');
    this.#schedule();
  }

  /** Pause a cat. Its turn is interrupted and its task waits as `blocked`. */
  async pauseCat(catId: string, reason: PauseReason = 'user', detail?: string): Promise<void> {
    const agent = this.#agent(catId);
    if (agent.cat.pausedReason) return;
    this.o.log.append({ type: 'cat.paused', catId, payload: { reason } });
    const task = this.activeTaskOf(catId);
    const statusReason =
      detail ?? (reason === 'budget' ? 'Budget reached; raise it and resume' : 'Paused by you');
    if (task) {
      const reasonCode: TaskReasonCode = reason === 'budget' ? 'budget' : 'paused';
      if (task.status === 'running') {
        this.#transition(task.id, 'blocked', reason === 'budget' ? 'system' : 'user', {
          reasonCode,
          statusReason,
        });
      } else {
        this.#update(task.id, { reasonCode, statusReason });
      }
    }
    this.#clearStuck(catId);
    this.#quiet.add(catId);
    try {
      await agent.interrupt();
    } finally {
      this.#quiet.delete(catId);
    }
    agent.setStatus('blocked', statusReason);
  }

  /**
   * Resume a paused cat and continue its task.
   *
   * @throws ApiError `conflict` if it is not paused, or still over budget.
   */
  async resumeCat(catId: string): Promise<void> {
    const agent = this.#agent(catId);
    const cat = agent.cat;
    if (!cat.pausedReason) throw new ApiError('conflict', `${cat.name} is not paused`);
    const over = this.#overBudget(cat);
    if (over)
      throw new ApiError(
        'conflict',
        `${cat.name} is still over budget (${over}). Raise the budget first.`,
      );
    this.#warned.delete(catId);
    this.o.log.append({ type: 'cat.resumed', catId, payload: {} });
    agent.setStatus('idle');
    const task = this.activeTaskOf(catId);
    if (task?.status === 'blocked') {
      this.#transition(task.id, 'running', 'user', { reasonCode: null, statusReason: null });
      await this.#continueTask(agent, this.task(task.id), CONTINUE_TEXT);
    }
    this.#schedule();
  }

  /**
   * Prompt a worker that seems stuck: interrupt its turn and ask for a
   * status report.
   *
   * @throws ApiError `conflict` if it has no active task or is paused.
   */
  async nudgeCat(catId: string, text?: string): Promise<void> {
    const agent = this.#agent(catId);
    if (agent.cat.pausedReason)
      throw new ApiError('conflict', `${agent.cat.name} is paused; resume it instead`);
    const task = this.activeTaskOf(catId);
    if (!task) throw new ApiError('conflict', `${agent.cat.name} has no task to nudge`);
    this.#quiet.add(catId);
    try {
      await agent.interrupt();
    } finally {
      this.#quiet.delete(catId);
    }
    // Re-read: the interrupt's own events may already have unblocked the task.
    const current = this.task(task.id);
    if (current.status === 'blocked') {
      this.#transition(task.id, 'running', 'user', { reasonCode: null, statusReason: null });
    }
    await this.#continueTask(agent, this.task(task.id), text ?? NUDGE_TEXT);
  }

  /**
   * The user's verdict on a result in review. Awards XP, which may change the
   * worker's level, then runs the debrief in the background.
   */
  async reviewTask(
    taskId: string,
    decision: 'accept' | 'reject',
    note: string | null = null,
  ): Promise<Task> {
    const task = this.task(taskId);
    const rejected = note ? `Rejected by you: ${note}` : 'Rejected by you';
    this.#transition(taskId, decision === 'accept' ? 'done' : 'rejected', 'user', {
      statusReason: decision === 'accept' ? 'Accepted by you' : rejected,
    });
    this.#costBase.delete(taskId);
    const leveledUp = this.#awardXp(task, decision);
    if (task.assigneeCatId) this.#track(this.#memory.writeStats(task.assigneeCatId));
    this.#memory.afterReview(this.task(taskId), { decision, note }, leveledUp);
    await this.#removeWorktree(task);
    const verdict = decision === 'accept' ? 'accepted' : 'rejected';
    this.#notifyOrchestrator(
      `The user ${verdict} task "${task.title}" (${task.id})${note ? `. Their note: ${note}` : ''}.`,
    );
    return this.task(taskId);
  }

  /** XP for a verdict, then the level that follows. Returns whether the cat leveled up. */
  #awardXp(task: Task, decision: 'accept' | 'reject'): boolean {
    const cat = task.assigneeCatId ? this.o.log.board.cats[task.assigneeCatId] : undefined;
    if (cat?.role !== 'worker') return false;
    const median = medianCost(this.tasks(), task.id);
    let xp = cat.xp;
    for (const award of xpForVerdict(decision, task, cat.xp, median, this.o.config.xp)) {
      xp = Math.max(0, xp + award.delta);
      this.o.log.append({
        type: 'xp.changed',
        catId: cat.id,
        taskId: task.id,
        payload: { delta: award.delta, reason: award.reason, xp },
      });
    }
    const level = levelForXp(xp);
    if (level === cat.level) return false;
    this.o.log.append({
      type: 'cat.level_changed',
      catId: cat.id,
      payload: { from: cat.level, to: level },
    });
    return level > cat.level;
  }

  /** Run a failed or interrupted task again. */
  rerunTask(taskId: string): Task {
    const task = this.task(taskId);
    this.#transition(taskId, 'queued', 'user', {
      attempt: task.attempt + 1,
      reasonCode: null,
      statusReason: 'Re-run by you',
    });
    this.#autoRetried.delete(taskId);
    this.#retryNotes.set(taskId, 'The user asked you to run this task again.');
    this.#schedule();
    return this.task(taskId);
  }

  async cancelTask(taskId: string, actor: TransitionActor): Promise<Task> {
    const task = this.task(taskId);
    assertTransitionOrConflict(task.status, 'cancelled', actor);
    const agent = task.assigneeCatId ? this.#agents.get(task.assigneeCatId) : undefined;
    if (agent?.taskId === taskId) {
      this.#quiet.add(agent.catId);
      try {
        await agent.endSession();
      } finally {
        this.#quiet.delete(agent.catId);
      }
      this.#clearStuck(agent.catId);
      agent.setStatus('idle');
    }
    this.#transition(taskId, 'cancelled', actor, {
      reasonCode: actor === 'orchestrator' ? 'cancelled_by_orchestrator' : 'cancelled_by_user',
      statusReason: actor === 'orchestrator' ? 'Cancelled by the orchestrator' : 'Cancelled by you',
    });
    await this.#removeWorktree(task);
    this.#schedule();
    return this.task(taskId);
  }

  // -------------------------------------------------------------------------
  // Learnings
  // -------------------------------------------------------------------------

  addLearning(catId: string, text: string): Promise<Cat> {
    return this.#memory.add(catId, text);
  }

  editLearning(catId: string, learningId: string, text: string): Promise<Cat> {
    return this.#memory.edit(catId, learningId, text);
  }

  deleteLearning(catId: string, learningId: string): Promise<Cat> {
    return this.#memory.delete(catId, learningId);
  }

  consolidateLearnings(catId: string): void {
    this.#memory.consolidateNow(catId);
  }

  learningsHistory(catId: string): Promise<LearningsVersion[]> {
    return this.#memory.history(catId);
  }

  restoreLearnings(catId: string, versionId: string): Promise<Cat> {
    return this.#memory.restore(catId, versionId);
  }

  resolveProposal(proposalId: string, decision: 'accept' | 'discard'): Promise<Cat> {
    return this.#memory.resolveProposal(proposalId, decision);
  }

  // -------------------------------------------------------------------------
  // Scheduling and task lifecycle
  // -------------------------------------------------------------------------

  #schedule(): void {
    if (this.#closed) return;
    for (const task of this.tasks()) {
      if (task.status !== 'queued' || this.#starting.has(task.id)) continue;
      const worker = this.#pickWorker(task);
      if (!worker) continue;
      this.#track(this.#startTask(task.id, worker));
    }
  }

  #isFree(agent: CatAgent): boolean {
    const cat = agent.cat;
    return (
      cat.role === 'worker' &&
      !cat.pausedReason &&
      !agent.busy &&
      !agent.hasSession &&
      this.activeTaskOf(agent.catId) === null &&
      ![...this.#starting].some((id) => this.o.log.board.tasks[id]?.assigneeCatId === agent.catId)
    );
  }

  #pickWorker(task: Task): CatAgent | null {
    if (task.assigneeCatId) {
      const assigned = this.#agents.get(task.assigneeCatId);
      return assigned && this.#isFree(assigned) ? assigned : null;
    }
    const workers = [...this.#agents.values()].filter((a) => a.cat.role === 'worker');
    const free = workers.find((a) => this.#isFree(a));
    if (free) return free;
    return workers.length < this.o.config.workers.max ? this.#hire('worker') : null;
  }

  async #startTask(taskId: string, worker: CatAgent): Promise<void> {
    this.#starting.add(taskId);
    this.#update(taskId, { assigneeCatId: worker.catId });
    try {
      const task = this.task(taskId);
      const branch = task.branch ?? this.o.worktrees.branchFor(worker.cat.name, taskId);
      const tree = await this.o.worktrees.ensure(taskId, branch);
      if (this.#closed) return;
      this.#baseCommits.set(taskId, tree.baseCommit);
      this.#transition(taskId, 'running', 'system', {
        branch,
        worktreePath: tree.path,
        reasonCode: null,
        statusReason: null,
      });
      const cat = worker.cat;
      if (!this.#costBase.has(taskId)) {
        this.#costBase.set(taskId, this.o.log.board.usage[cat.id]?.costUsd ?? 0);
      }
      const options: Omit<SpawnOptions, 'catId'> = {
        cwd: tree.path,
        model: cat.model,
        systemPrompt: await this.#workerPrompt(cat, task),
        permissionMode: cat.permissionMode,
        attribution: this.o.config.attribution,
        policy: await this.#workerPolicy(cat),
      };
      const resumeId = this.o.adapter.capabilities.resume ? this.o.store.resumeIdFor(taskId) : null;
      try {
        await worker.startSession(resumeId ? { ...options, resumeId } : options, taskId);
      } catch (error) {
        if (!resumeId) throw error;
        this.o.logger.warn(`Could not resume task ${taskId}, starting fresh: ${String(error)}`);
        await worker.startSession(options, taskId);
      }
      if (worker.resumeId) this.o.store.setResumeId(taskId, worker.resumeId);
      const note = this.#retryNotes.get(taskId);
      this.#retryNotes.delete(taskId);
      const prompt = [note, task.title, task.description].filter(Boolean).join('\n\n');
      await worker.send(prompt);
      this.#armStuck(worker);
    } catch (error) {
      this.#failure(
        taskId,
        worker,
        'spawn_failed',
        `Could not start the worker: ${errorMessage(error)}`,
      );
    } finally {
      this.#starting.delete(taskId);
    }
  }

  /** Continue a task on its worker, restarting the session (resumed) if it is gone. */
  async #continueTask(agent: CatAgent, task: Task, text: string): Promise<void> {
    if (agent.taskId === task.id && agent.hasSession) {
      await agent.send(text);
    } else {
      this.#retryNotes.set(task.id, text);
      this.#transition(task.id, 'queued', 'system', { statusReason: 'Restarting the worker' });
      this.#schedule();
      return;
    }
    this.#armStuck(agent);
  }

  async #completeTask(task: Task, worker: CatAgent, summary: string): Promise<void> {
    this.#clearStuck(worker.catId);
    const worktrees = this.o.worktrees;
    const branch = task.branch ?? '';
    let result: TaskResult | null = null;
    try {
      if (task.worktreePath && (await worktrees.isDirty(task.worktreePath))) {
        this.#notice(
          'warning',
          'uncommitted_work',
          `${worker.cat.name} left uncommitted changes in ${task.worktreePath}; they are not part of the result.`,
          { catId: worker.catId, taskId: task.id },
        );
      }
      const base = this.#baseCommits.get(task.id);
      const diffStat = base
        ? await worktrees.diffStat(branch, base)
        : { files: 0, insertions: 0, deletions: 0 };
      result = {
        summary: summary.trim().slice(0, 20_000),
        branch,
        diffStat,
        tests: testsFromSummary(summary),
        costUsd: this.#taskCost(task.id, worker.catId),
      };
    } catch (error) {
      this.o.logger.warn(`Could not read the result of task ${task.id}: ${errorMessage(error)}`);
    }
    this.#transition(task.id, 'review', 'system', {
      result,
      summary: summary.trim().slice(0, 500) || null,
      statusReason: 'Waiting for your review',
      reasonCode: null,
    });
    this.#quiet.add(worker.catId);
    try {
      await worker.endSession();
    } finally {
      this.#quiet.delete(worker.catId);
    }
    worker.setStatus('done');
    this.#track(this.#memory.writeStats(worker.catId));
    this.#notifyOrchestrator(
      `Task "${task.title}" (${task.id}) is ready for review on branch ${branch}. Use get_task_result for details.`,
    );
    this.#schedule();
  }

  /**
   * A worker crashed or its turn failed. Retry once automatically (resuming
   * the session), then mark the task `failed`.
   */
  #failure(taskId: string, worker: CatAgent, code: TaskReasonCode, message: string): void {
    this.#clearStuck(worker.catId);
    const task = this.o.log.board.tasks[taskId];
    if (!task || !['queued', 'running', 'blocked'].includes(task.status)) return;
    this.#track(
      (async () => {
        this.#quiet.add(worker.catId);
        try {
          await worker.endSession();
        } finally {
          this.#quiet.delete(worker.catId);
        }
        const current = this.task(taskId);
        // Retrying into a plan or rate limit only fails again: the user waits or raises it.
        const limited = USAGE_LIMIT.test(message);
        if (!limited && !this.#autoRetried.has(taskId) && current.status !== 'blocked') {
          this.#autoRetried.add(taskId);
          this.#retryNotes.set(
            taskId,
            `Your previous attempt at this task stopped unexpectedly (${message}). Check what is already done in this worktree, then continue.`,
          );
          if (current.status === 'running') {
            this.#transition(taskId, 'queued', 'system', {
              attempt: current.attempt + 1,
              reasonCode: code,
              statusReason: `Retrying after: ${message}`,
            });
          } else {
            this.#update(taskId, {
              attempt: current.attempt + 1,
              reasonCode: code,
              statusReason: `Retrying after: ${message}`,
            });
          }
        } else {
          this.#transition(taskId, 'failed', 'system', { reasonCode: code, statusReason: message });
          worker.setStatus('error', message);
          this.#notifyOrchestrator(`Task "${current.title}" (${taskId}) failed: ${message}`);
        }
        this.#schedule();
      })(),
    );
  }

  async #removeWorktree(task: Task): Promise<void> {
    if (!task.worktreePath) return;
    try {
      const removed = await this.o.worktrees.remove(task.worktreePath);
      if (!removed) {
        this.#notice(
          'warning',
          'uncommitted_work',
          `Kept the worktree ${task.worktreePath} because it has uncommitted changes.`,
          { taskId: task.id },
        );
      }
    } catch (error) {
      this.o.logger.warn(`Could not remove worktree ${task.worktreePath}: ${errorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Agent hooks
  // -------------------------------------------------------------------------

  #onTurnEnded(agent: CatAgent, outcome: TurnOutcome): void {
    if (agent.catId === this.#orchestratorId) {
      agent.setStatus('idle');
      this.#flushNotifications();
      return;
    }
    // A fatal error means the session is ending: handled as a crash in #onSessionEnded.
    if (this.#quiet.has(agent.catId) || agent.cat.pausedReason || outcome.fatal) return;
    const task = outcome.taskId ? this.o.log.board.tasks[outcome.taskId] : undefined;
    if (!task || !['running', 'blocked'].includes(task.status)) return;
    switch (outcome.stopReason) {
      case 'end_turn':
        this.#track(this.#completeTask(task, agent, outcome.text));
        return;
      case 'cancelled':
        return;
      case 'error':
      case 'refusal':
      case 'max_tokens':
      case 'max_turns':
        this.#failure(
          task.id,
          agent,
          'agent_error',
          outcome.lastError ?? `Turn ended: ${outcome.stopReason}`,
        );
        return;
    }
  }

  #onSessionEnded(
    agent: CatAgent,
    info: {
      reason: 'exited' | 'killed' | 'crashed';
      exitCode: number | null;
      taskId: string | null;
      expected: boolean;
    },
  ): void {
    if (agent.catId === this.#orchestratorId) {
      for (const [token, catId] of this.#mcpTokens) {
        if (catId === agent.catId) this.#mcpTokens.delete(token);
      }
      return;
    }
    if (info.expected || this.#quiet.has(agent.catId) || !info.taskId) return;
    const task = this.o.log.board.tasks[info.taskId];
    if (!task || !['running', 'blocked'].includes(task.status)) return;
    const code = info.exitCode === null ? '' : ` (exit ${String(info.exitCode)})`;
    this.#failure(task.id, agent, 'crashed', `The agent process stopped${code}`);
  }

  #onActivity(agent: CatAgent): void {
    const task = agent.taskId ? this.o.log.board.tasks[agent.taskId] : undefined;
    if (!task) return;
    if (task.status === 'blocked' && task.reasonCode === 'stuck') {
      this.#transition(task.id, 'running', 'system', { reasonCode: null, statusReason: null });
      this.#notice('info', 'unstuck', `${agent.cat.name} is active again`, {
        catId: agent.catId,
        taskId: task.id,
      });
    }
    if (this.#watching.has(agent.catId)) this.#armStuck(agent);
  }

  // -------------------------------------------------------------------------
  // Stuck watchdog
  // -------------------------------------------------------------------------

  #armStuck(agent: CatAgent): void {
    this.#clearStuck(agent.catId);
    if (this.#closed) return;
    this.#watching.add(agent.catId);
    const timer = setTimeout(() => {
      this.#stuckTimers.delete(agent.catId);
      if (this.#closed) return;
      const task = this.activeTaskOf(agent.catId);
      if (!task || task.status !== 'running' || agent.cat.pausedReason) return;
      if (agent.cat.status === 'waiting_approval') {
        this.#armStuck(agent); // waiting on you is not being stuck
        return;
      }
      const minutes = Math.max(1, Math.round(this.o.config.stuckTimeoutMs / 60_000));
      this.#transition(task.id, 'blocked', 'system', {
        reasonCode: 'stuck',
        statusReason: `No activity for ${String(minutes)} min`,
      });
      agent.setStatus('blocked', 'Stuck: no activity. Nudge or stop it.');
      this.#notice(
        'warning',
        'stuck',
        `${agent.cat.name} has been quiet for ${String(minutes)} min on "${task.title}"`,
        {
          catId: agent.catId,
          taskId: task.id,
        },
      );
      // Still watching: the next activity moves the task back to running.
    }, this.o.config.stuckTimeoutMs);
    timer.unref();
    this.#stuckTimers.set(agent.catId, timer);
  }

  #clearStuck(catId: string): void {
    clearTimeout(this.#stuckTimers.get(catId));
    this.#stuckTimers.delete(catId);
    this.#watching.delete(catId);
  }

  // -------------------------------------------------------------------------
  // Budgets
  // -------------------------------------------------------------------------

  #enforced(cat: Cat): boolean {
    const mode = this.o.config.budget.enforce;
    return mode === 'always' || (mode === 'metered' && cat.billing === 'metered');
  }

  /** Why a cat is over its own or the global budget, or `null`. */
  #overBudget(cat: Cat): string | null {
    if (!this.#enforced(cat)) return null;
    const usage = this.o.log.board.usage[cat.id];
    const spent = usage?.costUsd ?? 0;
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    if (cat.budget.maxUsd !== null && spent >= cat.budget.maxUsd) {
      return `$${spent.toFixed(2)} of $${cat.budget.maxUsd.toFixed(2)}`;
    }
    if (cat.budget.maxTokens !== null && tokens >= cat.budget.maxTokens) {
      return `${String(tokens)} of ${String(cat.budget.maxTokens)} tokens`;
    }
    const globalUsd = this.o.config.budget.globalUsd;
    const total = this.#globalSpent();
    if (globalUsd !== null && total >= globalUsd)
      return `team total $${total.toFixed(2)} of $${globalUsd.toFixed(2)}`;
    return null;
  }

  #globalSpent(): number {
    return this.cats()
      .filter((c) => this.#enforced(c))
      .reduce((sum, c) => sum + (this.o.log.board.usage[c.id]?.costUsd ?? 0), 0);
  }

  #checkBudget(agent: CatAgent): void {
    const cat = agent.cat;
    if (!this.#enforced(cat) || cat.pausedReason) return;
    const over = this.#overBudget(cat);
    if (over) {
      this.#notice(
        'warning',
        'budget_reached',
        `${cat.name} reached its budget (${over}) and is paused`,
        {
          catId: cat.id,
        },
      );
      this.#track(
        this.pauseCat(cat.id, 'budget', `Budget reached (${over}). Raise it and resume.`),
      );
      const globalUsd = this.o.config.budget.globalUsd;
      if (globalUsd !== null && this.#globalSpent() >= globalUsd) {
        for (const other of this.cats()) {
          if (
            other.id !== cat.id &&
            this.#enforced(other) &&
            !other.pausedReason &&
            this.#agents.get(other.id)?.busy
          ) {
            this.#track(
              this.pauseCat(other.id, 'budget', 'Team budget reached. Raise it and resume.'),
            );
          }
        }
      }
      return;
    }
    const usage = this.o.log.board.usage[cat.id];
    const spent = usage?.costUsd ?? 0;
    if (
      cat.budget.maxUsd !== null &&
      spent >= WARN_RATIO * cat.budget.maxUsd &&
      !this.#warned.has(cat.id)
    ) {
      this.#warned.add(cat.id);
      this.#notice(
        'warning',
        'budget_warning',
        `${cat.name} has used ${String(Math.round((100 * spent) / cat.budget.maxUsd))}% of its $${cat.budget.maxUsd.toFixed(2)} budget`,
        { catId: cat.id },
      );
    }
    const globalUsd = this.o.config.budget.globalUsd;
    if (
      globalUsd !== null &&
      this.#globalSpent() >= WARN_RATIO * globalUsd &&
      !this.#warned.has('global')
    ) {
      this.#warned.add('global');
      this.#notice(
        'warning',
        'budget_warning',
        `The team has used 80% of its $${globalUsd.toFixed(2)} budget`,
        {},
      );
    }
  }

  // -------------------------------------------------------------------------
  // Orchestrator
  // -------------------------------------------------------------------------

  async #startOrchestrator(): Promise<void> {
    const agent = this.#agent(this.#orchestratorId);
    const token = randomBytes(32).toString('base64url');
    this.#mcpTokens.set(token, agent.catId);
    const cat = agent.cat;
    await agent.startSession(
      {
        cwd: this.o.projectPath,
        model: cat.model,
        systemPrompt: this.#prompts.orchestrator,
        permissionMode: 'ask',
        mcpServers: {
          agentcats: {
            type: 'http',
            url: this.o.mcpUrl(),
            headers: { Authorization: `Bearer ${token}` },
          },
        },
        attribution: this.o.config.attribution,
        policy: { access: 'read_only', allowedCommands: [], protectedPaths: [this.o.projectPath] },
      },
      null,
    );
  }

  /** Tell the orchestrator about a task change, now if it is idle, else after its turn. */
  #notifyOrchestrator(text: string): void {
    const agent = this.#agents.get(this.#orchestratorId);
    if (!agent?.hasSession) return; // nobody to tell: the user has not talked to it yet
    this.#notifications.push(text);
    if (!agent.busy && !agent.cat.pausedReason) this.#flushNotifications();
  }

  #flushNotifications(): void {
    const agent = this.#agents.get(this.#orchestratorId);
    if (
      !agent?.hasSession ||
      agent.busy ||
      this.#notifications.length === 0 ||
      agent.cat.pausedReason
    )
      return;
    const text = this.#notifications.map((n) => `[agentcats] ${n}`).join('\n');
    this.#notifications = [];
    this.#track(
      agent.send(text).catch((error: unknown) => {
        this.o.logger.warn(`Could not notify the orchestrator: ${errorMessage(error)}`);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  #newAgent(catId: string): CatAgent {
    return new CatAgent(
      {
        log: this.o.log,
        adapter: this.o.adapter,
        pids: this.o.pids,
        logger: this.o.logger,
        approvalTimeoutMs: this.o.config.approvalTimeoutMs,
        hooks: this.#hooks,
      },
      catId,
    );
  }

  #hire(role: 'orchestrator' | 'worker'): CatAgent {
    const { config } = this.o;
    const taken = new Set(this.cats().map((c) => c.name));
    const name =
      role === 'orchestrator'
        ? ORCHESTRATOR_NAME
        : (WORKER_NAMES.find((n) => !taken.has(n)) ?? `Cat ${String(taken.size + 1)}`);
    const catId = randomBytes(8).toString('hex');
    this.o.log.append({
      type: 'cat.created',
      catId,
      payload: {
        name,
        role,
        adapter: this.o.adapter.id,
        model: role === 'orchestrator' ? config.orchestrator.model : config.workers.model,
        permissionMode: role === 'orchestrator' ? 'ask' : config.workers.permissionMode,
        budget: { maxUsd: config.budget.perCatUsd, maxTokens: config.budget.perCatTokens },
      },
    });
    const agent = this.#newAgent(catId);
    this.#agents.set(catId, agent);
    if (role === 'worker') this.#track(this.#memory.hired(catId));
    return agent;
  }

  /** The worker prompt for one task: its learnings (as many as its level loads) and persona. */
  async #workerPrompt(cat: Cat, task: Task): Promise<string> {
    const { learnings, persona } = await this.#memory.forPrompt(cat.id, task);
    return this.#prompts.worker
      .replaceAll('{{name}}', cat.name)
      .replace('{{learnings}}', learnings)
      .replace('{{persona}}', persona ? `\n## Your persona\n\n${persona}\n` : '');
  }

  /**
   * What a worker may do without asking: commit, the configured commands,
   * and what its level unlocks (`levels.ts` in the protocol).
   */
  async #workerPolicy(cat: Cat): Promise<NonNullable<SpawnOptions['policy']>> {
    const project = await readProjectCommands(this.o.projectPath);
    return {
      access: 'workspace',
      allowedCommands: [
        ...WORKER_GIT_COMMANDS,
        ...this.o.config.workers.allowedCommands,
        ...autonomousCommands(cat.level, project),
      ],
      protectedPaths: [this.o.projectPath],
      readablePaths: readablePathsFor(cat.level, this.o.projectPath),
    };
  }

  /** What a task cost: the cat's spending since the task first started. */
  #taskCost(taskId: string, catId: string): number | null {
    const base = this.#costBase.get(taskId);
    const now = this.o.log.board.usage[catId]?.costUsd;
    if (base === undefined || base === null || now === undefined || now === null) return null;
    return Math.max(0, now - base);
  }

  #agent(catId: string): CatAgent {
    const agent = this.#agents.get(catId);
    if (!agent) throw new ApiError('not_found', `No cat ${catId}`);
    return agent;
  }

  #notice(
    level: 'info' | 'warning',
    code: string,
    message: string,
    scope: { catId?: string; taskId?: string },
  ): void {
    this.o.log.append({
      type: 'notice',
      ...scope,
      payload: { level, code, message: message.slice(0, 500) },
    });
  }

  /** Change a task's status, enforcing the state machine. */
  #transition(
    taskId: string,
    to: TaskStatus,
    actor: TransitionActor,
    fields: TaskFields = {},
  ): void {
    const task = this.task(taskId);
    assertTransitionOrConflict(task.status, to, actor);
    this.o.log.append({
      type: 'task.updated',
      taskId,
      payload: { status: to, actor, ...clipFields(fields) },
    });
  }

  /** Change task fields without changing its status. */
  #update(taskId: string, fields: TaskFields): void {
    if (Object.keys(fields).length === 0) return;
    this.o.log.append({ type: 'task.updated', taskId, payload: clipFields(fields) });
  }
}

function assertTransitionOrConflict(
  from: TaskStatus,
  to: TaskStatus,
  actor: TransitionActor,
): void {
  try {
    assertTransition(from, to, actor);
  } catch (error) {
    throw new ApiError('conflict', (error as Error).message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
