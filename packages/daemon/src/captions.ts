import { readFileSync } from 'node:fs';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type AgentcatsEvent, CaptionKind, RUNTIME_DIR_NAME } from '@agentcats/protocol';
import { z } from 'zod';

import type { EventLog } from './event-log.js';

const DEFAULT_FILE = fileURLToPath(new URL('../captions/default.json', import.meta.url));

/** The caption file: lines per kind, with `{cat}`, `{task}`, `{level}` and `{cats}` filled in. */
const Templates = z.partialRecord(
  CaptionKind,
  z.array(z.string().trim().min(1).max(200)).min(1).max(50),
);
type Templates = Readonly<Partial<Record<CaptionKind, readonly string[]>>>;

export const DEFAULT_CAPTIONS: Templates = Templates.parse(
  JSON.parse(readFileSync(DEFAULT_FILE, 'utf8')),
);

export function captionsPath(projectPath: string): string {
  return join(projectPath, RUNTIME_DIR_NAME, 'captions.json');
}

/**
 * The project's caption templates. The defaults are copied to
 * `.agentcats/captions.json` on first use, so users can edit them there. A
 * kind missing from the file uses the defaults.
 *
 * @returns The templates, and a problem to show if the file is invalid (the
 *   defaults are used then).
 */
export async function loadCaptions(
  projectPath: string,
): Promise<{ templates: Templates; problem: string | null }> {
  const file = captionsPath(projectPath);
  if (!(await stat(file).catch(() => null))) {
    await copyFile(DEFAULT_FILE, file).catch(() => undefined);
    return { templates: DEFAULT_CAPTIONS, problem: null };
  }
  try {
    const parsed = Templates.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (!parsed.success) {
      return {
        templates: DEFAULT_CAPTIONS,
        problem: `${file} is invalid, so the default captions are used: ${z.prettifyError(parsed.error)}`,
      };
    }
    return { templates: { ...DEFAULT_CAPTIONS, ...parsed.data }, problem: null };
  } catch (error) {
    return {
      templates: DEFAULT_CAPTIONS,
      problem: `${file} is not valid JSON, so the default captions are used: ${(error as Error).message}`,
    };
  }
}

/**
 * Watches the log and adds a `caption` event after a task fails, a cat is
 * promoted, hits its budget or is retired, and candidates lose an interview.
 */
export class Captioner {
  readonly #unsubscribe: () => void;
  #stopped = false;

  constructor(
    private readonly log: EventLog,
    private readonly templates: Templates,
    private readonly random: () => number = Math.random,
  ) {
    this.#unsubscribe = log.subscribe((event) => {
      // After every listener has seen this event, so the caption never arrives first.
      queueMicrotask(() => {
        if (!this.#stopped) this.#onEvent(event);
      });
    });
  }

  /** Stop, including captions already queued: the log may be closing. */
  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
  }

  #onEvent(event: AgentcatsEvent): void {
    const board = this.log.board;
    const name = (catId: string | null | undefined) =>
      catId ? (board.cats[catId]?.name ?? board.retired[catId]?.cat.name ?? null) : null;
    switch (event.type) {
      case 'task.updated': {
        if (event.payload.status !== 'failed') return;
        const task = board.tasks[event.taskId];
        const cat = name(task?.assigneeCatId);
        if (task && cat)
          this.#say('task_failed', { cat, task: task.title }, event, task.assigneeCatId);
        return;
      }
      case 'cat.level_changed': {
        const cat = name(event.catId);
        if (cat && event.payload.to > event.payload.from) {
          this.#say('cat_promoted', { cat, level: String(event.payload.to) }, event, event.catId);
        }
        return;
      }
      case 'cat.paused': {
        const cat = name(event.catId);
        if (cat && event.payload.reason === 'budget')
          this.#say('budget_hit', { cat }, event, event.catId);
        return;
      }
      case 'cat.retired': {
        const cat = name(event.catId);
        if (cat) this.#say('cat_retired', { cat }, event, event.catId);
        return;
      }
      case 'interview.completed': {
        if (event.payload.outcome !== 'hired') return;
        const interview = board.interviews[event.payload.interviewId];
        const losers = (interview?.candidates ?? [])
          .filter((c) => c.catId !== event.payload.winnerCatId)
          .map((c) => this.#candidateName(c.catId))
          .filter((n): n is string => n !== null);
        if (losers.length > 0) this.#say('interview_rejected', { cats: list(losers) }, event, null);
        return;
      }
      default:
        return;
    }
  }

  /** A candidate that lost has left the board; its name is in its `cat.created` event. */
  #candidateName(catId: string): string | null {
    const board = this.log.board;
    const known = board.cats[catId]?.name ?? board.retired[catId]?.cat.name;
    if (known) return known;
    const created = this.log.recent().find((e) => e.type === 'cat.created' && e.catId === catId);
    return created?.type === 'cat.created' ? created.payload.name : null;
  }

  #say(
    kind: CaptionKind,
    values: Record<string, string>,
    cause: AgentcatsEvent,
    catId: string | null | undefined,
  ): void {
    const lines = this.templates[kind] ?? DEFAULT_CAPTIONS[kind] ?? [];
    const line = lines[Math.floor(this.random() * lines.length)];
    if (!line) return;
    const text = line.replace(
      /\{(cat|task|level|cats)\}/g,
      (match, key: string) => values[key] ?? match,
    );
    this.log.append({
      type: 'caption',
      ...(catId && { catId }),
      ...(cause.taskId && { taskId: cause.taskId }),
      payload: { kind, text: text.slice(0, 300) },
    });
  }
}

/** "A", "A and B", "A, B and C". */
function list(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}
