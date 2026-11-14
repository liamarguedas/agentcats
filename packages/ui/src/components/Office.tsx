import type { Cat } from '@agentcats/protocol';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/** Where a cat stands: planning at the whiteboard, at its desk, or at the table waiting for you. */
export type Area = 'whiteboard' | 'desks' | 'meeting';

export function areaOf(cat: Cat): Area {
  if (cat.role === 'orchestrator') return 'whiteboard';
  if (cat.pausedReason || ['waiting_approval', 'blocked', 'error'].includes(cat.status)) {
    return 'meeting';
  }
  if (cat.status === 'thinking' || cat.status === 'working') return 'desks';
  return 'whiteboard';
}

/** Canvas coordinates in px: `x` is the cat's center, `y` where its feet are. */
export interface Spot {
  readonly x: number;
  readonly y: number;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The office for a team, in canvas px: the zones and the size of the whole room. */
export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly whiteboard: Box;
  readonly desks: Box;
  readonly meeting: Box;
  /** One table per two seats. */
  readonly tables: number;
  readonly deskCount: number;
}

const PAD = 40;
const GAP = 48;
const DESK_COLUMNS = 4;
const DESK_WIDTH = 210;
const DESK_ROW = 230;
/** From the top of the desks zone to the feet of the first row: room for a bubble. */
const DESK_TOP = 200;
const IDLE_START = 560;
const IDLE_STEP = 112;
const IDLE_ROW = 150;
const BOARD_ROW_FEET = 280;
const MEETING_WIDTH = 560;
/** Two cats per table, one table per row; a row leaves room for an approval bubble. */
const MEETING_TOP = 230;
const MEETING_ROW = 270;

/**
 * The room for a team of `workers` with `meeting` cats at the table.
 * Desks sit in the middle, the whiteboard above them and the meeting table
 * to their side. The whiteboard has room for every worker to wait at it,
 * so a cat going idle never moves the desks.
 */
export function layoutFor(workers: number, meeting: number): Layout {
  const rows = Math.max(1, Math.ceil(workers / DESK_COLUMNS));
  const desksWidth = DESK_COLUMNS * DESK_WIDTH;
  const idlePerRow = Math.max(
    1,
    Math.floor((desksWidth + GAP + MEETING_WIDTH - IDLE_START) / IDLE_STEP),
  );
  const idleRows = Math.max(1, Math.ceil(workers / idlePerRow));
  const whiteboard: Box = {
    x: PAD,
    y: PAD,
    width: desksWidth + GAP + MEETING_WIDTH,
    height: BOARD_ROW_FEET + (idleRows - 1) * IDLE_ROW + 40,
  };
  const desks: Box = {
    x: PAD,
    y: whiteboard.y + whiteboard.height + GAP,
    width: desksWidth,
    height: DESK_TOP + (rows - 1) * DESK_ROW + 60,
  };
  const tables = Math.max(2, Math.ceil(meeting / 2));
  const meetingBox: Box = {
    x: desks.x + desks.width + GAP,
    y: desks.y,
    width: MEETING_WIDTH,
    height: Math.max(desks.height, MEETING_TOP + (tables - 1) * MEETING_ROW + 60),
  };
  return {
    width: whiteboard.x + whiteboard.width + PAD,
    height: Math.max(desks.y + desks.height, meetingBox.y + meetingBox.height) + PAD,
    whiteboard,
    desks,
    meeting: meetingBox,
    tables,
    deskCount: rows * DESK_COLUMNS,
  };
}

/** Desk spots, row by row; a worker keeps the same desk for as long as it is on the team. */
function deskSpot(layout: Layout, index: number): Spot {
  const col = index % DESK_COLUMNS;
  const row = Math.floor(index / DESK_COLUMNS);
  return {
    x: layout.desks.x + (col + 0.5) * DESK_WIDTH,
    y: layout.desks.y + DESK_TOP + row * DESK_ROW,
  };
}

function whiteboardSpot(layout: Layout, index: number): Spot {
  const { x, y, width } = layout.whiteboard;
  // The lead stands beside the board; everyone else waits in rows next to it.
  if (index === 0) return { x: x + 90, y: y + BOARD_ROW_FEET };
  const perRow = Math.max(1, Math.floor((width - IDLE_START) / IDLE_STEP));
  const i = index - 1;
  return {
    x: x + IDLE_START + (i % perRow) * IDLE_STEP + IDLE_STEP / 2,
    y: y + BOARD_ROW_FEET + Math.floor(i / perRow) * IDLE_ROW,
  };
}

