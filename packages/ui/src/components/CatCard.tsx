import type { Cat, PendingApproval, ToolKind, Usage } from '@agentcats/protocol';

import { CatSprite } from './Cat.js';
import { InlineText } from './InlineText.js';

const STATUS_LABEL: Record<Cat['status'], string> = {
  idle: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  blocked: 'Blocked',
  waiting_approval: 'Needs your approval',
  done: 'Done',
  error: 'Error',
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
  readonly approval: PendingApproval | undefined;
  readonly usage: Usage | undefined;
  /** Latest agent text, shown in the thought bubble. */
  readonly lastMessage: string | null;
  readonly onApprove: (approvalId: string, decision: 'allow' | 'deny') => void;
  readonly onKill: () => void;
}

export function CatCard({ cat, approval, usage, lastMessage, onApprove, onKill }: CatCardProps) {
  const sessionActive = cat.status !== 'idle' && cat.status !== 'done' && cat.status !== 'error';
  return (
    <section className={`cat-card cat-card--${cat.status}`} aria-label={`Cat ${cat.name}`}>
      <div className="cat-card__stage">
        <Bubble cat={cat} approval={approval} lastMessage={lastMessage} onApprove={onApprove} />
        <CatSprite status={cat.status} />
      </div>
      <div className="cat-card__meta">
        <h2 className="cat-card__name">{cat.name}</h2>
        <p
          className={`status-pill status-pill--${cat.status}`}
          data-testid="cat-status"
          aria-live="polite"
        >
          {STATUS_LABEL[cat.status]}
        </p>
        <p className="cat-card__detail">
          {cat.adapter} · {cat.model ?? 'default model'} · {cat.permissionMode.replace('_', ' ')}
        </p>
        {usage && <UsageLine usage={usage} />}
        <button
          type="button"
          className="button button--ghost"
          onClick={onKill}
          disabled={!sessionActive}
        >
          Stop
        </button>
      </div>
    </section>
  );
}

function Bubble({
  cat,
  approval,
  lastMessage,
  onApprove,
}: Pick<CatCardProps, 'cat' | 'approval' | 'lastMessage' | 'onApprove'>) {
  if (approval) {
    return (
      <div className="bubble bubble--approval" role="alertdialog" aria-label="Approval request">
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
      return (
        <div className="bubble bubble--done" data-testid="bubble">
          <p className="bubble__text">
            <InlineText text={lastMessage ?? 'Done!'} />
          </p>
        </div>
      );
    case 'error':
      return (
        <div className="bubble bubble--error" role="alert" data-testid="bubble">
          <p className="bubble__title">Something went wrong</p>
          <p className="bubble__text">{cat.statusReason ?? 'Unknown error'}</p>
        </div>
      );
    case 'blocked':
      return (
        <div className="bubble bubble--error" data-testid="bubble">
          <p className="bubble__title">Blocked</p>
          <p className="bubble__text">{cat.statusReason ?? 'Waiting on something'}</p>
        </div>
      );
    case 'idle':
    case 'waiting_approval':
      return null;
  }
}

function UsageLine({ usage }: { usage: Usage }) {
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost =
    usage.costUsd === null
      ? 'cost unknown'
      : `${usage.costSource === 'estimated' ? '≈ ' : ''}$${usage.costUsd.toFixed(4)}`;
  return (
    <p className="cat-card__usage" title={`Cost source: ${usage.costSource}`}>
      {tokens.toLocaleString()} tokens · {cost}
      {usage.costSource === 'estimated' && <span className="tag">estimate</span>}
    </p>
  );
}
