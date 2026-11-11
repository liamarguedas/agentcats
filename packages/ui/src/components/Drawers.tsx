import type { AgentcatsEvent, Cat, PermissionMode, Task, Usage } from '@agentcats/protocol';
import { type ReactNode, type SyntheticEvent, useEffect, useState } from 'react';

import { InlineText } from './InlineText.js';
import { plural, TASK_STATUS_LABEL } from './TaskCard.js';

/** A worker summary: markdown headings shown as bold lines, the rest as text. */
function SummaryText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        return (
          <span key={i} className="summary__line">
            {heading ? <strong>{heading[1]}</strong> : <InlineText text={line} />}
          </span>
        );
      })}
    </>
  );
}

function Drawer({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <header className="drawer__header">
          <h2 className="drawer__title">{title}</h2>
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="drawer__body">{children}</div>
      </aside>
    </div>
  );
}

const time = (ts: number) =>
  new Date(ts).toLocaleString(undefined, {
    hour12: false,
    dateStyle: 'short',
    timeStyle: 'medium',
  });

const ACTOR_LABEL = { system: 'agentcats', orchestrator: 'lead cat', user: 'you' } as const;

export interface TaskDrawerProps {
  readonly task: Task;
  readonly cat: Cat | undefined;
  readonly loadHistory: () => Promise<readonly AgentcatsEvent[]>;
  readonly onReview: (decision: 'accept' | 'reject', note?: string) => void;
  readonly onRerun: () => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
}

