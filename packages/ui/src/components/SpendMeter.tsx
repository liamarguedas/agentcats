import type { AdapterInfo, BoardState, Cat, Task, UsagePoint } from '@agentcats/protocol';
import { useEffect, useMemo, useState } from 'react';

import { clock } from './Replay.js';

/** Categorical slots, in fixed order (validated light and dark; see `--series-*` in styles.css). */
const SERIES = 8;
/** Past this many cats with a cost, the cheapest fold into "Other". */
const MAX_LINES = SERIES - 1;

export interface UsageData {
  readonly points: UsagePoint[];
  readonly globalBudgetUsd?: number | null;
  readonly names: Readonly<Record<string, string>>;
}

const usd = (n: number) => `$${n.toFixed(n >= 10 ? 0 : n > 0 && n < 0.1 ? 3 : 2)}`;
const hours = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60
    ? `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`
    : `${String(minutes)} min`;
};

interface Line {
  readonly key: string;
  readonly name: string;
  readonly slot: number;
  /** Cumulative cost, oldest first. */
  readonly points: readonly { ts: number; usd: number }[];
}

/** Cumulative cost per cat; cats beyond {@link MAX_LINES} are summed as "Other". */
function buildLines(points: readonly UsagePoint[], nameOf: (catId: string) => string): Line[] {
  const byCat = new Map<string, { ts: number; usd: number }[]>();
  for (const p of points) {
    if (p.costUsd === null) continue;
    const list = byCat.get(p.catId) ?? [];
    list.push({ ts: p.ts, usd: p.costUsd });
    byCat.set(p.catId, list);
  }
  // Slots follow the cat (first seen), not its rank, so a cat keeps its color.
  const cats = [...byCat.keys()];
  const total = (id: string) => byCat.get(id)?.at(-1)?.usd ?? 0;
  const shown = new Set(
    cats.length > MAX_LINES + 1
      ? [...cats].sort((a, b) => total(b) - total(a)).slice(0, MAX_LINES)
      : cats,
  );
  const lines: Line[] = cats
    .filter((id) => shown.has(id))
    .map((id) => ({
      key: id,
      name: nameOf(id),
      slot: cats.indexOf(id) % SERIES,
      points: byCat.get(id) ?? [],
    }));
  const rest = cats.filter((id) => !shown.has(id));
  if (rest.length > 0) {
    // "Other": the sum of the folded cats' cumulative cost at each of their points.
    const events = rest
      .flatMap((id) => (byCat.get(id) ?? []).map((p) => ({ ...p, id })))
      .sort((a, b) => a.ts - b.ts);
    const latest = new Map<string, number>();
    const merged = events.map((e) => {
      latest.set(e.id, e.usd);
      return { ts: e.ts, usd: [...latest.values()].reduce((s, v) => s + v, 0) };
    });
    lines.push({
      key: 'other',
      name: `Other (${String(rest.length)})`,
      slot: SERIES - 1,
      points: merged,
    });
  }
  return lines;
}

/** A line's value at a time: its last point at or before it (cost only grows between points). */
function valueAt(line: Line, ts: number): number {
  let value = 0;
  for (const p of line.points) {
    if (p.ts > ts) break;
    value = p.usd;
  }
  return value;
}

const W = 640;
const H = 220;
const PAD = { top: 12, right: 92, bottom: 26, left: 48 };

