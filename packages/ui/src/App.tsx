import { type AgentcatsEvent, type Cat, levelSpec, type Task } from '@agentcats/protocol';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { ApiRequestError, type BoardClient, type ConnectionState } from './board-client.js';
import { CatCard } from './components/CatCard.js';
import { ChatPanel } from './components/ChatPanel.js';
import { CatDrawer, TaskDrawer } from './components/Drawers.js';
import { EventLog, xpText } from './components/EventLog.js';
import { LearningsSection, LevelSection, levelPerks } from './components/Learnings.js';
import { TaskCard } from './components/TaskCard.js';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Token rejected',
};

type Drawer = { kind: 'task'; id: string } | { kind: 'cat'; id: string } | null;

/** Text of the most recent agent message from one cat, all chunks joined. */
function lastAgentMessage(
  events: readonly AgentcatsEvent[],
  catId: string,
  limit = 160,
): string | null {
  let messageId: string | null = null;
  const parts: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'message.agent' || event.catId !== catId) continue;
    messageId ??= event.payload.messageId;
    if (event.payload.messageId !== messageId) break;
    parts.unshift(event.payload.text);
  }
  if (parts.length === 0) return null;
  const text = parts.join('').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const ACTIVE_TASK = new Set<Task['status']>(['running', 'blocked']);

/** How long an XP pop-up or info toast stays up. */
const FLASH_MS = 6_000;

/**
 * The current time, ticking every second until {@link FLASH_MS} after the
 * latest event, so pop-ups and info toasts disappear on time.
 */
function useNow(latestTs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time - latestTs > FLASH_MS) clearInterval(timer);
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [latestTs]);
  return now;
}

/**
 * The backup that undoes a cat's last learnings change, when that change
 * was a consolidation or a restore.
 */
function undoVersionOf(events: readonly AgentcatsEvent[], catId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== 'learnings.changed' || event.catId !== catId) continue;
    return event.payload.backup;
  }
  return null;
}