function meetingSpot(layout: Layout, index: number): Spot {
  const { x, y, width } = layout.meeting;
  return {
    x: x + width * (index % 2 === 0 ? 0.27 : 0.73),
    y: y + MEETING_TOP + Math.floor(index / 2) * MEETING_ROW,
  };
}

/** Where every cat goes, keyed by id. Desks follow the team's order, so they do not shuffle. */
export function placeCats(
  lead: Cat | undefined,
  workers: readonly Cat[],
  layout = layoutFor(workers.length, workers.filter((c) => areaOf(c) === 'meeting').length),
): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  if (lead) spots.set(lead.id, whiteboardSpot(layout, 0));
  let waiting = 1;
  let meeting = 0;
  workers.forEach((cat, desk) => {
    const area = areaOf(cat);
    spots.set(
      cat.id,
      area === 'desks'
        ? deskSpot(layout, desk)
        : area === 'meeting'
          ? meetingSpot(layout, meeting++)
          : whiteboardSpot(layout, waiting++),
    );
  });
  return spots;
}

/** One cat on the floor, sliding to its spot, with a little walk while it moves. */
function Walker({ spot, area, children }: { spot: Spot; area: Area; children: ReactNode }) {
  const previous = useRef(spot);
  const [walking, setWalking] = useState(false);
  useEffect(() => {
    if (previous.current.x === spot.x && previous.current.y === spot.y) return;
    previous.current = spot;
    setWalking(true);
    const timer = setTimeout(() => {
      setWalking(false);
    }, 900);
    return () => {
      clearTimeout(timer);
    };
  }, [spot]);
  return (
    <div
      className={`office__cat${walking ? ' office__cat--walking' : ''}`}
      data-area={area}
      style={{ left: `${String(spot.x)}px`, top: `${String(spot.y)}px` }}
    >
      {children}
    </div>
  );
}

const px = (box: Box) => ({
  left: `${String(box.x)}px`,
  top: `${String(box.y)}px`,
  width: `${String(box.width)}px`,
  height: `${String(box.height)}px`,
});

/**
 * The office: a whiteboard where the lead plans and idle cats wait, desks
 * where cats work, and a meeting table where cats wait for you. A room of
 * fixed size in canvas px, sized for the team; the canvas pans and zooms it.
 */
export function Office({
  lead,
  workers,
  renderCat,
  empty,
  noWorkers,
}: {
  lead: Cat | undefined;
  workers: readonly Cat[];
  renderCat: (cat: Cat) => ReactNode;
  /** Shown on the floor when there is no cat at all. */
  empty: ReactNode;
  /** Shown at the desks while there are no workers. */
  noWorkers: ReactNode;
}) {
  const layout = layoutFor(workers.length, workers.filter((c) => areaOf(c) === 'meeting').length);
  const spots = placeCats(lead, workers, layout);
  return (
    <section
      className="office"
      aria-label="Office"
      style={{ width: `${String(layout.width)}px`, height: `${String(layout.height)}px` }}
    >
      <div
        className="office__area office__area--whiteboard"
        aria-hidden="true"
        style={px(layout.whiteboard)}
      >
        <span className="office__label">Whiteboard</span>
        <div className="office__board">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="office__area office__area--desks" aria-hidden="true" style={px(layout.desks)}>
        <span className="office__label">Desks</span>
        {lead && workers.length === 0 && <div className="office__hint">{noWorkers}</div>}
      </div>
      <div
        className="office__area office__area--meeting"
        aria-hidden="true"
        style={px(layout.meeting)}
      >
        <span className="office__label">Meeting · needs you</span>
        {Array.from({ length: layout.tables }, (_, i) => (
          <span
            key={i}
            className="office__table"
            style={{ top: `${String(MEETING_TOP + i * MEETING_ROW + 4)}px` }}
          />
        ))}
      </div>
      <div className="office__furniture" aria-hidden="true">
        {Array.from({ length: layout.deskCount }, (_, i) => {
          const spot = deskSpot(layout, i);
          return (
            <span
              key={i}
              className="office__desk"
              style={{ left: `${String(spot.x)}px`, top: `${String(spot.y)}px` }}
            />
          );
        })}
      </div>
      {!lead && workers.length === 0 && <div className="office__empty">{empty}</div>}
      <div className="office__floor" aria-label="Cats" role="group">
        {[...(lead ? [lead] : []), ...workers].map((cat) => {
          const spot = spots.get(cat.id);
          return spot ? (
            <Walker key={cat.id} spot={spot} area={areaOf(cat)}>
              {renderCat(cat)}
            </Walker>
          ) : null;
        })}
      </div>
    </section>
  );
}
