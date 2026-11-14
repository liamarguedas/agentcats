import { z } from 'zod';

import { Timestamp } from './common.js';
import { AgentcatsEvent } from './events.js';
import { redactDeep } from './redact.js';

/**
 * One session: one run of the daemon, from a `daemon.started` event to the
 * next. Events stored before the first `daemon.started` (logs from before
 * M5) form one session of their own.
 */
export const SessionSummary = z.strictObject({
  /** Position in the log, oldest first, from 0. */
  index: z.int().nonnegative(),
  firstSeq: z.int().positive(),
  lastSeq: z.int().positive(),
  startedAt: Timestamp,
  endedAt: Timestamp,
  eventCount: z.int().positive(),
  /** agentcats version from `daemon.started`, `null` for an old log. */
  version: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Split a log (oldest first) into sessions. */
export function splitSessions(events: readonly AgentcatsEvent[]): SessionSummary[] {
  const sessions: SessionSummary[] = [];
  let start = 0;
  const close = (end: number) => {
    const slice = events.slice(start, end);
    const first = slice[0];
    const last = slice.at(-1);
    if (!first || !last) return;
    sessions.push({
      index: sessions.length,
      firstSeq: first.seq,
      lastSeq: last.seq,
      startedAt: first.ts,
      endedAt: last.ts,
      eventCount: slice.length,
      version: first.type === 'daemon.started' ? first.payload.version : null,
    });
  };
  events.forEach((event, i) => {
    if (event.type === 'daemon.started' && i > start) {
      close(i);
      start = i;
    }
  });
  close(events.length);
  return sessions;
}

export const SESSION_EXPORT_FORMAT = 'agentcats-session';

/** A session saved to a file, for bug reports and demos. Replayed read-only. */
export const SessionExport = z.strictObject({
  format: z.literal(SESSION_EXPORT_FORMAT),
  version: z.literal(1),
  exportedAt: Timestamp,
  /** Whether long agent output, task descriptions and summaries were kept in full. */
  includesContents: z.boolean(),
  events: z.array(AgentcatsEvent).min(1),
});
export type SessionExport = z.infer<typeof SessionExport>;

/** How much of each long text an export without contents keeps. */
export const EXPORT_LIMITS = {
  /** Per agent message, across its chunks. */
  agentMessage: 200,
  taskDescription: 200,
  taskSummary: 500,
  userMessage: 500,
} as const;

const CUT = ' […]';

export interface ExportOptions {
  /** Keep long texts in full. Secrets are redacted either way. */
  readonly includeContents: boolean;
  /** Shown as `<project>` in the export. */
  readonly projectPath: string;
  /** Shown as `~` in the export. */
  readonly homeDir: string;
  readonly now?: number;
}

/**
 * Turn stored events into a file to share. Always: secrets redacted, the
 * project path and home directory replaced. Without `includeContents`, long
 * agent output, task descriptions, summaries and user messages are cut short,
 * so file contents an agent printed do not travel with the file.
 */
export function prepareExport(
  events: readonly AgentcatsEvent[],
  options: ExportOptions,
): SessionExport {
  const kept = new Map<string, number>();
  const trimmed = events.map((event) => {
    if (options.includeContents) return event;
    switch (event.type) {
      case 'message.agent': {
        const used = kept.get(event.payload.messageId) ?? 0;
        const room = EXPORT_LIMITS.agentMessage - used;
        kept.set(event.payload.messageId, used + event.payload.text.length);
        if (room >= event.payload.text.length) return event;
        const text = room > 0 ? `${event.payload.text.slice(0, room)}${CUT}` : '';
        return { ...event, payload: { ...event.payload, text } };
      }
      case 'task.created':
        return {
          ...event,
          payload: {
            ...event.payload,
            description: cut(event.payload.description, EXPORT_LIMITS.taskDescription),
          },
        };
      case 'task.updated':
        return typeof event.payload.summary === 'string'
          ? {
              ...event,
              payload: {
                ...event.payload,
                summary: cut(event.payload.summary, EXPORT_LIMITS.taskSummary),
              },
            }
          : event;
      case 'message.user':
        return {
          ...event,
          payload: { text: cut(event.payload.text, EXPORT_LIMITS.userMessage) },
        };
      default:
        return event;
    }
  });
  // Agent messages cut to nothing are dropped: they only continued a message already cut.
  const events_ = trimmed.filter((e) => e.type !== 'message.agent' || e.payload.text !== '');
  return SessionExport.parse({
    format: SESSION_EXPORT_FORMAT,
    version: 1,
    exportedAt: options.now ?? Date.now(),
    includesContents: options.includeContents,
    events: redactDeep(hidePaths(events_, options)),
  });
}

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${CUT}`;
}

/** Replace the project path and the home directory, in both slash styles, longest first. */
function hidePaths<T>(value: T, options: ExportOptions): T {
  const swaps: [string, string][] = [];
  for (const [path, label] of [
    [options.projectPath, '<project>'],
    [options.homeDir, '~'],
  ] as const) {
    if (!path) continue;
    for (const form of new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])) {
      swaps.push([form, label]);
    }
  }
  swaps.sort((a, b) => b[0].length - a[0].length);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return swaps.reduce((s, [from, to]) => s.replaceAll(from, to), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