export function App({ client }: { client: BoardClient }) {
  const view = useSyncExternalStore(client.subscribe, client.getView);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<readonly { id: number; text: string }[]>([]);
  const { board, events } = view;

  const cats = useMemo(
    () => Object.values(board.cats).sort((a, b) => a.createdAt - b.createdAt),
    [board.cats],
  );
  const lead = cats.find((c) => c.role === 'orchestrator');
  const workers = cats.filter((c) => c.role === 'worker');
  const tasks = useMemo(
    () => Object.values(board.tasks).sort((a, b) => b.createdAt - a.createdAt),
    [board.tasks],
  );
  const activeTask = (catId: string) =>
    tasks.find((t) => t.assigneeCatId === catId && ACTIVE_TASK.has(t.status)) ?? null;
  const approvalOf = (catId: string) =>
    Object.values(board.pendingApprovals).find((a) => a.catId === catId);
  const spent = Object.values(board.usage).reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
  const estimated =
    cats.some((c) => c.billing === 'subscription') ||
    Object.values(board.usage).some((u) => u.costSource === 'estimated');

  const notices = events
    .filter((e): e is Extract<AgentcatsEvent, { type: 'notice' }> => e.type === 'notice')
    .filter((e) => e.payload.level === 'warning' && !dismissed.has(e.id))
    .slice(-3)
    .reverse();

  // Recent good news: level changes and new learning suggestions, for a few seconds.
  const now = useNow(events.at(-1)?.ts ?? 0);
  const recent = events.filter((e) => now - e.ts < FLASH_MS);
  const infoToasts = recent
    .flatMap((e) => {
      const name = e.catId ? board.cats[e.catId]?.name : undefined;
      if (!name || dismissed.has(e.id)) return [];
      if (e.type === 'cat.level_changed') {
        const up = e.payload.to > e.payload.from;
        const perks = levelPerks(levelSpec(e.payload.to)).join('; ').toLowerCase();
        return [
          {
            id: e.id,
            catId: e.catId,
            text: up
              ? `${name} reached level ${String(e.payload.to)}: ${perks}.`
              : `${name} dropped to level ${String(e.payload.to)}.`,
          },
        ];
      }
      if (e.type === 'learnings.proposed') {
        return [
          {
            id: e.id,
            catId: e.catId,
            text:
              e.payload.kind === 'add'
                ? `${name} suggests ${String(e.payload.lines.length)} new learning${e.payload.lines.length === 1 ? '' : 's'}.`
                : `${name} suggests a tidier learnings list.`,
          },
        ];
      }
      return [];
    })
    .slice(-3)
    .reverse();
  const xpPopOf = (catId: string) => {
    const xp = recent.findLast((e) => e.type === 'xp.changed' && e.catId === catId);
    if (xp?.type !== 'xp.changed') return null;
    const total = recent
      .filter((e) => e.type === 'xp.changed' && e.catId === catId && e.taskId === xp.taskId)
      .reduce((sum, e) => sum + (e.type === 'xp.changed' ? e.payload.delta : 0), 0);
    return { id: xp.id, text: `${xpText(total)} XP` };
  };
  const proposalsOf = (catId: string) =>
    Object.values(board.proposals)
      .filter((p) => p.catId === catId)
      .sort((a, b) => a.createdAt - b.createdAt);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      const text = error instanceof ApiRequestError ? error.message : String(error);
      setErrors((list) => [...list.slice(-2), { id: Date.now(), text }]);
    }
  }

  const openTaskId = drawer?.kind === 'task' ? drawer.id : null;
  // Stable per open task, so the drawer refetches only when the task changes.
  const loadHistory = useCallback(
    async () =>
      openTaskId ? (await client.request('taskEvents', { taskId: openTaskId })).events : [],
    [client, openTaskId],
  );

  const catCard = (cat: Cat, size: 'lead' | 'worker') => (
    <CatCard
      key={cat.id}
      cat={cat}
      size={size}
      approval={approvalOf(cat.id)}
      usage={board.usage[cat.id]}
      task={activeTask(cat.id)}
      lastMessage={lastAgentMessage(events, cat.id)}
      onApprove={(approvalId, decision) =>
        void run(() => client.request('resolveApproval', { approvalId }, { decision }))
      }
      onKill={() => void run(() => client.request('killCat', { catId: cat.id }))}
      onPause={() => void run(() => client.request('pauseCat', { catId: cat.id }))}
      onResume={() => void run(() => client.request('resumeCat', { catId: cat.id }))}
      onOpen={() => {
        setDrawer({ kind: 'cat', id: cat.id });
      }}
      xpPop={xpPopOf(cat.id)}
      pendingLearnings={proposalsOf(cat.id).length}
    />
  );

  /** Run a request and report whether it worked, for forms that keep their input on failure. */
  async function attempt(action: () => Promise<unknown>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      const text = error instanceof ApiRequestError ? error.message : String(error);
      setErrors((list) => [...list.slice(-2), { id: Date.now(), text }]);
      return false;
    }
  }

  const openTask = drawer?.kind === 'task' ? board.tasks[drawer.id] : undefined;
  const openCat = drawer?.kind === 'cat' ? board.cats[drawer.id] : undefined;

  return (
    <div className={`app${drawer ? ' app--drawer-open' : ''}`}>
      <header className="app__header">
        <h1 className="app__title">
          agent<span>cats</span>
        </h1>
        <div className="app__header-right">
          <span
            className="team-spend"
            title={estimated ? 'Includes API-equivalent estimates' : 'Reported cost'}
          >
            Team spend {estimated ? '≈ ' : ''}${spent.toFixed(2)}
          </span>
          <span className={`connection connection--${view.connection}`} data-testid="connection">
            {CONNECTION_LABEL[view.connection]}
          </span>
        </div>
      </header>

      <main className="board">
        <div className="board__canvas">
          <section className="board__lead" aria-label="Lead">
            {lead ? catCard(lead, 'lead') : <p className="board__empty">Waiting for the daemon…</p>}
          </section>
          <section className="board__team" aria-label="Workers">
            {workers.length === 0 ? (
              <p className="board__empty">
                No workers yet. They are hired when {lead?.name ?? 'the lead'} hands out tasks.
              </p>
            ) : (
              workers.map((w) => {
                const task = activeTask(w.id);
                return (
                  <div key={w.id} className="seat">
                    {catCard(w, 'worker')}
                    {task && (
                      <TaskCard
                        task={task}
                        cat={w}
                        onOpen={() => {
                          setDrawer({ kind: 'task', id: task.id });
                        }}
                      />
                    )}
                  </div>
                );
              })
            )}
          </section>
          <section className="board__tasks" aria-label="Tasks">
            <h2 className="section-title">
              Tasks <span className="panel__count">{tasks.length}</span>
            </h2>
            {tasks.length === 0 ? (
              <p className="board__empty">No tasks yet.</p>
            ) : (
              <div className="task-grid">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    cat={task.assigneeCatId ? board.cats[task.assigneeCatId] : undefined}
                    onOpen={() => {
                      setDrawer({ kind: 'task', id: task.id });
                    }}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      <aside className="sidebar">
        <ChatPanel
          cat={lead}
          events={events}
          live={view.connection === 'live'}
          onSend={(text) => run(() => client.request('chat', {}, { text }))}
        />
        <EventLog events={events} />
      </aside>

      <div className="toasts" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className="toast toast--warning" role="status">
            <span>{n.payload.message}</span>
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label="Dismiss"
              onClick={() => {
                setDismissed((set) => new Set([...set, n.id]));
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {infoToasts.map((n) => (
          <div key={n.id} className="toast toast--info" role="status">
            <button
              type="button"
              className="toast__link"
              onClick={() => {
                setDismissed((set) => new Set([...set, n.id]));
                setDrawer({ kind: 'cat', id: n.catId });
              }}
            >
              {n.text}
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label="Dismiss"
              onClick={() => {
                setDismissed((set) => new Set([...set, n.id]));
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {errors.map((e) => (
          <div key={e.id} className="toast toast--error" role="alert">
            <span>{e.text}</span>
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label="Dismiss"
              onClick={() => {
                setErrors((list) => list.filter((x) => x.id !== e.id));
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {openTask && (
        <TaskDrawer
          task={openTask}
          cat={openTask.assigneeCatId ? board.cats[openTask.assigneeCatId] : undefined}
          loadHistory={loadHistory}
          onReview={(decision, note) =>
            void run(() =>
              client.request(
                'reviewTask',
                { taskId: openTask.id },
                { decision, ...(note && { note }) },
              ),
            )
          }
          onRerun={() => void run(() => client.request('rerunTask', { taskId: openTask.id }))}
          onCancel={() => void run(() => client.request('cancelTask', { taskId: openTask.id }))}
          onClose={() => {
            setDrawer(null);
          }}
        />
      )}
      {openCat && (
        <CatDrawer
          key={openCat.id}
          cat={openCat}
          usage={board.usage[openCat.id]}
          canNudge={
            openCat.role === 'worker' &&
            activeTask(openCat.id) !== null &&
            openCat.pausedReason === null
          }
          onSave={(patch) => run(() => client.request('updateCat', { catId: openCat.id }, patch))}
          onNudge={() => void run(() => client.request('nudgeCat', { catId: openCat.id }, {}))}
          onClose={() => {
            setDrawer(null);
          }}
        >
          {openCat.role === 'worker' && (
            <>
              <LevelSection cat={openCat} />
              <LearningsSection
                cat={openCat}
                proposals={proposalsOf(openCat.id)}
                tasks={board.tasks}
                undoVersion={undoVersionOf(events, openCat.id)}
                onAdd={(text) =>
                  attempt(() => client.request('addLearning', { catId: openCat.id }, { text }))
                }
                onEdit={(learningId, text) =>
                  attempt(() =>
                    client.request('editLearning', { catId: openCat.id, learningId }, { text }),
                  )
                }
                onDelete={(learningId) =>
                  void run(() =>
                    client.request('deleteLearning', { catId: openCat.id, learningId }),
                  )
                }
                onResolve={(proposalId, decision) =>
                  void run(() => client.request('resolveProposal', { proposalId }, { decision }))
                }
                onConsolidate={() =>
                  void run(() => client.request('consolidateLearnings', { catId: openCat.id }))
                }
                onRestore={(versionId) =>
                  void run(() =>
                    client.request('restoreLearnings', { catId: openCat.id }, { versionId }),
                  )
                }
                loadHistory={async () =>
                  (await client.request('learningsHistory', { catId: openCat.id })).versions
                }
                onOpenTask={(taskId) => {
                  setDrawer({ kind: 'task', id: taskId });
                }}
              />
            </>
          )}
        </CatDrawer>
      )}
    </div>
  );
}
