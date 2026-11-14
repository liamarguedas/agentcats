import type { Cat } from '@agentcats/protocol';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { type Box, type CanvasApi, useCanvas } from './Canvas.js';

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
/** Wide enough that name tags stay apart when zoomed out to Fit. */
const IDLE_STEP = 150;
const IDLE_ROW = 150;
const BOARD_ROW_FEET = 280;
const MEETING_WIDTH = 480;
/** Two cats per table, one table per row; a row leaves room for an approval bubble. */
const MEETING_TOP = 230;
const MEETING_ROW = 270;

/**
 * The room for a team of `workers`, `meeting` of them at the table and
 * `waiting` at the whiteboard. Desks sit in the middle, the whiteboard above
 * them and the meeting tables to their side. Waiting cats stand in rows next
 * to the board; a new row pushes the desks down.
 */
export function layoutFor(workers: number, meeting: number, waiting: number): Layout {
  const rows = Math.max(1, Math.ceil(workers / DESK_COLUMNS));
  const desksWidth = DESK_COLUMNS * DESK_WIDTH;
  const idlePerRow = Math.max(
    1,
    Math.floor((desksWidth + GAP + MEETING_WIDTH - IDLE_START) / IDLE_STEP),
  );
  const idleRows = Math.max(1, Math.ceil(waiting / idlePerRow));
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
  const tables = Math.max(1, Math.ceil(meeting / 2));
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

/** The room for this team, as it stands now. */
export function layoutForTeam(workers: readonly Cat[]): Layout {
  const count = (area: Area) => workers.filter((c) => areaOf(c) === area).length;
  return layoutFor(workers.length, count('meeting'), count('whiteboard'));
}

/** Where every cat goes, keyed by id. Desks follow the team's order, so they do not shuffle. */
export function placeCats(
  lead: Cat | undefined,
  workers: readonly Cat[],
  layout = layoutForTeam(workers),
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

/** How tall a cat stands, in canvas px (its photo; `styles.css` sizes them alike). */
function catHeight(cat: Cat, area: Area): number {
  if (cat.role === 'orchestrator') return 118;
  return area === 'whiteboard' ? 76 : 92;
}

/** The box a cat takes on the canvas, with room for its bubble above and its name below. */
export function catBox(cat: Cat, spot: Spot): Box {
  const height = catHeight(cat, areaOf(cat));
  return { x: spot.x - 130, y: spot.y - height - 150, width: 260, height: height + 190 };
}

/** Whether a cat waits for the user: an approval, a pause, a block or an error. */
export function needsYou(cat: Cat): boolean {
  return (
    cat.role !== 'candidate' &&
    (cat.pausedReason !== null || ['waiting_approval', 'blocked', 'error'].includes(cat.status))
  );
}

const px = (box: Box) => ({
  left: `${String(box.x)}px`,
  top: `${String(box.y)}px`,
  width: `${String(box.width)}px`,
  height: `${String(box.height)}px`,
});

/** One cat on the floor, sliding to its spot, with a little walk while it moves. */
function Walker({
  spot,
  area,
  children,
  onEnter,
  onLeave,
}: {
  spot: Spot;
  area: Area;
  children: ReactNode;
  onEnter: (focus: boolean) => void;
  onLeave: () => void;
}) {
  const previous = useRef(spot);
  const [walking, setWalking] = useState(false);
  const touched = useRef(false);
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
      // No hover card for a touch: a tap opens the cat's details, and a card
      // sliding in under the finger would take the tap.
      onPointerDown={(e) => {
        touched.current = e.pointerType === 'touch';
      }}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') onEnter(false);
      }}
      onPointerLeave={onLeave}
      // Only keyboard focus brings the cat into view: a click must not move it away.
      onFocus={(e) => {
        if (!touched.current) onEnter(e.target.matches(':focus-visible'));
      }}
      onBlur={onLeave}
    >
      {children}
    </div>
  );
}

/** Space kept between what floats over the cats and the edges of the visible canvas. */
const EDGE = 8;
/** Space kept between two bubbles. */
const BUBBLE_GAP = 6;

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right + BUBBLE_GAP &&
  b.left < a.right + BUBBLE_GAP &&
  a.top < b.bottom + BUBBLE_GAP &&
  b.top < a.bottom + BUBBLE_GAP;

