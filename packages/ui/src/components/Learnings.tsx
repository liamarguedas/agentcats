import {
  type Cat,
  type Learning,
  type LearningDraft,
  type LearningProposal,
  type LearningsVersion,
  LEVELS,
  levelProgress,
  levelSpec,
  type LevelSpec,
  type Task,
} from '@agentcats/protocol';
import { type SyntheticEvent, useState } from 'react';

/** What a level lets a cat do, in words. The rules themselves are in `levels.ts`. */
export function levelPerks(spec: LevelSpec): string[] {
  return [
    spec.memoryTopK === null
      ? 'Loads all its learnings'
      : `Loads its ${String(spec.memoryTopK)} most relevant learnings`,
    ...(spec.projectScripts ? ["Runs the project's scripts without asking"] : []),
    ...(spec.devTools ? ['Runs local test, lint and type tools without asking'] : []),
    ...(spec.readMainCheckout ? ['Reads the main checkout without asking'] : []),
  ];
}

/** Level badge and XP bar for a worker. */
export function LevelBadge({ cat }: { cat: Cat }) {
  const { level, current, next } = levelProgress(cat.xp);
  const ratio = next === null ? 1 : (cat.xp - current) / (next - current);
  return (
    <div
      className="level"
      title={
        next === null
          ? `${String(cat.xp)} XP, top level`
          : `${String(cat.xp)} / ${String(next)} XP to level ${String(level + 1)}`
      }
      data-testid="cat-level"
    >
      <span className="level__badge">Lv {level}</span>
      <span className="meter meter--xp" aria-hidden="true">
        <span className="meter__fill" style={{ width: `${String(Math.round(ratio * 100))}%` }} />
      </span>
      <span className="level__xp">{cat.xp} XP</span>
    </div>
  );
}

export function LevelSection({ cat }: { cat: Cat }) {
  const { level, next } = levelProgress(cat.xp);
  const nextSpec = LEVELS[level];
  return (
    <section className="drawer__section">
      <h3>
        Level {level} · {cat.xp} XP
      </h3>
      <p className="drawer__muted">
        {cat.stats.completed} handed in · {cat.stats.accepted} accepted · {cat.stats.rejected}{' '}
        rejected
      </p>
      <ul className="perks">
        {levelPerks(levelSpec(level)).map((perk) => (
          <li key={perk}>{perk}</li>
        ))}
        <li className="perks__always">
          Always asks before network access, installs and deleting files
        </li>
      </ul>
      {nextSpec && next !== null && (
        <p className="drawer__hint">
          Level {nextSpec.level} at {next} XP:{' '}
          {levelPerks(nextSpec)
            .filter((perk) => !levelPerks(levelSpec(level)).includes(perk))
            .join('; ')
            .toLowerCase()}
          .
        </p>
      )}
    </section>
  );
}

export interface LearningsSectionProps {
  readonly cat: Cat;
  readonly proposals: readonly LearningProposal[];
  readonly tasks: Readonly<Record<string, Task>>;
  /** Backup that undoes the last consolidation or restore, if that was the last change. */
  readonly undoVersion: string | null;
  readonly onAdd: (text: string) => Promise<boolean>;
  readonly onEdit: (learningId: string, text: string) => Promise<boolean>;
  readonly onDelete: (learningId: string) => void;
  readonly onResolve: (proposalId: string, decision: 'accept' | 'discard') => void;
  readonly onConsolidate: () => void;
  readonly onRestore: (versionId: string) => void;
  readonly loadHistory: () => Promise<readonly LearningsVersion[]>;
  readonly onOpenTask: (taskId: string) => void;
}

