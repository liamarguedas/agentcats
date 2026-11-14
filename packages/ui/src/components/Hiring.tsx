import type {
  AdapterInfo,
  Candidate,
  Cat,
  HireRole,
  Interview,
  InterviewSample,
  ModelTier,
  RetireCheckResponse,
  RetiredEntry,
} from '@agentcats/protocol';
import { type ReactNode, type SyntheticEvent, useEffect, useState } from 'react';

/** An interview estimate in words; `null` when an agent in it cannot report cost. */
export const estimateText = (usd: number | null) =>
  usd === null ? 'cost unknown' : `about $${usd.toFixed(2)}`;

const TIER_LABEL: Record<ModelTier, string> = {
  fast: 'Fast and cheap',
  balanced: 'Balanced',
  best: 'Best and most expensive',
};

export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div className="drawer-backdrop dialog-backdrop" onClick={onClose}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <header className="drawer__header">
          <h2 className="drawer__title">{title}</h2>
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="drawer__body">{children}</div>
      </section>
    </div>
  );
}

export interface HireDialogProps {
  readonly loadSamples: () => Promise<readonly InterviewSample[]>;
  readonly defaultCandidates: number;
  /** Plan the interview; resolves with it (status `proposed`) or `null` on error. */
  /** Agents candidates can run on; the first is the default. */
  readonly adapters: readonly AdapterInfo[];
  readonly onPropose: (
    role: HireRole,
    sampleId: string,
    candidates: number,
    adapters: readonly string[],
  ) => Promise<Interview | null>;
  readonly onStart: (interviewId: string) => Promise<boolean>;
  readonly onCancel: (interviewId: string) => void;
  readonly onClose: () => void;
}

