import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Snapshot, WS_PATH, WS_PROTOCOL } from '@agentcats/protocol';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectEvents,
  rawRequest,
  startTestDaemon,
  type TestDaemon,
  tempProject,
} from './harness.js';

let t: TestDaemon;
afterEach(async () => {
  await t.close();
});

describe('REST security', () => {
  it('serves the snapshot with a valid token', async () => {
    t = await startTestDaemon();
    const res = await t.api('GET', '/api/snapshot');
    expect(res.status).toBe(200);
    const snapshot = Snapshot.parse(res.body);
    expect(Object.values(snapshot.board.cats)).toHaveLength(1);
  });

  it('listens on 127.0.0.1 only', async () => {
    t = await startTestDaemon();
    expect(t.daemon.url).toBe(`http://127.0.0.1:${t.daemon.port}`);
  });

  it.each([
    ['no token', {}],
    ['a wrong token', { Authorization: 'Bearer wrong-token-wrong-token-wrong-token-0000' }],
    ['a non-bearer scheme', { Authorization: 'Basic abc' }],
  ])('rejects %s with 401', async (_label, headers: Record<string, string>) => {
    t = await startTestDaemon();
    const res = await rawRequest(t.daemon.url, { path: '/api/snapshot', headers });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'unauthorized', message: 'Missing or invalid token' },
    });
  });

  it('rejects a foreign Origin even with a valid token', async () => {
    t = await startTestDaemon();
    const res = await rawRequest(t.daemon.url, {
      method: 'POST',
      path: '/api/tasks',
      headers: {
        Authorization: `Bearer ${t.daemon.token}`,
        Origin: 'http://evil.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'pwn' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    t = await startTestDaemon();
    const res = await rawRequest(t.daemon.url, {
      path: '/api/snapshot',
      headers: { Host: `evil.example:${t.daemon.port}`, Authorization: `Bearer ${t.daemon.token}` },
    });
    expect(res.status).toBe(403);
  });

  it('accepts localhost as Host', async () => {
    t = await startTestDaemon();
    const res = await rawRequest(t.daemon.url, {
      path: '/api/snapshot',
      headers: { Host: `localhost:${t.daemon.port}`, Authorization: `Bearer ${t.daemon.token}` },
    });
    expect(res.status).toBe(200);
  });
});

describe('static UI', () => {
  it('serves the UI without a token, with a strict CSP, and no path traversal', async () => {
    const uiDir = join(await tempProject(), 'ui');
    await mkdir(uiDir, { recursive: true });
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>agentcats</title>');
    await writeFile(join(uiDir, '..', 'secret.txt'), 'top secret');
    t = await startTestDaemon({}, {}, uiDir);

    const index = await rawRequest(t.daemon.url, { path: '/' });
    expect(index.status).toBe(200);
    expect(index.body).toContain('<title>agentcats</title>');
    expect(index.headers['content-security-policy']).toContain("default-src 'self'");
    expect(index.headers['x-frame-options']).toBe('DENY');

    const traversal = await rawRequest(t.daemon.url, { path: '/..%2Fsecret.txt' });
    expect(traversal.body).not.toContain('top secret');
  });

  it('rejects a foreign Host for static files too', async () => {
    t = await startTestDaemon();
    const res = await rawRequest(t.daemon.url, { path: '/', headers: { Host: 'evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('WebSocket security', () => {
  it('accepts the right token and Origin, and echoes only the agentcats protocol', async () => {
    t = await startTestDaemon();
    const stream = await connectEvents(t.daemon);
    expect(stream.socket.protocol).toBe(WS_PROTOCOL);
    stream.close();
  });

  it('rejects a wrong token with 401', async () => {
    t = await startTestDaemon();
    await expect(connectEvents(t.daemon, { token: 'x'.repeat(43) })).rejects.toThrow('HTTP 401');
  });

  it('rejects a foreign Origin with 403', async () => {
    t = await startTestDaemon();
    await expect(connectEvents(t.daemon, { origin: 'http://evil.example' })).rejects.toThrow(
      'HTTP 403',
    );
  });

  it('rejects a missing Origin with 403', async () => {
    t = await startTestDaemon();
    await expect(connectEvents(t.daemon, { origin: null })).rejects.toThrow('HTTP 403');
  });

  it('rejects a token passed in the query string instead of the subprotocol', async () => {
    t = await startTestDaemon();
    const socket = new WebSocket(
      `ws://127.0.0.1:${t.daemon.port}${WS_PATH}?token=${t.daemon.token}`,
      [WS_PROTOCOL],
      { origin: t.daemon.url },
    );
    const status = await new Promise<number | undefined>((resolve) => {
      socket.once('unexpected-response', (_req, res) => {
        resolve(res.statusCode);
      });
      socket.once('open', () => {
        resolve(101);
      });
    });
    expect(status).toBe(401);
  });
});
