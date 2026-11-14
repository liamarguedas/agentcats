import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  type ReactZoomPanPinchRef,
  TransformComponent,
  TransformWrapper,
} from 'react-zoom-pan-pinch';

const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
/** Fit never zooms in past 100%: a small team stays at its natural size. */
const FIT_MAX_SCALE = 1;
/** Space kept around the office when it is fitted, in screen px. */
const FIT_MARGIN = 16;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animation = () => (reducedMotion() ? 0 : 200);

/**
 * The board's canvas: the office on a surface you pan by dragging the floor,
 * with the wheel or the arrow keys, and zoom with Ctrl or Cmd and the wheel,
 * a pinch, or + and -. Fit (F) frames the whole office in the part of the
 * screen the panels leave free.
 */
export function Canvas({
  children,
  coveredRight,
}: {
  children: ReactNode;
  /** Screen px on the right covered by open panels. */
  coveredRight: number;
}) {
  const api = useRef<ReactZoomPanPinchRef>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  // Until the user moves the view, it keeps fitting the office as the team grows.
  const moved = useRef(false);
  const covered = useRef(coveredRight);

  const fit = useCallback((animationTime = animation()) => {
    const instance = api.current?.instance;
    const wrapper = instance?.wrapperComponent;
    const content = instance?.contentComponent;
    if (!api.current || !wrapper || !content) return;
    const width = wrapper.clientWidth - covered.current - 2 * FIT_MARGIN;
    const height = wrapper.clientHeight - 2 * FIT_MARGIN;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(FIT_MAX_SCALE, width / content.offsetWidth, height / content.offsetHeight),
    );
    void api.current.setTransform(
      FIT_MARGIN + (width - content.offsetWidth * scale) / 2,
      FIT_MARGIN + Math.max(0, (height - content.offsetHeight * scale) / 2),
      scale,
      animationTime,
    );
  }, []);
  const userMoved = () => {
    moved.current = true;
  };

  useEffect(() => {
    const content = api.current?.instance.contentComponent;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (!moved.current) fit(0);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [fit]);
  // A panel opened or closed: refit, unless the user has moved the view.
  useLayoutEffect(() => {
    covered.current = coveredRight;
    if (!moved.current) fit();
  }, [coveredRight, fit]);

  return (
    <TransformWrapper
      ref={api}
      minScale={MIN_SCALE}
      maxScale={MAX_SCALE}
      limitToBounds={false}
      wheel={{ activationKeys: ['Control', 'Meta'], step: 0.1 }}
      panning={{ excluded: ['cat-card__photo', 'bubble', 'cat-card__meta', 'button'] }}
      doubleClick={{ disabled: true }}
      keyboard={{ panStep: 80, zoomStep: 0.15 }}
      velocityAnimation={{ disabled: true }}
      onPanningStart={userMoved}
      onWheelStart={userMoved}
      onPinchStart={userMoved}
      onTransform={(_ref, { scale }) => {
        // Bubbles and cards keep a readable size when zoomed out.
        const root = api.current?.instance.wrapperComponent;
        root?.style.setProperty('--counter-scale', String(Math.max(1, 1 / scale)));
        if (zoomLabel.current)
          zoomLabel.current.textContent = `${String(Math.round(scale * 100))}%`;
      }}
    >
      <div
        className="canvas"
        onKeyDown={(e) => {
          const typing = (e.target as HTMLElement).closest('input, textarea, select');
          if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
          if (e.key.toLowerCase() === 'f') {
            e.preventDefault();
            moved.current = false;
            fit();
          } else if (e.key.startsWith('Arrow') || ['+', '-', '='].includes(e.key)) {
            userMoved();
          }
        }}
      >
        <TransformComponent wrapperClass="canvas__viewport" contentClass="canvas__content">
          {children}
        </TransformComponent>
        <div className="canvas__controls">
          <button
            type="button"
            className="button button--small"
            aria-label="Zoom out"
            onClick={() => {
              userMoved();
              void api.current?.zoomOut(0.2, animation());
            }}
          >
            −
          </button>
          <span ref={zoomLabel} className="canvas__zoom">
            100%
          </span>
          <button
            type="button"
            className="button button--small"
            aria-label="Zoom in"
            onClick={() => {
              userMoved();
              void api.current?.zoomIn(0.2, animation());
            }}
          >
            +
          </button>
          <button
            type="button"
            className="button button--small"
            aria-keyshortcuts="F"
            onClick={() => {
              moved.current = false;
              fit();
            }}
          >
            Fit
          </button>
        </div>
      </div>
    </TransformWrapper>
  );
}
