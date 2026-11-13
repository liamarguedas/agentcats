import { createRequire } from 'node:module';

import { type AcpAgentConfig, createAcpAdapter } from '@agentcats/adapter-acp';
import type { Adapter } from '@agentcats/protocol/adapter';

const require = createRequire(import.meta.url);

/** The codex-acp version agentcats is tested with (it bundles its own Codex build). */
export const TESTED_CODEX_ACP_VERSION = '0.16.0';

export interface CodexAdapterOptions {
  /**
   * Command that speaks ACP for Codex. Default: the bundled
   * `@zed-industries/codex-acp` launcher, run with this Node.
   */
  readonly command?: { readonly command: string; readonly args: readonly string[] };
  /**
   * On Windows, which sandbox Codex uses. The default `unelevated` works with
   * codex-acp's bundled Codex build; `codex_config` keeps what
   * `~/.codex/config.toml` says. In the M4 live run, the user's `elevated`
   * setting (made by a newer Codex CLI) made every command fail with
   * "windows sandbox: spawn setup refresh".
   */
  readonly windowsSandbox?: 'unelevated' | 'codex_config';
}

/**
 * Codex, over the Agent Client Protocol through Zed's codex-acp. It uses the
 * user's own Codex login and config (`~/.codex`), so agentcats never handles
 * credentials.
 *
 * Codex keeps its agents safe with a sandbox rather than per-call checks: in
 * its `auto` mode it edits files and runs commands in the workspace without
 * asking, and its sandbox blocks the network and writes elsewhere. On
 * Windows (verified live, M4) a network command is not asked about: it runs
 * and fails in the sandbox. So the
 * worker policy's allowed commands, level gates and always-ask rules are not
 * enforced one by one (`policyEnforcement: 'sandbox'`); the board says so on
 * Codex cats. Codex reports no cost over ACP, so its cats get a time budget.
 */
export function createCodexAdapter(options: CodexAdapterOptions = {}): Adapter {
  const sandboxArgs =
    process.platform === 'win32' && (options.windowsSandbox ?? 'unelevated') === 'unelevated'
      ? ['-c', 'windows.sandbox="unelevated"']
      : [];
  const launcher = options.command ?? {
    command: process.execPath,
    args: [require.resolve('@zed-industries/codex-acp/bin/codex-acp.js'), ...sandboxArgs],
  };
  const config: AcpAgentConfig = {
    id: 'codex',
    displayName: 'Codex',
    command: launcher.command,
    args: launcher.args,
    capabilities: {
      mcp: true,
      approvals: true,
      resume: true,
      reportsCost: false,
      modelSelection: true,
      interrupt: true,
      permissionModes: ['ask', 'accept_edits', 'auto'],
      policyEnforcement: 'sandbox',
      complete: true,
    },
    modelTiers: { fast: 'gpt-5.4-mini', balanced: 'gpt-5.4', best: 'gpt-5.5' },
    estimateUsd: () => null,
    // `read-only` asks before every edit; `auto` edits and runs commands in
    // the workspace and asks for the network and anything outside it.
    modeFor: (policy, mode) =>
      policy?.access === 'read_only' || mode === 'ask' ? 'read-only' : 'auto',
    modelOption: 'model',
  };
  return createAcpAdapter(config);
}
