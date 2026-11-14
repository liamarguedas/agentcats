# Writing an adapter

An adapter connects one coding agent to agentcats.
agentcats ships three: Claude (`packages/adapters/claude`), Codex (`packages/adapters/codex`) and a scripted mock (`packages/adapters/mock`).
This page takes you from an empty folder to an adapter that passes the conformance suite.

## Pick a route

- **The agent speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP)**, like Gemini CLI, Kiro or Codex through codex-acp: you do not write a session yourself. `packages/adapters/acp` drives any ACP agent; your package only says how to start it and what it can do. `packages/adapters/codex` is the example, about 100 lines.
- **Anything else**: implement the `Adapter` interface directly, like `packages/adapters/claude` (an SDK) or `packages/adapters/mock` (in-process).

## 1. Create the package

```
packages/adapters/<name>/
  package.json
  tsconfig.json
  tsconfig.build.json
  src/index.ts
  src/<name>-adapter.ts
```

Copy `package.json`, `tsconfig.json` and `tsconfig.build.json` from `packages/adapters/codex`, then change the name to `@agentcats/adapter-<name>` and the dependencies to yours.
An ACP adapter depends on `@agentcats/adapter-acp` and `@agentcats/protocol`, like Codex; a direct adapter on `@agentcats/kit` (for `spawnGuarded`) and `@agentcats/protocol`.
Keep `"private": true`: only the `agentcats` package is published, with adapters bundled into it.
If your adapter reads a file at runtime, such as an agent script, resolve it with `new URL('../bin/agent.mjs', import.meta.url)` and add it to the files `packages/cli/scripts/pack.mjs` copies, so it survives bundling.
Pin every dependency to an exact version at least two weeks old.
Run `pnpm install` at the root.

If your adapter uses an agent SDK, add the SDK to `AGENT_SDKS` in `eslint.config.js`, so that no other package can import it.

## 2. Implement the adapter

The contract is `packages/protocol/src/adapter.ts`; its comments are the reference.
Import the contract's types (`Adapter`, `Session`, `SpawnOptions`, `AgentEvent`, `AdapterError`) from `@agentcats/protocol/adapter`, and shared types and rules (`PermissionMode`, `ToolKind`, `Usage`, `Billing`, `alwaysAskReason`, `isPush`) from `@agentcats/protocol`.

```ts
import type { Adapter } from '@agentcats/protocol/adapter';

export function createMyAdapter(): Adapter {
  return {
    id: 'my-agent', // stored on each cat; lowercase, stable
    displayName: 'My Agent', // shown on the cat's badge
    capabilities: {
      mcp: true, // can it take MCP servers? The lead needs this.
      approvals: true, // does it ask before actions?
      resume: false, // can a session continue after a restart?
      reportsCost: false, // does it report dollars? If not, cats get a time budget.
      modelSelection: true,
      interrupt: true,
      permissionModes: ['ask', 'accept_edits', 'auto'],
      policyEnforcement: 'sandbox', // 'hooks' if agentcats can check each action
      complete: true, // can it answer one prompt without tools (debriefs)?
    },
    modelTiers: { fast: 'small-model', balanced: 'medium-model', best: 'large-model' },
    estimateUsd: () => null, // dollars per interview candidate, or null if unknown
    spawn: (options) => startSession(options), // returns a Session
    complete: (options) => answerOnce(options),
    preflight: async () => ({ ready: true, detail: 'My Agent 1.2.3, logged in' }),
  };
}
```

Be honest in `capabilities`: the board relies on them.
`policyEnforcement: 'sandbox'` puts a ⚠ badge on the cat explaining that agentcats cannot check its actions one by one, and `reportsCost: false` switches its budget to working time.

