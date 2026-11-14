import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  STATUS_CODES,
} from 'node:http';
import { homedir } from 'node:os';
import type { Duplex } from 'node:stream';
import { extname, resolve, sep } from 'node:path';

import {
  API_PREFIX,
  applyEvent,
  emptyBoard,
  type ErrorResponse,
  PROTOCOL_VERSION,
  type RouteName,
  routes,
  splitSessions,
  tokenFromWsProtocolHeader,
  WS_PATH,
  WS_PROTOCOL,
} from '@agentcats/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import type { z } from 'zod';

import type { CatManager } from './cat-manager.js';
import { ApiError } from './errors.js';
import type { EventLog } from './event-log.js';
import type { Logger } from './logger.js';
import { handleMcpRequest, MCP_PATH } from './mcp-server.js';

export interface HttpServerOptions {
  readonly log: EventLog;
  readonly manager: CatManager;
  readonly token: string;
  /** Directory with the built UI, or `null` to serve no UI. */
  readonly uiDir: string | null;
  readonly logger: Logger;
  /** The project, for hiding its path in exported sessions. */
  readonly projectPath: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WS_BUFFER_BYTES = 16 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

type Handler = (params: Record<string, string>, body: unknown) => Promise<unknown>;

/**
 * HTTP server for the REST commands, the event WebSocket and the static UI.
 *
 * Security model (see `@agentcats/protocol` transport docs):
 * - Listens on 127.0.0.1 only (done by the caller).
 * - Every request must carry `Host: 127.0.0.1:<port>` or `localhost:<port>`,
 *   which defeats DNS rebinding.
 * - `/api` requests need the bearer token and, if they carry an `Origin`, it
 *   must be the daemon's own.
 * - The WebSocket needs the token in its subprotocol list and must come from
 *   the daemon's own `Origin`; a missing `Origin` is rejected too.
 * - `/mcp` is for agents, not browsers: it needs a per-session agent token
 *   (never the UI token), and a foreign `Origin` is rejected.
 */
export function createHttpServer(options: HttpServerOptions): {
  server: Server;
  closeSockets: () => void;
} {
  const { log, manager, token, logger } = options;
  const expectedToken = Buffer.from(token);
  const uiDir = options.uiDir === null ? null : resolve(options.uiDir);

  const port = () => {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  };
  const hosts = () => [`127.0.0.1:${port()}`, `localhost:${port()}`];
  const hostAllowed = (host: string | undefined) => host !== undefined && hosts().includes(host);
  const originAllowed = (origin: string) => hosts().some((h) => origin === `http://${h}`);
  const tokenValid = (candidate: string | null | undefined) => {
    if (!candidate) return false;
    const given = Buffer.from(candidate);
    return given.length === expectedToken.length && timingSafeEqual(given, expectedToken);
  };

  const param = (params: Record<string, string>, name: string) => params[name] ?? '';
  const accepted = { accepted: true } as const;

  const handlers: Record<RouteName, Handler> = {
    createTask: (_params, body) => {
      const { title, description, catId } = body as z.infer<typeof routes.createTask.body>;
      const task = manager.createTask(title, description, {
        actor: 'user',
        ...(catId !== undefined && { catId }),
      });
      return Promise.resolve({ task });
    },
    resolveApproval: async (params, body) => {
      const { decision } = body as z.infer<typeof routes.resolveApproval.body>;
      const approvalId = param(params, 'approvalId');
      await manager.resolveApproval(approvalId, decision);
      return { approvalId, decision };
    },
    killCat: async (params) => {
      await manager.killCat(param(params, 'catId'));
      return accepted;
    },
    updateCat: (params, body) =>
      Promise.resolve({
        cat: manager.updateCat(
          param(params, 'catId'),
          body as z.infer<typeof routes.updateCat.body>,
        ),
      }),
    pauseCat: async (params) => {
      await manager.pauseCat(param(params, 'catId'), 'user');
      return accepted;
    },
    resumeCat: async (params) => {
      await manager.resumeCat(param(params, 'catId'));
      return accepted;
    },
    nudgeCat: async (params, body) => {
      const { text } = body as z.infer<typeof routes.nudgeCat.body>;
      await manager.nudgeCat(param(params, 'catId'), text);
      return accepted;
    },
    reviewTask: async (params, body) => {
      const { decision, note } = body as z.infer<typeof routes.reviewTask.body>;
      return {
        task: await manager.reviewTask(param(params, 'taskId'), decision, note || null),
      };
    },
    addLearning: async (params, body) => {
      const { text } = body as z.infer<typeof routes.addLearning.body>;
      return { cat: await manager.addLearning(param(params, 'catId'), text) };
    },
    editLearning: async (params, body) => {
      const { text } = body as z.infer<typeof routes.editLearning.body>;
      return {
        cat: await manager.editLearning(param(params, 'catId'), param(params, 'learningId'), text),
      };
    },
    deleteLearning: async (params) => ({
      cat: await manager.deleteLearning(param(params, 'catId'), param(params, 'learningId')),
    }),
    consolidateLearnings: (params) => {
      manager.consolidateLearnings(param(params, 'catId'));
      return Promise.resolve(accepted);
    },
    learningsHistory: async (params) => ({
      versions: await manager.learningsHistory(param(params, 'catId')),
    }),
    restoreLearnings: async (params, body) => {
      const { versionId } = body as z.infer<typeof routes.restoreLearnings.body>;
      return { cat: await manager.restoreLearnings(param(params, 'catId'), versionId) };
    },
    retireCheck: (params) => manager.retireCheck(param(params, 'catId')),
    retireCat: async (params, body) => {
      const { reason, openTask } = body as z.infer<typeof routes.retireCat.body>;
      return { retired: await manager.retireCat(param(params, 'catId'), reason, openTask) };
    },
    dismissRetire: (params) => {
      manager.dismissRetire(param(params, 'catId'));
      return Promise.resolve(accepted);
    },
    resurrectCat: async (params) => ({ cat: await manager.resurrectCat(param(params, 'catId')) }),
    interviewSamples: async () => ({ samples: await manager.interviewSamples() }),
    proposeInterview: async (_params, body) => {
      const { role, sampleId, candidates, adapters } = body as z.infer<
        typeof routes.proposeInterview.body
      >;
      return {
        interview: await manager.proposeInterview(role, sampleId, candidates, 'user', adapters),
      };
    },
    startInterview: async (params) => ({
      interview: await manager.startInterview(param(params, 'interviewId')),
    }),
    cancelInterview: async (params) => ({
      interview: await manager.cancelInterview(param(params, 'interviewId')),
    }),
    pickCandidate: async (params, body) => {
      const { catId } = body as z.infer<typeof routes.pickCandidate.body>;
      return { interview: await manager.pickCandidate(param(params, 'interviewId'), catId) };
    },
    resolveProposal: async (params, body) => {
      const { decision } = body as z.infer<typeof routes.resolveProposal.body>;
      return { cat: await manager.resolveProposal(param(params, 'proposalId'), decision) };
    },
    rerunTask: (params) => Promise.resolve({ task: manager.rerunTask(param(params, 'taskId')) }),
    cancelTask: async (params) => ({
      task: await manager.cancelTask(param(params, 'taskId'), 'user'),
    }),
    taskEvents: (params) => {
      const taskId = param(params, 'taskId');
      manager.task(taskId);
      return Promise.resolve({ events: log.taskEvents(taskId) });
    },
    sessions: () => Promise.resolve({ sessions: splitSessions(log.allEvents()) }),
    sessionEvents: (params) => {
      const index = Number(param(params, 'index'));
      const session = splitSessions(log.allEvents())[index];
      if (!Number.isInteger(index) || !session) {
        throw new ApiError('not_found', `No session ${param(params, 'index')}`);
      }
      const all = log.allEvents();
      return Promise.resolve({
        initialBoard: all.filter((e) => e.seq < session.firstSeq).reduce(applyEvent, emptyBoard()),
        events: all.filter((e) => e.seq >= session.firstSeq && e.seq <= session.lastSeq),
        projectPath: options.projectPath,
        homeDir: homedir(),
      });
    },
    chat: async (_params, body) => {
      const { text, catId } = body as z.infer<typeof routes.chat.body>;
      await manager.chat(text, catId);
      return accepted;
    },
    snapshot: () =>
      Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        board: log.board,
        events: log.recent(),
        adapters: manager.adapterInfos(),
      }),
  };

  const compiled = (Object.keys(routes) as RouteName[]).map((name) => {
    const route = routes[name];
    const keys: string[] = [];
    const pattern = route.path.replace(/:([A-Za-z]+)/g, (_m, key: string) => {
      keys.push(key);
      return '([^/]+)';
    });
    return { name, route, keys, regex: new RegExp(`^${pattern}$`) };
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin)) {
      throw new ApiError('forbidden', 'Origin not allowed');
    }
    const auth = req.headers.authorization;
    if (!tokenValid(auth?.startsWith('Bearer ') ? auth.slice(7) : null)) {
      throw new ApiError('unauthorized', 'Missing or invalid token');
    }

    let pathMatched = false;
    for (const { name, route, keys, regex } of compiled) {
      const match = regex.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== req.method) continue;
      const params = Object.fromEntries(
        keys.map((key, i) => [key, decodeURIComponent(match[i + 1] ?? '')]),
      );
      let body: unknown = undefined;
      if (route.body !== null) {
        const parsed = route.body.safeParse(await readJson(req));
        if (!parsed.success) throw new ApiError('bad_request', parsed.error.message);
        body = parsed.data;
      }
      const result = route.response.parse(await handlers[name](params, body));
      sendJson(res, route.successStatus, result);
      return;
    }
    if (pathMatched) {
      res.setHeader(
        'Allow',
        compiled
          .filter((c) => c.regex.test(pathname))
          .map((c) => c.route.method)
          .join(', '),
      );
      sendJson(res, 405, errorBody('bad_request', `${String(req.method)} not allowed`));
      return;
    }
    throw new ApiError('not_found', `No route ${pathname}`);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin)) {
      throw new ApiError('forbidden', 'Origin not allowed');
    }
    const auth = req.headers.authorization;
    const agentToken = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!manager.catForMcpToken(agentToken)) {
      throw new ApiError('unauthorized', 'Missing or invalid agent token');
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    await handleMcpRequest(manager, req, res, body);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new ApiError('not_found', 'Not found');
    }
    if (uiDir === null) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('agentcats: UI not built. Run `pnpm build` first.\n');
      return;
    }
    let file = resolve(uiDir, `.${decodeURIComponent(pathname)}`);
    if (file !== uiDir && !file.startsWith(uiDir + sep))
      throw new ApiError('not_found', 'Not found');
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) file = resolve(uiDir, 'index.html');
    const isHtml = extname(file) === '.html';
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': isHtml ? 'no-store' : 'public, max-age=31536000, immutable',
      ...(isHtml && {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': [
          "default-src 'self'",
          `connect-src 'self' ${hosts()
            .map((h) => `ws://${h}`)
            .join(' ')}`,
          "img-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          "frame-ancestors 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; '),
      }),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!hostAllowed(req.headers.host)) throw new ApiError('forbidden', 'Host not allowed');
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');
        if (pathname === MCP_PATH) {
          await handleMcp(req, res);
        } else if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
          await handleApi(req, res, pathname);
        } else {
          await serveStatic(req, res, pathname);
        }
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof ApiError) {
          sendJson(res, error.status, errorBody(error.code, error.message));
        } else {
          logger.error(
            `Request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
          );
          sendJson(res, 500, errorBody('internal', 'Internal error'));
        }
      }
    })();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname !== WS_PATH) {
      rejectUpgrade(socket, 404);
      return;
    }
    if (!hostAllowed(req.headers.host)) {
      rejectUpgrade(socket, 403);
      return;
    }
    const origin = req.headers.origin;
    if (origin === undefined || !originAllowed(origin)) {
      rejectUpgrade(socket, 403);
      return;
    }
    if (!tokenValid(tokenFromWsProtocolHeader(req.headers['sec-websocket-protocol']))) {
      rejectUpgrade(socket, 401);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      stream(ws);
    });
  });

  function stream(ws: WebSocket) {
    let alive = true;
    const unsubscribe = log.subscribe((event) => {
      if (ws.bufferedAmount > MAX_WS_BUFFER_BYTES) {
        ws.close(1013, 'Client too slow; refetch the snapshot');
        return;
      }
      ws.send(JSON.stringify(event));
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  }

  return {
    server,
    closeSockets: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
    },
  };
}

function errorBody(code: ErrorResponse['error']['code'], message: string): ErrorResponse {
  return { error: { code, message } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function rejectUpgrade(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/json')) {
    throw new ApiError('bad_request', 'Content-Type must be application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('bad_request', 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('bad_request', 'Body is not valid JSON');
  }
}
