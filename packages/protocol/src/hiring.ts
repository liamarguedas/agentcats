import { z } from 'zod';

import { Id, LearningText, ShortText, Timestamp } from './common.js';
import { Cat } from './entities.js';

/**
 * Agent-neutral model tiers for hiring. Each adapter maps them to its own
 * model names (`Adapter.modelTiers`).
 */
export const ModelTier = z.enum(['fast', 'balanced', 'best']);
export type ModelTier = z.infer<typeof ModelTier>;

/** The role a hire is for, written by the user or proposed by the lead. */
export const HireRole = z.strictObject({
  /** What the cat is for, in a sentence or two. Becomes the hire's persona. */
  description: z.string().trim().min(1).max(1_000),
  tier: ModelTier,
  /** Lines the winner starts with in its learnings. */
  learnings: z.array(LearningText).max(20).default([]),
});
export type HireRole = z.infer<typeof HireRole>;

/** A sample task candidates are interviewed on: a bundled one, a project one, or a past task re-run. */
export const InterviewSample = z.strictObject({
  /** File name without `.md`, or `task:<taskId>` for a re-run. */
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  /** `fixture`: the bundled sample repo, copied per candidate. `project`: worktrees of the user's repo. */
  repo: z.enum(['fixture', 'project']),
  source: z.enum(['bundled', 'project', 'task']),
});
export type InterviewSample = z.infer<typeof InterviewSample>;

export const InterviewStatus = z.enum([
  /** Waiting for the user to confirm the estimate. */
  'proposed',
  'running',
  /** Every candidate is scored; waiting for the user to pick. */
  'deciding',
  'completed',
  'cancelled',
]);
export type InterviewStatus = z.infer<typeof InterviewStatus>;

/** Raw results of one candidate, measured by the daemon, not reported by the candidate. */
export const CandidateResult = z.strictObject({
  /** The interview's check passed. A hard gate: a candidate without it cannot win. */
  passed: z.boolean(),
  /** `null` when the sample defines no such command. */
  lintClean: z.boolean().nullable(),
  typecheckClean: z.boolean().nullable(),
  diff: z.strictObject({
    files: z.int().nonnegative(),
    insertions: z.int().nonnegative(),
    deletions: z.int().nonnegative(),
  }),
  costUsd: z.number().nonnegative().nullable(),
  durationMs: z.int().nonnegative(),
  /** Why it failed, if it did: the check's last lines, a crash, a timeout. */
  failure: ShortText.nullable(),
});
export type CandidateResult = z.infer<typeof CandidateResult>;

/** The computed score, 0 to 100 per part; `total` is `null` for a candidate that failed the gate. */
export const CandidateScore = z.strictObject({
  total: z.number().min(0).max(100).nullable(),
  diff: z.number().min(0).max(100),
  cost: z.number().min(0).max(100),
  time: z.number().min(0).max(100),
  quality: z.number().min(0).max(100),
});
export type CandidateScore = z.infer<typeof CandidateScore>;

export const Candidate = z.strictObject({
  catId: Id,
  result: CandidateResult.nullable(),
  score: CandidateScore.nullable(),
});
export type Candidate = z.infer<typeof Candidate>;

export const Interview = z.strictObject({
  id: Id,
  role: HireRole,
  sample: InterviewSample,
  /** How many candidates run, 1 to 3. */
  candidateCount: z.int().min(1).max(3),
  /**
   * API-equivalent dollars for all candidates, shown before the user
   * confirms. `null` when an adapter in the interview cannot report cost.
   */
  estimateUsd: z.number().nonnegative().nullable(),
  /** Adapter of each candidate, in hiring order. */
  candidateAdapters: z.array(z.string().min(1).max(64)).max(3).default([]),
  status: InterviewStatus,
  proposedBy: z.enum(['user', 'orchestrator']),
  candidates: z.array(Candidate).max(3),
  winnerCatId: Id.nullable(),
  createdAt: Timestamp,
});
export type Interview = z.infer<typeof Interview>;

/** A retired cat in the archive, with what it had when it left. */
export const RetiredCat = z.strictObject({
  catId: Id,
  name: z.string().min(1).max(64),
  reason: ShortText,
  level: z.int().positive(),
  xp: z.int().nonnegative(),
  /** Folder under `.agentcats/retired/`. */
  archive: z.string().min(1).max(200),
  retiredAt: Timestamp,
});
export type RetiredCat = z.infer<typeof RetiredCat>;

/** A retired cat, kept whole so it can come back exactly as it left. */
export const RetiredEntry = z.strictObject({ cat: Cat, retired: RetiredCat });
export type RetiredEntry = z.infer<typeof RetiredEntry>;

/** The lead suggested retiring a cat; the user confirms or dismisses it. */
export const RetireProposal = z.strictObject({
  catId: Id,
  reason: ShortText,
  proposedAt: Timestamp,
});
export type RetireProposal = z.infer<typeof RetireProposal>;
