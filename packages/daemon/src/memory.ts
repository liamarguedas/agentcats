import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  type AgentcatsConfig,
  type Cat,
  type Learning,
  type LearningDraft,
  type LearningProposal,
  type LearningsChangeReason,
  type LearningsVersion,
  type ProposalTrigger,
  selectLearnings,
  type Task,
  type Usage,
} from '@agentcats/protocol';
import type { Adapter } from '@agentcats/protocol/adapter';

import type { CatMemory } from './cat-memory.js';
import { ApiError } from './errors.js';
import type { EventLog } from './event-log.js';
import { cleanText, dedupe, isDuplicate, parseProposal } from './learnings.js';
import type { Logger } from './logger.js';

/** Most lines a debrief may propose. */
const DEBRIEF_LIMIT = 3;

/** Prompt templates, loaded once from `packages/daemon/prompts/`. */
export function loadPrompt(name: string): string {
  const text = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8');
  return text.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
}

export interface MemoryOptions {
  readonly log: EventLog;
  readonly adapter: Adapter;
  readonly config: AgentcatsConfig;
  readonly projectPath: string;
  readonly files: CatMemory;
  readonly logger: Logger;
  /** Add the cost of a debrief or consolidation call to the cat's usage. */
  readonly chargeUsage: (catId: string, usage: Usage) => void;
  /** Run work in the background, tracked for shutdown. */
  readonly track: (work: Promise<unknown>) => void;
}

/** What the user decided about a task, for its debrief. */
export interface Verdict {
  readonly decision: 'accept' | 'reject';
  readonly note: string | null;
}

/**
 * Workers' learnings: the files on disk, the debrief after each reviewed
 * task, consolidation, and every change the user makes from the board.
 *
 * `learnings.md` is the source of truth. Every change is written to the file
 * first and then recorded as a `learnings.changed` event carrying the whole
 * new list, so the log keeps the history. Changes to one cat's file are
 * serialized. Nothing a model suggests is written until the user accepts it,
 * unless the user turned on `memory.autoAcceptAfter`.
 */