const scaleOf = (overlay: HTMLElement) => Number(overlay.style.getPropertyValue('--s') || 1);

const width = (r: Rect) => r.right - r.left;
const height = (r: Rect) => r.bottom - r.top;
const moveBy = (r: Rect, dx: number, dy: number): Rect => ({
  left: r.left + dx,
  top: r.top + dy,
  right: r.right + dx,
  bottom: r.bottom + dy,
});

/** Where a bubble may go, from its spot over the cat's head, nearest first. */
function candidates(over: Rect, under: Rect): { rect: Rect; below: boolean; cost: number }[] {
  const w = width(over) + BUBBLE_GAP;
  const h = height(over) + BUBBLE_GAP;
  const list: { rect: Rect; below: boolean; cost: number }[] = [];
  for (const dx of [0, -0.55, 0.55, -1.1, 1.1, -1.65, 1.65, -2.2, 2.2].map((k) => k * w)) {
    for (const lift of [0, 0.5 * h, h, 1.5 * h, 2 * h, 3 * h]) {
      list.push({ rect: moveBy(over, dx, -lift), below: false, cost: Math.abs(dx) + 1.5 * lift });
    }
    list.push({ rect: moveBy(under, dx, 0), below: true, cost: Math.abs(dx) + 0.9 * h });
  }
  return list.sort((a, b) => a.cost - b.cost);
}

/**
 * Lay out what floats over the cats, in screen space. Each bubble takes the
 * nearest spot (above its cat, then lifted or to the side, then below it)
 * that is inside the visible canvas, clear of the panels, and covers no
 * other bubble and no cat; a bubble moved off its cat gets a line to
 * it. The open card goes below its cat if it fits, else above it. Run when
 * the view settles and after renders; while the view moves everything
 * moves together, so the result holds.
 */
