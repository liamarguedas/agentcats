# M6: The board as a canvas

Prerequisite: M5 acceptance criteria met (0.1.0 released).

## Goal

Make the office the whole screen: a canvas you can pan and zoom, with the chat, tasks and details in panels that slide in from the sides, the way Excalidraw keeps its tools around a full-screen drawing.
Two things drive it.
The office is a fixed-size box inside a scrolling container, so bubbles and cards near its edges get cut off, and every fix so far has been a patch for one case.
And a fixed room does not scale: at 12 to 16 cats the desks, the meeting table and the cards crowd each other.

The office metaphor stays.
Where a cat stands still says what it is doing: planning or waiting at the whiteboard, working at a desk, needing you at the meeting table.
This is not a drawing tool and cats are not placed by hand.

## Scope

### 1. Step 0: prototype and decisions
Before the real work, a short spike on a branch, recorded in `docs/decisions.md`:
- Pan and zoom on a transform layer over the current office, with 3 and with 12 mock cats.
- One side panel (the chat) as an overlay.
- Screenshots of the current board and the prototype, side by side, at 1280 x 800 and 1920 x 1080, with 3 and 12 cats.
- Frame times while panning with 16 cats walking.
- Go or no-go on the rest of this milestone.

Decided with the user on 2026-11-14, before the spike:
- **Pan and zoom: a library**, such as react-zoom-pan-pinch. The spike checks its license, that the version is at least two weeks old, its bundle size, keyboard and reduced-motion support, and that the overlay layer (section 6) can follow its transform.
- **Panels: the chat open on first load**, the tasks and the event log closed.
- **Zones: the desks in the middle** as an open-plan area, the whiteboard above them and the meeting table to the side.

### 2. The canvas
- The office fills the window under a thin top bar.
- Pan by dragging the empty floor, with the scroll wheel or trackpad, or with the arrow keys.
- Zoom with Ctrl or Cmd and the wheel, pinch on a trackpad or touch screen, and `+` and `-`, between limits that keep cats readable.
- **Fit** (key `F`) frames every cat; the first load and a new team fit automatically.
- The viewport is remembered per project in the browser, and reset by Fit.
- Respects reduced motion: no animated panning or zooming then.

### 3. Zones that grow with the team
- The whiteboard, the desks and the meeting table stay three zones on the canvas, laid out by the board, not by the user: the desks in the middle, the whiteboard above, the meeting table to the side.
- The desks add rows as workers are hired, the meeting table adds seats as cats wait for you, and the whiteboard row grows with idle cats. Nothing overlaps at 16 workers.
- A cat walks between zones as it does today.
- Zone labels stay readable at every zoom.

### 4. Panels at the edges
- The chat with the lead, the tasks and the event log become panels that overlay the canvas from the sides, each collapsible to a tab. The chat is open on first load, the others closed; their state is then remembered.
- A cat's or a task's details open as a side panel instead of a drawer over the board; the canvas stays visible and live next to it.
- The top bar keeps the actions: Hire a cat, Replay, Settings, theme, team spend, connection.
- Hiring, retiring, settings and replay keep their dialogs.

### 5. Attention
- A **Needs you** button in the top bar counts the cats waiting for an approval, blocked, paused or in error. Clicking it brings them into view; `N` steps through them.
- A cat that needs you while it is off screen shows as a marker at the edge of the canvas, in its direction; clicking the marker brings it into view.

### 6. Bubbles and cards that are never cut off
- Bubbles, hover cards and meme captions are drawn in a screen-space layer above the canvas, anchored to their cat, at a readable size whatever the zoom.
- They are kept inside the visible canvas and clear of the open panels. This replaces the office's height and edge workarounds.

### 7. Keyboard, accessibility and small screens
- Tab moves through the cats in a stable order and brings the focused one into view. A, D and P keep working on it, Enter opens its details.
- The canvas has an accessible name and the cats keep their labels; a screen reader user can work the board without panning.
- On a narrow screen (about 400 px wide), panels become bottom sheets and the canvas stays usable with touch.

### 8. Replay and read-only
- Replay plays on the canvas, with the replay bar in the top bar area and the read-only guards as today.

### 9. Tests, docs and media
- Every browser test passes on the new layout; tests that relied on fixed positions are rewritten against the canvas.
- New tests for pan, zoom, fit, the Needs you button and its markers, keyboard focus following, and bubbles and cards staying inside the visible canvas at the zoom limits and at every zone edge.
- `docs/guide.md` describes the canvas, the panels and the keys.
- The README GIF, the banner and the social preview are rendered again from the new board.

## Acceptance criteria
- [x] Step 0 is recorded in `docs/decisions.md`: the screenshots, the frame times, the decisions, and the go.
- [x] With 12 cats and 3 of them needing you, one click on **Needs you** brings all 3 into view, and `N` steps through them (browser test).
- [x] No bubble or card is cut off: a browser test opens them for cats at every zone edge, at the minimum and maximum zoom, with a panel open.
- [x] 16 cats on the board, no overlaps between cats, desks and the table (browser test on positions).
- [x] Panning and zooming with 16 cats walking keeps the frame interval at most 17 ms at the 95th percentile, with fewer than 5% of frames over 20 ms, on the CI runner (measured in the browser test; changed on 2026-11-14, see the decisions log).
- [x] The whole board works from the keyboard: focus moves through the cats and follows them into view, and A, D, P and Enter work.
- [x] Panels collapse and open, and remember it; the canvas is usable at 400 px wide with touch, and at 1280 x 800 and 1920 x 1080.
- [x] Replay works on the canvas, read-only.
- [x] Every existing board flow still passes its browser test; the README GIF matches the new board.

## Not in this milestone
- Placing cats by hand, drawing, notes or other Excalidraw tools on the canvas.
- Several projects or teams on one canvas.
- Workers that run their own sub-agents (nested orchestration): parked on 2026-11-14, see `docs/decisions.md`.