function CostChart({ lines }: { lines: readonly Line[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const all = lines.flatMap((l) => l.points);
  const t0 = Math.min(...all.map((p) => p.ts));
  const t1 = Math.max(...all.map((p) => p.ts), t0 + 60_000);
  const top = niceMax(Math.max(...all.map((p) => p.usd), 0.01));
  const x = (ts: number) => PAD.left + ((ts - t0) / (t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - v / top) * (H - PAD.top - PAD.bottom);
  const ticks = [0, top / 2, top];
  const path = (line: Line) => {
    let d = '';
    let last = 0;
    line.points.forEach((p, i) => {
      // Steps: cost is known only at each report, and holds until the next.
      d += i === 0 ? `M${x(p.ts)},${y(p.usd)}` : `H${x(p.ts)}V${y(p.usd)}`;
      last = p.ts;
    });
    return `${d}H${x(Math.max(last, t1))}`;
  };
  const time = (ts: number) =>
    new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const ends = lines
    .map((l) => ({ line: l, value: l.points.at(-1)?.usd ?? 0 }))
    .sort((a, b) => b.value - a.value);
  // Direct labels only for up to four lines, nudged apart so they never overlap.
  const labels: { line: Line; y: number }[] = [];
  if (lines.length <= 4) {
    for (const { line, value } of ends) {
      const wanted = y(value);
      const prev = labels.at(-1);
      labels.push({ line, y: prev ? Math.max(wanted, prev.y + 14) : wanted });
    }
  }
  const hoverTs =
    hover === null ? null : t0 + ((hover - PAD.left) / (W - PAD.left - PAD.right)) * (t1 - t0);

  return (
    <div className="spend-chart">
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label="Cost per cat over time"
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          setHover(px >= PAD.left && px <= W - PAD.right ? px : null);
        }}
        onMouseLeave={() => {
          setHover(null);
        }}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line
              className="spend-chart__grid"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
            />
            <text
              className="spend-chart__tick"
              x={PAD.left - 8}
              y={y(v)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {usd(v)}
            </text>
          </g>
        ))}
        <text className="spend-chart__tick" x={PAD.left} y={H - 6}>
          {time(t0)}
        </text>
        <text className="spend-chart__tick" x={W - PAD.right} y={H - 6} textAnchor="end">
          {time(t1)}
        </text>
        {lines.map((l) => (
          <path
            key={l.key}
            className="spend-chart__line"
            style={{ stroke: `var(--series-${String(l.slot + 1)})` }}
            d={path(l)}
          />
        ))}
        {labels.map(({ line, y: ly }) => (
          <text
            key={line.key}
            className="spend-chart__label"
            x={W - PAD.right + 8}
            y={ly}
            dominantBaseline="middle"
          >
            {line.name}
          </text>
        ))}
        {hover !== null && hoverTs !== null && (
          <g>
            <line
              className="spend-chart__crosshair"
              x1={hover}
              x2={hover}
              y1={PAD.top}
              y2={H - PAD.bottom}
            />
            {lines.map((l) => (
              <circle
                key={l.key}
                className="spend-chart__dot"
                cx={hover}
                cy={y(valueAt(l, hoverTs))}
                r={4}
                style={{ fill: `var(--series-${String(l.slot + 1)})` }}
              />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && hoverTs !== null && (
        <div
          className="spend-chart__tooltip"
          role="status"
          style={{ left: `${String((hover / W) * 100)}%` }}
        >
          <p className="spend-chart__tooltip-time">{time(hoverTs)}</p>
          {lines.map((l) => (
            <p key={l.key}>
              <span
                className="spend-chart__swatch"
                style={{ background: `var(--series-${String(l.slot + 1)})` }}
              />
              {l.name} <strong>{usd(valueAt(l, hoverTs))}</strong>
            </p>
          ))}
        </div>
      )}
      <ul className="spend-chart__legend" aria-label="Legend">
        {lines.map((l) => (
          <li key={l.key}>
            <span
              className="spend-chart__swatch"
              style={{ background: `var(--series-${String(l.slot + 1)})` }}
            />
            {l.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A round axis top: 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

/**
 * The cost meter: what the team spent, what is left, over time, and the
 * tasks that cost the most. Cats whose agent reports no cost are counted by
 * working time, never as $0.
 */
export function SpendMeter({
  board,
  adapters,
  loadUsage,
}: {
  board: BoardState;
  adapters: readonly AdapterInfo[];
  /** `globalBudgetUsd` is left out when it is not known (a replay). */
  loadUsage: () => Promise<UsageData>;
}) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    loadUsage().then(setData, (e: unknown) => {
      setError(String(e));
    });
  }, [loadUsage]);

  const cats: Cat[] = useMemo(
    () => [...Object.values(board.cats), ...Object.values(board.retired).map((r) => r.cat)],
    [board],
  );
  const nameOf = (id: string) =>
    cats.find((c) => c.id === id)?.name ?? data?.names[id] ?? 'Unknown cat';
  // As on the cat card: an agent that reports no cost makes the cat's cost unknown.
  const costBlind = (c: Cat) =>
    adapters.find((a) => a.id === c.adapter)?.capabilities.reportsCost === false ||
    board.usage[c.id]?.costUsd == null;
  const costed = cats.filter((c) => board.usage[c.id]?.costUsd != null);
  const unknown = cats.filter((c) => board.usage[c.id] && costBlind(c));
  const total = costed.reduce((s, c) => s + (board.usage[c.id]?.costUsd ?? 0), 0);
  const estimated = Object.values(board.usage).some((u) => u.costSource === 'estimated');
  const unknownMs = unknown.reduce((s, c) => s + (board.usage[c.id]?.activeMs ?? 0), 0);
  const lines = data ? buildLines(data.points, nameOf) : [];

  const tasks: Task[] = Object.values(board.tasks).filter((t) => t.result);
  const byCost = tasks
    .filter((t) => t.result?.costUsd != null)
    .sort((a, b) => (b.result?.costUsd ?? 0) - (a.result?.costUsd ?? 0))
    .slice(0, 5);
  const byTime = tasks
    .filter((t) => t.result?.costUsd == null && t.result?.activeMs != null)
    .sort((a, b) => (b.result?.activeMs ?? 0) - (a.result?.activeMs ?? 0))
    .slice(0, 5);

  return (
    <div className="cost-meter">
      <div className="cost-meter__tiles">
        <div className="cost-meter__tile">
          <p className="cost-meter__tile-label">
            Spent{estimated ? ' (API-equivalent estimate)' : ''}
          </p>
          <p className="cost-meter__tile-value">
            {estimated ? '≈ ' : ''}
            {usd(total)}
          </p>
        </div>
        {data && data.globalBudgetUsd !== undefined && (
          <div className="cost-meter__tile">
            <p className="cost-meter__tile-label">Team budget left</p>
            <p className="cost-meter__tile-value">
              {data.globalBudgetUsd === null
                ? 'No limit'
                : usd(Math.max(0, data.globalBudgetUsd - total))}
            </p>
            {data.globalBudgetUsd !== null && (
              <p className="cost-meter__tile-note">of {usd(data.globalBudgetUsd)}</p>
            )}
          </div>
        )}
        {unknown.length > 0 && (
          <div className="cost-meter__tile">
            <p className="cost-meter__tile-label">Cost unknown</p>
            <p className="cost-meter__tile-value">{hours(unknownMs)}</p>
            <p className="cost-meter__tile-note">
              working time of {String(unknown.length)} cat{unknown.length === 1 ? '' : 's'} whose
              agent reports no cost
            </p>
          </div>
        )}
      </div>

      <h3 className="cost-meter__heading">Cost over time</h3>
      {error && <p className="cost-meter__empty">{error}</p>}
      {!error && !data && <p className="cost-meter__empty">Loading…</p>}
      {data && lines.length === 0 && <p className="cost-meter__empty">Nothing spent yet.</p>}
      {data && lines.length > 0 && <CostChart lines={lines} />}

      <h3 className="cost-meter__heading">Per cat</h3>
      <div className="cost-meter__table-wrap">
        <table className="cost-meter__table">
          <thead>
            <tr>
              <th scope="col">Cat</th>
              <th scope="col">Spent</th>
              <th scope="col">Budget left</th>
              <th scope="col">Working time</th>
              <th scope="col">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {cats
              .filter((c) => board.usage[c.id])
              .map((c) => {
                const u = board.usage[c.id];
                const cost = u?.costUsd ?? null;
                const left = !costBlind(c)
                  ? c.budget.maxUsd === null
                    ? 'No limit'
                    : usd(Math.max(0, c.budget.maxUsd - (cost ?? 0)))
                  : c.budget.maxMinutes === null
                    ? 'No limit'
                    : hours(Math.max(0, c.budget.maxMinutes * 60_000 - (u?.activeMs ?? 0)));
                return (
                  <tr key={c.id}>
                    <th scope="row">
                      {c.name}
                      {board.retired[c.id] && <span className="cost-meter__muted"> (retired)</span>}
                    </th>
                    <td>
                      {cost === null
                        ? 'Cost unknown'
                        : costBlind(c)
                          ? `Cost unknown (${usd(cost)} before)`
                          : usd(cost)}
                    </td>
                    <td>{left}</td>
                    <td>{clock(u?.activeMs ?? 0)}</td>
                    <td>{((u?.inputTokens ?? 0) + (u?.outputTokens ?? 0)).toLocaleString()}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <h3 className="cost-meter__heading">Most expensive tasks</h3>
      {byCost.length === 0 && byTime.length === 0 ? (
        <p className="cost-meter__empty">No finished tasks yet.</p>
      ) : (
        <ol className="cost-meter__tasks">
          {byCost.map((t) => (
            <li key={t.id}>
              <span className="cost-meter__task-title">{t.title}</span>
              <span className="cost-meter__muted">
                {t.assigneeCatId ? nameOf(t.assigneeCatId) : ''}
              </span>
              <strong>{usd(t.result?.costUsd ?? 0)}</strong>
            </li>
          ))}
          {byTime.map((t) => (
            <li key={t.id}>
              <span className="cost-meter__task-title">{t.title}</span>
              <span className="cost-meter__muted">
                {t.assigneeCatId ? nameOf(t.assigneeCatId) : ''}
              </span>
              <strong title="Cost unknown: working time">{clock(t.result?.activeMs ?? 0)}</strong>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
