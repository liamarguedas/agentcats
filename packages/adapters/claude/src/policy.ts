import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { alwaysAskReason, isPush, scriptRisk } from '@agentcats/protocol';
import type { AgentPolicy } from '@agentcats/protocol/adapter';
import type { HookCallbackMatcher, Options } from '@anthropic-ai/claude-agent-sdk';

/**
 * A decision for one tool call: let Claude Code's normal flow decide, allow
 * without a prompt, force a prompt, or block.
 */
export type Decision =
  | { readonly kind: 'pass' }
  | { readonly kind: 'allow'; readonly reason: string }
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

const sameCase = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** Whether `path` is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(sameCase(resolve(root)), sameCase(resolve(path)));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Decide a shell command for a worker. `scripts` are the `package.json`
 * scripts in the worktree, read when the command runs: an allowed
 * `pnpm test` still asks if the worker made its `test` script fetch or delete.
 */
export function decideCommand(
  command: string,
  policy: AgentPolicy,
  scripts: Readonly<Record<string, string>> = {},
): Decision {
  if (isPush(command)) {
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
  const ask = alwaysAskReason(command);
  if (ask) return { kind: 'ask', reason: ASK_REASONS[ask] };
  const risk = scriptRisk(command, scripts);
  if (risk) {
    return {
      kind: 'ask',
      reason: `The "${risk.script}" script in package.json involves ${SCRIPT_RISKS[risk.reason]}: needs your approval.`,
    };
  }
  return PASS;
}

const SCRIPT_RISKS: Record<'network' | 'install' | 'destructive' | 'push', string> = {
  network: 'network access',
  install: 'a package install',
  destructive: 'deleting files',
  push: 'a git push',
};

/** `package.json` scripts in `dir`, or none if there is no readable file. */
export function readScripts(dir: string): Record<string, string> {
  try {
    const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      scripts?: unknown;
    };
    if (typeof json.scripts !== 'object' || json.scripts === null) return {};
    return Object.fromEntries(
      Object.entries(json.scripts).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

const ASK_REASONS: Record<NonNullable<ReturnType<typeof alwaysAskReason>>, string> = {
  network: 'Network access: needs your approval.',
  install: 'Package install: needs your approval.',
  destructive: 'This can delete work: needs your approval.',
};

/**
 * Decide a read or search for a worker. Inside its worktree Claude Code
 * allows it anyway; inside one of the policy's `readablePaths` it is allowed
 * without a prompt; anywhere else Claude Code asks as usual.
 */
export function decideRead(path: string, cwd: string, policy: AgentPolicy): Decision {
  if (!path) return PASS;
  const target = resolve(cwd, path);
  if (isInside(cwd, target)) return PASS;
  if ((policy.readablePaths ?? []).some((p) => isInside(p, target))) {
    return { kind: 'allow', reason: 'Reading the main checkout is allowed at this level.' };
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

/**
 * Claude Code settings for a session. With `attribution: false` the
 * commit and PR attribution (the `Co-Authored-By: Claude` trailer) is hidden.
 * The object form is used because older Claude Code versions reject a bare
 * boolean there.
 */
export function sessionSettings(attribution: boolean | undefined): Pick<Options, 'settings'> {
  return attribution === false ? { settings: { attribution: { commit: '', pr: '' } } } : {};
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
 *   pushes and writes outside `cwd`, force a prompt for network access,
 *   installs and destructive commands, and allow reads in `readablePaths`.
 *   Hooks run for every call, including ones Claude Code would auto-approve.
 */
export function policyOptions(
  policy: AgentPolicy | undefined,
  cwd: string,
): Pick<Options, 'allowedTools' | 'disallowedTools' | 'hooks'> {
  if (!policy) return {};
  if (policy.access === 'read_only') {
    // A hook approves the agentcats tools. An allow rule would too, but the SDK
    // warns that it shadows canUseTool, and that warning reaches the user's terminal.
    const allowAgentcats: HookCallbackMatcher = {
      matcher: '^mcp__agentcats__',
      hooks: [
        () =>
          Promise.resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
              permissionDecisionReason: 'agentcats team tool',
            },
          }),
      ],
    };
    return { disallowedTools: WRITE_AND_SHELL_TOOLS, hooks: { PreToolUse: [allowAgentcats] } };
  }
  const pre: HookCallbackMatcher[] = [
    {
      matcher: 'Bash|PowerShell',
      hooks: [
        (input) =>
          Promise.resolve(
            hookOutput(decideCommand(field(toolInput(input), 'command'), policy, readScripts(cwd))),
          ),
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
      matcher: 'Read|Grep|Glob|LS',
      hooks: [
        (input) => {
          const args = toolInput(input);
          const path = field(args, 'file_path') || field(args, 'path');
          return Promise.resolve(hookOutput(decideRead(path, cwd, policy)));
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
