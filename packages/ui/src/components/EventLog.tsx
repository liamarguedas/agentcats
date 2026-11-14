import type { AgentcatsEvent, XpReason } from '@agentcats/protocol';
import { useEffect, useMemo, useRef } from 'react';

export const XP_REASON: Record<XpReason, string> = {
  accepted: 'result accepted',
  tests_first_try: 'tests passed first try',
  under_cost: 'cheaper than usual',
  rejected: 'result rejected',
};

export const xpText = (delta: number) => (delta > 0 ? `+${String(delta)}` : `−${String(-delta)}`);

function describe(event: AgentcatsEvent): string {
  switch (event.type) {
    case 'cat.created':
      return `${event.payload.name} joined (${event.payload.adapter})`;
    case 'cat.updated':
      return Object.keys(event.payload).join(', ');
    case 'cat.paused':
      return event.payload.reason === 'budget' ? 'paused: budget reached' : 'paused';
    case 'cat.resumed':
      return 'resumed';
    case 'message.user':
      return `you: ${event.payload.text}`;
    case 'notice':
      return event.payload.message;
    case 'cat.status_changed':
      return event.payload.reason
        ? `${event.payload.status}: ${event.payload.reason}`
        : event.payload.status;
    case 'task.created':
      return event.payload.title;
    case 'task.updated':
      return [event.payload.status, event.payload.summary].filter(Boolean).join(': ');
    case 'tool.called':
      return `${event.payload.toolName} ${event.payload.inputSummary} [${event.payload.status}]`;
    case 'approval.requested':
      return `${event.payload.toolName} ${event.payload.inputSummary}`;
    case 'approval.resolved':
      return `${event.payload.decision} (${event.payload.resolvedBy})`;
    case 'message.agent':
      return `${event.payload.channel === 'thought' ? '💭 ' : ''}${event.payload.text}`;
    case 'usage.updated':
      return `${String(event.payload.inputTokens + event.payload.outputTokens)} tokens`;
    case 'daemon.error':
      return `${event.payload.code}: ${event.payload.message}`;
    case 'daemon.started':
      return `agentcats ${event.payload.version} started`;
    case 'xp.changed':
      return `${xpText(event.payload.delta)} XP, ${XP_REASON[event.payload.reason]} (now ${String(event.payload.xp)})`;
    case 'cat.level_changed':
      return `level ${String(event.payload.from)} → ${String(event.payload.to)}`;
    case 'learnings.proposed':
      return `${event.payload.kind === 'add' ? 'suggests' : 'suggests a rewrite with'} ${String(event.payload.lines.length)} learning${event.payload.lines.length === 1 ? '' : 's'} (${event.payload.trigger.replace('_', ' ')})`;
    case 'learnings.proposal_resolved':
      return `suggestion ${event.payload.decision}${event.payload.resolvedBy === 'auto' ? ' automatically' : ''}`;
    case 'cat.retire_proposed':
      return `lead suggests retiring: ${event.payload.reason}`;
    case 'cat.retire_dismissed':
      return 'retirement dismissed';
    case 'cat.retired':
      return `retired: ${event.payload.reason}`;
    case 'cat.resurrected':
      return `back on the team as ${event.payload.name}`;
    case 'cat.hired':
      return 'hired after an interview';
    case 'interview.proposed':
      return `interview proposed by ${event.payload.proposedBy === 'user' ? 'you' : 'the lead'}: ${String(event.payload.candidateCount)} candidates, ${event.payload.estimateUsd === null ? 'cost unknown' : `≈ $${event.payload.estimateUsd.toFixed(2)}`}`;
    case 'interview.started':
      return `interview started with ${String(event.payload.candidateCatIds.length)} candidates`;
    case 'interview.candidate_scored':
      return event.payload.score === null
        ? `finished: ${event.payload.result.passed ? 'check passed' : (event.payload.result.failure ?? 'check failed')}`
        : `scored ${event.payload.score.total === null ? 'not hireable' : String(event.payload.score.total)}`;
    case 'interview.completed':
      return event.payload.outcome === 'hired' ? 'interview over: hired' : 'interview cancelled';
    case 'learnings.changed':
      return `learnings ${event.payload.reason}: ${String(event.payload.learnings.length)} line${event.payload.learnings.length === 1 ? '' : 's'}`;
  }
}

interface Row {
  readonly key: string;
  readonly seq: string;
  readonly ts: number;
  readonly type: AgentcatsEvent['type'];
  readonly text: string;
}

/** One row per event, except that streamed chunks of one agent message share a row. */
function toRows(events: readonly AgentcatsEvent[]): Row[] {
  const rows: Row[] = [];
  let open = null as { messageId: string; firstSeq: number; row: Row } | null;
  for (const event of events) {
    if (event.type === 'message.agent' && open?.messageId === event.payload.messageId) {
      const row: Row = {
        ...open.row,
        seq: `${String(open.firstSeq)}–${String(event.seq)}`,
        text: open.row.text + event.payload.text,
      };
      rows[rows.length - 1] = row;
      open = { ...open, row };
      continue;
    }
    const row: Row = {
      key: event.id,
      seq: String(event.seq),
      ts: event.ts,
      type: event.type,
      text: describe(event),
    };
    rows.push(row);
    open =
      event.type === 'message.agent'
        ? { messageId: event.payload.messageId, firstSeq: event.seq, row }
        : null;
  }
  return rows;
}

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour12: false, timeStyle: 'medium' });

/** Debug view of the raw event stream. Sticks to the bottom unless the user scrolls up. */
export function EventLog({ events }: { events: readonly AgentcatsEvent[] }) {
  const listRef = useRef<HTMLOListElement>(null);
  const stickRef = useRef(true);
  const rows = useMemo(() => toRows(events), [events]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stickRef.current) list.scrollTop = list.scrollHeight;
  }, [rows]);

  return (
    <section className="panel event-log" aria-label="Event log">
      <h2 className="panel__title">
        Event log <span className="panel__count">{events.length}</span>
      </h2>
      <ol
        ref={listRef}
        className="event-log__list"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {rows.map((row) => (
          <li
            key={row.key}
            className={`event-log__row event-log__row--${row.type.split('.')[0] ?? ''}`}
          >
            <span className="event-log__seq">#{row.seq}</span>
            <time className="event-log__time">{time(row.ts)}</time>
            <span className="event-log__type">{row.type}</span>
            <span className="event-log__text">{row.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
