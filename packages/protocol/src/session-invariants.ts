import type { AgentEvent } from './adapter.js';

/**
 * Check a complete event stream from one session against the guarantees
 * documented on `Session`. Used by adapter tests now and by the conformance
 * suite in M4.
 *
 * @returns Human-readable violations; empty when the stream is valid.
 */
export function checkSessionInvariants(events: readonly AgentEvent[]): string[] {
  const violations: string[] = [];
  const at = (i: number, msg: string) => violations.push(`#${i} ${msg}`);

  if (events[0]?.type !== 'session.started') at(0, 'first event must be session.started');
  if (events.at(-1)?.type !== 'session.ended') {
    at(events.length - 1, 'last event must be session.ended');
  }

  let inTurn = false;
  const openTools = new Set<string>();
  let lastUsage: Extract<AgentEvent, { type: 'usage' }>['usage'] | null = null;

  for (const [i, event] of events.entries()) {
    switch (event.type) {
      case 'session.started':
        if (i !== 0) at(i, 'session.started may only appear first');
        break;
      case 'session.ended':
        if (i !== events.length - 1) at(i, 'session.ended may only appear last');
        break;
      case 'turn.started':
        if (inTurn) at(i, 'turn.started while a turn is running');
        inTurn = true;
        break;
      case 'turn.ended':
        if (!inTurn) at(i, 'turn.ended without turn.started');
        for (const id of openTools) at(i, `turn ended with tool ${id} still running`);
        openTools.clear();
        inTurn = false;
        break;
      case 'tool.started':
        if (!inTurn) at(i, `tool ${event.toolCallId} started outside a turn`);
        if (openTools.has(event.toolCallId)) at(i, `tool ${event.toolCallId} started twice`);
        openTools.add(event.toolCallId);
        break;
      case 'tool.finished':
        if (!openTools.delete(event.toolCallId)) {
          at(i, `tool ${event.toolCallId} finished without starting`);
        }
        break;
      case 'usage':
        if (lastUsage) {
          for (const key of [
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
          ] as const) {
            if (event.usage[key] < lastUsage[key]) at(i, `usage.${key} decreased`);
          }
          if (
            lastUsage.costUsd !== null &&
            event.usage.costUsd !== null &&
            event.usage.costUsd < lastUsage.costUsd
          ) {
            at(i, 'usage.costUsd decreased');
          }
        }
        lastUsage = event.usage;
        break;
      case 'message.chunk':
      case 'approval.requested':
      case 'error':
        break;
    }
  }

  if (inTurn && events.at(-1)?.type === 'session.ended') {
    at(events.length - 1, 'session ended inside a turn without turn.ended');
  }
  return violations;
}
