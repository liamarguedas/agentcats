import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type AgentcatsConfig,
  type CandidateResult,
  type Cat,
  type HireRole,
  type Interview,
  type ModelTier,
  RUNTIME_DIR_NAME,
} from '@agentcats/protocol';
import type { Adapter, AgentPolicy } from '@agentcats/protocol/adapter';

import type { CatAgent, TurnOutcome } from './cat-agent.js';
import { ApiError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Logger } from './logger.js';
import { readProjectCommands } from './project.js';
import { runCommand } from './run-command.js';
import { listSamples, overlay, prepareFixtureRepo, type SampleSpec, workDiff } from './samples.js';
import { scoreCandidates } from './scoring.js';
import type { WorktreeManager } from './worktrees.js';

/** What one candidate is expected to cost when there is no history for the sample and tier. */
export const DEFAULT_CANDIDATE_USD: Readonly<Record<ModelTier, number>> = {
  fast: 0.05,
  balanced: 0.25,
  best: 1.25,
};

/** What the interviews need from the rest of the daemon. */
export interface InterviewHost {
  readonly log: EventLog;
  readonly adapter: Adapter;
  readonly config: AgentcatsConfig;
  readonly projectPath: string;
  readonly worktrees: WorktreeManager;
  readonly logger: Logger;
  /** Add a candidate cat to the board with a fresh name, and return its agent. */
  hireCandidate(model: string | null): CatAgent;
  /** A candidate's agent, if it still has one. */
  agentFor(catId: string): CatAgent | null;
  /** Forget a candidate's agent after it left the board. */
  dropAgent(catId: string): void;
  /** The worker prompt for a candidate, with the role as its persona. */
  candidatePrompt(cat: Cat, role: HireRole): string;
  /** A new worker's policy (level 1). */
  candidatePolicy(): Promise<AgentPolicy>;
  /** How many workers are on the team now. */
  workerCount(): number;
  /** Give a hired candidate its folder, persona and starting learnings. */
  onHired(catId: string, role: HireRole): Promise<void>;
  /** Whether dollar budgets are enforced for this team. */
  budgetEnforced(): boolean;
  track(work: Promise<unknown>): void;
  notice(level: 'info' | 'warning', code: string, message: string, scope: { catId?: string }): void;
}

interface Workspace {
  readonly interviewId: string;
  readonly dir: string;
  readonly base: string;
  /** Set for worktrees of the project; `null` for fixture copies. */
  readonly branch: string | null;
  readonly startedAt: number;
  finished: boolean;
  timer: NodeJS.Timeout | null;
}

/**
 * Hiring interviews. An interview is proposed with a cost estimate, started
 * once the user confirms, runs 1 to 3 candidates on the same sample task in
 * their own throwaway repos, measures and scores their work itself, and ends
 * when the user picks a winner (who becomes a worker) or cancels. Losing
 * candidates leave the board and their repos are deleted.
 */
export class Interviews {
  readonly #workspaces = new Map<string, Workspace>();
  readonly #samples = new Map<string, SampleSpec>();
  #closed = false;

  constructor(private readonly h: InterviewHost) {}

