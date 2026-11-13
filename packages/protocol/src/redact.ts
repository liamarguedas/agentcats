/**
 * Secret redaction for everything agentcats stores, shows, logs or exports.
 * Agents echo commands and file contents, so a key in `.env` or a header in
 * a `curl` command can end up in an event. Patterns favor known token
 * formats; the generic `name = value` rule only fires on values that look
 * random, so code like `token = getToken()` stays readable.
 */

export const REDACTED = '[redacted]';

const KNOWN_TOKENS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{50,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API key
  /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}/g, // npm
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** `Authorization: Bearer <token>`, also as `-H "Authorization: Basic …"`. */
const AUTH_HEADER = /(\bauthorization\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s'"]+/gi;

/** `scheme://user:password@host`. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi;

/** `API_KEY=…`, `"password": "…"`, `--token …`: the name stays, a random-looking value goes. */
const ASSIGNMENT =
  /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)s?["']?\s*(?:[:=]|\s)\s*["']?)([A-Za-z0-9_\-./+=~]{12,})/gi;

/** A value with letters and digits and no word-like shape, as keys and passwords have. */
function looksRandom(value: string): boolean {
  return /\d/.test(value) && /[A-Za-z]/.test(value) && !/^[a-z]+(?:[A-Z][a-z]+)+$/.test(value);
}

/** Replace secrets in a string with {@link REDACTED}. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, REDACTED);
  out = out.replace(AUTH_HEADER, `$1${REDACTED}`);
  out = out.replace(URL_PASSWORD, `$1${REDACTED}$2`);
  out = out.replace(ASSIGNMENT, (match, name: string, value: string) =>
    value === REDACTED || !looksRandom(value) ? match : `${name}${REDACTED}`,
  );
  return out;
}

/** {@link redactSecrets} on every string inside a JSON-like value; other values are kept. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v as unknown)]),
    ) as T;
  }
  return value;
}
