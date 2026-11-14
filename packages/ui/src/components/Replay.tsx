import { SessionExport, type SessionSummary } from '@agentcats/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { IDLE_CAP_MS, REPLAY_SPEEDS, type ReplayPlayer, type ReplaySpeed } from '../replay.js';
import { Dialog } from './Hiring.js';

const dateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** `m:ss`, or `h:mm:ss` past an hour. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}

/** Pick a past session to replay, or import an exported one. */
export function SessionPicker({
  loadSessions,
  onPick,
  onImport,
  onClose,
}: {
  loadSessions: () => Promise<SessionSummary[]>;
  onPick: (session: SessionSummary) => void;
  onImport: (file: SessionExport, name: string) => void;
  onClose: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadSessions().then(
      (list) => {
        setSessions(list.slice().reverse());
      },
      (e: unknown) => {
        setError(String(e));
      },
    );
  }, [loadSessions]);

  async function importFile(file: File) {
    try {
      const parsed = SessionExport.safeParse(JSON.parse(await file.text()));
      if (!parsed.success) {
        setError(`${file.name} is not an agentcats session file.`);
        return;
      }
      onImport(parsed.data, file.name);
    } catch {
      setError(`${file.name} is not valid JSON.`);
    }
  }

  return (
    <Dialog title="Replay a session" onClose={onClose}>
      <p className="replay-picker__hint">
        A session is one run of agentcats. Replays are read-only: nothing is sent to the cats.
      </p>
      {error && <p className="replay-picker__error">{error}</p>}
      {sessions === null && !error && <p className="replay-picker__hint">Loading…</p>}
      {sessions?.length === 0 && <p className="replay-picker__hint">No sessions yet.</p>}
      {sessions && sessions.length > 0 && (
        <ul className="replay-picker__list" aria-label="Sessions">
          {sessions.map((s, i) => (
            <li key={s.index}>
              <button
                type="button"
                className="replay-picker__session"
                onClick={() => {
                  onPick(s);
                }}
              >
                <span className="replay-picker__when">
                  {dateTime(s.startedAt)}
                  {i === 0 && <span className="replay-picker__badge">This run</span>}
                </span>
                <span className="replay-picker__meta">
                  {clock(s.endedAt - s.startedAt)} · {String(s.eventCount)} events
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="button replay-picker__import">
        Import a session file…
        <input
          type="file"
          accept=".json,application/json"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importFile(file);
            e.target.value = '';
          }}
        />
      </label>
    </Dialog>
  );
}

/** Play, pause, speed, scrub, export and leave a replay. Sits at the bottom of the board. */
export function ReplayBar({
  player,
  label,
  onExport,
  onExit,
}: {
  player: ReplayPlayer;
  label: string;
  /** `null` for an imported file: it is already an export. */
  onExport: ((includeContents: boolean) => void) | null;
  onExit: () => void;
}) {
  const state = useSyncExternalStore(player.subscribe, player.getState);
  const [exporting, setExporting] = useState(false);
  const [contents, setContents] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (state.playing) player.pause();
        else player.play();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [player, state.playing]);

  return (
    <section className="replay-bar" aria-label="Replay">
      <div className="replay-bar__row">
        <button
          type="button"
          className="button button--primary replay-bar__play"
          aria-label={state.playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (state.playing) player.pause();
            else player.play();
          }}
        >
          {state.playing ? '❚❚' : '▶'}
        </button>
        <label className="replay-bar__speed">
          <span className="visually-hidden">Speed</span>
          <select
            value={state.speed}
            onChange={(e) => {
              player.setSpeed(Number(e.target.value) as ReplaySpeed);
            }}
          >
            {REPLAY_SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {String(speed)}×
              </option>
            ))}
          </select>
        </label>
        <input
          type="range"
          className="replay-bar__scrub"
          aria-label="Position"
          min={0}
          max={Math.max(state.duration, 1)}
          step="any"
          value={state.position}
          onChange={(e) => {
            player.seek(Number(e.target.value));
          }}
        />
        <span className="replay-bar__time" data-testid="replay-time">
          {clock(state.position)} / {clock(state.duration)}
        </span>
      </div>
      <div className="replay-bar__row replay-bar__row--meta">
        <span
          className="replay-bar__label"
          title={`Pauses longer than ${String(IDLE_CAP_MS / 1000)} s are shortened`}
        >
          <strong>Replay</strong> · {label} · {dateTime(state.at)} · event {String(state.shown)} of{' '}
          {String(state.total)}
        </span>
        <span className="replay-bar__actions">
          {onExport && !exporting && (
            <button
              type="button"
              className="button button--small"
              onClick={() => {
                setExporting(true);
              }}
            >
              Export…
            </button>
          )}
          {onExport && exporting && (
            <span className="replay-bar__export">
              <label>
                <input
                  type="checkbox"
                  checked={contents}
                  onChange={(e) => {
                    setContents(e.target.checked);
                  }}
                />{' '}
                Include file contents and long outputs
              </label>
              <button
                type="button"
                className="button button--small button--primary"
                onClick={() => {
                  onExport(contents);
                  setExporting(false);
                }}
              >
                Download
              </button>
            </span>
          )}
          <button type="button" className="button button--small" onClick={onExit}>
            Exit replay
          </button>
        </span>
      </div>
    </section>
  );
}