export class Memory {
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #consolidating = new Set<string>();
  readonly #prompts = {
    debrief: loadPrompt('debrief'),
    consolidation: loadPrompt('consolidation'),
  };

  constructor(private readonly o: MemoryOptions) {}

  /** Create missing folders, pick up hand edits made while the daemon was off, watch for more. */
  async start(): Promise<void> {
    await this.o.files.ensureGitignore();
    for (const cat of this.#workers()) await this.#open(cat);
  }

  close(): void {
    this.o.files.close();
  }

  /** A new worker was hired: give it a folder. */
  async hired(catId: string): Promise<void> {
    await this.#open(this.#cat(catId));
  }

  /**
   * An interview winner joined: give it a folder, its role as persona, and
   * the role's starting learnings.
   */
  async hiredFor(catId: string, persona: string, learnings: readonly string[]): Promise<void> {
    await this.#open(this.#cat(catId));
    await this.o.files.writeProfile(this.#cat(catId), persona);
    if (learnings.length > 0) {
      await this.#edit(catId, (lines) => {
        const drafts = learnings
          .map((text) => ({ text: cleanText(text), sourceTaskId: null }))
          .filter((l) => l.text);
        const kept = lines.map(({ text, sourceTaskId }) => ({ text, sourceTaskId }));
        return { lines: [...kept, ...dedupe(drafts, lines)], reason: 'added' };
      });
    }
  }

  /**
   * A cat is retiring: drop its pending suggestions and move its folder to
   * the archive. Call before `cat.retired`, while it is still on the board.
   */
  async retire(catId: string, archive: string, reason: string): Promise<void> {
    await this.#locked(catId, async () => {
      const cat = this.#cat(catId);
      for (const proposal of Object.values(this.o.log.board.proposals)) {
        if (proposal.catId === catId) this.#resolved(proposal, 'superseded', 'system');
      }
      await this.o.files.archive(cat.name, archive, {
        id: cat.id,
        name: cat.name,
        reason,
        level: cat.level,
        xp: cat.xp,
        stats: cat.stats,
        retiredAt: new Date().toISOString(),
      });
    });
  }

  /** Move an archived folder back under the cat's (possibly new) name. Call before `cat.resurrected`. */
  async unarchive(archive: string, name: string): Promise<void> {
    await this.o.files.unarchive(archive, name);
  }

  /** A resurrected cat is on the board again: rename its files to its name and watch them. */
  async resurrected(catId: string): Promise<void> {
    const cat = this.#cat(catId);
    const lines = (await this.o.files.readLearnings(cat.name)) ?? cat.learnings;
    await this.o.files.writeLearnings(cat.name, lines);
    await this.#open(cat);
  }

  async #open(cat: Cat): Promise<void> {
    await this.o.files.ensure(cat, cat.learnings);
    await this.writeStats(cat.id);
    await this.sync(cat.id);
    this.o.files.watch(cat.name, () => {
      this.o.track(this.sync(cat.id));
    });
  }

  /** Bring the board in line with the file, if someone edited it by hand. */
  sync(catId: string): Promise<Learning[]> {
    return this.#locked(catId, () => this.#syncUnlocked(catId));
  }

  async #syncUnlocked(catId: string): Promise<Learning[]> {
    const cat = this.#cat(catId);
    const onDisk = (await this.o.files.readLearnings(cat.name)) ?? [];
    if (!sameLines(onDisk, cat.learnings)) this.#changed(catId, onDisk, 'external', null);
    return onDisk;
  }

  /** Copy XP, level and task counts to `stats.json`. */
  /**
   * Copy XP, level and task counts to `stats.json`. Serialized per cat, and
   * read from the board inside the lock, so the last write is the newest.
   */
  writeStats(catId: string): Promise<void> {
    return this.#locked(catId, async () => {
      const cat = this.o.log.board.cats[catId];
      if (cat?.role === 'worker') await this.o.files.writeStats(cat);
    });
  }

  async writeProfile(catId: string): Promise<void> {
    const cat = this.o.log.board.cats[catId];
    if (cat?.role === 'worker') await this.o.files.writeProfile(cat);
  }

  // -------------------------------------------------------------------------
  // The worker's prompt
  // -------------------------------------------------------------------------

  /**
   * The learnings section of a worker's prompt for one task, chosen by the
   * cat's level (`selectLearnings` in the protocol's `levels.ts`), and its
   * persona.
   */
  async forPrompt(catId: string, task: Task): Promise<{ learnings: string; persona: string }> {
    const cat = this.#cat(catId);
    const all = await this.sync(catId);
    const chosen = selectLearnings(all, `${task.title}\n${task.description}`, cat.level);
    const learnings =
      chosen.length === 0
        ? 'Nothing yet: this is one of your first tasks here.'
        : chosen.map((l) => `- ${l.text}`).join('\n');
    return { learnings, persona: await this.o.files.persona(cat.name) };
  }

  // -------------------------------------------------------------------------
  // Commands from the board
  // -------------------------------------------------------------------------

  add(catId: string, text: string): Promise<Cat> {
    return this.#edit(catId, (lines) => {
      const clean = cleanText(text);
      if (!clean) throw new ApiError('bad_request', 'A learning needs some text');
      if (isDuplicate(clean, lines)) {
        throw new ApiError('conflict', 'A learning that says this is already in the list');
      }
      this.#assertRoom(lines.length + 1);
      return { lines: [...lines, { text: clean, sourceTaskId: null }], reason: 'added' };
    });
  }

  edit(catId: string, learningId: string, text: string): Promise<Cat> {
    return this.#edit(catId, (lines) => {
      const clean = cleanText(text);
      if (!clean) throw new ApiError('bad_request', 'A learning needs some text');
      const at = indexOf(lines, learningId);
      const next = lines.map((l, i) => (i === at ? { ...l, text: clean } : l));
      return { lines: next, reason: 'edited' };
    });
  }

  delete(catId: string, learningId: string): Promise<Cat> {
    return this.#edit(catId, (lines) => {
      const at = indexOf(lines, learningId);
      return { lines: lines.filter((_, i) => i !== at), reason: 'deleted' };
    });
  }

  history(catId: string): Promise<LearningsVersion[]> {
    return this.o.files.history(this.#cat(catId).name);
  }

  /** Put back a saved version. The current file is saved first, so this can be undone too. */
  restore(catId: string, versionId: string): Promise<Cat> {
    return this.#locked(catId, async () => {
      const cat = this.#cat(catId);
      const version = await this.o.files.readVersion(cat.name, versionId);
      if (!version) throw new ApiError('not_found', `No saved version ${versionId}`);
      await this.#syncUnlocked(catId);
      const backup = await this.o.files.backup(cat.name);
      const written = await this.o.files.writeLearnings(cat.name, version);
      this.#changed(catId, written, 'restored', backup);
      return this.#cat(catId);
    });
  }

  /**
   * Accept or discard a proposal. Accepting an `add` appends the lines that
   * are still new; accepting a `rewrite` saves the current file to history
   * first, so it can be undone.
   *
   * @throws ApiError `conflict` if accepting would go over the cap.
   */
  resolveProposal(proposalId: string, decision: 'accept' | 'discard'): Promise<Cat> {
    const proposal = this.#proposal(proposalId);
    return this.#locked(proposal.catId, async () => {
      this.#proposal(proposalId); // still pending once we hold the lock
      if (decision === 'discard') {
        this.#resolved(proposal, 'discarded', 'user');
        return this.#cat(proposal.catId);
      }
      await this.#apply(proposal, 'user');
      return this.#cat(proposal.catId);
    });
  }

  /**
   * Ask for a consolidation now. The proposal arrives later as an event.
   *
   * @throws ApiError `conflict` if there is nothing to consolidate or one is running.
   */
  consolidateNow(catId: string): void {
    const cat = this.#cat(catId);
    if (cat.role !== 'worker') throw new ApiError('bad_request', 'Only workers have learnings');
    if (cat.learnings.length < 2) {
      throw new ApiError('conflict', `${cat.name} has too few learnings to consolidate`);
    }
    if (this.#consolidating.has(catId)) {
      throw new ApiError('conflict', `${cat.name}'s learnings are already being consolidated`);
    }
    this.o.track(this.#consolidate(catId, 'user', [], null));
  }

  // -------------------------------------------------------------------------
  // After a review
  // -------------------------------------------------------------------------

  /**
   * Run the debrief for a task the user just reviewed, and turn its lines
   * into exactly one proposal: a consolidation that includes them if the cat
   * leveled up or the new lines do not fit under the cap, an `add` otherwise.
   * Runs in the background; failures become notices.
   *
   * Accepted tasks are always debriefed. A rejection only teaches something
   * when the user wrote a note saying why.
   */
  afterReview(task: Task, verdict: Verdict, leveledUp: boolean): void {
    const catId = task.assigneeCatId;
    if (!catId || this.o.log.board.cats[catId]?.role !== 'worker') return;
    this.o.track(
      (async () => {
        let fresh: LearningDraft[] = [];
        if (this.o.config.memory.debrief && (verdict.decision === 'accept' || verdict.note)) {
          fresh = await this.#debrief(catId, task, verdict);
        }
        const total = this.#cat(catId).learnings.length + fresh.length;
        if (fresh.length > 0 && total > this.o.config.memory.cap) {
          await this.#consolidate(catId, 'cap', fresh, task.id);
        } else if (leveledUp && total >= 2) {
          await this.#consolidate(catId, 'level_up', fresh, task.id);
        } else if (fresh.length > 0) {
          await this.#proposeAdd(catId, task.id, fresh);
        }
      })(),
    );
  }

  /** New, deduplicated lines the debrief suggests; none if it failed or found nothing. */
  async #debrief(catId: string, task: Task, verdict: Verdict): Promise<LearningDraft[]> {
    const cat = this.#cat(catId);
    const current = await this.sync(catId);
    let answer: string;
    try {
      answer = await this.#ask(catId, this.#prompts.debrief, debriefPrompt(task, verdict, current));
    } catch (error) {
      this.#notice(
        catId,
        task.id,
        'warning',
        'debrief_failed',
        `${cat.name}'s debrief failed: ${message(error)}`,
      );
      return [];
    }
    const fresh = dedupe(parseProposal(answer, task.id, DEBRIEF_LIMIT), current);
    if (fresh.length === 0) {
      this.#notice(
        catId,
        task.id,
        'info',
        'debrief_empty',
        `${cat.name} found nothing new to learn from "${task.title}"`,
      );
    }
    return fresh;
  }

  async #proposeAdd(catId: string, taskId: string, lines: LearningDraft[]): Promise<void> {
    const proposal = this.#propose(catId, taskId, 'add', 'debrief', lines, []);
    const threshold = this.o.config.memory.autoAcceptAfter;
    if (threshold !== null && this.#cat(catId).stats.accepted >= threshold) {
      await this.#locked(catId, () => this.#apply(proposal, 'auto')).catch((error: unknown) => {
        this.o.logger.warn(
          `Could not auto-accept learnings for ${this.#cat(catId).name}: ${message(error)}`,
        );
      });
    }
  }

  /**
   * Ask the model to merge and prune the learnings (plus `extra` lines that
   * did not fit), and propose the result as a rewrite.
   */
  async #consolidate(
    catId: string,
    trigger: ProposalTrigger,
    extra: readonly LearningDraft[],
    taskId: string | null,
  ): Promise<void> {
    if (this.#consolidating.has(catId)) return;
    this.#consolidating.add(catId);
    const cat = this.#cat(catId);
    try {
      const current = await this.sync(catId);
      const input = [
        ...current.map(({ text, sourceTaskId }) => ({ text, sourceTaskId })),
        ...extra,
      ];
      const { cap } = this.o.config.memory;
      let answer: string;
      try {
        answer = await this.#ask(
          catId,
          this.#prompts.consolidation.replaceAll('{{cap}}', String(cap)),
          consolidationPrompt(input),
        );
      } catch (error) {
        this.#notice(
          catId,
          taskId,
          'warning',
          'consolidation_failed',
          `Consolidating ${cat.name}'s learnings failed: ${message(error)}`,
        );
        return;
      }
      const lines = dedupe(parseProposal(answer, null, Number.POSITIVE_INFINITY), []);
      if (extra.length === 0 && sameTexts(lines, current)) {
        this.#notice(
          catId,
          taskId,
          'info',
          'consolidation_unchanged',
          `${cat.name}'s learnings are already tidy; nothing to change.`,
        );
        return;
      }
      if (lines.length === 0 || lines.length > cap) {
        this.#notice(
          catId,
          taskId,
          'warning',
          'consolidation_failed',
          `Consolidating ${cat.name}'s learnings gave ${String(lines.length)} lines (limit ${String(cap)}); nothing was proposed.`,
        );
        return;
      }
      for (const old of Object.values(this.o.log.board.proposals)) {
        if (old.catId === catId && old.kind === 'rewrite')
          this.#resolved(old, 'superseded', 'system');
      }
      this.#propose(
        catId,
        taskId,
        'rewrite',
        trigger,
        lines,
        current.map((l) => l.id),
      );
    } finally {
      this.#consolidating.delete(catId);
    }
  }

  /** Write an accepted proposal. Caller holds the cat's lock. */
  async #apply(proposal: LearningProposal, by: 'user' | 'auto'): Promise<void> {
    const cat = this.#cat(proposal.catId);
    const current = await this.#syncUnlocked(proposal.catId);
    const drafts = current.map(({ text, sourceTaskId }) => ({ text, sourceTaskId }));
    if (proposal.kind === 'add') {
      const fresh = dedupe(proposal.lines, current);
      this.#assertRoom(current.length + fresh.length);
      const written = await this.o.files.writeLearnings(cat.name, [...drafts, ...fresh]);
      this.#changed(proposal.catId, written, 'debrief', null);
    } else {
      // Keep what was added to the file after the rewrite was proposed.
      const base = new Set(proposal.base);
      const since = base.size === 0 ? [] : drafts.filter((_, i) => !base.has(current[i]?.id ?? ''));
      const lines = [...proposal.lines, ...dedupe(since, proposal.lines)];
      const backup = await this.o.files.backup(cat.name);
      const written = await this.o.files.writeLearnings(cat.name, lines);
      this.#changed(proposal.catId, written, 'consolidation', backup);
    }
    this.#resolved(proposal, 'accepted', by);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * One-shot model call on the default adapter; its cost goes on the cat's
   * usage when the cat runs on that adapter.
   *
   * @throws Error when the adapter has no one-shot calls.
   */
  async #ask(catId: string, systemPrompt: string, prompt: string): Promise<string> {
    const { adapter } = this.o;
    if (!adapter.capabilities.complete) {
      throw new Error(`${adapter.displayName} has no one-shot calls, so there is no debrief`);
    }
    const answer = await adapter.complete({
      cwd: this.o.projectPath,
      model: this.o.config.memory.model ?? adapter.modelTiers.fast,
      systemPrompt,
      prompt,
    });
    this.o.chargeUsage(catId, answer.usage);
    return answer.text;
  }

  #edit(
    catId: string,
    change: (lines: Learning[]) => { lines: LearningDraft[]; reason: LearningsChangeReason },
  ): Promise<Cat> {
    return this.#locked(catId, async () => {
      const cat = this.#cat(catId);
      if (cat.role !== 'worker') throw new ApiError('bad_request', 'Only workers have learnings');
      const current = await this.#syncUnlocked(catId);
      const { lines, reason } = change(current);
      const written = await this.o.files.writeLearnings(cat.name, lines);
      this.#changed(catId, written, reason, null);
      return this.#cat(catId);
    });
  }

  #assertRoom(lines: number): void {
    const { cap } = this.o.config.memory;
    if (lines > cap) {
      throw new ApiError(
        'conflict',
        `That would make ${String(lines)} learnings, over the limit of ${String(cap)}. Delete some or consolidate first.`,
      );
    }
  }

  /** Serialize work on one cat's file. A failure does not block the next caller. */
  #locked<T>(catId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(catId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#locks.set(catId, next);
    return next;
  }

  #changed(
    catId: string,
    learnings: Learning[],
    reason: LearningsChangeReason,
    backup: string | null,
  ): void {
    this.o.log.append({ type: 'learnings.changed', catId, payload: { learnings, reason, backup } });
  }

  #propose(
    catId: string,
    taskId: string | null,
    kind: 'add' | 'rewrite',
    trigger: ProposalTrigger,
    lines: LearningDraft[],
    base: string[],
  ): LearningProposal {
    const proposalId = randomBytes(8).toString('hex');
    this.o.log.append({
      type: 'learnings.proposed',
      catId,
      ...(taskId !== null && { taskId }),
      payload: { proposalId, kind, trigger, lines, base },
    });
    return this.#proposal(proposalId);
  }

  #resolved(
    proposal: LearningProposal,
    decision: 'accepted' | 'discarded' | 'superseded',
    resolvedBy: 'user' | 'auto' | 'system',
  ): void {
    this.o.log.append({
      type: 'learnings.proposal_resolved',
      catId: proposal.catId,
      payload: { proposalId: proposal.id, decision, resolvedBy },
    });
  }

  #notice(
    catId: string,
    taskId: string | null,
    level: 'info' | 'warning',
    code: string,
    text: string,
  ): void {
    this.o.log.append({
      type: 'notice',
      catId,
      ...(taskId !== null && { taskId }),
      payload: { level, code, message: text.slice(0, 500) },
    });
  }

  #workers(): Cat[] {
    return Object.values(this.o.log.board.cats).filter((c) => c.role === 'worker');
  }

  #cat(catId: string): Cat {
    const cat = this.o.log.board.cats[catId];
    if (!cat) throw new ApiError('not_found', `No cat ${catId}`);
    return cat;
  }

  #proposal(proposalId: string): LearningProposal {
    const proposal = this.o.log.board.proposals[proposalId];
    if (!proposal) throw new ApiError('not_found', `No pending proposal ${proposalId}`);
    return proposal;
  }
}

