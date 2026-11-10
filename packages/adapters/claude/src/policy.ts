import { isAbsolute, relative, resolve } from 'node:path';

import type { AgentPolicy } from '@agentcats/protocol/adapter';
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';

/** A decision for one tool call: let Claude Code's normal flow decide, force a prompt, or block. */
export type Decision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'ask'; readonly reason: string }
  | { readonly kind: 'deny'; readonly reason: string };

const PASS: Decision = { kind: 'pass' };

/** Tools that change files or run commands. The orchestrator gets none of them. */
const WRITE_AND_SHELL_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'PowerShell',
];

const PUSH = /\bgit\b[^\n;&|]*\bpush\b/i;
/**
 * Commands that usually reach the network. They always ask, even when an
 * allow rule or Claude Code's read-only list would let them through.
 */
const NETWORK = new RegExp(
  [
    String.raw`\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp)\b`,
    String.raw`\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b`,
    String.raw`\bgit\s+(clone|fetch|pull|ls-remote|submodule\s+update)\b`,
    String.raw`\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|dlx|create)\b`,
    String.raw`\b(npx|pnpx|bunx)\b`,
    String.raw`\bpip3?\s+(install|download)\b`,
    String.raw`\b(uv|poetry)\s+(add|sync|install|pip\s+install)\b`,
    String.raw`\b(cargo|go)\s+(install|get|add|fetch)\b`,
  ].join('|'),
  'i',
);

const sameCase = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** Whether `path` is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(sameCase(resolve(root)), sameCase(resolve(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Decide a shell command for a worker. */
export function decideCommand(command: string, policy: AgentPolicy): Decision {
  if (PUSH.test(command)) {
    return {
      kind: 'deny',
      reason: 'Pushing is not allowed in agentcats. Commit to your branch; the user merges it.',
    };
  }
  const normalized = sameCase(command.replace(/\\/g, '/'));
  for (const path of policy.protectedPaths) {
    const protectedPath = sameCase(resolve(path).replace(/\\/g, '/'));
    if (normalized.includes(protectedPath)) {
      return {
        kind: 'deny',
        reason: 'That command touches the main checkout. Work only inside your worktree.',
      };
    }
  }
  if (NETWORK.test(command)) {
    return { kind: 'ask', reason: 'Network access or package install: needs your approval.' };
  }
  return PASS;
}

/** Decide a file write for a worker whose worktree is `cwd`. */
export function decideWrite(filePath: string, cwd: string, policy: AgentPolicy): Decision {
  const target = resolve(cwd, filePath);
  if (isInside(cwd, target)) return PASS;
  if (policy.protectedPaths.some((p) => isInside(p, target))) {
    return {
      kind: 'deny',
      reason: 'That file is in the main checkout. Work only inside your worktree.',
    };
  }
  return { kind: 'deny', reason: 'Writes outside your worktree are not allowed.' };
}

function hookOutput(decision: Decision) {
  if (decision.kind === 'pass') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse' as const,
      permissionDecision: decision.kind,
      permissionDecisionReason: decision.reason,
    },
  };
}

const field = (input: unknown, name: string): string => {
  const value = (input as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : '';
};

/**
 * SDK options that enforce an {@link AgentPolicy}.
 *
 * - `read_only`: edit and shell tools are removed; agentcats MCP tools need no prompt.
 * - `workspace`: allowed commands run without asking; PreToolUse hooks deny
 *   pushes and writes outside `cwd`, and force a prompt for network access.
 *   Hooks run for every call, including ones Claude Code would auto-approve.
 */
export function policyOptions(
  policy: AgentPolicy | undefined,
  cwd: string,
): Pick<Options, 'allowedTools' | 'disallowedTools' | 'hooks'> {
  if (!policy) return {};
  if (policy.access === 'read_only') {
    return { disallowedTools: WRITE_AND_SHELL_TOOLS, allowedTools: ['mcp__agentcats__*'] };
  }
  const pre: HookCallbackMatcher[] = [
    {
      matcher: 'Bash|PowerShell',
      hooks: [
        (input) =>
          Promise.resolve(hookOutput(decideCommand(field(toolInput(input), 'command'), policy))),
      ],
    },
    {
      matcher: 'Write|Edit|MultiEdit|NotebookEdit',
      hooks: [
        (input) => {
          const args = toolInput(input);
          const path = field(args, 'file_path') || field(args, 'notebook_path');
          return Promise.resolve(path ? hookOutput(decideWrite(path, cwd, policy)) : {});
        },
      ],
    },
    {
      matcher: 'WebFetch|WebSearch',
      hooks: [
        () =>
          Promise.resolve(
            hookOutput({ kind: 'ask', reason: 'Network access: needs your approval.' }),
          ),
      ],
    },
  ];
  return {
    allowedTools: policy.allowedCommands.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
    hooks: { PreToolUse: pre },
  };
}

function toolInput(input: unknown): unknown {
  return (input as { tool_input?: unknown }).tool_input;
}
