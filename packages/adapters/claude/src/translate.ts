import type { Billing, ToolKind, Usage } from '@agentcats/protocol';
import type { AgentEvent, StopReason } from '@agentcats/protocol/adapter';
import type { AccountInfo, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

const SUMMARY_LIMIT = 200;

const TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  PowerShell: 'execute',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
  Task: 'think',
  Agent: 'think',
  TodoWrite: 'think',
};

/** Normalized category for a Claude Code tool name. */
export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS[toolName] ?? 'other';
}

const SUMMARY_FIELDS = ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'url', 'query'];

/** One line describing a tool input, for the bubble. Never the full input. */
export function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const field of SUMMARY_FIELDS) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) return clip(value);
  }
  if (typeof record['description'] === 'string') return clip(record['description']);
  return clip(JSON.stringify(input));
}

function clip(text: string, limit = SUMMARY_LIMIT): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join(' ');
}

/**
 * How a Claude session is paid for. Cloud providers and API keys are metered;
 * a first-party login with a subscription plan is not. `null` account info
 * (an older CLI, or the lookup failed) is `unknown`.
 */
export function billingOf(account: AccountInfo | null): Billing {
  if (!account) return 'unknown';
  if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') return 'metered';
  if (account.apiKeySource !== undefined && account.apiKeySource !== 'none') return 'metered';
  if (account.subscriptionType) return 'subscription';
  return 'unknown';
}

/** How a Claude `result` message ends the turn. */
export function stopReasonOf(result: SDKResultMessage, interrupted: boolean): StopReason {
  if (interrupted) return 'cancelled';
  if (result.stop_reason === 'refusal') return 'refusal';
  if (result.stop_reason === 'max_tokens') return 'max_tokens';
  switch (result.subtype) {
    case 'success':
      return result.is_error ? 'error' : 'end_turn';
    case 'error_max_turns':
      return 'max_turns';
    case 'error_during_execution':
    case 'error_max_budget_usd':
    case 'error_max_structured_output_retries':
      return 'error';
  }
}

/**
 * Turns Claude Agent SDK messages into normalized {@link AgentEvent}s. Holds
 * the per-session state needed to keep the stream guarantees: which tool
 * calls are still open, and the cumulative usage.
 *
 * Only top-level activity is reported. Subagent frames (`parent_tool_use_id`
 * set) are folded into the `Task` tool call that started them.
 */
export class Translator {
  readonly #openTools = new Set<string>();
  #usage: Usage | null = null;

  /** Events for one SDK message. A `result` also closes the turn. */
  handle(message: SDKMessage, interrupted = false): AgentEvent[] {
    switch (message.type) {
      case 'assistant': {
        if (message.parent_tool_use_id !== null) return [];
        const events: AgentEvent[] = [];
        if (message.error) {
          events.push({
            type: 'error',
            message: `Claude API error: ${message.error}`,
            fatal: false,
          });
        }
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.length > 0) {
            events.push({
              type: 'message.chunk',
              messageId: `${message.message.id}-${String(events.length)}`,
              channel: 'text',
              text: block.text,
            });
          } else if (block.type === 'thinking' && block.thinking.length > 0) {
            events.push({
              type: 'message.chunk',
              messageId: `${message.message.id}-${String(events.length)}`,
              channel: 'thought',
              text: block.thinking,
            });
          } else if (block.type === 'tool_use') {
            this.#openTools.add(block.id);
            events.push({
              type: 'tool.started',
              toolCallId: block.id,
              toolName: block.name,
              kind: toolKind(block.name),
              inputSummary: summarizeInput(block.input),
            });
          }
        }
        return events;
      }

      case 'user': {
        if (message.parent_tool_use_id !== null || typeof message.message.content === 'string') {
          return [];
        }
        const events: AgentEvent[] = [];
        for (const block of message.message.content) {
          if (block.type !== 'tool_result' || !this.#openTools.delete(block.tool_use_id)) continue;
          events.push({
            type: 'tool.finished',
            toolCallId: block.tool_use_id,
            status: block.is_error ? 'error' : 'success',
            outputSummary: block.is_error ? clip(textOf(block.content)) || null : null,
          });
        }
        return events;
      }

      case 'result': {
        const events: AgentEvent[] = [];
        const usage = this.#usageFrom(message);
        if (usage) events.push({ type: 'usage', usage });
        if (message.subtype === 'success' && message.is_error && !interrupted) {
          events.push({
            type: 'error',
            message: clip(message.result || 'Claude reported an error'),
            fatal: false,
          });
        } else if (message.subtype !== 'success' && !interrupted) {
          const detail =
            'errors' in message && Array.isArray(message.errors) ? message.errors.join('; ') : '';
          events.push({
            type: 'error',
            message: clip(detail || `Claude stopped: ${message.subtype}`),
            fatal: false,
          });
        }
        events.push(...this.closeTurn(stopReasonOf(message, interrupted)));
        return events;
      }

      default:
        return [];
    }
  }

  /** Finish every open tool call as failed, then end the turn. */
  closeTurn(stopReason: StopReason): AgentEvent[] {
    const events: AgentEvent[] = [...this.#openTools].map((toolCallId) => ({
      type: 'tool.finished' as const,
      toolCallId,
      status: 'error' as const,
      outputSummary: null,
    }));
    this.#openTools.clear();
    events.push({ type: 'turn.ended', stopReason });
    return events;
  }

  /**
   * Cumulative usage from a result. `modelUsage` and `total_cost_usd` are
   * running totals for the session, so read them, never sum them. Values are
   * clamped so they never go backwards.
   */
  #usageFrom(result: SDKResultMessage): Usage | null {
    const models = Object.values(result.modelUsage);
    if (models.length === 0 && this.#usage === null) return null;
    const sum = (pick: (m: (typeof models)[number]) => number) =>
      models.reduce((total, m) => total + pick(m), 0);
    const previous = this.#usage;
    const next: Usage = {
      inputTokens: Math.max(
        previous?.inputTokens ?? 0,
        sum((m) => m.inputTokens),
      ),
      outputTokens: Math.max(
        previous?.outputTokens ?? 0,
        sum((m) => m.outputTokens),
      ),
      cacheReadTokens: Math.max(
        previous?.cacheReadTokens ?? 0,
        sum((m) => m.cacheReadInputTokens),
      ),
      cacheWriteTokens: Math.max(
        previous?.cacheWriteTokens ?? 0,
        sum((m) => m.cacheCreationInputTokens),
      ),
      costUsd: Math.max(previous?.costUsd ?? 0, result.total_cost_usd),
      costSource: 'reported',
      activeMs: 0,
    };
    this.#usage = next;
    return next;
  }
}

/** Usage of a single one-shot call, from its result message. */
export function usageOfResult(result: SDKResultMessage): Usage {
  const models = Object.values(result.modelUsage);
  const sum = (pick: (m: (typeof models)[number]) => number) =>
    models.reduce((total, m) => total + pick(m), 0);
  return {
    inputTokens: sum((m) => m.inputTokens),
    outputTokens: sum((m) => m.outputTokens),
    cacheReadTokens: sum((m) => m.cacheReadInputTokens),
    cacheWriteTokens: sum((m) => m.cacheCreationInputTokens),
    costUsd: result.total_cost_usd,
    costSource: 'reported',
    activeMs: 0,
  };
}