  /** Cancel interviews that were running when the daemon stopped. */
  start(): void {
    for (const interview of Object.values(this.h.log.board.interviews)) {
      if (interview.status === 'running') {
        this.h.notice(
          'warning',
          'interview_interrupted',
          `The interview for "${short(interview.role.description)}" stopped with the daemon and was cancelled.`,
          {},
        );
        this.#complete(interview, null);
        this.h.track(this.#cleanup(interview, null));
      }
    }
  }

  close(): void {
    this.#closed = true;
    for (const workspace of this.#workspaces.values())
      if (workspace.timer) clearTimeout(workspace.timer);
  }

  async samples(): Promise<SampleSpec[]> {
    const projectCheck =
      this.h.config.interviews.projectCheck ?? (await this.#projectTestCommand());
    const samples = await listSamples(
      join(this.h.projectPath, RUNTIME_DIR_NAME, 'interviews'),
      Object.values(this.h.log.board.tasks),
      projectCheck,
    );
    for (const sample of samples) this.#samples.set(sample.id, sample);
    return samples;
  }

  /**
   * Plan an interview and estimate its cost. Nothing runs until {@link begin}.
   *
   * @throws ApiError `not_found` for an unknown sample, `conflict` if the
   *   sample has no check, the team is full, or the estimate is over budget.
   */
  async propose(
    role: HireRole,
    sampleId: string,
    candidateCount: number | undefined,
    proposedBy: 'user' | 'orchestrator',
  ): Promise<Interview> {
    const sample = (await this.samples()).find((s) => s.id === sampleId);
    if (!sample) throw new ApiError('not_found', `No interview sample ${sampleId}`);
    if (!sample.check) {
      throw new ApiError(
        'conflict',
        `"${sample.title}" has no check command, so candidates cannot be scored. Set interviews.projectCheck in the config.`,
      );
    }
    this.#assertRoom();
    const count = candidateCount ?? this.h.config.interviews.candidates;
    const estimateUsd = round(count * this.#perCandidateEstimate(sample.id, role.tier));
    const budget = this.h.config.interviews.budgetUsd;
    if (budget !== null && this.h.budgetEnforced() && estimateUsd > budget) {
      throw new ApiError(
        'conflict',
        `The estimate ($${estimateUsd.toFixed(2)}) is over the interview budget ($${budget.toFixed(2)}). Use fewer candidates or a cheaper tier, or raise interviews.budgetUsd.`,
      );
    }
    const interviewId = randomBytes(8).toString('hex');
    this.h.log.append({
      type: 'interview.proposed',
      payload: {
        interviewId,
        role,
        sample: { id: sample.id, title: sample.title, repo: sample.repo, source: sample.source },
        candidateCount: count,
        estimateUsd,
        proposedBy,
      },
    });
    return this.interview(interviewId);
  }

  /**
   * Start a proposed interview: hire the candidates, give each its own repo,
   * and send them the task.
   */
  async begin(interviewId: string): Promise<Interview> {
    const interview = this.interview(interviewId);
    if (interview.status !== 'proposed') {
      throw new ApiError('conflict', `The interview is ${interview.status}, not waiting to start`);
    }
    this.#assertRoom();
    const sample =
      this.#samples.get(interview.sample.id) ??
      (await this.samples()).find((s) => s.id === interview.sample.id);
    if (!sample) throw new ApiError('not_found', `The sample ${interview.sample.id} is gone`);
    const model = this.h.adapter.modelTiers[interview.role.tier];
    const agents = Array.from({ length: interview.candidateCount }, () =>
      this.h.hireCandidate(model),
    );
    this.h.log.append({
      type: 'interview.started',
      payload: { interviewId, candidateCatIds: agents.map((a) => a.catId) },
    });
    // One after another, so candidates start in hiring order; each start is a quick repo copy.
    this.h.track(
      (async () => {
        for (const agent of agents) await this.#run(interview, sample, agent);
      })(),
    );
    return this.interview(interviewId);
  }

  async #run(interview: Interview, sample: SampleSpec, agent: CatAgent): Promise<void> {
    const startedAt = Date.now();
    let workspace: Workspace;
    try {
      workspace = await this.#prepare(interview, sample, agent.cat, startedAt);
      if (this.#closed) return;
      await agent.startSession(
        {
          cwd: workspace.dir,
          model: agent.cat.model,
          systemPrompt: this.h.candidatePrompt(agent.cat, interview.role),
          permissionMode: this.h.config.workers.permissionMode,
          attribution: this.h.config.attribution,
          policy: await this.h.candidatePolicy(),
        },
        null,
      );
      workspace.timer = setTimeout(() => {
        void this.#finish(
          agent,
          `Did not finish within ${String(Math.round(this.h.config.interviews.candidateTimeoutMs / 60_000))} min`,
        );
      }, this.h.config.interviews.candidateTimeoutMs);
      workspace.timer.unref();
      await agent.send(
        `${sample.task}\n\nThis is a hiring interview: other candidates do the same task. Work only in this repository and finish with your usual summary.`,
      );
    } catch (error) {
      if (!this.#workspaces.has(agent.catId)) {
        this.#workspaces.set(agent.catId, {
          interviewId: interview.id,
          dir: '',
          base: '',
          branch: null,
          startedAt,
          finished: false,
          timer: null,
        });
      }
      await this.#finish(agent, `Could not start: ${message(error)}`);
    }
  }

  async #prepare(
    interview: Interview,
    sample: SampleSpec,
    cat: Cat,
    startedAt: number,
  ): Promise<Workspace> {
    let workspace: Workspace;
    if (sample.repo === 'fixture') {
      const dir = this.#fixtureDir(interview.id, cat.id);
      const base = await prepareFixtureRepo(sample, dir);
      workspace = {
        interviewId: interview.id,
        dir,
        base,
        branch: null,
        startedAt,
        finished: false,
        timer: null,
      };
    } else {
      const branch = `agentcats/interview/${interview.id.slice(0, 8)}/${cat.name.toLowerCase()}`;
      const tree = await this.h.worktrees.ensure(
        `interview-${interview.id.slice(0, 8)}-${cat.id.slice(0, 8)}`,
        branch,
      );
      await overlay(sample.setupDir, tree.path);
      workspace = {
        interviewId: interview.id,
        dir: tree.path,
        base: tree.baseCommit,
        branch,
        startedAt,
        finished: false,
        timer: null,
      };
    }
    this.#workspaces.set(cat.id, workspace);
    return workspace;
  }

