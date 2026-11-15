import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  type ReactZoomPanPinchRef,
  TransformComponent,
  TransformWrapper,
} from 'react-zoom-pan-pinch';

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2;
/** Zoom per px of wheel with Ctrl or Cmd: e^(0.001 * 100) is about 10% a notch. */
const WHEEL_ZOOM = 0.001;
/** Each click on + or - zooms by this factor. */
const ZOOM_STEP = 1.25;
/** Fit never zooms in past 100%: a small team stays at its natural size. */
const FIT_MAX_SCALE = 1;
/** Space kept around what is framed, in screen px. */
const FIT_MARGIN = 16;
/** The zoom controls' height with their margin: Fit keeps the office above them. */
const CONTROLS_HEIGHT = 60;
/** Below this zoom, bubbles fold away and approvals become badges. */
export const FAR_SCALE = 0.45;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animation = () => (reducedMotion() ? 0 : 220);

/** A rectangle in canvas px (the office's own coordinates). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The part of the canvas not covered by panels, in px from the canvas's top left. */
export interface Visible {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface CanvasApi {
  /** The screen-space layer for bubbles, cards and markers. */
  readonly overlay: HTMLDivElement | null;
  readonly visible: () => Visible;
  /** Canvas px to screen px, relative to the canvas's top left. */
  readonly toScreen: (x: number, y: number) => { x: number; y: number };
  readonly scale: () => number;
  /** Frame the box, zooming out if it does not fit and in up to 100% if it is small. */
  readonly show: (box: Box) => void;
  /** Pan, at the current zoom, so the box is in view; nothing if it already is. */
  readonly reveal: (box: Box) => void;
  /** Frame the whole office, and keep framing it as the team grows. */
  readonly fit: () => void;
  /** Called after every change of the view (`false`), and once when it settles (`true`). */
  readonly subscribe: (listener: (settled: boolean) => void) => () => void;
}

const CanvasContext = createContext<CanvasApi | null>(null);

export function useCanvas(): CanvasApi | null {
  return useContext(CanvasContext);
}

interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

function readViewport(key: string): Viewport | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as Viewport | null;
    return value && [value.x, value.y, value.scale].every(Number.isFinite) ? value : null;
  } catch {
    return null;
  }
}

function writeViewport(key: string, value: Viewport | null): void {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the view is simply not remembered.
  }
}

/** Hand the view to the overlay as CSS variables: its anchors follow without a render. */
function placeOverlay(overlay: HTMLElement, x: number, y: number, scale: number): void {
  // The office reads the zoom too, to keep its zone labels readable.
  overlay.parentElement?.style.setProperty('--s', String(scale));
  overlay.style.setProperty('--ox', String(x));
  overlay.style.setProperty('--oy', String(y));
  overlay.style.setProperty('--s', String(scale));
  overlay.dataset['zoom'] = scale < FAR_SCALE ? 'far' : 'near';
}

/**
 * The board's canvas: the office on a surface you pan by dragging the floor,
 * with the wheel or the arrow keys, and zoom with Ctrl or Cmd and the wheel,
 * a pinch, or + and -. Fit (F) frames the whole office in the part of the
 * screen the panels leave free. Bubbles and cards are drawn in a layer above
 * it, at their own size, so zooming never makes them unreadable.
 */
