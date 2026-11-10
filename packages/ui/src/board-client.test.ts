import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMockAdapter } from '@agentcats/adapter-mock';
import { type RunningDaemon, startDaemon } from '@agentcats/daemon';
import {
  type AgentcatsEvent,
  AgentcatsConfig,
  applyEvent,
  emptyBoard,
  PROTOCOL_VERSION,
  type Snapshot,
} from '@agentcats/protocol';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardClient, type BoardView, type WebSocketLike } from './board-client.js';

// ---------------------------------------------------------------------------
// Fakes for the sync logic
// ---------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  open() {
    this.onopen?.();
  }
  send(event: AgentcatsEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

const statusEvent = (seq: number, status: 'thinking' | 'working' | 'idle'): AgentcatsEvent => ({
  id: `e${String(seq)}`,
  seq,
  ts: seq,
  type: 'cat.status_changed',
  catId: 'cat-1',
  payload: { status, reason: null },
});

const created: AgentcatsEvent = {
  id: 'e1',
  seq: 1,
  ts: 1,
  type: 'cat.created',
  catId: 'cat-1',
  payload: { name: 'Mochi', adapter: 'mock', model: null, permissionMode: 'accept_edits' },
};

function snapshotOf(events: AgentcatsEvent[]): Snapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    board: events.reduce(applyEvent, emptyBoard()),
    events,
  };
}

function fakeClient(snapshots: (Snapshot | 401)[]) {
  const sockets: FakeSocket[] = [];
  const fetch = vi.fn(() => {
    const next = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
    const body = next === 401 ? { error: { code: 'unauthorized', message: 'bad token' } } : next;
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: next === 401 ? 401 : 200 }),
    );
  });
  const client = new BoardClient({
    baseUrl: 'http://127.0.0.1:1',
    token: 't'.repeat(43),
    fetch,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets, fetch };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('BoardClient sync', () => {
  it('applies events buffered while the snapshot loads and drops duplicates', async () => {
    const { client, sockets } = fakeClient([snapshotOf([created, statusEvent(2, 'thinking')])]);
    client.start();
    sockets[0]!.open();
    sockets[0]!.send(statusEvent(2, 'thinking')); // already in the snapshot
    sockets[0]!.send(statusEvent(3, 'working')); // newer than the snapshot
    await settle();

    const view = client.getView();
    expect(view.connection).toBe('live');
    expect(view.board.lastSeq).toBe(3);
    expect(view.board.cats['cat-1']?.status).toBe('working');
    expect(view.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    client.stop();
  });

  it('refetches the snapshot when it sees a gap', async () => {
    const full = [
      created,
      statusEvent(2, 'thinking'),
      statusEvent(3, 'working'),
      statusEvent(4, 'idle'),
    ];
    const { client, sockets, fetch } = fakeClient([snapshotOf([created]), snapshotOf(full)]);
    client.start();
    sockets[0]!.open();
    await settle();
    sockets[0]!.send(statusEvent(4, 'idle')); // 2 and 3 were missed
    await settle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client.getView().board.lastSeq).toBe(4);
    expect(client.getView().board.cats['cat-1']?.status).toBe('idle');
    client.stop();
  });

  it('reconnects after the socket drops, then resyncs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { client, sockets } = fakeClient([snapshotOf([created])]);
      client.start();
      sockets[0]!.open();
      await vi.runOnlyPendingTimersAsync();
      sockets[0]!.close();
      expect(client.getView().connection).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(600);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      await vi.runOnlyPendingTimersAsync();
      expect(client.getView().connection).toBe('live');
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops and reports a rejected token when the upgrade fails', async () => {
    const { client, sockets } = fakeClient([401]);
    client.start();
    sockets[0]!.close(); // closed without ever opening
    await settle();

    expect(client.getView().connection).toBe('unauthorized');
    expect(sockets).toHaveLength(1);
  });

  it('ignores malformed events', async () => {
    const { client, sockets } = fakeClient([snapshotOf([created])]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    client.start();
    sockets[0]!.open();
    await settle();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: 'cat.exploded', seq: 2 }) });

    expect(client.getView().board.lastSeq).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    client.stop();
  });
});

// ---------------------------------------------------------------------------
// Against a real daemon running the mock adapter
// ---------------------------------------------------------------------------

describe('BoardClient against a daemon', () => {
  let daemon: RunningDaemon | null = null;
  let projectPath = '';
  afterEach(async () => {
    await daemon?.close();
    await rm(projectPath, { recursive: true, force: true, maxRetries: 5 });
  });

  it('follows a task from creation to done', async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'agentcats-ui-'));
    daemon = await startDaemon({
      projectPath,
      adapter: createMockAdapter({ timeScale: 0 }),
      config: AgentcatsConfig.parse({ adapter: 'mock' }),
    });
    const origin = daemon.url;
    const client = new BoardClient({
      baseUrl: daemon.url,
      token: daemon.token,
      // Node's fetch sends no Origin, which the daemon allows; the browser's WebSocket always does.
      createWebSocket: (url, protocols) =>
        new WebSocket(url, protocols, { origin }) as unknown as WebSocketLike,
    });
    client.start();
    await vi.waitFor(() => {
      expect(client.getView().connection).toBe('live');
    });

    const { task } = await client.request('createTask', {}, { title: 'add a hello function' });
    await vi.waitFor(() => {
      const view: BoardView = client.getView();
      expect(view.board.tasks[task.id]?.status).toBe('done');
    });
    const cat = Object.values(client.getView().board.cats)[0];
    expect(cat?.status).toBe('done');
    client.stop();
  });
});
