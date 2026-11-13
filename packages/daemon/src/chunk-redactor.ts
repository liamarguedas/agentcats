import { type MessageChannel, redactSecrets } from '@agentcats/protocol';

/** Longest text held back waiting for a line end; past it, the text goes out at the last space. */
const MAX_PENDING = 2_000;
/** Longest open private key block held back (real keys are a few kB); past it, it goes out redacted to its end. */
const MAX_KEY_BLOCK = 32_000;

const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Streamed agent text, redacted before it is stored. A secret split across
 * two chunks would get past {@link redactSecrets}, so each message's text is
 * held back until a line ends (secrets and the names that announce them,
 * like `Authorization: Bearer`, sit on one line), and a private key block
 * until it closes. {@link flush} releases the rest when the message is over.
 */
export class ChunkRedactor {
  readonly #pending = new Map<string, { channel: MessageChannel; text: string }>();

  /** Add a chunk; returns the text that is now safe to emit, redacted, or `''`. */
  push(messageId: string, channel: MessageChannel, text: string): string {
    const buffer = (this.#pending.get(messageId)?.text ?? '') + text;
    const cut = safeCut(buffer);
    this.#pending.set(messageId, { channel, text: buffer.slice(cut) });
    return redactSecrets(buffer.slice(0, cut));
  }

  /** Release held text: of one message, or of every message except `except`. */
  flush(except?: string): { messageId: string; channel: MessageChannel; text: string }[] {
    const out: { messageId: string; channel: MessageChannel; text: string }[] = [];
    for (const [messageId, { channel, text }] of this.#pending) {
      if (messageId === except) continue;
      this.#pending.delete(messageId);
      if (text) out.push({ messageId, channel, text: redactSecrets(text) });
    }
    return out;
  }
}

function safeCut(buffer: string): number {
  const begins = [...buffer.matchAll(KEY_BEGIN)];
  const lastBegin = begins.at(-1);
  if (lastBegin && lastBegin.index >= lastEnd(buffer)) {
    // An open private key block: hold it until it closes.
    return buffer.length - lastBegin.index > MAX_KEY_BLOCK ? buffer.length : lastBegin.index;
  }
  const newline = buffer.lastIndexOf('\n');
  if (newline >= 0) return newline + 1;
  if (buffer.length <= MAX_PENDING) return 0;
  const space = buffer.lastIndexOf(' ');
  return space > 0 ? space + 1 : buffer.length;
}

function lastEnd(buffer: string): number {
  const ends = [...buffer.matchAll(KEY_END)];
  const last = ends.at(-1);
  return last ? last.index : -1;
}