export function Canvas({
  children,
  coveredLeft,
  coveredRight,
  coveredBottom = 0,
  storageKey,
  apiRef,
}: {
  children: ReactNode;
  /** Screen px on the left covered by an open panel. */
  coveredLeft: number;
  /** Screen px on the right covered by open panels. */
  coveredRight: number;
  /** Screen px at the bottom covered by panels (on a narrow screen they are bottom sheets). */
  coveredBottom?: number;
  /** Where the view is remembered in the browser; `null` to not remember it. */
  storageKey: string | null;
  apiRef?: RefObject<CanvasApi | null>;
}) {
  const zoom = useRef<ReactZoomPanPinchRef>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  // Until the user moves the view, it keeps fitting the office as the team grows.
  const moved = useRef(false);
  const covered = useRef({ left: coveredLeft, right: coveredRight, bottom: coveredBottom });
  const listeners = useRef(new Set<(settled: boolean) => void>());
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const key = useRef(storageKey);
  const mounted = useRef(false);

  const visible = useCallback((): Visible => {
    const wrapper = zoom.current?.instance.wrapperComponent;
    return {
      left: covered.current.left,
      top: 0,
      right: (wrapper?.clientWidth ?? 0) - covered.current.right,
      bottom: (wrapper?.clientHeight ?? 0) - covered.current.bottom,
    };
  }, []);

  const view = useCallback(
    () => zoom.current?.instance.state ?? { positionX: 0, positionY: 0, scale: 1 },
    [],
  );

  const frame = useCallback(
    (box: Box, maxScale: number, animationTime = animation()) => {
      if (!zoom.current) return;
      const area = visible();
      const width = area.right - area.left - 2 * FIT_MARGIN;
      // Clear of the zoom controls at the bottom.
      const height = area.bottom - area.top - FIT_MARGIN - CONTROLS_HEIGHT;
      const scale = Math.max(MIN_SCALE, Math.min(maxScale, width / box.width, height / box.height));
      void zoom.current.setTransform(
        // Too wide even at the smallest zoom (a phone): start at the left, where the lead is.
        area.left + FIT_MARGIN + Math.max(0, (width - box.width * scale) / 2) - box.x * scale,
        area.top + FIT_MARGIN + Math.max(0, (height - box.height * scale) / 2) - box.y * scale,
        scale,
        animationTime,
      );
    },
    [visible],
  );

  const fitOffice = useCallback(
    (animationTime = animation()) => {
      const content = zoom.current?.instance.contentComponent;
      if (!content) return;
      frame(
        { x: 0, y: 0, width: content.offsetWidth, height: content.offsetHeight },
        FIT_MAX_SCALE,
        animationTime,
      );
    },
    [frame],
  );

  const userMoved = useCallback(() => {
    moved.current = true;
  }, []);

  // Where an animation is heading: quick clicks on + or - step from there, not from mid-way.
  const target = useRef<{ positionX: number; positionY: number; scale: number } | null>(null);
  /** Zoom by a factor, about the middle of the visible canvas. */
  const zoomBy = useCallback(
    (factor: number) => {
      userMoved();
      const from = target.current ?? view();
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, from.scale * factor));
      const area = visible();
      const cx = (area.left + area.right) / 2;
      const cy = (area.top + area.bottom) / 2;
      const x = cx - ((cx - from.positionX) / from.scale) * scale;
      const y = cy - ((cy - from.positionY) / from.scale) * scale;
      target.current = { positionX: x, positionY: y, scale };
      void zoom.current?.setTransform(x, y, scale, animation());
    },
    [userMoved, view, visible],
  );

  /**
   * Ctrl or Cmd and the wheel (a trackpad pinch sends the same) zoom about
   * the pointer, at once: the page itself never zooms over the canvas.
   */
  useEffect(() => {
    const wrapper = zoom.current?.instance.wrapperComponent;
    if (!wrapper) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      userMoved();
      const from = view();
      // A notch of a mouse wheel is about 100 px: a 10% step. A pinch is finer.
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, from.scale * Math.exp(-e.deltaY * WHEEL_ZOOM)),
      );
      const box = wrapper.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      target.current = null;
      void zoom.current?.setTransform(
        px - ((px - from.positionX) / from.scale) * scale,
        py - ((py - from.positionY) / from.scale) * scale,
        scale,
        0,
      );
    };
    wrapper.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      wrapper.removeEventListener('wheel', onWheel);
    };
  }, [userMoved, view]);

  const fit = useCallback(() => {
    moved.current = false;
    if (key.current) writeViewport(key.current, null);
    fitOffice();
  }, [fitOffice]);

  const api: CanvasApi = {
    overlay,
    visible,
    toScreen: (x, y) => {
      const { positionX, positionY, scale } = view();
      return { x: positionX + x * scale, y: positionY + y * scale };
    },
    scale: () => view().scale,
    show: (box) => {
      userMoved();
      frame(box, Math.max(view().scale, FIT_MAX_SCALE));
    },
    reveal: (box) => {
      const { positionX, positionY, scale } = view();
      const area = visible();
      const left = positionX + box.x * scale;
      const top = positionY + box.y * scale;
      const right = left + box.width * scale;
      const bottom = top + box.height * scale;
      let dx = 0;
      let dy = 0;
      if (left < area.left + FIT_MARGIN) dx = area.left + FIT_MARGIN - left;
      else if (right > area.right - FIT_MARGIN) dx = area.right - FIT_MARGIN - right;
      if (top < area.top + FIT_MARGIN) dy = area.top + FIT_MARGIN - top;
      else if (bottom > area.bottom - FIT_MARGIN) dy = area.bottom - FIT_MARGIN - bottom;
      if (dx === 0 && dy === 0) return;
      userMoved();
      void zoom.current?.setTransform(positionX + dx, positionY + dy, scale, animation());
    },
    fit,
    subscribe: (listener) => {
      listeners.current.add(listener);
      return () => {
        listeners.current.delete(listener);
      };
    },
  };
  useImperativeHandle(apiRef, () => api);

  // Keys that work anywhere on the board. Ctrl or Cmd with + and - zoom the
  // canvas instead of the page, and with 0 fit it. Without Ctrl, F fits and
  // + and - zoom, except while typing or in a dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not `defaultPrevented`: the library marks + and - as handled when the canvas has focus.
      if (e.altKey) return;
      const zoomIn = e.key === '+' || e.key === '=';
      const zoomOut = e.key === '-' || e.key === '_';
      const command = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement;
      if (target.closest('[aria-modal="true"]')) return;
      if (
        !command &&
        target.closest('input, textarea, select, [contenteditable], [role="dialog"]')
      ) {
        return;
      }
      if (zoomIn || zoomOut) zoomBy(zoomIn ? ZOOM_STEP : 1 / ZOOM_STEP);
      else if (command ? e.key === '0' : e.key === 'f' || e.key === 'F') fit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [fit, zoomBy]);

  // Grows with the team: refit, unless the user has moved the view.
  useEffect(() => {
    const content = zoom.current?.instance.contentComponent;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (!moved.current) fitOffice(0);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [fitOffice]);
  // A panel opened or closed: refit, unless the user has moved the view.
  useLayoutEffect(() => {
    covered.current = { left: coveredLeft, right: coveredRight, bottom: coveredBottom };
    // The first fit is instant: the board opens framed, not flying in.
    if (!moved.current) fitOffice(mounted.current ? animation() : 0);
    mounted.current = true;
  }, [coveredLeft, coveredRight, coveredBottom, fitOffice]);
  // The view remembered for this project, if any.
  useLayoutEffect(() => {
    key.current = storageKey;
    const saved = storageKey ? readViewport(storageKey) : null;
    if (!saved) return;
    moved.current = true;
    void zoom.current?.setTransform(saved.x, saved.y, saved.scale, 0);
  }, [storageKey]);

  return (
    <CanvasContext.Provider value={api}>
      <TransformWrapper
        ref={zoom}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        limitToBounds={false}
        // The wheel pans; with Ctrl or Cmd it zooms, in our own handler above.
        wheel={{ disabled: true }}
        // Off by default in the library: the wheel and two-finger scrolling pan.
        trackPadPanning={{ disabled: false, velocityDisabled: true }}
        panning={{ excluded: ['cat-token', 'button'] }}
        doubleClick={{ disabled: true }}
        keyboard={{ panStep: 80, zoomStep: 0 }}
        velocityAnimation={{ disabled: true }}
        onPanningStart={userMoved}
        onWheelStart={userMoved}
        onPinchStart={userMoved}
        onTransform={(_ref, { positionX, positionY, scale }) => {
          if (overlayRef.current) placeOverlay(overlayRef.current, positionX, positionY, scale);
          if (zoomLabel.current) {
            zoomLabel.current.textContent = `${String(Math.round(scale * 100))}%`;
          }
          for (const listener of listeners.current) listener(false);
          clearTimeout(settleTimer.current);
          settleTimer.current = setTimeout(() => {
            target.current = null;
            for (const listener of listeners.current) listener(true);
            if (moved.current && key.current) {
              writeViewport(key.current, { x: positionX, y: positionY, scale });
            }
          }, 160);
        }}
      >
        <div
          className="canvas"
          onKeyDown={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) {
              return;
            }
            if (e.key.startsWith('Arrow')) {
              userMoved();
            }
          }}
        >
          <TransformComponent
            wrapperClass="canvas__viewport"
            wrapperProps={{
              // Focusable, so the arrow keys and + and - work on it.
              tabIndex: 0,
              role: 'region',
              'aria-label':
                'Office canvas: drag or use the arrow keys to pan, Ctrl + and Ctrl - to zoom, F to fit',
              // Focusing a cat must not scroll the viewport: the transform does the moving.
              onScroll: (e) => {
                e.currentTarget.scrollTo(0, 0);
              },
            }}
            contentClass="canvas__content"
          >
            {children}
          </TransformComponent>
          <div
            ref={(el) => {
              overlayRef.current = el;
              setOverlay(el);
              const { positionX, positionY, scale } = view();
              if (el) placeOverlay(el, positionX, positionY, scale);
            }}
            className="canvas__overlay"
          />
          <div className="canvas__controls" style={{ left: `${String(coveredLeft + 14)}px` }}>
            <button
              type="button"
              className="button button--small"
              aria-label="Zoom out"
              aria-keyshortcuts="-"
              onClick={() => {
                zoomBy(1 / ZOOM_STEP);
              }}
            >
              −
            </button>
            <span ref={zoomLabel} className="canvas__zoom" data-testid="zoom">
              100%
            </span>
            <button
              type="button"
              className="button button--small"
              aria-label="Zoom in"
              aria-keyshortcuts="+"
              onClick={() => {
                zoomBy(ZOOM_STEP);
              }}
            >
              +
            </button>
            <button
              type="button"
              className="button button--small"
              aria-keyshortcuts="F"
              onClick={fit}
            >
              Fit
            </button>
          </div>
        </div>
      </TransformWrapper>
    </CanvasContext.Provider>
  );
}