For an ACP agent, pass an `AcpAgentConfig` to `createAcpAdapter` instead: the start command, the same capabilities and tiers, `modeFor` (which of the agent's modes to use for a permission mode and policy) and `modelOption` (the session option that sets the model).

### The session

`spawn` resolves once the agent runs, with a `Session`:

- `events()`: an async iterable of `AgentEvent`s: `session.started`, `turn.started`, `message.chunk`, `tool.started`, `tool.finished`, `approval.requested`, `usage`, `turn.ended`, `error`, `session.ended`.
- `send(text)`: start a turn.
- `approve(requestId, decision)`: answer an approval request.
- `interrupt()`: end the running turn with `stopReason: 'cancelled'`.
- `kill()`: end the agent and every process it started.

The guarantees the daemon relies on are listed on `Session`: `session.started` first, `session.ended` exactly once and last, turns that never overlap, every `turn.started` matched by one `turn.ended`.

What to send when:

- **`session.started.billing`**: `metered` (pay per use), `subscription`, or `unknown` when the agent does not say.
- **`usage` without a cost**: tokens if you have them, `costUsd: null` and `costSource: 'unknown'`; or no `usage` events at all.
- **A crash mid-turn**: an `error` event, `turn.ended` with `stopReason: 'error'`, then `session.ended` with `reason: 'crashed'`. A process that exits on its own after a clean shutdown is `exited`; one you killed is `killed`, whatever its exit code.
- **`interrupt()`**: end the running turn with `stopReason: 'cancelled'`, and keep the session usable.
- **`policyEnforcement`**: `hooks` when your adapter (or the agent, through a hook) checks every action against `SpawnOptions.policy` before it runs; `sandbox` when the agent's own sandbox is the only fence; `none` when there is neither.

### Helpers in `@agentcats/kit`

- **`spawnGuarded(command, args, { cwd, env })`** starts the agent under a guardian process and returns the guardian as a `ChildProcess`, whose stdin, stdout and stderr are piped straight to the agent. Report `child.pid` as `Session.pid`.
- **`killProcessTree(pid)`** kills the guardian and everything under it. Use it in `kill()`; `child.kill()` alone leaves the agent running on Windows.
- **`AsyncQueue`** is an async iterable you push events into; `events()` can return it. It allows one iterator, as `Session` requires.

### Rules that keep users safe

- **Start every process with `spawnGuarded`** from `@agentcats/kit`, and kill the whole tree in `kill()`. Then the agent cannot outlive agentcats, even after a hard kill.
- **Set a "killing" flag before you kill**, and report the exit that follows as `killed`, not `crashed`. Otherwise every Stop shows as a crash.
- **Map the agent policy.** `SpawnOptions.policy` says whether the session is `read_only` (the lead) or may edit its `cwd` (`workspace`), which commands run without asking (`allowedCommands`), which paths it must never write (`protectedPaths`) and which it may read outside its `cwd` (`readablePaths`). If your agent asks before actions, deny what the policy forbids and ask the user about the rest. `alwaysAskReason` in `@agentcats/protocol` says which commands ask at every level.
- **Never handle credentials.** Use the agent's own login, and check it in `preflight()`.

## 3. Pass the conformance suite

The suite (`packages/adapters/conformance`) checks the contract against a real session:

- a valid turn, and a follow-up in the same session;
- approvals allowed and denied;
- an interrupt that cancels a turn and leaves the session usable;
- one `events()` iterator per session;
- a kill that leaves no process;
- usage, or an honest "cost unknown";
- the working directory;
- a crash reported as the session ending;
- `preflight`.

Its options are `ConformanceTarget` in `packages/adapters/conformance/src/suite.ts`.
Some checks depend on your adapter:
- The crash check kills `Session.pid` from outside, so an adapter whose `pid` is `null` (an in-process agent) skips it.
- An adapter whose `capabilities.approvals` is false skips the approval checks.
- The interrupt check runs only if you give `prompts.long`.

The suite does not cover everything.
Test these in your package's own tests:
- policy enforcement: `read_only`, `protectedPaths`, `allowedCommands`;
- `complete()`;
- the `busy` and `closed` errors;
- `unsupported` options.

Add a target in `packages/adapters/conformance/test/<name>.test.ts`:

```ts
import { createMyAdapter } from '@agentcats/adapter-my-agent';

import { describeConformance } from '../src/index.js';

describeConformance({
  name: 'my agent',
  create: () => createMyAdapter(),
  prompts: {
    reply: 'Reply with one short sentence.',
    approval: 'Run exactly this shell command: curl -sI https://example.com',
    write: 'Create a file named conformance.txt containing: ok',
    long: 'Count from 1 to 400, one number per line.', // for the interrupt check
  },
});
```

Add your package to the conformance package's `devDependencies`, then run:

```sh
pnpm exec vitest run packages/adapters/conformance/test/<name>.test.ts
```

`prompts.approval` must make your agent ask for permission. If it only asks in a stricter mode, set `prompts.approvalMode` (Codex asks before edits in `ask`).
A target that spends money or needs a login runs only behind its own environment variable, like `AGENTCATS_LIVE_CODEX=1`, so CI and contributors never pay for it.
A scripted stand-in for your agent, like `packages/adapters/acp/test/fake-agent.mjs`, lets CI run the same code path for free.

## 4. Register it

- Add the id to `AdapterId` in `packages/protocol/src/config.ts`.
- Create it in `createAdapter` in `packages/cli/src/main.ts`, and add the package to the CLI's dependencies.
- Document its policy model and cost behavior in [the guide](guide.md#agents), and what it cannot do in the README's known limitations.
- Record how you verified it in `docs/decisions.md`.

`pnpm check` must pass before you open a pull request.
