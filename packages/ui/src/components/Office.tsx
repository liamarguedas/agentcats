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

/** Scene coordinates in percent: `x` is the cat's center, `y` where its feet are. */
interface Spot {
  readonly x: number;
  readonly y: number;
}

const DESK_COLUMNS = 3;
/** Desk spots, row by row; a worker keeps the same desk for as long as it is on the team. */
function deskSpot(index: number): Spot {
  const col = index % DESK_COLUMNS;
  const row = Math.floor(index / DESK_COLUMNS);
  return { x: 39 + col * 11, y: 52 + row * 42 };
}

function whiteboardSpot(index: number): Spot {
  // The lead stands beside the board; everyone else waits in a row in front of it.
  return index === 0 ? { x: 22.5, y: 56 } : { x: 6 + ((index - 1) % 3) * 10.5, y: 95 };
}

function meetingSpot(index: number): Spot {
  // Two behind the table, two in front of it.
  const seats: readonly Spot[] = [
    { x: 78, y: 62 },
    { x: 92, y: 62 },
    { x: 78, y: 98 },
    { x: 92, y: 98 },
  ];
  return seats[index % seats.length] ?? { x: 86, y: 70 };
}

/** Where every cat goes, keyed by id. Desks follow the team's order, so they do not shuffle. */
export function placeCats(lead: Cat | undefined, workers: readonly Cat[]): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  if (lead) spots.set(lead.id, whiteboardSpot(0));
  let waiting = 1;
  let meeting = 0;
  workers.forEach((cat, desk) => {
    const area = areaOf(cat);
    spots.set(
      cat.id,
      area === 'desks'
        ? deskSpot(desk)
        : area === 'meeting'
          ? meetingSpot(meeting++)
          : whiteboardSpot(waiting++),
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
      // Near a wall, bubbles and cards open toward the room instead of off the edge.
      data-edge={spot.x < 25 ? 'left' : spot.x > 84 ? 'right' : undefined}
      data-area={area}
      style={{ left: `${String(spot.x)}%`, top: `${String(spot.y)}%` }}
    >
      {children}
    </div>
  );
}

/**
 * The office: a whiteboard where the lead plans and idle cats wait, desks
 * where cats work, and a meeting table where cats wait for you.
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
  const spots = placeCats(lead, workers);
  const rows = Math.max(1, Math.ceil(workers.length / DESK_COLUMNS));
  const desks = Math.max(DESK_COLUMNS, rows * DESK_COLUMNS);
  return (
    <div className="office-scroll">
      <section
        className="office"
        aria-label="Office"
        // Room above the first row for an approval bubble, which must never be cut off.
        style={{ minHeight: `${String(420 + (rows - 1) * 150)}px` }}
      >
        <div className="office__area office__area--whiteboard" aria-hidden="true">
          <span className="office__label">Whiteboard</span>
          <div className="office__board">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="office__area office__area--desks" aria-hidden="true">
          <span className="office__label">Desks</span>
          {lead && workers.length === 0 && <div className="office__hint">{noWorkers}</div>}
        </div>
        <div className="office__area office__area--meeting" aria-hidden="true">
          <span className="office__label">Meeting · needs you</span>
          <span className="office__table" />
        </div>
        <div className="office__furniture" aria-hidden="true">
          {Array.from({ length: desks }, (_, i) => {
            const spot = deskSpot(i);
            return (
              <span
                key={i}
                className="office__desk"
                style={{ left: `${String(spot.x)}%`, top: `${String(spot.y)}%` }}
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
    </div>
  );
}
