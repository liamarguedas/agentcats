import type { AdapterInfo, Cat, PendingApproval, Task, ToolKind, Usage } from '@agentcats/protocol';

import { CatSprite } from './Cat.js';
import { InlineText } from './InlineText.js';
import { LevelBadge } from './Learnings.js';

export const STATUS_LABEL: Record<Cat['status'], string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  blocked: 'Blocked',
  waiting_approval: 'Needs your approval',
  done: 'Done',
  error: 'Error',
};

const ROLE_LABEL: Record<Cat['role'], string> = {
  orchestrator: 'Lead',
  worker: 'Worker',
  candidate: 'Candidate',
};

export const KIND_ICON: Record<ToolKind, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '↔️',
  search: '🔍',
  execute: '⌨️',
  think: '💭',
  fetch: '🌐',
  other: '🔧',
};

export interface CatCardProps {
  readonly cat: Cat;
  readonly size: 'lead' | 'worker';
  readonly approval: PendingApproval | undefined;
  readonly usage: Usage | undefined;
  /** The task the cat is on, for workers. */
  readonly task: Task | null;
  /** Latest agent text, shown in the thought bubble. */
  readonly lastMessage: string | null;
  readonly onApprove: (approvalId: string, decision: 'allow' | 'deny') => void;
  readonly onKill: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onOpen: () => void;
  /** The latest XP change, shown briefly as a pop-up. */
  readonly xpPop: { readonly id: string; readonly text: string } | null;
  /** Learnings waiting for the user's review. */
  readonly pendingLearnings: number;
  /** Why the lead suggests retiring this cat, if it does. */
  readonly retireSuggestion: string | null;
  /** The adapter the cat runs on; `undefined` before the snapshot lists it. */
  readonly adapter: AdapterInfo | undefined;
  readonly onReviewRetire: () => void;
  readonly onDismissRetire: () => void;
}

const ACTIVE = new Set<Cat['status']>(['thinking', 'working', 'waiting_approval', 'blocked']);

export function CatCard(props: CatCardProps) {
  const { cat, size, usage, task } = props;
  const paused = cat.pausedReason !== null;
  const status = paused ? 'blocked' : cat.status;
  return (
    <section
      className={`cat-card cat-card--${size} cat-card--${status}`}
      aria-label={`Cat ${cat.name}`}
      data-testid={`cat-${cat.name}`}
    >
      <div className="cat-card__stage">
        <Bubble {...props} />
        <CatSprite status={status} />
        {props.xpPop && (
          <span key={props.xpPop.id} className="xp-pop" aria-live="polite">
            {props.xpPop.text}
          </span>
        )}
      </div>
      {props.retireSuggestion && (
        <div className="retire-suggestion" role="status">
          <p>
            The lead suggests retiring {cat.name}: {props.retireSuggestion}
          </p>
          <div className="drawer__actions">
            <button
              type="button"
              className="button button--small button--danger"
              onClick={props.onReviewRetire}
            >
              Retire…
            </button>
            <button type="button" className="button button--small" onClick={props.onDismissRetire}>
              Keep
            </button>
          </div>
        </div>
      )}
      <div className="cat-card__meta">
        <h2 className="cat-card__name">
          {cat.name}
          <span className="role-tag">{ROLE_LABEL[cat.role]}</span>
          <AdapterBadge adapter={props.adapter} id={cat.adapter} />
        </h2>
        <p
          className={`status-pill status-pill--${status}`}
          data-testid="cat-status"
          aria-live="polite"
        >
          {paused
            ? cat.pausedReason === 'budget'
              ? 'Paused: budget'
              : 'Paused'
            : STATUS_LABEL[cat.status]}
        </p>
        {cat.role === 'worker' && <LevelBadge cat={cat} />}
        {task && size === 'worker' && <p className="cat-card__task">{task.title}</p>}
        <Spend cat={cat} usage={usage} adapter={props.adapter} />
        <div className="cat-card__actions">
          {paused ? (
            <button type="button" className="button button--small" onClick={props.onResume}>
              Resume
            </button>
          ) : (
            <button
              type="button"
              className="button button--small"
              onClick={props.onPause}
              disabled={!ACTIVE.has(cat.status)}
            >
              Pause
            </button>
          )}
          <button
            type="button"
            className="button button--small"
            onClick={props.onKill}
            disabled={!ACTIVE.has(cat.status) && !paused}
          >
            Stop
          </button>
          <button
            type="button"
            className="button button--small button--ghost"
            onClick={props.onOpen}
            aria-label={`Properties of ${cat.name}`}
          >
            ⚙
          </button>
          {props.pendingLearnings > 0 && (
            <button
              type="button"
              className="button button--small learnings-badge"
              onClick={props.onOpen}
              aria-label={`${String(props.pendingLearnings)} learning suggestions from ${cat.name} to review`}
            >
              📝 {props.pendingLearnings}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function Bubble({ cat, approval, lastMessage, onApprove }: CatCardProps) {
  if (approval) {
    return (
      <div
        className="bubble bubble--approval"
        role="alertdialog"
        aria-label={`Approval request from ${cat.name}`}
      >
        <p className="bubble__title">
          {KIND_ICON[approval.kind]} May I use <strong>{approval.toolName}</strong>?
        </p>
        <code className="bubble__code">{approval.inputSummary}</code>
        <div className="bubble__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              onApprove(approval.id, 'allow');
            }}
          >
            Allow
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              onApprove(approval.id, 'deny');
            }}
          >
            Deny
          </button>
        </div>
      </div>
    );
  }
  if (cat.pausedReason) {
    return (
      <div className="bubble bubble--warning" data-testid="bubble">
        <p className="bubble__title">
          {cat.pausedReason === 'budget' ? 'Out of budget' : 'Paused'}
        </p>
        <p className="bubble__text">{cat.statusReason ?? 'Resume when you are ready.'}</p>
      </div>
    );
  }
  switch (cat.status) {
    case 'thinking':
      return (
        <div className="bubble bubble--thought" data-testid="bubble">
          <span className="dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {lastMessage && (
            <p className="bubble__text">
              <InlineText text={lastMessage} />
            </p>
          )}
        </div>
      );
    case 'working':
      return (
        <div className="bubble" data-testid="bubble">
          <p className="bubble__text">{cat.statusReason ?? 'Working'}</p>
        </div>
      );
    case 'done':
      if (cat.role === 'candidate') {
        return (
          <div className="bubble bubble--done" data-testid="bubble">
            <p className="bubble__text">Finished. Waiting for the scores.</p>
          </div>
        );
      }
      if (cat.role === 'worker') {
        return (
          <div className="bubble bubble--done" data-testid="bubble">
            <p className="bubble__text">Finished. The result is on its task card.</p>
          </div>
        );
      }
      return lastMessage ? (
        <div className="bubble bubble--done" data-testid="bubble">
          <p className="bubble__text">
            <InlineText text={lastMessage} />
          </p>
        </div>
      ) : null;
    case 'error':
      return (
        <div className="bubble bubble--error" role="alert" data-testid="bubble">
          <p className="bubble__title">Something went wrong</p>
          <p className="bubble__text">{cat.statusReason ?? 'Unknown error'}</p>
        </div>
      );
    case 'blocked':
      return (
        <div className="bubble bubble--warning" data-testid="bubble">
          <p className="bubble__title">Blocked</p>
          <p className="bubble__text">{cat.statusReason ?? 'Waiting on something'}</p>
        </div>
      );
    case 'idle':
    case 'waiting_approval':
      return null;
  }
}

