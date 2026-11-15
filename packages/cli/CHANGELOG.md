# agentcats

## 0.2.1

### Patch Changes

- 50536fc: Bubbles land in the right place: on a page with CSS zoom they no longer end up off screen, a cat's bubble waits until the cat arrives instead of showing mid-walk, and in a crowded room bubbles move to free space instead of covering each other or the cats, with their lines kept clear of other bubbles.

## 0.2.0

### Minor Changes

- 5990dd8: The board is a full-screen canvas: pan and zoom the office (drag, scroll, Ctrl or Cmd and scroll, Ctrl or Cmd and + or -, pinch, arrow keys, F or Ctrl 0 to fit), with the chat, tasks and event log in panels on the right and a cat's or task's details on the left. The office is a set of rooms spread over the canvas: the lead's office, the workspace, the meeting room, the break room and, for retired cats, out of office. Each room grows with the team. Names, bubbles and cards stay readable and in view at any zoom, and bubbles move aside instead of covering each other or a cat. **Needs you** in the header and the N key bring the cats waiting for you into view, and markers at the edge point to those out of view. On a phone the panels are bottom sheets.
- 978bfca: Settings on the board: the default agent, the lead's and workers' agent and model, team size, budgets and captions, saved for the project or as your defaults for every project (`~/.agentcats/agentcats.config.json`). Cats on another agent than their role's default are listed and can be moved, and agentcats says at start when one is.

### Patch Changes

- 32f7603: Cats whose meme photo cut through their body now fade out at that edge instead of ending in a straight line.

## 0.1.0

### Minor Changes

- 0dc99b3: First release: a local whiteboard where coding agents are cats. Claude Code and Codex cats, a lead that splits work across workers on their own git branches, approvals on the board, memory and levels, hiring by interview, session replay and export, a cost meter, meme captions, and `npx agentcats --demo`.
