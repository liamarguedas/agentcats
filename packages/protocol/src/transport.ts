import { z } from 'zod';

/**
 * Wire-level constants shared by the daemon and the UI.
 *
 * Security model: the daemon binds to 127.0.0.1 and generates a random token at
 * startup. The CLI opens the UI with the token in the URL fragment
 * (`#token=...`), which never reaches server logs. REST calls send it as
 * `Authorization: Bearer <token>`. Browsers cannot set headers on a WebSocket,
 * so the UI offers two subprotocols, {@link WS_PROTOCOL} and
 * `agentcats.token.<token>`; the daemon checks the token and echoes only
 * {@link WS_PROTOCOL} back.
 */

/** Prefix of every authenticated REST route. Everything else is the static UI. */
export const API_PREFIX = '/api';

/** WebSocket endpoint for the live event stream. */
export const WS_PATH = `${API_PREFIX}/events`;

/** Subprotocol the daemon accepts and echoes. */
export const WS_PROTOCOL = 'agentcats.v1';

const WS_TOKEN_PREFIX = 'agentcats.token.';

/** Key of the token in the UI URL fragment. */
export const TOKEN_FRAGMENT_KEY = 'token';

/** base64url only, so the token is a valid subprotocol value and URL fragment. */
export const DaemonToken = z.string().regex(/^[A-Za-z0-9_-]{32,256}$/);
export type DaemonToken = z.infer<typeof DaemonToken>;

/** Subprotocols the UI passes to `new WebSocket(url, protocols)`. */
export function wsProtocols(token: DaemonToken): [string, string] {
  return [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${token}`];
}

/**
 * Extract the token from a `Sec-WebSocket-Protocol` request header.
 *
 * @returns The token, or `null` if the header lacks {@link WS_PROTOCOL} or a
 *   well-formed token entry.
 */
export function tokenFromWsProtocolHeader(header: string | undefined): DaemonToken | null {
  if (!header) return null;
  const offered = header.split(',').map((p) => p.trim());
  if (!offered.includes(WS_PROTOCOL)) return null;
  const entry = offered.find((p) => p.startsWith(WS_TOKEN_PREFIX));
  if (!entry) return null;
  const parsed = DaemonToken.safeParse(entry.slice(WS_TOKEN_PREFIX.length));
  return parsed.success ? parsed.data : null;
}