/** What the debrief model sees about one task. */
export function debriefPrompt(task: Task, verdict: Verdict, current: readonly Learning[]): string {
  const result = task.result;
  const outcome =
    verdict.decision === 'accept'
      ? 'The user accepted the result.'
      : 'The user rejected the result.';
  return [
    '<task>',
    `Title: ${task.title}`,
    task.description ? `Description:\n${task.description}` : 'Description: (none)',
    '</task>',
    '',
    '<outcome>',
    outcome,
    verdict.note ? `The user's note: ${verdict.note}` : "The user's note: (none)",
    '</outcome>',
    '',
    '<result>',
    result
      ? `Diff: ${String(result.diffStat.files)} files, +${String(result.diffStat.insertions)} -${String(result.diffStat.deletions)}. Tests: ${result.tests.replace('_', ' ')}. Attempt: ${String(task.attempt)}.`
      : 'No result was recorded.',
    '</result>',
    '',
    '<worker-summary>',
    result?.summary ?? task.summary ?? '(none)',
    '</worker-summary>',
    '',
    '<current-learnings>',
    current.length > 0 ? current.map((l) => `- ${l.text}`).join('\n') : '(none yet)',
    '</current-learnings>',
  ].join('\n');
}

/** What the consolidation model sees: the list, oldest first, with sources. */
export function consolidationPrompt(lines: readonly LearningDraft[]): string {
  const body = lines
    .map((l) => `- ${l.text}${l.sourceTaskId ? ` (task ${l.sourceTaskId})` : ''}`)
    .join('\n');
  return `<learnings>\n${body}\n</learnings>`;
}

function sameTexts(a: readonly LearningDraft[], b: readonly LearningDraft[]): boolean {
  return a.length === b.length && a.every((l, i) => l.text === b[i]?.text);
}

function sameLines(a: readonly Learning[], b: readonly Learning[]): boolean {
  return a.length === b.length && a.every((l, i) => l.id === b[i]?.id);
}

function indexOf(lines: readonly Learning[], learningId: string): number {
  const at = lines.findIndex((l) => l.id === learningId);
  if (at < 0) {
    throw new ApiError(
      'conflict',
      'That learning is no longer in the file; it was changed elsewhere. The board has been refreshed.',
    );
  }
  return at;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
