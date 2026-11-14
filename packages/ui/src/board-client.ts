import {
  type AdapterInfo,
  AgentcatsEvent,
  applyEvent,
  type BoardState,
  buildPath,
  classifySeq,
  emptyBoard,
  ErrorResponse,
  type RouteName,
  routes,
  Snapshot,
  SNAPSHOT_EVENT_LIMIT,
  WS_PATH,
  wsProtocols,
} from '@agentcats/protocol';
import type { z } from 'zod';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'replay';

/** Everything the UI renders. Replaced, never mutated, so React can compare by reference. */
export interface BoardView {
  readonly connection: ConnectionState;
  readonly board: BoardState;
  /** Recent events for the log panel, oldest first. */
  readonly events: readonly AgentcatsEvent[];
  /** The adapters cats can run on, with what each can do. */
  readonly adapters: readonly AdapterInfo[];
}

/** The subset of the browser WebSocket the client uses, so tests can inject `ws`. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

export interface BoardClientOptions {
  /** Origin of the daemon, e.g. `http://127.0.0.1:4545`. */
  readonly baseUrl: string;
  readonly token: string;
  readonly createWebSocket?: (url: string, protocols: string[]) => WebSocketLike;
  readonly fetch?: typeof fetch;
}

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BACKOFF_MS = 10_000;

/**
 * Keeps a {@link BoardView} in sync with the daemon.
 *
 * Sync protocol: open the WebSocket first and buffer its events, then fetch
 * the snapshot, then apply buffered events newer than the snapshot. Any later
 * gap in `seq` triggers the same resync. A dropped socket reconnects with
 * exponential backoff and resyncs.
 */
export class BoardClient {
  #view: BoardView = { connection: 'connecting', board: emptyBoard(), events: [], adapters: [] };
  readonly #listeners = new Set<() => void>();
  #socket: WebSocketLike | null = null;
  #buffer: AgentcatsEvent[] | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  readonly #fetch: typeof fetch;
  readonly #createWebSocket: (url: string, protocols: string[]) => WebSocketLike;

  constructor(private readonly options: BoardClientOptions) {
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#createWebSocket =
      options.createWebSocket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike);
  }

  getView = (): BoardView => this.#view;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retryTimer);
    const socket = this.#socket;
    this.#socket = null;
    socket?.close();
  }

  /**
   * Call a REST command from the protocol route table.
   *
   * @throws ApiRequestError with the daemon's error code on a non-2xx response.
   */
  async request<K extends RouteName>(
    name: K,
    params: Record<string, string> = {},
    body?: z.input<NonNullable<(typeof routes)[K]['body']>>,
  ): Promise<z.infer<(typeof routes)[K]['response']>> {
    const route = routes[name];
    const res = await this.#fetch(`${this.options.baseUrl}${buildPath(route.path, params)}`, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = ErrorResponse.safeParse(json);
      if (res.status === 401) this.#set({ connection: 'unauthorized' });
      throw new ApiRequestError(
        res.status,
        error.success ? error.data.error.code : 'internal',
        error.success ? error.data.error.message : `HTTP ${String(res.status)}`,
      );
    }
    return route.response.parse(json) as z.infer<(typeof routes)[K]['response']>;
  }

  #connect(): void {
    const wsUrl = `${this.options.baseUrl.replace(/^http/, 'ws')}${WS_PATH}`;
    const socket = this.#createWebSocket(wsUrl, wsProtocols(this.options.token));
    this.#socket = socket;
    this.#buffer = [];

    let opened = false;
    socket.onopen = () => {
      opened = true;
      void this.#resync();
    };
    socket.onmessage = (message) => {
      if (socket !== this.#socket) return;
      const parsed = AgentcatsEvent.safeParse(
        JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)),
      );
      if (!parsed.success) {
        console.warn('agentcats: ignoring malformed event', parsed.error);
        return;
      }
      if (this.#buffer) this.#buffer.push(parsed.data);
      else this.#apply(parsed.data);
    };
    socket.onclose = () => {
      if (socket !== this.#socket || this.#stopped) return;
      this.#socket = null;
      if (this.#view.connection === 'unauthorized') return;
      this.#set({ connection: 'reconnecting' });
      if (opened) {
        this.#scheduleReconnect();
        return;
      }
      // Browsers hide why a WebSocket upgrade failed. Ask REST whether the token is the problem.
      this.request('snapshot').then(
        () => {
          this.#scheduleReconnect();
        },
        (error: unknown) => {
          if (error instanceof ApiRequestError && error.status === 401) this.stop();
          else this.#scheduleReconnect();
        },
      );
    };
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#connect();
    }, delay);
  }

  async #resync(): Promise<void> {
    this.#buffer ??= [];
    let snapshot: Snapshot;
    try {
      snapshot = await this.request('snapshot');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        this.stop();
        return;
      }
      this.#socket?.close(); // reconnect path retries
      return;
    }
    const buffered = this.#buffer;
    this.#buffer = null;
    this.#attempt = 0;
    this.#set({
      connection: 'live',
      board: snapshot.board,
      events: snapshot.events,
      adapters: snapshot.adapters,
    });
    for (const event of buffered) this.#apply(event);
  }

  #apply(event: AgentcatsEvent): void {
    switch (classifySeq(this.#view.board, event)) {
      case 'duplicate':
        return;
      case 'gap':
        this.#buffer = [event];
        void this.#resync();
        return;
      case 'next':
        this.#set({
          board: applyEvent(this.#view.board, event),
          events: [...this.#view.events, event].slice(-SNAPSHOT_EVENT_LIMIT),
        });
    }
  }

  #set(patch: Partial<BoardView>): void {
    this.#view = { ...this.#view, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
