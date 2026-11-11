import { createHash } from 'node:crypto';

import { keywords, type Learning, type LearningDraft, LearningText } from '@agentcats/protocol';

/**
 * The `learnings.md` format, and the checks every learning passes before it
 * is written: one line, specific, not a duplicate.
 *
 * ```markdown
 * # Mochi's learnings
 *
 * - Use the repo's `makeUser` test fixture, not raw inserts. (task 1a2b3c4d5e6f7a8b)
 * - A line the user wrote has no task.
 * ```
 */

const SOURCE = /\s*\(task ([0-9a-f]{4,64})\)\s*$/i;
const BULLET = /^\s*[-*]\s+(.*)$/;

/**
 * Lines of the file that are learnings: Markdown bullets. Headings, comments
 * and blank lines are ignored, so the user can annotate the file freely.
 */
export function parseLearningsFile(text: string): Learning[] {
  const drafts: LearningDraft[] = [];
  let inComment = false;
  for (const line of text.split(/\r?\n/)) {
    if (inComment || line.trimStart().startsWith('<!--')) {
      inComment = !line.includes('-->');
      continue;
    }
    const draft = parseLine(line);
    if (draft) drafts.push(draft);
  }
  return withIds(drafts);
}

/** One `- text (task id)` line, or `null` if it is not a usable learning. */
export function parseLine(line: string): LearningDraft | null {
  const bullet = BULLET.exec(line);
  if (!bullet?.[1]) return null;
  const source = SOURCE.exec(bullet[1]);
  const text = cleanText(source ? bullet[1].slice(0, source.index) : bullet[1]);
  if (!text) return null;
  return { text, sourceTaskId: source?.[1]?.toLowerCase() ?? null };
}

export function serializeLearningsFile(
  catName: string,
  learnings: readonly LearningDraft[],
): string {
  const lines = learnings.map(
    (l) => `- ${l.text}${l.sourceTaskId ? ` (task ${l.sourceTaskId})` : ''}`,
  );
  return [
    `# ${catName}'s learnings`,
    '',
    `<!-- One learning per line. agentcats loads them into ${catName}'s prompt. Edit or delete lines freely; the board picks up changes. -->`,
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * Give each line a stable id derived from its content, so an edit made
 * against an old copy of the file finds nothing instead of the wrong line.
 * Identical lines get a counter suffix.
 */
export function withIds(drafts: readonly LearningDraft[]): Learning[] {
  const seen = new Map<string, number>();
  return drafts.map((draft) => {
    const hash = createHash('sha256')
      .update(`${draft.text}\0${draft.sourceTaskId ?? ''}`)
      .digest('hex')
      .slice(0, 12);
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    return { id: n === 0 ? hash : `${hash}-${String(n)}`, ...draft };
  });
}

/** One trimmed line within the length limit, or `''` if nothing usable is left. */
export function cleanText(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const parsed = LearningText.safeParse(oneLine);
  if (parsed.success) return parsed.data;
  return oneLine.length > 300 ? `${oneLine.slice(0, 297).trimEnd()}...` : '';
}

/** Lowercase, without punctuation and Markdown, for comparing lines. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`'"*_.,;:!?()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether two lines say the same thing: they share most of their keywords
 * (Jaccard index at least {@link NEAR_DUPLICATE}), or every keyword of the
 * shorter one (at least three) appears in the longer one.
 */
export function nearDuplicate(a: string, b: string): boolean {
  const ka = keywords(a);
  const kb = keywords(b);
  if (ka.size === 0 || kb.size === 0) return false;
  let shared = 0;
  for (const word of ka) if (kb.has(word)) shared++;
  const smaller = Math.min(ka.size, kb.size);
  return (
    shared / (ka.size + kb.size - shared) >= NEAR_DUPLICATE || (smaller >= 3 && shared === smaller)
  );
}

/** Lines sharing at least this share of their keywords count as the same learning. */
export const NEAR_DUPLICATE = 0.7;

/** Whether `text` says what one of `existing` already says (exactly, or nearly). */
export function isDuplicate(text: string, existing: readonly { text: string }[]): boolean {
  const normalized = normalize(text);
  return existing.some((e) => normalize(e.text) === normalized || nearDuplicate(e.text, text));
}

/** Drop drafts that repeat an existing line or an earlier draft. */
export function dedupe(
  drafts: readonly LearningDraft[],
  existing: readonly { text: string }[],
): LearningDraft[] {
  const kept: LearningDraft[] = [];
  for (const draft of drafts) {
    if (!isDuplicate(draft.text, [...existing, ...kept])) kept.push(draft);
  }
  return kept;
}

/**
 * Learnings from a model's answer: its bullet lines, cleaned. `NONE` (or no
 * bullets) means nothing. At most `limit` lines; lines too short to say
 * anything specific are dropped.
 */
export function parseProposal(
  answer: string,
  sourceTaskId: string | null,
  limit: number,
): LearningDraft[] {
  const drafts: LearningDraft[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const draft = parseLine(line);
    if (!draft || draft.text.length < 15 || /^none\b/i.test(draft.text)) continue;
    drafts.push({ text: draft.text, sourceTaskId: draft.sourceTaskId ?? sourceTaskId });
    if (drafts.length === limit) break;
  }
  return drafts;
}
