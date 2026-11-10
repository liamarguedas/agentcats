import type { AgentcatsEvent, Cat } from '@agentcats/protocol';
import { useEffect, useMemo, useRef } from 'react';

import { InlineText } from './InlineText.js';
import { PromptBox } from './PromptBox.js';

interface ChatMessage {
  readonly key: string;
  readonly from: 'user' | 'cat';
  readonly text: string;
}

/** The conversation with one cat: your messages and its answers, chunks joined. */
function toMessages(events: readonly AgentcatsEvent[], catId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let openId: string | null = null;
  for (const event of events) {
    if (event.catId !== catId) continue;
    if (event.type === 'message.user') {
      messages.push({ key: event.id, from: 'user', text: event.payload.text });
      openId = null;
    } else if (event.type === 'message.agent' && event.payload.channel === 'text') {
      const last = messages.at(-1);
      if (last && openId === event.payload.messageId) {
        messages[messages.length - 1] = { ...last, text: last.text + event.payload.text };
      } else {
        messages.push({ key: event.id, from: 'cat', text: event.payload.text });
        openId = event.payload.messageId;
      }
    }
  }
  return messages;
}

const BUSY = new Set<Cat['status']>(['thinking', 'working', 'waiting_approval']);

export function ChatPanel({
  cat,
  events,
  live,
  onSend,
}: {
  cat: Cat | undefined;
  events: readonly AgentcatsEvent[];
  live: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const messages = useMemo(() => (cat ? toMessages(events, cat.id) : []), [events, cat]);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  const busy = cat !== undefined && BUSY.has(cat.status);
  return (
    <section className="panel chat" aria-label="Chat">
      <h2 className="panel__title">Chat with {cat?.name ?? 'the lead'}</h2>
      <ol ref={listRef} className="chat__list">
        {messages.length === 0 && (
          <li className="chat__empty">
            Tell {cat?.name ?? 'the lead cat'} what you want built. It plans the work and hands it
            to worker cats, each on its own branch.
          </li>
        )}
        {messages.map((m) => (
          <li key={m.key} className={`chat__msg chat__msg--${m.from}`}>
            <InlineText text={m.text} />
          </li>
        ))}
        {busy && (
          <li
            className="chat__msg chat__msg--cat chat__msg--typing"
            aria-label={`${cat.name} is thinking`}
          >
            <span className="dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </li>
        )}
      </ol>
      <PromptBox
        disabled={!cat || !live || busy || cat.pausedReason !== null}
        placeholder={
          busy ? `${cat.name} is busy…` : `Ask ${cat?.name ?? 'the lead'} to build something`
        }
        onSubmit={onSend}
      />
    </section>
  );
}