  // -------------------------------------------------------------------------
  // Agent hooks, forwarded by the manager for candidate cats
  // -------------------------------------------------------------------------

  turnEnded(agent: CatAgent, outcome: TurnOutcome): void {
    if (outcome.stopReason === 'cancelled') return;
    const failure =
      outcome.stopReason === 'end_turn'
        ? null
        : (outcome.lastError ?? `Turn ended: ${outcome.stopReason}`);
    this.h.track(this.#finish(agent, failure));
  }

  sessionEnded(agent: CatAgent, expected: boolean): void {
    if (expected) return;
    this.h.track(this.#finish(agent, 'The agent process stopped'));
  }

  /** Stop the interview's candidates once together they reach the interview budget. */
  usage(agent: CatAgent): void {
    const workspace = this.#workspaces.get(agent.catId);
    const budget = this.h.config.interviews.budgetUsd;
    if (!workspace || budget === null || !this.h.budgetEnforced()) return;
    const interview = this.h.log.board.interviews[workspace.interviewId];
    if (!interview) return;
    const spent = interview.candidates.reduce(
      (sum, c) => sum + (this.h.log.board.usage[c.catId]?.costUsd ?? 0),
      0,
    );
    if (spent < budget) return;
    for (const c of interview.candidates) {
      const running = this.#workspaces.get(c.catId);
      const other = running && !running.finished ? this.h.agentFor(c.catId) : null;
      if (other)
        this.h.track(this.#finish(other, `Interview budget reached ($${budget.toFixed(2)})`));
    }
  }

  /**
   * A candidate is done (or failed): end its session, measure its work, copy
   * the hidden files in and run the checks. Once every candidate is done,
   * score them all.
   */
  async #finish(agent: CatAgent, failure: string | null): Promise<void> {
    const workspace = this.#workspaces.get(agent.catId);
    if (!workspace || workspace.finished) return;
    workspace.finished = true;
    if (workspace.timer) clearTimeout(workspace.timer);
    await agent.endSession();
    agent.setStatus(failure ? 'error' : 'done', failure);
    const result = await this.#measure(workspace, failure, agent.catId);
    this.h.log.append({
      type: 'interview.candidate_scored',
      catId: agent.catId,
      payload: { interviewId: workspace.interviewId, result, score: null },
    });
    const interview = this.interview(workspace.interviewId);
    if (interview.status !== 'running' || interview.candidates.some((c) => c.result === null))
      return;
    const results = interview.candidates.map((c) => c.result as CandidateResult);
    const scores = scoreCandidates(results, this.h.config.interviews.weights);
    interview.candidates.forEach((c, i) => {
      this.h.log.append({
        type: 'interview.candidate_scored',
        catId: c.catId,
        payload: {
          interviewId: interview.id,
          result: results[i] as CandidateResult,
          score: scores[i] ?? null,
        },
      });
    });
    this.h.notice(
      'info',
      'interview_scored',
      `Interview for "${short(interview.role.description)}": every candidate is scored. Pick one to hire.`,
      {},
    );
  }

  async #measure(
    workspace: Workspace,
    failure: string | null,
    catId: string,
  ): Promise<CandidateResult> {
    const empty = { files: 0, insertions: 0, deletions: 0 };
    const usage = this.h.log.board.usage[catId];
    const base = {
      diff: empty,
      costUsd: usage?.costUsd ?? null,
      durationMs: Date.now() - workspace.startedAt,
      lintClean: null,
      typecheckClean: null,
    };
    if (!workspace.dir)
      return { ...base, passed: false, failure: short(failure ?? 'No workspace') };
    const interview = this.interview(workspace.interviewId);
    const sample = this.#samples.get(interview.sample.id);
    try {
      const diff = await workDiff(workspace.dir, workspace.base);
      if (failure || !sample?.check) {
        return {
          ...base,
          diff,
          passed: false,
          failure: short(failure ?? 'The sample has no check'),
        };
      }
      await overlay(sample.hiddenDir, workspace.dir);
      const timeout = this.h.config.interviews.checkTimeoutMs;
      const check = await runCommand(sample.check, workspace.dir, timeout);
      const lint = sample.lint ? await runCommand(sample.lint, workspace.dir, timeout) : null;
      const typecheck = sample.typecheck
        ? await runCommand(sample.typecheck, workspace.dir, timeout)
        : null;
      return {
        ...base,
        diff,
        passed: check.ok,
        lintClean: lint ? lint.ok : null,
        typecheckClean: typecheck ? typecheck.ok : null,
        failure: check.ok
          ? null
          : short(
              check.timedOut
                ? 'The check timed out'
                : check.tail
                  ? `The check failed: ${check.tail}`
                  : 'The check failed without output',
            ),
      };
    } catch (error) {
      return {
        ...base,
        passed: false,
        failure: short(`Could not check the work: ${message(error)}`),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Ending an interview
  // -------------------------------------------------------------------------

  /**
   * Hire a candidate. Only one that passed the check can be hired.
   *
   * @throws ApiError `conflict` if the interview is not deciding, the
   *   candidate failed, or the team is full.
   */
  async pick(interviewId: string, catId: string): Promise<Interview> {
    const interview = this.interview(interviewId);
    if (interview.status !== 'deciding') {
      throw new ApiError(
        'conflict',
        `The interview is ${interview.status}; pick once every candidate is scored`,
      );
    }
    const candidate = interview.candidates.find((c) => c.catId === catId);
    if (!candidate)
      throw new ApiError('not_found', `${catId} is not a candidate in this interview`);
    if (candidate.score?.total == null) {
      throw new ApiError(
        'conflict',
        'That candidate did not pass the check, so it cannot be hired',
      );
    }
    this.#assertRoom();
    this.h.log.append({ type: 'cat.hired', catId, payload: { interviewId } });
    await this.h.onHired(catId, interview.role);
    this.#complete(interview, catId);
    await this.#cleanup(interview, catId);
    return this.interview(interviewId);
  }

  /** Stop an interview at any point before it is decided; nobody is hired. */
  async cancel(interviewId: string): Promise<Interview> {
    const interview = this.interview(interviewId);
    if (interview.status === 'completed' || interview.status === 'cancelled') {
      throw new ApiError('conflict', `The interview is already ${interview.status}`);
    }
    for (const c of interview.candidates) {
      const workspace = this.#workspaces.get(c.catId);
      if (workspace) {
        workspace.finished = true;
        if (workspace.timer) clearTimeout(workspace.timer);
      }
      await this.h.agentFor(c.catId)?.endSession();
    }
    this.#complete(interview, null);
    await this.#cleanup(interview, null);
    return this.interview(interviewId);
  }

  #complete(interview: Interview, winnerCatId: string | null): void {
    this.h.log.append({
      type: 'interview.completed',
      payload: {
        interviewId: interview.id,
        winnerCatId,
        outcome: winnerCatId ? 'hired' : 'cancelled',
      },
    });
  }

  /**
   * Delete every candidate's repo and forget the losers. The winner of a
   * project interview keeps its branch; its worktree goes like the others.
   */
  async #cleanup(interview: Interview, winnerCatId: string | null): Promise<void> {
    for (const c of interview.candidates) {
      const workspace = this.#workspaces.get(c.catId);
      this.#workspaces.delete(c.catId);
      if (c.catId !== winnerCatId) this.h.dropAgent(c.catId);
      try {
        if (workspace?.branch) {
          await this.h.worktrees.discard(workspace.dir, workspace.branch, c.catId === winnerCatId);
        }
      } catch (error) {
        this.h.logger.warn(`Could not remove a candidate's worktree: ${message(error)}`);
      }
    }
    await rm(join(this.#fixtureRoot(), interview.id), {
      recursive: true,
      force: true,
      maxRetries: 5,
    }).catch((error: unknown) => {
      this.h.logger.warn(`Could not remove interview files: ${message(error)}`);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  interview(interviewId: string): Interview {
    const interview = this.h.log.board.interviews[interviewId];
    if (!interview) throw new ApiError('not_found', `No interview ${interviewId}`);
    return interview;
  }

  /** Candidates' fixture repos live next to the task worktrees, outside the project. */
  #fixtureRoot(): string {
    return join(this.h.worktrees.root, 'interviews');
  }

  #fixtureDir(interviewId: string, catId: string): string {
    return join(this.#fixtureRoot(), interviewId, catId.slice(0, 8));
  }

  #assertRoom(): void {
    const max = this.h.config.workers.max;
    if (this.h.workerCount() >= max) {
      throw new ApiError(
        'conflict',
        `The team is full (${String(max)} workers). Retire a cat first, or raise workers.max.`,
      );
    }
  }

  /**
   * Cost per candidate: the median of earlier candidates on the same sample
   * and tier when there are at least two, otherwise a default per tier.
   */
  #perCandidateEstimate(sampleId: string, tier: ModelTier): number {
    const costs = Object.values(this.h.log.board.interviews)
      .filter((i) => i.sample.id === sampleId && i.role.tier === tier)
      .flatMap((i) =>
        i.candidates.flatMap((c) => (c.result?.costUsd != null ? [c.result.costUsd] : [])),
      )
      .sort((a, b) => a - b);
    if (costs.length < 2) return DEFAULT_CANDIDATE_USD[tier];
    const mid = Math.floor(costs.length / 2);
    return costs.length % 2 ? (costs[mid] ?? 0) : ((costs[mid - 1] ?? 0) + (costs[mid] ?? 0)) / 2;
  }

  async #projectTestCommand(): Promise<string | null> {
    const project = await readProjectCommands(this.h.projectPath);
    if (!project.packageManager || !project.scripts['test']) return null;
    return project.packageManager === 'npm' ? 'npm test' : `${project.packageManager} test`;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const short = (text: string) => (text.length > 480 ? `${text.slice(0, 477)}...` : text);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