export function TaskDrawer({
  task,
  cat,
  loadHistory,
  onReview,
  onRerun,
  onCancel,
  onClose,
}: TaskDrawerProps) {
  const [history, setHistory] = useState<readonly AgentcatsEvent[] | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadHistory().then(
      (events) => {
        if (!cancelled) setHistory(events);
      },
      () => {
        if (!cancelled) setHistory([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadHistory, task.updatedAt]);

  const transitions = (history ?? []).filter(
    (e): e is Extract<AgentcatsEvent, { type: 'task.updated' }> =>
      e.type === 'task.updated' && e.payload.status !== undefined,
  );
  const active = ['queued', 'running', 'blocked'].includes(task.status);

  return (
    <Drawer title={task.title} onClose={onClose}>
      <div className="drawer__row">
        <span className={`chip chip--${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
        {cat && <span className="drawer__muted">{cat.name}</span>}
        {task.attempt > 1 && <span className="drawer__muted">attempt {task.attempt}</span>}
      </div>
      {task.statusReason && <p className="drawer__reason">{task.statusReason}</p>}

      <div className="drawer__actions">
        {task.status === 'review' && (
          <>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                onReview('accept');
              }}
            >
              Accept
            </button>
            <button
              type="button"
              className="button"
              aria-expanded={rejecting}
              onClick={() => {
                setRejecting((open) => !open);
              }}
            >
              Reject…
            </button>
          </>
        )}
        {(task.status === 'failed' || task.status === 'interrupted') && (
          <button type="button" className="button button--primary" onClick={onRerun}>
            Re-run
          </button>
        )}
        {(active || task.status === 'interrupted') && (
          <button type="button" className="button" onClick={onCancel}>
            Cancel task
          </button>
        )}
      </div>

      {task.status === 'review' && rejecting && (
        <form
          className="form reject-form"
          onSubmit={(e) => {
            e.preventDefault();
            onReview('reject', note.trim() || undefined);
          }}
        >
          <label className="form__field">
            <span>What was wrong? (optional)</span>
            <textarea
              rows={3}
              value={note}
              maxLength={2000}
              placeholder="For example: the handler is far too long; split it."
              onChange={(e) => {
                setNote(e.target.value);
              }}
            />
          </label>
          <p className="drawer__hint">
            With a note, {cat?.name ?? 'the cat'} can learn from the rejection. Without one, it only
            loses XP.
          </p>
          <div className="drawer__actions">
            <button type="submit" className="button button--danger">
              Reject
            </button>
          </div>
        </form>
      )}

      {task.branch && (
        <dl className="facts">
          <dt>Branch</dt>
          <dd>
            <code>{task.branch}</code>
          </dd>
          {task.worktreePath && (
            <>
              <dt>Worktree</dt>
              <dd>
                <code>{task.worktreePath}</code>
              </dd>
            </>
          )}
          {task.result && (
            <>
              <dt>Changes</dt>
              <dd>
                {plural(task.result.diffStat.files, 'file')},{' '}
                <span className="diff-add">+{task.result.diffStat.insertions}</span>{' '}
                <span className="diff-del">−{task.result.diffStat.deletions}</span>
              </dd>
              <dt>Tests</dt>
              <dd>{task.result.tests.replace('_', ' ')}</dd>
              {task.result.costUsd !== null && (
                <>
                  <dt>Cost</dt>
                  <dd>${task.result.costUsd.toFixed(3)}</dd>
                </>
              )}
            </>
          )}
        </dl>
      )}
      {task.status === 'review' && task.branch && (
        <p className="drawer__hint">
          Review it with <code>{`git diff ...${task.branch}`}</code> (what it changed since it left
          your current branch), merge it yourself, then accept.
        </p>
      )}

      {task.result && (
        <section className="drawer__section">
          <h3>Worker summary</h3>
          <div className="summary">
            <SummaryText text={task.result.summary} />
          </div>
        </section>
      )}

      {task.description && (
        <section className="drawer__section">
          <h3>Description</h3>
          <p className="drawer__text">{task.description}</p>
        </section>
      )}

      <section className="drawer__section">
        <h3>History</h3>
        {history === null ? (
          <p className="drawer__muted">Loading…</p>
        ) : (
          <ol className="history">
            {transitions.map((e) => (
              <li key={e.id}>
                <time>{time(e.ts)}</time>
                <span className={`chip chip--${e.payload.status ?? 'queued'}`}>
                  {TASK_STATUS_LABEL[e.payload.status ?? 'queued']}
                </span>
                <span className="drawer__muted">
                  {e.payload.actor ? ACTOR_LABEL[e.payload.actor] : ''}
                  {e.payload.statusReason ? ` · ${e.payload.statusReason}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Drawer>
  );
}

export interface CatDrawerProps {
  readonly cat: Cat;
  readonly usage: Usage | undefined;
  readonly canNudge: boolean;
  readonly onSave: (patch: {
    model: string | null;
    permissionMode?: PermissionMode;
    budget: { maxUsd: number | null; maxTokens: number | null };
  }) => Promise<void>;
  readonly onNudge: () => void;
  readonly onClose: () => void;
  /** Sections shown before the properties form: level and learnings, for workers. */
  readonly children?: ReactNode;
}

const numberOrNull = (text: string) => {
  const value = Number(text);
  return text.trim() === '' || !Number.isFinite(value) || value <= 0 ? null : value;
};

export function CatDrawer({
  cat,
  usage,
  canNudge,
  onSave,
  onNudge,
  onClose,
  children,
}: CatDrawerProps) {
  const [model, setModel] = useState(cat.model ?? '');
  const [mode, setMode] = useState<PermissionMode>(cat.permissionMode);
  const [usd, setUsd] = useState(cat.budget.maxUsd === null ? '' : String(cat.budget.maxUsd));
  const [tokens, setTokens] = useState(
    cat.budget.maxTokens === null ? '' : String(cat.budget.maxTokens),
  );
  const [saved, setSaved] = useState(false);
  const isLead = cat.role === 'orchestrator';

  async function submit(e: SyntheticEvent) {
    e.preventDefault();
    const maxTokens = numberOrNull(tokens);
    await onSave({
      model: model.trim() || null,
      ...(!isLead && { permissionMode: mode }),
      budget: {
        maxUsd: numberOrNull(usd),
        maxTokens: maxTokens === null ? null : Math.round(maxTokens),
      },
    });
    setSaved(true);
  }

  return (
    <Drawer title={isLead ? `${cat.name} · lead` : `${cat.name} · worker`} onClose={onClose}>
      <dl className="facts">
        <dt>Role</dt>
        <dd>
          {isLead
            ? 'Lead (orchestrator): reads and delegates, never edits'
            : 'Worker: edits in its own worktree'}
        </dd>
        <dt>Agent</dt>
        <dd>{cat.adapter}</dd>
        <dt>Billing</dt>
        <dd>
          {cat.billing === 'subscription'
            ? 'Subscription: cost is an API-equivalent estimate'
            : cat.billing === 'metered'
              ? 'Pay per use (API)'
              : 'Not known until its first session'}
        </dd>
        <dt>Spent</dt>
        <dd>
          {usage?.costUsd != null ? `$${usage.costUsd.toFixed(3)}` : '–'} ·{' '}
          {((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toLocaleString()} tokens
        </dd>
      </dl>

      {children}

      {children && <h3 className="drawer__subtitle">Properties</h3>}

      <form className="form" onSubmit={(e) => void submit(e)}>
        <label className="form__field">
          <span>Model</span>
          <input
            value={model}
            placeholder="agent default"
            onChange={(e) => {
              setModel(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <label className="form__field">
          <span>Permission mode</span>
          <select
            value={isLead ? 'ask' : mode}
            disabled={isLead}
            onChange={(e) => {
              setMode(e.target.value as PermissionMode);
              setSaved(false);
            }}
          >
            <option value="ask">Ask before changes</option>
            <option value="accept_edits">Edit files freely, ask for the rest</option>
            <option value="auto">Auto (agent decides what is safe)</option>
          </select>
        </label>
        <div className="form__row">
          <label className="form__field">
            <span>Budget ($)</span>
            <input
              inputMode="decimal"
              value={usd}
              placeholder="no limit"
              onChange={(e) => {
                setUsd(e.target.value);
                setSaved(false);
              }}
            />
          </label>
          <label className="form__field">
            <span>Token limit</span>
            <input
              inputMode="numeric"
              value={tokens}
              placeholder="no limit"
              onChange={(e) => {
                setTokens(e.target.value);
                setSaved(false);
              }}
            />
          </label>
        </div>
        <p className="drawer__hint">
          Model and permission mode apply from the cat&apos;s next session.
        </p>
        <div className="drawer__actions">
          <button type="submit" className="button button--primary">
            Save
          </button>
          {saved && (
            <span className="drawer__muted" role="status">
              Saved
            </span>
          )}
          {canNudge && (
            <button type="button" className="button" onClick={onNudge}>
              Nudge
            </button>
          )}
        </div>
      </form>
    </Drawer>
  );
}
