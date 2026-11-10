import type { Cat, Task } from '@agentcats/protocol';

export const TASK_STATUS_LABEL: Record<Task['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  rejected: 'Rejected',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

export const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export function TaskCard({
  task,
  cat,
  onOpen,
}: {
  task: Task;
  cat: Cat | undefined;
  onOpen: () => void;
}) {
  return (
    <button type="button" className={`task-card task-card--${task.status}`} onClick={onOpen}>
      <span className="task-card__top">
        <span className={`chip chip--${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span>
        {task.attempt > 1 && <span className="task-card__attempt">attempt {task.attempt}</span>}
        {cat && <span className="task-card__cat">{cat.name}</span>}
      </span>
      <span className="task-card__title">{task.title}</span>
      {task.statusReason && <span className="task-card__reason">{task.statusReason}</span>}
      {task.branch && <code className="task-card__branch">{task.branch}</code>}
      {task.result && (
        <span className="task-card__diff">
          {plural(task.result.diffStat.files, 'file')} ·{' '}
          <span className="diff-add">+{task.result.diffStat.insertions}</span>{' '}
          <span className="diff-del">−{task.result.diffStat.deletions}</span> · tests{' '}
          {task.result.tests.replace('_', ' ')}
        </span>
      )}
    </button>
  );
}