/** Describe the role, get the estimate, then confirm. Nothing runs before the confirmation. */
export function HireDialog(props: HireDialogProps) {
  const [samples, setSamples] = useState<readonly InterviewSample[] | null>(null);
  const [description, setDescription] = useState('');
  const [tier, setTier] = useState<ModelTier>('balanced');
  const [candidates, setCandidates] = useState(props.defaultCandidates);
  const [candidateAdapters, setCandidateAdapters] = useState<readonly string[]>([]);
  const adapterOf = (i: number) => candidateAdapters[i] ?? props.adapters[0]?.id ?? '';
  const [sampleId, setSampleId] = useState('');
  const [learnings, setLearnings] = useState('');
  const [planned, setPlanned] = useState<Interview | null>(null);
  const [busy, setBusy] = useState(false);
  const { loadSamples } = props;

  useEffect(() => {
    let cancelled = false;
    loadSamples().then(
      (list) => {
        if (cancelled) return;
        setSamples(list);
        setSampleId((current) => current || (list[0]?.id ?? ''));
      },
      () => {
        if (!cancelled) setSamples([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadSamples]);

  async function estimate(e: SyntheticEvent) {
    e.preventDefault();
    setBusy(true);
    const role: HireRole = {
      description: description.trim(),
      tier,
      learnings: learnings
        .split('\n')
        .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean),
    };
    const adapters = Array.from({ length: candidates }, (_, i) => adapterOf(i));
    setPlanned(await props.onPropose(role, sampleId, candidates, adapters));
    setBusy(false);
  }

  const close = () => {
    if (planned) props.onCancel(planned.id);
    props.onClose();
  };

  return (
    <Dialog title="Hire a cat" onClose={close}>
      {planned ? (
        <div className="hire-confirm">
          <p>
            {planned.candidateCount} candidates will each do <strong>{planned.sample.title}</strong>{' '}
            on the {TIER_LABEL[planned.role.tier].toLowerCase()} tier.
          </p>
          <p className="hire-confirm__estimate" data-testid="estimate">
            Estimated cost: {estimateText(planned.estimateUsd)}
          </p>
          <p className="drawer__hint">
            API-equivalent: on a subscription plan this is plan usage, not a charge. The daemon runs
            each candidate&apos;s tests itself, in throwaway copies, to score them.
          </p>
          <div className="drawer__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void props.onStart(planned.id).then((ok) => {
                  setBusy(false);
                  if (ok) props.onClose();
                });
              }}
            >
              Start interview ({estimateText(planned.estimateUsd)})
            </button>
            <button type="button" className="button" onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={(e) => void estimate(e)}>
          <label className="form__field">
            <span>What is the new cat for?</span>
            <textarea
              rows={3}
              required
              maxLength={1000}
              value={description}
              placeholder="For example: writes small, careful changes with tests"
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </label>
          <div className="form__row">
            <label className="form__field">
              <span>Model tier</span>
              <select
                value={tier}
                onChange={(e) => {
                  setTier(e.target.value as ModelTier);
                }}
              >
                {(Object.keys(TIER_LABEL) as ModelTier[]).map((t) => (
                  <option key={t} value={t}>
                    {TIER_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="form__field">
              <span>Candidates</span>
              <select
                value={candidates}
                onChange={(e) => {
                  setCandidates(Number(e.target.value));
                }}
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {props.adapters.length > 1 && (
            <div className="form__row form__row--candidates">
              {Array.from({ length: candidates }, (_, i) => (
                <label key={i} className="form__field">
                  <span>Candidate {i + 1}</span>
                  <select
                    value={adapterOf(i)}
                    onChange={(e) => {
                      const next = Array.from({ length: 3 }, (_, n) => adapterOf(n));
                      next[i] = e.target.value;
                      setCandidateAdapters(next);
                    }}
                  >
                    {props.adapters.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}
          <label className="form__field">
            <span>Interview task</span>
            <select
              value={sampleId}
              disabled={!samples || samples.length === 0}
              onChange={(e) => {
                setSampleId(e.target.value);
              }}
            >
              {(samples ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                  {s.source === 'bundled'
                    ? ''
                    : s.source === 'task'
                      ? ' (your project)'
                      : ' (yours)'}
                </option>
              ))}
            </select>
          </label>
          <label className="form__field">
            <span>Starting learnings (optional, one per line)</span>
            <textarea
              rows={2}
              value={learnings}
              onChange={(e) => {
                setLearnings(e.target.value);
              }}
            />
          </label>
          <div className="drawer__actions">
            <button
              type="submit"
              className="button button--primary"
              disabled={busy || !description.trim() || !sampleId}
            >
              Get an estimate
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export interface InterviewPanelProps {
  readonly interview: Interview;
  readonly cats: Readonly<Record<string, Cat>>;
  /** Cards for the candidates, rendered by the board. */
  readonly renderCandidate: (cat: Cat) => ReactNode;
  readonly onStart: () => void;
  readonly onCancel: () => void;
  readonly onPick: (catId: string) => void;
}

const STATUS_TEXT: Record<Interview['status'], string> = {
  proposed: 'Waiting for you to start it',
  running: 'Candidates are working',
  deciding: 'Scored: pick one to hire',
  completed: 'Hired',
  cancelled: 'Cancelled',
};

/** One interview on the board: candidates side by side, then the score table. */
export function InterviewPanel(props: InterviewPanelProps) {
  const { interview, cats } = props;
  const name = (c: Candidate) => cats[c.catId]?.name ?? 'candidate';
  return (
    <section className="interview" aria-label={`Interview: ${interview.role.description}`}>
      <header className="interview__header">
        <div>
          <h2 className="section-title">Interview · {interview.sample.title}</h2>
          <p className="drawer__muted">
            {interview.role.description} · {interview.role.tier} ·{' '}
            {interview.proposedBy === 'orchestrator' ? 'proposed by the lead · ' : ''}
            {estimateText(interview.estimateUsd)}
          </p>
        </div>
        <span className={`chip chip--interview-${interview.status}`}>
          {STATUS_TEXT[interview.status]}
        </span>
      </header>

      {interview.status === 'proposed' && (
        <div className="drawer__actions">
          <button type="button" className="button button--primary" onClick={props.onStart}>
            Start interview ({estimateText(interview.estimateUsd)})
          </button>
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      )}

      {interview.candidates.length > 0 && (
        <div className="interview__candidates">
          {interview.candidates.map((c) => {
            const cat = cats[c.catId];
            return cat ? <div key={c.catId}>{props.renderCandidate(cat)}</div> : null;
          })}
        </div>
      )}

      {interview.candidates.some((c) => c.result) && (
        <div className="table-scroll">
          <table className="scores" data-testid="scores">
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col">Tests</th>
                <th scope="col">Diff</th>
                <th scope="col">Cost</th>
                <th scope="col">Time</th>
                <th scope="col">Lint</th>
                <th scope="col">Types</th>
                <th scope="col">Score</th>
                <th scope="col">
                  <span className="visually-hidden">Hire</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {interview.candidates.map((c) => {
                const r = c.result;
                const s = c.score;
                return (
                  <tr key={c.catId} className={r && !r.passed ? 'scores__row--failed' : ''}>
                    <th scope="row">{name(c)}</th>
                    {r ? (
                      <>
                        <td title={r.failure ?? undefined}>{r.passed ? '✓ pass' : '✗ fail'}</td>
                        <td>
                          +{r.diff.insertions} −{r.diff.deletions}
                          {s && <span className="scores__part"> {Math.round(s.diff)}</span>}
                        </td>
                        <td>
                          {r.costUsd === null ? '–' : `$${r.costUsd.toFixed(3)}`}
                          {s && <span className="scores__part"> {Math.round(s.cost)}</span>}
                        </td>
                        <td>
                          {Math.round(r.durationMs / 1000)} s
                          {s && <span className="scores__part"> {Math.round(s.time)}</span>}
                        </td>
                        <td>{r.lintClean === null ? '–' : r.lintClean ? '✓' : '✗'}</td>
                        <td>{r.typecheckClean === null ? '–' : r.typecheckClean ? '✓' : '✗'}</td>
                        <td className="scores__total">
                          {s === null
                            ? '…'
                            : s.total === null
                              ? 'not hireable'
                              : s.total.toFixed(0)}
                        </td>
                        <td>
                          {interview.status === 'deciding' && s?.total != null && (
                            <button
                              type="button"
                              className="button button--small button--primary"
                              onClick={() => {
                                props.onPick(c.catId);
                              }}
                            >
                              Hire {name(c)}
                            </button>
                          )}
                        </td>
                      </>
                    ) : (
                      <td colSpan={8} className="drawer__muted">
                        working…
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {interview.candidates.some((c) => c.result?.failure) && (
        <ul className="interview__failures">
          {interview.candidates
            .filter((c) => c.result?.failure)
            .map((c) => (
              <li key={c.catId}>
                <strong>{name(c)}:</strong> <code>{c.result?.failure}</code>
              </li>
            ))}
        </ul>
      )}
      <p className="drawer__hint">
        Score parts are 0 to 100 against the best candidate who passed; passing the tests is
        required to be hired. The raw numbers are next to them, so you can disagree.
      </p>
      {(interview.status === 'running' || interview.status === 'deciding') && (
        <div className="drawer__actions">
          <button type="button" className="button button--small" onClick={props.onCancel}>
            Cancel interview
          </button>
        </div>
      )}
    </section>
  );
}

/** The hire announcement, with a friendly note for the candidates who were not picked. */
export function hireAnnouncement(winner: string, losers: readonly string[]): string {
  if (losers.length === 0) return `${winner} is hired!`;
  return `${winner} is hired! ${losers.join(' and ')} got a kind note: “We went with ${winner} this time. Your whiskers were impeccable.”`;
}

export interface RetireDialogProps {
  readonly cat: Cat;
  readonly suggestedReason: string;
  readonly loadCheck: () => Promise<RetireCheckResponse>;
  readonly onRetire: (reason: string, openTask: 'cancel' | 'after_task') => Promise<boolean>;
  readonly onClose: () => void;
}

/** Confirm a retirement, with what it would leave behind. */
export function RetireDialog({
  cat,
  suggestedReason,
  loadCheck,
  onRetire,
  onClose,
}: RetireDialogProps) {
  const [check, setCheck] = useState<RetireCheckResponse | null>(null);
  const [reason, setReason] = useState(suggestedReason);
  const [openTask, setOpenTask] = useState<'cancel' | 'after_task'>('after_task');
  useEffect(() => {
    let cancelled = false;
    loadCheck().then(
      (c) => {
        if (!cancelled) setCheck(c);
      },
      () => {
        if (!cancelled) setCheck({ openTask: null, uncommittedWork: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadCheck]);

  return (
    <Dialog title={`Retire ${cat.name}?`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void onRetire(reason.trim(), openTask).then((ok) => {
            if (ok) onClose();
          });
        }}
      >
        <p className="drawer__text">
          {cat.name} (level {cat.level}, {cat.xp} XP, {cat.learnings.length} learnings) leaves the
          team. Its learnings, XP and level are archived, and you can bring it back later.
        </p>
        {check === null ? (
          <p className="drawer__muted">Checking for open work…</p>
        ) : (
          <>
            {check.openTask && (
              <fieldset className="warning-box" role="alert">
                <legend>
                  {cat.name} is working on “{check.openTask.title}”
                </legend>
                <label className="radio">
                  <input
                    type="radio"
                    name="open-task"
                    checked={openTask === 'after_task'}
                    onChange={() => {
                      setOpenTask('after_task');
                    }}
                  />
                  Let it finish, then retire
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="open-task"
                    checked={openTask === 'cancel'}
                    onChange={() => {
                      setOpenTask('cancel');
                    }}
                  />
                  Cancel the task now and retire
                </label>
              </fieldset>
            )}
            {check.uncommittedWork.length > 0 && (
              <div className="warning-box" role="alert">
                <p>Uncommitted changes in these worktrees are kept, not deleted:</p>
                <ul>
                  {check.uncommittedWork.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        <label className="form__field">
          <span>Reason</span>
          <input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
            }}
          />
        </label>
        <div className="drawer__actions">
          <button
            type="submit"
            className="button button--danger"
            disabled={!check || !reason.trim()}
          >
            Retire {cat.name}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Keep {cat.name}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Cats that left the team, with a way back. */
export function RetiredList({
  retired,
  onResurrect,
}: {
  retired: readonly RetiredEntry[];
  onResurrect: (catId: string) => void;
}) {
  if (retired.length === 0) return null;
  return (
    <section className="retired" aria-label="Retired cats">
      <details>
        <summary className="section-title">
          Retired <span className="panel__count">{retired.length}</span>
        </summary>
        <ul className="retired__list">
          {retired.map(({ retired: r }) => (
            <li key={r.catId} className="retired__item">
              <span className="retired__name">📦 {r.name}</span>
              <span className="drawer__muted">
                level {r.level} · {r.xp} XP · {r.reason} ·{' '}
                {new Date(r.retiredAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                className="button button--small"
                onClick={() => {
                  onResurrect(r.catId);
                }}
              >
                Bring back
              </button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