function arrange(overlay: HTMLElement, visible: Rect): void {
  const origin = overlay.getBoundingClientRect();
  const local = (r: DOMRect): Rect => ({
    left: r.left - origin.left,
    top: r.top - origin.top,
    right: r.right - origin.left,
    bottom: r.bottom - origin.top,
  });
  const scale = scaleOf(overlay);
  const anchors = [...overlay.querySelectorAll<HTMLElement>('.anchor')];
  for (const anchor of anchors) {
    for (const name of [
      '--lift',
      '--shift',
      '--card-shift',
      '--card-rise',
      '--card-drop',
      '--card-nudge',
      '--leader-length',
      '--leader-angle',
    ]) {
      anchor.style.removeProperty(name);
    }
    delete anchor.dataset['bubble'];
    delete anchor.dataset['leader'];
  }
  // Every cat, from the top of its head to the bottom of its name tag.
  const bodies = new Map<HTMLElement, { body: Rect; feet: { x: number; y: number } }>();
  for (const anchor of anchors) {
    const label = anchor.querySelector<HTMLElement>('.cat-card__label');
    if (!label) continue;
    const at = local(anchor.getBoundingClientRect());
    const tag = local(label.getBoundingClientRect());
    const head = Number(anchor.dataset['height'] ?? 0) * scale;
    const half = Math.max(width(tag), head * 0.8) / 2;
    bodies.set(anchor, {
      body: { left: at.left - half, right: at.left + half, top: at.top - head, bottom: tag.bottom },
      feet: { x: at.left, y: at.top },
    });
  }
  const bubbles: { anchor: HTMLElement; over: Rect; under: Rect }[] = [];
  for (const anchor of anchors) {
    const bubble = anchor.querySelector<HTMLElement>('.bubble');
    const cat = bodies.get(anchor);
    if (!bubble || bubble.offsetParent === null || !cat) continue;
    const over = local(bubble.getBoundingClientRect());
    // Below the cat, the bubble starts under its name tag (styles.css).
    const under = { ...over, top: cat.body.bottom + 7, bottom: cat.body.bottom + 7 + height(over) };
    bubbles.push({ anchor, over, under });
  }
  const inView = (r: Rect) =>
    r.left >= visible.left + EDGE &&
    r.right <= visible.right - EDGE &&
    r.top >= visible.top + EDGE &&
    r.bottom <= visible.bottom - EDGE;
  // The front rows first: their bubbles stay closest to their cats.
  bubbles.sort((a, b) => b.over.bottom - a.over.bottom);
  const placed: Rect[] = [];
  const bubbleOf = new Map<HTMLElement, { rect: Rect; below: boolean }>();
  for (const b of bubbles) {
    const options = candidates(b.over, b.under);
    const apart = (r: Rect) => !placed.some((other) => overlaps(r, other));
    // No cat is covered, its own included: a bubble over its photo would take its clicks.
    const clear = (r: Rect) =>
      apart(r) && ![...bodies.values()].some((cat) => overlaps(r, cat.body));
    // Best covering nothing; else covering a cat but no bubble; else at least in view.
    const choice =
      options.find((o) => inView(o.rect) && clear(o.rect)) ??
      options.find((o) => inView(o.rect) && apart(o.rect)) ??
      options.find((o) => inView(o.rect)) ??
      options[0];
    if (!choice) continue;
    placed.push(choice.rect);
    bubbleOf.set(b.anchor, choice);
    const dx = choice.rect.left - (choice.below ? b.under : b.over).left;
    const lift = choice.below ? 0 : b.over.top - choice.rect.top;
    if (choice.below) b.anchor.dataset['bubble'] = 'below';
    if (dx !== 0) b.anchor.style.setProperty('--shift', `${String(dx)}px`);
    if (lift !== 0) b.anchor.style.setProperty('--lift', `${String(lift)}px`);
    // Still over its cat: the tail points at it. Moved away: a line to it.
    const cat = bodies.get(b.anchor);
    if (!cat || (lift === 0 && Math.abs(dx) <= width(b.over) / 2 - 18)) continue;
    const from = {
      x: (choice.rect.left + choice.rect.right) / 2,
      y: choice.below ? choice.rect.top : choice.rect.bottom,
    };
    const to = { x: cat.feet.x, y: choice.below ? cat.body.bottom : cat.body.top };
    b.anchor.dataset['leader'] = '';
    b.anchor.style.setProperty(
      '--leader-length',
      `${String(Math.hypot(to.x - from.x, to.y - from.y))}px`,
    );
    b.anchor.style.setProperty(
      '--leader-angle',
      `${String(Math.atan2(to.y - from.y, to.x - from.x))}rad`,
    );
  }
  // The open card: below the cat if it fits, else above it, kept in view
  // sideways. It never covers the cat's own bubble: an approval is answered there.
  for (const anchor of anchors) {
    if (anchor.dataset['open'] === undefined) continue;
    const card = anchor.querySelector<HTMLElement>('.cat-card__meta');
    const label = anchor.querySelector<HTMLElement>('.cat-card__label');
    if (!card || !label) continue;
    const tag = local(label.getBoundingClientRect());
    const head =
      local(anchor.getBoundingClientRect()).top - Number(anchor.dataset['height'] ?? 0) * scale;
    const own = bubbleOf.get(anchor);
    const ceiling = own && !own.below ? Math.min(head, own.rect.top) : head;
    const floor = own?.below ? own.rect.bottom : tag.bottom;
    const below = visible.bottom - floor - EDGE;
    const above = ceiling - visible.top - EDGE;
    const up = card.offsetHeight > below && above > below;
    anchor.dataset['card'] = up ? 'up' : 'down';
    if (up) anchor.style.setProperty('--card-rise', `${String(tag.top - ceiling + 6)}px`);
    else anchor.style.setProperty('--card-drop', `${String(floor - tag.bottom + 6)}px`);
    const rect = local(card.getBoundingClientRect());
    let shift = 0;
    if (rect.left < visible.left + EDGE) shift = visible.left + EDGE - rect.left;
    else if (rect.right > visible.right - EDGE) shift = visible.right - EDGE - rect.right;
    if (shift !== 0) anchor.style.setProperty('--card-shift', `${String(shift)}px`);
    // Room on neither side (zoomed far in on a short screen): slide it into view,
    // over the cat if it must.
    let nudge = 0;
    if (rect.bottom > visible.bottom - EDGE) nudge = visible.bottom - EDGE - rect.bottom;
    if (rect.top + nudge < visible.top + EDGE) nudge = visible.top + EDGE - rect.top;
    if (nudge !== 0) anchor.style.setProperty('--card-nudge', `${String(nudge)}px`);
  }
}

