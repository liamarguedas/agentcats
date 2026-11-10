import { describe, expect, it } from 'vitest';

import { tokenFromWsProtocolHeader, WS_PATH, WS_PROTOCOL, wsProtocols } from './transport.js';

const token = 'A'.repeat(43);

describe('WebSocket token subprotocol', () => {
  it('round-trips a token through the protocol header', () => {
    const header = wsProtocols(token).join(', ');
    expect(tokenFromWsProtocolHeader(header)).toBe(token);
  });

  it('serves events under /api', () => {
    expect(WS_PATH).toBe('/api/events');
  });

  it.each([
    ['a missing header', undefined],
    ['no agentcats protocol', `agentcats.token.${token}`],
    ['no token entry', WS_PROTOCOL],
    ['a malformed token', `${WS_PROTOCOL}, agentcats.token.short`],
    ['a token with illegal characters', `${WS_PROTOCOL}, agentcats.token.${'a'.repeat(40)}!`],
  ])('returns null for %s', (_label, header) => {
    expect(tokenFromWsProtocolHeader(header)).toBeNull();
  });
});
