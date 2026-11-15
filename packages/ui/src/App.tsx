import {
  type AgentcatsEvent,
  type BoardState,
  type Cat,
  levelSpec,
  prepareExport,
  type Task,
  usagePoints,
  catNames,
} from '@agentcats/protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ApiRequestError, type BoardClient, type ConnectionState } from './board-client.js';
import { Canvas, type CanvasApi } from './components/Canvas.js';
import { CatCard } from './components/CatCard.js';
import { ChatPanel } from './components/ChatPanel.js';
import { CatDrawer, TaskDrawer } from './components/Drawers.js';
import { EventLog, xpText } from './components/EventLog.js';
import {
  Dialog,
  HireDialog,
  InterviewPanel,
  hireAnnouncement,
  RetiredList,
  RetireDialog,
} from './components/Hiring.js';
import { LearningsSection, LevelSection, levelPerks } from './components/Learnings.js';
import { ReplayBar, SessionPicker } from './components/Replay.js';
import { SettingsDialog } from './components/Settings.js';
import { SpendMeter } from './components/SpendMeter.js';
import { catBox, needsYou, Office, placeCats } from './components/Office.js';
import { TaskCard } from './components/TaskCard.js';
import { ReplayPlayer } from './replay.js';
import { applyTheme, storedTheme, type Theme, THEMES } from './theme.js';

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Token rejected',
  replay: 'Replay',
};

const THEME_LABEL: Record<Theme, string> = { system: 'system', light: 'light', dark: 'dark' };
const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' };

type Panel = 'chat' | 'tasks' | 'events';
const PANELS_KEY = 'agentcats:panel';
/** Width of the dock on the right and of the details panel on the left, with their margin. */
const DOCK_WIDTH = 424;
const DETAILS_WIDTH = 484;
/** A narrow screen, where panels become bottom sheets (`styles.css` agrees). */
const NARROW = '(width < 640px)';
/** How much of a narrow screen's height an open sheet takes, with its tab bar. */
const SHEET_SHARE = 0.55;

/** Whether the screen is narrow, and its height, kept current. */
function useScreen(): { narrow: boolean; height: number } {
  const read = () => ({ narrow: window.matchMedia(NARROW).matches, height: window.innerHeight });
  const [screen, setScreen] = useState(read);
  useEffect(() => {
    const update = () => {
      setScreen(read);
    };
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
    };
  }, []);
  return screen;
}

/** The panel left open last time; the chat on a first visit. */
function storedPanel(): Panel | null {
  try {
    const value = localStorage.getItem(PANELS_KEY);
    if (value === null) return 'chat';
    return value === 'chat' || value === 'tasks' || value === 'events' ? value : null;
  } catch {
    return 'chat';
  }
}

function storePanel(panel: Panel | null): void {
  try {
    localStorage.setItem(PANELS_KEY, panel ?? 'none');
  } catch {
    // Storage blocked: the panels open as on a first visit.
  }
}

interface Replay {
  readonly player: ReplayPlayer;
  readonly label: string;
  /** What an export needs; `null` for an imported file, which already is one. */
  readonly source: {
    readonly initialBoard: BoardState;
    readonly events: readonly AgentcatsEvent[];
    readonly projectPath: string;
    readonly homeDir: string;
    readonly startedAt: number;
  } | null;
}

/** Save a JSON file through the browser. */
function download(name: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1_000);
}