/**
 * Markers at the edge of the visible canvas for cats that need you and are
 * out of view, pointing their way. Moved straight in the DOM as the view
 * moves; clicking one brings the cat into view.
 */
function placeMarkers(
  overlay: HTMLElement,
  canvas: CanvasApi,
  boxes: ReadonlyMap<string, Box>,
): void {
  const area = canvas.visible();
  const placed: Rect[] = [];
  for (const marker of overlay.querySelectorAll<HTMLElement>('.edge-marker')) {
    const box = boxes.get(marker.dataset['cat'] ?? '');
    if (!box) continue;
    const a = canvas.toScreen(box.x, box.y);
    const b = canvas.toScreen(box.x + box.width, box.y + box.height);
    const x = (a.x + b.x) / 2;
    const y = (a.y + b.y) / 2;
    const inside = x > area.left && x < area.right && y > area.top && y < area.bottom;
    marker.hidden = inside;
    if (inside) continue;
    const side = y < area.top ? 'up' : y > area.bottom ? 'down' : x < area.left ? 'left' : 'right';
    marker.dataset['side'] = side;
    const w = marker.offsetWidth;
    const h = marker.offsetHeight;
    const clampX = (v: number) =>
      Math.min(Math.max(v, area.left + EDGE + w / 2), area.right - EDGE - w / 2);
    const clampY = (v: number) =>
      Math.min(Math.max(v, area.top + EDGE + h / 2), area.bottom - EDGE - h / 2);
    let cx = clampX(x);
    let cy = clampY(y);
    // Several cats the same way: the markers line up along the edge.
    const rect = () => ({
      left: cx - w / 2,
      right: cx + w / 2,
      top: cy - h / 2,
      bottom: cy + h / 2,
    });
    for (
      let tries = 0;
      tries < placed.length + 1 && placed.some((p) => overlaps(rect(), p));
      tries++
    ) {
      if (side === 'left' || side === 'right') cy = clampY(cy + h + BUBBLE_GAP);
      else cx = clampX(cx + w + BUBBLE_GAP);
    }
    placed.push(rect());
    marker.style.left = `${String(cx)}px`;
    marker.style.top = `${String(cy)}px`;
  }
}

/**
 * The office: a whiteboard where the lead plans and idle cats wait, desks
 * where cats work, and meeting tables where cats wait for you. A room of
 * fixed size in canvas px, sized for the team; the canvas pans and zooms it.
 * The cats stand on the canvas; their names, bubbles and cards float over it
 * in the canvas's screen-space layer, anchored to them.
 */
