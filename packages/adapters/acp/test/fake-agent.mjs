// A scripted ACP agent for tests: speaks the Agent Client Protocol on stdio
// and spends nothing. What it does in a turn depends on words in the prompt:
//
//   approve  asks permission to run a command; runs it only if allowed
//   write    writes conformance.txt ("ok") into the session's cwd
//   mcp      lists the MCP servers it was given, in its answer
//   hang     never answers until cancelled
//   crash    exits the process mid-turn
//   cost     reports a usage update with a cost of $0.01
//   (other)  answers "Hello from the fake agent."
//
// Every prompt's text is echoed in `_meta`-free form: the first line of the
// answer quotes the last prompt block, so tests can check what was sent.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

const sessions = new Map();
let next = 0;

const update = (client, sessionId, value) =>
  client.notify(methods.client.session.update, { sessionId, update: value });
const say = (client, sessionId, text) =>
  update(client, sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });

agent({ name: 'fake-agent' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: false,
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { resume: {} },
    },
    agentInfo: { name: 'fake-agent', version: '1.0.0' },
  }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    const sessionId = `fake-${String(++next)}`;
    sessions.set(sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      mode: null,
      model: null,
    });
    return { sessionId };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => {
    sessions.set(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      mode: null,
      model: null,
    });
    return {};
  })
  .onRequest(methods.agent.session.setMode, ({ params }) => {
    sessions.get(params.sessionId).mode = params.modeId;
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    sessions.get(params.sessionId).model = params.value;
    return { configOptions: [] };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    sessions.get(params.sessionId)?.cancel?.();
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const { sessionId } = params;
    const session = sessions.get(sessionId);
    const texts = params.prompt.filter((b) => b.type === 'text').map((b) => b.text);
    const text = texts.at(-1) ?? '';
    const cancelled = new Promise((resolve) => {
      session.cancel = () => resolve('cancelled');
    });

    await update(client, sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking about it.' },
    });

    if (/\bcrash\b/.test(text)) process.exit(3);
    if (/\bhang\b/.test(text)) return { stopReason: await cancelled };

    if (/\bapprove\b/.test(text)) {
      const toolCallId = 'tool-approve';
      await update(client, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'Run npm test',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'npm test' },
      });
      const answer = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: {
          toolCallId,
          title: 'Run npm test',
          kind: 'execute',
          rawInput: { command: 'npm test' },
        },
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes';
      await update(client, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: allowed ? 'completed' : 'failed',
      });
      await say(client, sessionId, allowed ? 'Ran the tests.' : 'Did not run the tests.');
      return { stopReason: 'end_turn' };
    }

    if (/\bwrite\b/.test(text)) {
      await update(client, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-write',
        title: 'Write conformance.txt',
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: join(session.cwd, 'conformance.txt') }],
      });
      writeFileSync(join(session.cwd, 'conformance.txt'), 'ok\n');
      await update(client, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-write',
        status: 'completed',
      });
    }

    if (/\bcost\b/.test(text)) {
      await update(client, sessionId, {
        sessionUpdate: 'usage_update',
        used: 1000,
        size: 200000,
        cost: { amount: 0.01, currency: 'USD' },
      });
    }

    const lines = [
      `Prompt blocks: ${String(texts.length)}. Mode: ${String(session.mode)}. Model: ${String(session.model)}.`,
    ];
    if (/\bmcp\b/.test(text))
      lines.push(`MCP: ${session.mcpServers.map((s) => s.name).join(', ')}`);
    if (texts.length > 1) lines.push(`First block: ${texts[0].slice(0, 80)}`);
    lines.push('Hello from the fake agent.');
    await say(client, sessionId, lines.join('\n'));
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
