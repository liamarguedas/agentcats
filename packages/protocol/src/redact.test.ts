import { describe, expect, it } from 'vitest';

import { REDACTED, redactDeep, redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it.each([
    ['Anthropic key', 'key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx-1234'],
    ['OpenAI project key', 'OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234'],
    ['GitHub token', 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['AWS key id', 'aws AKIAIOSFODNN7EXAMPLE here'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['Stripe key', 'sk_live_AbCdEfGh12345678'],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
  ])('removes a %s', (_name, text) => {
    const out = redactSecrets(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/AbCdEfGh|AKIAIOSFODNN7|1234567890-abc|dozjgNry/);
  });

  it('removes private key blocks, even cut off', () => {
    const block =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactSecrets(`key:\n${block}\ndone`)).toBe(`key:\n${REDACTED}\ndone`);
    expect(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).toBe(REDACTED);
  });

  it('keeps the shape of headers, URLs and assignments', () => {
    expect(redactSecrets('curl -H "Authorization: Bearer abc.def-123" https://x')).toBe(
      `curl -H "Authorization: Bearer ${REDACTED}" https://x`,
    );
    expect(redactSecrets('postgres://admin:hunter2pass@db:5432/app')).toBe(
      `postgres://admin:${REDACTED}@db:5432/app`,
    );
    expect(redactSecrets('DB_PASSWORD=Tr0ub4dor3xyz9')).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('{"apiKey": "a1b2c3d4e5f6g7h8"}')).toBe(`{"apiKey": "${REDACTED}"}`);
    expect(redactSecrets('--token 9f8e7d6c5b4a39281')).toBe(`--token ${REDACTED}`);
  });

  it('leaves ordinary code and prose alone', () => {
    for (const text of [
      'const token = getAccessToken();',
      'password: process.env.DB_PASSWORD',
      'maxTokens = 100000',
      'The secret is to run the tests first.',
      'Changed: src/auth/tokenStore.ts',
      'git push origin agentcats/mochi/abc12345',
      'token = refreshTokenFromCache',
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('redactDeep', () => {
  it('redacts every string in nested objects and arrays, keeping other values', () => {
    expect(
      redactDeep({ a: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', n: 3, list: ['ok', null], b: true }),
    ).toEqual({ a: REDACTED, n: 3, list: ['ok', null], b: true });
  });
});
