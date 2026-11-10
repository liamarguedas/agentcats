import type { AgentcatsEvent, Task } from '@agentcats/protocol';
import { useMemo, useState, useSyncExternalStore } from 'react';

import { ApiRequestError, type BoardClient, type ConnectionState } from './board-client.js';
import { CatCard } from './components/CatCard.js';
import { EventLog } from './components/EventLog.js';
import { PromptBox } from './components/PromptBox.js';

const BUSY = new Set(['thinking', 'working', 'waiting_approval', 'blocked']);
const TITLE_LIMIT = 200;

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Token rejected',
};

/** Text of the most recent agent message, all chunks joined. */
function lastAgentMessage(events: readonly AgentcatsEvent[], limit = 160): string | null {
  let messageId: string | null = null;
  const parts: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'message.agent') continue;
    messageId ??= event.payload.messageId;
    if (event.payload.messageId !== messageId) break;
    parts.unshift(event.payload.text);
  }
  if (parts.length === 0) return null;
  const text = parts.join('').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function App({ client }: { client: BoardClient }) {
  const view = useSyncExternalStore(client.subscribe, client.getView);
  const [actionError, setActionError] = useState<string | null>(null);

  const cat = Object.values(view.board.cats)[0];
  const approval = Object.values(view.board.pendingApprovals).find((a) => a.catId === cat?.id);
  const tasks = useMemo(
    () => Object.values(view.board.tasks).sort((a, b) => b.createdAt - a.createdAt),
    [view.board.tasks],
  );
  const lastMessage = useMemo(() => lastAgentMessage(view.events), [view.events]);
  const busy = cat !== undefined && BUSY.has(cat.status);

  async function run(action: () => Promise<unknown>) {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof ApiRequestError ? error.message : String(error));
    }
  }

  async function sendPrompt(text: string) {
    const firstLine = text.split('\n', 1)[0] ?? text;
    const title =
      firstLine.length > TITLE_LIMIT ? `${firstLine.slice(0, TITLE_LIMIT - 1)}…` : firstLine;
    await run(() =>
      client.request('createTask', {}, { title, description: text === title ? '' : text }),
    );
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">
          agent<span>cats</span>
        </h1>
        <span className={`connection connection--${view.connection}`} data-testid="connection">
          {CONNECTION_LABEL[view.connection]}
        </span>
      </header>

      <main className="board">
        <div className="board__canvas">
          {cat ? (
            <CatCard
              cat={cat}
              approval={approval}
              usage={view.board.usage[cat.id]}
              lastMessage={lastMessage}
              onApprove={(approvalId, decision) =>
                void run(() => client.request('resolveApproval', { approvalId }, { decision }))
              }
              onKill={() => void run(() => client.request('killCat', { catId: cat.id }))}
            />
          ) : (
            <p className="board__empty">
              {view.connection === 'live' ? 'No cats yet.' : 'Waiting for the daemon…'}
            </p>
          )}
        </div>
        <div className="board__prompt">
          <PromptBox
            disabled={!cat || busy || view.connection !== 'live'}
            placeholder={
              busy ? `${cat.name} is busy…` : 'Give the cat a task, e.g. "add a hello function"'
            }
            onSubmit={sendPrompt}
          />
          {actionError && (
            <p className="board__error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      </main>

      <aside className="sidebar">
        <TaskList tasks={tasks} />
        <EventLog events={view.events} />
      </aside>
    </div>
  );
}

function TaskList({ tasks }: { tasks: readonly Task[] }) {
  return (
    <section className="panel tasks" aria-label="Tasks">
      <h2 className="panel__title">
        Tasks <span className="panel__count">{tasks.length}</span>
      </h2>
      {tasks.length === 0 ? (
        <p className="panel__empty">No tasks yet.</p>
      ) : (
        <ul className="tasks__list">
          {tasks.map((task) => (
            <li key={task.id} className="tasks__item">
              <span className={`chip chip--${task.status}`}>{task.status}</span>
              <span className="tasks__title">{task.title}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
