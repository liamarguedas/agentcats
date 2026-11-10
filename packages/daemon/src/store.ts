import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AgentcatsEvent } from '@agentcats/protocol';

/**
 * Durable storage for the daemon. The event log is the source of truth: the
 * board is rebuilt from it on start. The only other state is the per-task
 * agent session handle, kept so a crashed or interrupted task can resume its
 * conversation.
 *
 * Synchronous on purpose (node:sqlite is), so an event is on disk before it is
 * broadcast.
 */
export interface Store {
  appendEvent(event: AgentcatsEvent): void;
  /** Every event, oldest first. */
  allEvents(): AgentcatsEvent[];
  /** Every event about one task, oldest first. */
  taskEvents(taskId: string): AgentcatsEvent[];
  lastSeq(): number;
  /** The agent's resume id for a task's most recent session, if any. */
  resumeIdFor(taskId: string): string | null;
  setResumeId(taskId: string, resumeId: string | null): void;
  close(): void;
}

const SCHEMA_VERSION = 1;

/**
 * {@link Store} on Node's built-in SQLite (`node:sqlite`). Use `:memory:` in
 * tests.
 */
export class SqliteStore implements Store {
  readonly #db: DatabaseSync;
  readonly #insert;
  readonly #byTask;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        cat_id TEXT,
        task_id TEXT,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
      CREATE TABLE IF NOT EXISTS task_sessions (
        task_id TEXT PRIMARY KEY,
        resume_id TEXT NOT NULL
      );
    `);
    const version = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as
      { value: string } | undefined;
    if (!version) {
      this.#db
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('schema', String(SCHEMA_VERSION));
    } else if (Number(version.value) !== SCHEMA_VERSION) {
      throw new Error(
        `agentcats database schema ${version.value} is not supported (expected ${String(SCHEMA_VERSION)}). Move .agentcats/agentcats.db aside to start fresh.`,
      );
    }
    this.#insert = this.#db.prepare(
      'INSERT INTO events (seq, id, ts, type, cat_id, task_id, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.#byTask = this.#db.prepare('SELECT body FROM events WHERE task_id = ? ORDER BY seq');
  }

  appendEvent(event: AgentcatsEvent): void {
    this.#insert.run(
      event.seq,
      event.id,
      event.ts,
      event.type,
      event.catId ?? null,
      event.taskId ?? null,
      JSON.stringify(event),
    );
  }

  allEvents(): AgentcatsEvent[] {
    const rows = this.#db.prepare('SELECT body FROM events ORDER BY seq').all() as {
      body: string;
    }[];
    return rows.map((row) => AgentcatsEvent.parse(JSON.parse(row.body)));
  }

  taskEvents(taskId: string): AgentcatsEvent[] {
    const rows = this.#byTask.all(taskId) as { body: string }[];
    return rows.map((row) => AgentcatsEvent.parse(JSON.parse(row.body)));
  }

  lastSeq(): number {
    const row = this.#db.prepare('SELECT MAX(seq) AS seq FROM events').get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  resumeIdFor(taskId: string): string | null {
    const row = this.#db
      .prepare('SELECT resume_id FROM task_sessions WHERE task_id = ?')
      .get(taskId) as { resume_id: string } | undefined;
    return row?.resume_id ?? null;
  }

  setResumeId(taskId: string, resumeId: string | null): void {
    if (resumeId === null) {
      this.#db.prepare('DELETE FROM task_sessions WHERE task_id = ?').run(taskId);
    } else {
      this.#db
        .prepare(
          'INSERT INTO task_sessions (task_id, resume_id) VALUES (?, ?) ON CONFLICT (task_id) DO UPDATE SET resume_id = excluded.resume_id',
        )
        .run(taskId, resumeId);
    }
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }
}