export function LearningsSection(props: LearningsSectionProps) {
  const { cat, proposals, tasks, undoVersion } = props;
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState('');
  const [versions, setVersions] = useState<readonly LearningsVersion[] | null>(null);

  async function saveEdit(e: SyntheticEvent, id: string) {
    e.preventDefault();
    if (await props.onEdit(id, draft)) setEditing(null);
  }

  async function add(e: SyntheticEvent) {
    e.preventDefault();
    if (adding.trim() && (await props.onAdd(adding))) setAdding('');
  }

  return (
    <section className="drawer__section learnings" aria-label={`${cat.name}'s learnings`}>
      <h3>
        Learnings <span className="panel__count">{cat.learnings.length}</span>
      </h3>

      {proposals.map((p) => (
        <ProposalDiff
          key={p.id}
          proposal={p}
          current={cat.learnings}
          task={p.taskId ? tasks[p.taskId] : undefined}
          onResolve={props.onResolve}
        />
      ))}

      {cat.learnings.length === 0 ? (
        proposals.length === 0 && (
          <p className="drawer__muted">
            Nothing yet. After you review a task, {cat.name} suggests what to remember.
          </p>
        )
      ) : (
        <ol className="learnings__list" data-testid="learnings">
          {cat.learnings.map((l) => (
            <li key={l.id} className="learning">
              {editing === l.id ? (
                <form className="learning__edit" onSubmit={(e) => void saveEdit(e, l.id)}>
                  <input
                    aria-label="Learning text"
                    value={draft}
                    autoFocus
                    onChange={(e) => {
                      setDraft(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                  <button type="submit" className="button button--small button--primary">
                    Save
                  </button>
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="learning__text"
                    title="Click to edit"
                    onClick={() => {
                      setEditing(l.id);
                      setDraft(l.text);
                    }}
                  >
                    {l.text}
                  </button>
                  <Source learning={l} tasks={tasks} onOpenTask={props.onOpenTask} />
                  <button
                    type="button"
                    className="button button--ghost button--small learning__delete"
                    aria-label={`Delete learning: ${l.text}`}
                    onClick={() => {
                      props.onDelete(l.id);
                    }}
                  >
                    ✕
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      <form className="learning__add" onSubmit={(e) => void add(e)}>
        <input
          aria-label="New learning"
          placeholder="Add a learning…"
          value={adding}
          onChange={(e) => {
            setAdding(e.target.value);
          }}
        />
        <button type="submit" className="button button--small" disabled={!adding.trim()}>
          Add
        </button>
      </form>

      <div className="drawer__actions">
        <button
          type="button"
          className="button button--small"
          disabled={cat.learnings.length < 2 || proposals.some((p) => p.kind === 'rewrite')}
          onClick={props.onConsolidate}
        >
          Consolidate
        </button>
        {undoVersion && (
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              props.onRestore(undoVersion);
            }}
          >
            Undo last change
          </button>
        )}
        <button
          type="button"
          className="button button--small button--ghost"
          onClick={() =>
            void props.loadHistory().then(setVersions, () => {
              setVersions([]);
            })
          }
        >
          {versions === null ? 'Earlier versions' : 'Refresh versions'}
        </button>
      </div>

      {versions !== null &&
        (versions.length === 0 ? (
          <p className="drawer__muted">No earlier versions yet. Consolidating saves one.</p>
        ) : (
          <ol className="versions">
            {versions.map((v) => (
              <li key={v.id}>
                <details>
                  <summary>
                    {new Date(v.createdAt).toLocaleString(undefined, { hour12: false })} ·{' '}
                    {v.lines.length} lines
                  </summary>
                  <ul className="versions__lines">
                    {v.lines.map((line, i) => (
                      <li key={i}>{line.text}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => {
                      props.onRestore(v.id);
                    }}
                  >
                    Restore this version
                  </button>
                </details>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}

function Source({
  learning,
  tasks,
  onOpenTask,
}: {
  learning: Learning;
  tasks: Readonly<Record<string, Task>>;
  onOpenTask: (taskId: string) => void;
}) {
  if (!learning.sourceTaskId) return <span className="learning__source">yours</span>;
  const task = tasks[learning.sourceTaskId];
  if (!task) {
    return <span className="learning__source">task {learning.sourceTaskId.slice(0, 8)}</span>;
  }
  return (
    <button
      type="button"
      className="learning__source learning__source--link"
      title={task.title}
      onClick={() => {
        onOpenTask(task.id);
      }}
    >
      {task.title}
    </button>
  );
}

const TRIGGER_LABEL: Record<LearningProposal['trigger'], string> = {
  debrief: 'New learnings',
  level_up: 'Tidy-up after leveling up',
  cap: 'Tidy-up: the list is full',
  user: 'Consolidated list',
};

/** A proposal as a diff against the current list: added lines, and for a rewrite, removed ones. */
function ProposalDiff({
  proposal,
  current,
  task,
  onResolve,
}: {
  proposal: LearningProposal;
  current: readonly Learning[];
  task: Task | undefined;
  onResolve: (proposalId: string, decision: 'accept' | 'discard') => void;
}) {
  const proposed = new Set(proposal.lines.map((l) => l.text));
  const existing = new Set(current.map((l) => l.text));
  const rows: { text: string; kind: 'add' | 'del' | 'same' }[] =
    proposal.kind === 'add'
      ? proposal.lines.map((l: LearningDraft) => ({ text: l.text, kind: 'add' }))
      : [
          ...current.map((l) => ({
            text: l.text,
            kind: proposed.has(l.text) ? ('same' as const) : ('del' as const),
          })),
          ...proposal.lines
            .filter((l) => !existing.has(l.text))
            .map((l) => ({ text: l.text, kind: 'add' as const })),
        ];
  return (
    <div className="proposal" data-testid="proposal">
      <p className="proposal__title">
        {TRIGGER_LABEL[proposal.trigger]}
        {task && <span className="drawer__muted"> · from “{task.title}”</span>}
      </p>
      <ul className="diff">
        {rows.map((row, i) => (
          <li key={i} className={`diff__line diff__line--${row.kind}`}>
            <span className="diff__sign" aria-hidden="true">
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
            </span>
            {row.text}
          </li>
        ))}
      </ul>
      <div className="drawer__actions">
        <button
          type="button"
          className="button button--small button--primary"
          onClick={() => {
            onResolve(proposal.id, 'accept');
          }}
        >
          {proposal.kind === 'add' ? 'Keep' : 'Apply'}
        </button>
        <button
          type="button"
          className="button button--small"
          onClick={() => {
            onResolve(proposal.id, 'discard');
          }}
        >
          Discard
        </button>
      </div>
    </div>
  );
}