const fileStamp = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace(/[:T]/g, '-');

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
  const [replay, setReplay] = useState<Replay | null>(null);
  const [picking, setPicking] = useState(false);
  const [meter, setMeter] = useState(false);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const source = replay?.player ?? client;
  const view = useSyncExternalStore(source.subscribe, source.getView);
  useEffect(() => () => replay?.player.dispose(), [replay]);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [hiring, setHiring] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [panel, setPanelState] = useState<Panel | null>(storedPanel);
  const setPanel = (next: Panel | null) => {
    setPanelState(next);
    storePanel(next);
  };
  const canvas = useRef<CanvasApi>(null);
  const screen = useScreen();
  /** The last cat `N` brought into view. */
  const attentionStep = useRef(-1);
  const [retiring, setRetiring] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<readonly { id: number; text: string }[]>([]);
  const { board, events } = view;

  const cats = useMemo(
    () => Object.values(board.cats).sort((a, b) => a.createdAt - b.createdAt),
    [board.cats],
  );
  const lead = cats.find((c) => c.role === 'orchestrator');
  const workers = cats.filter((c) => c.role === 'worker');
  const attention = [...(lead ? [lead] : []), ...workers].filter(needsYou);
  const attentionBoxes = (list: readonly Cat[]) => {
    const spots = placeCats(lead, workers);
    return list.flatMap((cat) => {
      const spot = spots.get(cat.id);
      return spot ? [catBox(cat, spot)] : [];
    });
  };
  /** Bring every cat that needs you into view. */
  const showAttention = () => {
    const boxes = attentionBoxes(attention);
    if (boxes.length === 0) return;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    canvas.current?.show({
      x,
      y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
    });
  };
  /** Bring the next cat that needs you into view and give it focus, for A, D and P. */
  const stepAttention = () => {
    if (attention.length === 0) return;
    attentionStep.current = (attentionStep.current + 1) % attention.length;
    const cat = attention[attentionStep.current];
    const box = cat && attentionBoxes([cat])[0];
    if (!cat || !box) return;
    canvas.current?.show(box);
    document
      .querySelector<HTMLElement>(`.cat-token[data-cat="${CSS.escape(cat.name)}"] button`)
      ?.focus({ preventScroll: true });
  };
  const stepAttentionRef = useRef(stepAttention);
  useEffect(() => {
    stepAttentionRef.current = stepAttention;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return;
      e.preventDefault();
      stepAttentionRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
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

  /** A candidate's name, also after it left the board, from its `cat.created` event. */
  const candidateName = (catId: string) => {
    const created = events.find((e) => e.type === 'cat.created' && e.catId === catId);
    return board.cats[catId]?.name ?? (created?.type === 'cat.created' ? created.payload.name : '');
  };
  // Recent good news: level changes and new learning suggestions, for a few seconds.
  const now = useNow(events.at(-1)?.ts ?? 0);
  const recent = events.filter((e) => now - e.ts < FLASH_MS);
  const infoToasts = recent
    .flatMap((e) => {
      const name = e.catId
        ? (board.cats[e.catId]?.name ?? board.retired[e.catId]?.cat.name)
        : undefined;
      if (!name || !e.catId || dismissed.has(e.id)) return [];
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
      if (e.type === 'cat.retired') {
        return [{ id: e.id, catId: e.catId, text: `📦 ${name} retired: ${e.payload.reason}` }];
      }
      if (e.type === 'cat.hired') {
        const interview = board.interviews[e.payload.interviewId];
        const losers = (interview?.candidates ?? [])
          .filter((c) => c.catId !== e.catId)
          .map((c) => candidateName(c.catId))
          .filter(Boolean);
        return [
          {
            id: e.id,
            catId: e.catId,
            text: hireAnnouncement(name, losers),
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
  // A caption about a cat on the board sits on its card; any other (a retired cat,
  // rejected candidates) is a toast.
  const memeToasts = recent
    .filter(
      (e): e is Extract<AgentcatsEvent, { type: 'caption' }> =>
        e.type === 'caption' && !(e.catId && board.cats[e.catId]) && !dismissed.has(e.id),
    )
    .slice(-2);
  const promotedRecently = (catId: string) =>
    recent.some(
      (e) => e.type === 'cat.level_changed' && e.catId === catId && e.payload.to > e.payload.from,
    );
  const captionOf = (catId: string) => {
    const caption = recent.findLast((e) => e.type === 'caption' && e.catId === catId);
    return caption?.type === 'caption' ? { id: caption.id, text: caption.payload.text } : null;
  };
  const xpPopOf = (catId: string) => {
    const xp = recent.findLast((e) => e.type === 'xp.changed' && e.catId === catId);
    if (xp?.type !== 'xp.changed') return null;
    const total = recent
      .filter((e) => e.type === 'xp.changed' && e.catId === catId && e.taskId === xp.taskId)
      .reduce((sum, e) => sum + (e.type === 'xp.changed' ? e.payload.delta : 0), 0);
    return { id: xp.id, text: `${xpText(total)} XP` };
  };
  const interviews = Object.values(board.interviews)
    .filter((i) => ['proposed', 'running', 'deciding'].includes(i.status))
    .sort((a, b) => a.createdAt - b.createdAt);
  const retiredCats = Object.values(board.retired).sort(
    (a, b) => b.retired.retiredAt - a.retired.retiredAt,
  );
  const proposalsOf = (catId: string) =>
    Object.values(board.proposals)
      .filter((p) => p.catId === catId)
      .sort((a, b) => a.createdAt - b.createdAt);

  const readOnly = () => {
    setErrors((list) => [
      ...list.slice(-2),
      { id: Date.now(), text: 'This is a replay: nothing can be changed. Exit the replay first.' },
    ]);
  };

  /** Run a request, showing its error as a toast. Resolves to whether it worked. */
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (replay) {
      readOnly();
      return false;
    }
    try {
      await action();
      return true;
    } catch (error) {
      const text = error instanceof ApiRequestError ? error.message : String(error);
      setErrors((list) => [...list.slice(-2), { id: Date.now(), text }]);
      return false;
    }
  }

  const loadSettings = useCallback(async () => {
    try {
      return await client.request('settings');
    } catch (error) {
      const text = error instanceof ApiRequestError ? error.message : String(error);
      setErrors((list) => [...list.slice(-2), { id: Date.now(), text }]);
      return null;
    }
  }, [client]);

  const loadSamples = useCallback(
    async () => (await client.request('interviewSamples')).samples,
    [client],
  );
  const loadRetireCheck = useCallback(
    () => client.request('retireCheck', { catId: retiring ?? '' }),
    [client, retiring],
  );

  const openTaskId = drawer?.kind === 'task' ? drawer.id : null;
  // Stable per open task, so the drawer refetches only when the task changes.
  const loadHistory = useCallback(
    async () =>
      !openTaskId
        ? []
        : replay
          ? replay.player.getView().events.filter((e) => e.taskId === openTaskId)
          : (await client.request('taskEvents', { taskId: openTaskId })).events,
    [client, openTaskId, replay],
  );

  // In a replay, spending comes from the replayed events, not from the live daemon.
  const loadUsage = useCallback(
    async () =>
      replay
        ? {
            points: usagePoints(replay.player.getView().events),
            names: catNames(replay.player.getView().events),
          }
        : client.request('usage'),
    [client, replay],
  );

  const loadSessions = useCallback(
    async () => (await client.request('sessions')).sessions,
    [client],
  );

  const catCard = (
    cat: Cat,
    size: 'lead' | 'worker',
    layout: 'card' | 'token' = 'card',
    part?: 'token' | 'overlay',
  ) => (
    <CatCard
      key={cat.id}
      cat={cat}
      size={size}
      layout={layout}
      {...(part && { part })}
      promoted={promotedRecently(cat.id)}
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
      caption={captionOf(cat.id)}
      pendingLearnings={proposalsOf(cat.id).length}
      retireSuggestion={board.retireProposals[cat.id]?.reason ?? null}
      adapter={view.adapters.find((a) => a.id === cat.adapter)}
      onReviewRetire={() => {
        setRetiring(cat.id);
      }}
      onDismissRetire={() => void run(() => client.request('dismissRetire', { catId: cat.id }))}
      readOnly={replay !== null}
    />
  );

  /** Run a request and return its result, or `null` after showing its error. */
  async function fetchOrNull<T>(action: () => Promise<T>): Promise<T | null> {
    let result: T | null = null;
    const ok = await run(async () => {
      result = await action();
    });
    return ok ? result : null;
  }

  const openTask = drawer?.kind === 'task' ? board.tasks[drawer.id] : undefined;
  const retiringCat = retiring ? board.cats[retiring] : undefined;
  const openCat = drawer?.kind === 'cat' ? board.cats[drawer.id] : undefined;

  return (
    <div className={`app${replay ? ' app--replay' : ''}`}>
      <header className="app__header">
        <h1 className="app__title">
          agent<span>cats</span>
        </h1>
        <div className="app__header-right">
          {attention.length > 0 && (
            <button
              type="button"
              className="button button--small needs-you"
              aria-keyshortcuts="N"
              title="Show the cats that need you (N steps through them)"
              onClick={showAttention}
            >
              Needs you <span className="needs-you__count">{attention.length}</span>
            </button>
          )}
          {!replay && (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setPicking(true);
              }}
            >
              Replay
            </button>
          )}
          {!replay && (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setHiring(true);
              }}
            >
              Hire a cat
            </button>
          )}
          {!replay && (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setSettingsOpen(true);
              }}
            >
              Settings
            </button>
          )}
          <button
            type="button"
            className="team-spend"
            title={`${estimated ? 'Includes API-equivalent estimates. ' : ''}Open the cost meter`}
            onClick={() => {
              setMeter(true);
            }}
          >
            Team spend {estimated ? '≈ ' : ''}${spent.toFixed(2)}
          </button>
          <button
            type="button"
            className="button button--small button--ghost theme-switch"
            aria-label={`Theme: ${THEME_LABEL[theme]}. Switch theme`}
            title={`Theme: ${THEME_LABEL[theme]}`}
            onClick={() => {
              const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system';
              applyTheme(next);
              setTheme(next);
            }}
          >
            {THEME_ICON[theme]}
          </button>
          <span className={`connection connection--${view.connection}`} data-testid="connection">
            {CONNECTION_LABEL[view.connection]}
          </span>
        </div>
      </header>

      <main className="board">
        <Canvas
          apiRef={canvas}
          // On a narrow screen the panels are bottom sheets.
          coveredLeft={drawer && !screen.narrow ? DETAILS_WIDTH : 0}
          coveredRight={panel && !screen.narrow ? DOCK_WIDTH : 0}
          coveredBottom={
            screen.narrow && (panel || drawer) ? Math.round(screen.height * SHEET_SHARE) : 0
          }
          // The view is remembered per project; the lead is the project's own.
          storageKey={replay || !lead ? null : `agentcats:view:${lead.id}`}
        >
          <Office
            lead={lead}
            workers={workers}
            detailsOf={drawer?.kind === 'cat' ? drawer.id : null}
            retired={retiredCats}
            {...(!replay && {
              onBringBack: (catId: string) =>
                void run(() => client.request('resurrectCat', { catId })),
            })}
            renderCat={(cat, part) =>
              catCard(cat, cat.role === 'orchestrator' ? 'lead' : 'worker', 'token', part)
            }
            empty={
              <p className="board__empty">
                {replay ? 'No cats yet at this point of the replay.' : 'Waiting for the daemon…'}
              </p>
            }
            noWorkers={
              <p className="board__empty">
                No workers yet. They are hired when {lead?.name ?? 'the lead'} hands out tasks.
              </p>
            }
          />
        </Canvas>
        {interviews.length > 0 && (
          <div className="board__interviews">
            {interviews.map((interview) => (
              <InterviewPanel
                key={interview.id}
                interview={interview}
                cats={board.cats}
                renderCandidate={(cat) => catCard(cat, 'worker')}
                onStart={() =>
                  void run(() => client.request('startInterview', { interviewId: interview.id }))
                }
                onCancel={() =>
                  void run(() => client.request('cancelInterview', { interviewId: interview.id }))
                }
                onPick={(catId) =>
                  void run(() =>
                    client.request('pickCandidate', { interviewId: interview.id }, { catId }),
                  )
                }
              />
            ))}
          </div>
        )}
        <aside className={`dock${panel ? '' : ' dock--closed'}`} aria-label="Panels">
          <div className="dock__tabs" role="tablist">
            {(['chat', 'tasks', 'events'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={panel === id}
                className="dock__tab"
                onClick={() => {
                  setPanel(panel === id ? null : id);
                }}
              >
                {id === 'chat'
                  ? 'Chat'
                  : id === 'tasks'
                    ? `Tasks ${String(tasks.length)}`
                    : 'Events'}
              </button>
            ))}
          </div>
          <div className="dock__panel" hidden={panel !== 'chat'}>
            <ChatPanel
              cat={lead}
              events={events}
              live={view.connection === 'live'}
              readOnly={replay !== null}
              onSend={(text) => run(() => client.request('chat', {}, { text }))}
            />
          </div>
          {
            <div className="dock__panel dock__panel--scroll" hidden={panel !== 'tasks'}>
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
              <RetiredList
                retired={retiredCats}
                onResurrect={(catId) => void run(() => client.request('resurrectCat', { catId }))}
              />
            </div>
          }
          <div className="dock__panel" hidden={panel !== 'events'}>
            <EventLog events={events} />
          </div>
        </aside>
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
            adapters={view.adapters}
            usage={board.usage[openCat.id]}
            canNudge={
              openCat.role === 'worker' &&
              activeTask(openCat.id) !== null &&
              openCat.pausedReason === null
            }
            onSave={(patch) => run(() => client.request('updateCat', { catId: openCat.id }, patch))}
            onNudge={() => void run(() => client.request('nudgeCat', { catId: openCat.id }, {}))}
            {...(openCat.role === 'worker' && {
              onRetire: () => {
                setDrawer(null);
                setRetiring(openCat.id);
              },
            })}
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
                    run(() => client.request('addLearning', { catId: openCat.id }, { text }))
                  }
                  onEdit={(learningId, text) =>
                    run(() =>
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
      </main>

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
        {memeToasts.map((e) => (
          <div key={e.id} className="toast toast--meme" role="status">
            <span className="toast__meme-text">{e.payload.text}</span>
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label="Dismiss"
              onClick={() => {
                setDismissed((set) => new Set([...set, e.id]));
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

      {settingsOpen && (
        <SettingsDialog
          adapters={view.adapters}
          cats={lead ? [lead, ...workers] : workers}
          load={loadSettings}
          save={(scope, settings, moveCats) =>
            fetchOrNull(() => client.request('saveSettings', {}, { scope, settings, moveCats }))
          }
          onClose={() => {
            setSettingsOpen(false);
          }}
        />
      )}
      {hiring && (
        <HireDialog
          defaultCandidates={2}
          loadSamples={loadSamples}
          adapters={view.adapters}
          onPropose={async (role, sampleId, candidates, adapters) => {
            let planned = null;
            await run(async () => {
              planned = (
                await client.request(
                  'proposeInterview',
                  {},
                  {
                    role,
                    sampleId,
                    candidates,
                    ...(view.adapters.length > 1 && { adapters: [...adapters] }),
                  },
                )
              ).interview;
            });
            return planned;
          }}
          onStart={(interviewId) => run(() => client.request('startInterview', { interviewId }))}
          onCancel={(interviewId) =>
            void run(() => client.request('cancelInterview', { interviewId }))
          }
          onClose={() => {
            setHiring(false);
          }}
        />
      )}
      {retiringCat && (
        <RetireDialog
          key={retiringCat.id}
          cat={retiringCat}
          suggestedReason={board.retireProposals[retiringCat.id]?.reason ?? ''}
          loadCheck={loadRetireCheck}
          onRetire={(reason, openTask) =>
            run(() => client.request('retireCat', { catId: retiringCat.id }, { reason, openTask }))
          }
          onClose={() => {
            setRetiring(null);
          }}
        />
      )}
      {meter && (
        <Dialog
          title="Spend"
          wide
          onClose={() => {
            setMeter(false);
          }}
        >
          <SpendMeter board={board} adapters={view.adapters} loadUsage={loadUsage} />
        </Dialog>
      )}
      {picking && (
        <SessionPicker
          loadSessions={loadSessions}
          onClose={() => {
            setPicking(false);
          }}
          onPick={(session) => {
            void run(async () => {
              const res = await client.request('sessionEvents', { index: String(session.index) });
              setDrawer(null);
              setPicking(false);
              setReplay({
                player: new ReplayPlayer(res.initialBoard, res.events, client.getView().adapters),
                label: `session from ${new Date(session.startedAt).toLocaleDateString()}`,
                source: { ...res, startedAt: session.startedAt },
              });
            });
          }}
          onImport={(file, name) => {
            setDrawer(null);
            setPicking(false);
            setReplay({
              player: new ReplayPlayer(file.initialBoard, file.events, client.getView().adapters),
              label: `${name}${file.includesContents ? '' : ' (long texts cut)'}`,
              source: null,
            });
          }}
        />
      )}
      {replay && (
        <ReplayBar
          player={replay.player}
          label={replay.label}
          onExport={
            replay.source
              ? ((src) => (includeContents: boolean) => {
                  download(
                    `agentcats-session-${fileStamp(src.startedAt)}.json`,
                    prepareExport(src.initialBoard, src.events, { ...src, includeContents }),
                  );
                })(replay.source)
              : null
          }
          onExit={() => {
            setDrawer(null);
            setReplay(null);
          }}
        />
      )}
    </div>
  );
}