/** Which agent a cat runs on, with a warning when agentcats cannot check each of its actions. */
function AdapterBadge({ adapter, id }: { adapter: AdapterInfo | undefined; id: string }) {
  const sandboxed = adapter && adapter.capabilities.policyEnforcement !== 'hooks';
  return (
    <span
      className={`adapter-badge${sandboxed ? ' adapter-badge--sandbox' : ''}`}
      data-testid="adapter-badge"
      title={
        sandboxed
          ? `${adapter.displayName} enforces its own sandbox: it runs commands in its worktree without asking, so allowed commands, level gates and always-ask rules are not checked one by one. Its sandbox, not an approval, keeps the network and the rest of the disk out of reach.`
          : `Runs on ${adapter?.displayName ?? id}`
      }
    >
      {adapter?.displayName ?? id}
      {sandboxed && ' ⚠'}
    </span>
  );
}

/** Working time against the time budget, for cats whose agent reports no cost. */
function TimeSpend({ cat, usage }: { cat: Cat; usage: Usage | undefined }) {
  const minutes = (usage?.activeMs ?? 0) / 60_000;
  const max = cat.budget.maxMinutes;
  const ratio = max === null ? null : Math.min(1, minutes / max);
  return (
    <div className="spend" title="This agent reports no cost, so its budget is working time">
      <span className="spend__text">
        cost unknown · {minutes < 1 ? '<1' : minutes.toFixed(0)}
        {max !== null && <span className="spend__max"> / {max} min</span>}
        {max === null && ' min'}
      </span>
      {ratio !== null && (
        <span className="meter" aria-hidden="true">
          <span
            className={`meter__fill${ratio >= 1 ? ' meter__fill--over' : ratio >= 0.8 ? ' meter__fill--warn' : ''}`}
            style={{ width: `${String(Math.round(ratio * 100))}%` }}
          />
        </span>
      )}
    </div>
  );
}

/** Running spend against the budget. On a subscription the cost is an API-equivalent estimate. */
function Spend({
  cat,
  usage,
  adapter,
}: {
  cat: Cat;
  usage: Usage | undefined;
  adapter: AdapterInfo | undefined;
}) {
  if (adapter && !adapter.capabilities.reportsCost) return <TimeSpend cat={cat} usage={usage} />;
  const spent = usage?.costUsd ?? null;
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  const estimate = cat.billing === 'subscription' || usage?.costSource === 'estimated';
  const max = cat.budget.maxUsd;
  const ratio = spent !== null && max !== null ? Math.min(1, spent / max) : null;
  return (
    <div className="spend" title={estimate ? 'API-equivalent estimate' : 'Reported by the agent'}>
      <span className="spend__text">
        {spent === null
          ? 'cost unknown'
          : `${estimate ? '≈ ' : ''}$${spent.toFixed(spent < 1 ? 3 : 2)}`}
        {max !== null && <span className="spend__max"> / ${max.toFixed(2)}</span>}
        <span className="spend__tokens"> · {tokens.toLocaleString()} tokens</span>
      </span>
      {ratio !== null && (
        <span className="meter" aria-hidden="true">
          <span
            className={`meter__fill${ratio >= 1 ? ' meter__fill--over' : ratio >= 0.8 ? ' meter__fill--warn' : ''}`}
            style={{ width: `${String(Math.round(ratio * 100))}%` }}
          />
        </span>
      )}
    </div>
  );
}
