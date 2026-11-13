import { REDACTED } from '@agentcats/protocol';
import { describe, expect, it } from 'vitest';

import { ChunkRedactor } from './chunk-redactor.js';

const KEY = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx-1234';

/** Feed chunks, then flush; return everything that would be stored. */
function stream(chunks: string[]): string {
  const redactor = new ChunkRedactor();
  const out = chunks.map((c) => redactor.push('m1', 'text', c));
  return [...out, ...redactor.flush().map((f) => f.text)].join('');
}

describe('ChunkRedactor', () => {
  it('catches a key split across chunks', () => {
    const text = stream(['Your key is ', KEY.slice(0, 15), KEY.slice(15), ' and more\n']);
    expect(text).toBe(`Your key is ${REDACTED} and more\n`);
  });

  it('keeps a header name and its token together', () => {
    expect(stream(['curl -H "Authorization: Bearer ', 'abc123def456ghi', '" https://x\n'])).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}" https://x\n`,
    );
  });

  it('emits whole lines as they complete, and the rest on flush', () => {
    const redactor = new ChunkRedactor();
    expect(redactor.push('m1', 'text', 'first line\nsecond')).toBe('first line\n');
    expect(redactor.push('m1', 'text', ' half')).toBe('');
    expect(redactor.flush()).toEqual([{ messageId: 'm1', channel: 'text', text: 'second half' }]);
    expect(redactor.flush()).toEqual([]);
  });

  it('holds a private key block until it closes', () => {
    const text = stream([
      'here:\n-----BEGIN OPENSSH PRIVATE KEY-----\n',
      'b3BlbnNzaC1rZXktdjEAAAAA\n',
      'QyNTUxOQAAACD\n-----END OPENSSH PRIVATE KEY-----\nok\n',
    ]);
    expect(text).toBe(`here:\n${REDACTED}\nok\n`);
  });

  it('does not hold long text without a line end forever', () => {
    const redactor = new ChunkRedactor();
    const out = redactor.push('m1', 'text', 'word '.repeat(500));
    expect(out.length).toBeGreaterThan(2_000);
  });

  it('flushes other messages, keeping the one named', () => {
    const redactor = new ChunkRedactor();
    redactor.push('m1', 'thought', 'thinking');
    redactor.push('m2', 'text', 'talking');
    expect(redactor.flush('m2')).toEqual([
      { messageId: 'm1', channel: 'thought', text: 'thinking' },
    ]);
  });
});