export function Office({
  lead,
  workers,
  renderCat,
  empty,
  noWorkers,
  detailsOf = null,
}: {
  lead: Cat | undefined;
  workers: readonly Cat[];
  /** The cat whose details panel is open: its hover card stays closed. */
  detailsOf?: string | null;
  renderCat: (cat: Cat, part: 'token' | 'overlay') => ReactNode;
  /** Shown on the floor when there is no cat at all. */
  empty: ReactNode;
  /** Shown at the desks while there are no workers. */
  noWorkers: ReactNode;
}) {
  const canvas = useCanvas();
  const layout = layoutForTeam(workers);
  const spots = placeCats(lead, workers, layout);
  const cats = [...(lead ? [lead] : []), ...workers];
  const boxes = new Map(
    cats.flatMap((cat) => {
      const spot = spots.get(cat.id);
      return spot ? [[cat.id, catBox(cat, spot)] as const] : [];
    }),
  );
  const boxesRef = useRef(boxes);
  const overlay = canvas?.overlay ?? null;

  // The card of the cat under the pointer or with focus; a short grace lets
  // the pointer travel from the cat to its card.
  const [open, setOpen] = useState<string | null>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hold = useCallback((id: string) => {
    clearTimeout(closing.current);
    setOpen(id);
  }, []);
  const release = useCallback(() => {
    clearTimeout(closing.current);
    closing.current = setTimeout(() => {
      setOpen(null);
    }, 150);
  }, []);

  // The canvas's api is a new object on every render; keep the latest for the callbacks.
  const canvasRef = useRef(canvas);
  const layoutPass = useCallback(() => {
    const api = canvasRef.current;
    if (!overlay || !api) return;
    arrange(overlay, api.visible());
    placeMarkers(overlay, api, boxesRef.current);
  }, [overlay]);
  const scheduled = useRef(0);
  const schedule = useCallback(() => {
    cancelAnimationFrame(scheduled.current);
    scheduled.current = requestAnimationFrame(layoutPass);
  }, [layoutPass]);

  // After every render: the bubbles' text, the team or the open card may have changed.
  useLayoutEffect(() => {
    boxesRef.current = boxes;
    canvasRef.current = canvas;
    layoutPass();
  });
  useEffect(() => {
    const api = canvasRef.current;
    if (!overlay || !api) return;
    // While the view moves only the markers need placing; once it settles, everything.
    const unsubscribe = api.subscribe((settled) => {
      if (settled) schedule();
      else placeMarkers(overlay, api, boxesRef.current);
    });
    // A cat finished walking somewhere else.
    overlay.addEventListener('transitionend', schedule);
    return () => {
      unsubscribe();
      overlay.removeEventListener('transitionend', schedule);
      cancelAnimationFrame(scheduled.current);
    };
  }, [overlay, schedule]);

  const attention = cats.filter(needsYou);
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
      {cats.length === 0 && <div className="office__empty">{empty}</div>}
      <div className="office__floor" aria-label="Cats" role="group">
        {cats.map((cat) => {
          const spot = spots.get(cat.id);
          return spot ? (
            <Walker
              key={cat.id}
              spot={spot}
              area={areaOf(cat)}
              onEnter={(focus) => {
                hold(cat.id);
                // Tabbing to a cat off screen brings it into view.
                const box = boxes.get(cat.id);
                if (focus && box) canvas?.reveal(box);
              }}
              onLeave={release}
            >
              {renderCat(cat, 'token')}
            </Walker>
          ) : null;
        })}
      </div>
      {overlay &&
        createPortal(
          <>
            {cats.map((cat) => {
              const spot = spots.get(cat.id);
              if (!spot) return null;
              const area = areaOf(cat);
              const anchor: CSSProperties & Record<`--${string}`, number> = {
                '--wx': spot.x,
                '--wy': spot.y,
                '--ch': catHeight(cat, area),
              };
              return (
                <div
                  key={cat.id}
                  className="anchor"
                  data-cat={cat.name}
                  data-area={area}
                  data-role={cat.role}
                  data-height={catHeight(cat, area)}
                  data-open={open === cat.id ? '' : undefined}
                  data-details={detailsOf === cat.id ? '' : undefined}
                  style={anchor}
                  onPointerEnter={() => {
                    if (open === cat.id) hold(cat.id);
                  }}
                  onPointerLeave={() => {
                    if (open === cat.id) release();
                  }}
                  onFocus={() => {
                    hold(cat.id);
                  }}
                  onBlur={release}
                >
                  {renderCat(cat, 'overlay')}
                  {cat.status === 'waiting_approval' && (
                    <button
                      type="button"
                      className="approval-badge"
                      aria-label={`${cat.name} asks for approval: show`}
                      onClick={() => {
                        const box = boxes.get(cat.id);
                        if (box) canvas?.show(box);
                      }}
                    >
                      ?
                    </button>
                  )}
                </div>
              );
            })}
            {attention.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className="edge-marker"
                data-cat={cat.id}
                hidden
                onClick={() => {
                  const box = boxes.get(cat.id);
                  if (box) canvas?.show(box);
                }}
              >
                {cat.name} needs you
              </button>
            ))}
          </>,
          overlay,
        )}
    </section>
  );
}
