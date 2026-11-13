import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { defaultCompletion } from '@agentcats/adapter-mock';
import {
  type BoardState,
  type Cat,
  type LearningProposal,
  type LearningsVersion,
  Snapshot,
  type Task,
  type TaskStatus,
} from '@agentcats/protocol';
import type { CompleteOptions, SpawnOptions } from '@agentcats/protocol/adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectEvents,
  type EventStream,
  isType,
  startTestDaemon,
  type TestDaemon,
} from './harness.js';

let t: TestDaemon;
let stream: EventStream;
afterEach(async () => {
  stream.close();
  await t.close();
});

/** Every one-shot call the daemon made, and the spawn options of every session. */
let completions: CompleteOptions[];
let spawns: SpawnOptions[];

async function setup(
  config: Parameters<typeof startTestDaemon>[1] = {},
  complete: (options: CompleteOptions) => string = defaultCompletion,
) {
  completions = [];
  spawns = [];
  t = await startTestDaemon(
    {
      complete: (options) => {
        completions.push(options);
        return complete(options);
      },
    },
    config,
    null,
    (adapter) => ({
      ...adapter,
      spawn: (options) => {
        spawns.push(options);
        return adapter.spawn(options);
      },
    }),
  );
  stream = await connectEvents(t.daemon);
}

const isDebrief = (o: CompleteOptions) => o.systemPrompt.startsWith('# Debrief');

async function board(): Promise<BoardState> {
  return Snapshot.parse((await t.api('GET', '/api/snapshot')).body).board;
}

async function waitForStatus(taskId: string, status: TaskStatus): Promise<Task> {
  await vi.waitFor(
    async () => {
      expect((await board()).tasks[taskId]?.status).toBe(status);
    },
    { timeout: 10_000, interval: 25 },
  );
  return (await board()).tasks[taskId]!;
}

/** Run a task to review. A `learn:` line makes the mock worker report it as learned. */
async function taskInReview(title: string, learn?: string, catId?: string): Promise<Task> {
  const res = await t.api('POST', '/api/tasks', {
    title,
    description: learn ? `learn: ${learn}` : '',
    ...(catId && { catId }),
  });
  expect(res.status).toBe(201);
  return waitForStatus((res.body as { task: Task }).task.id, 'review');
}

async function review(taskId: string, decision: 'accept' | 'reject', note?: string) {
  const res = await t.api('POST', `/api/tasks/${taskId}/review`, {
    decision,
    ...(note && { note }),
  });
  expect(res.status).toBe(200);
}

async function proposal(match: (p: LearningProposal) => boolean = () => true) {
  let found: LearningProposal | undefined;
  await vi.waitFor(
    async () => {
      found = Object.values((await board()).proposals).find(match);
      expect(found).toBeDefined();
    },
    { timeout: 10_000, interval: 25 },
  );
  return found!;
}

async function resolve(proposalId: string, decision: 'accept' | 'discard') {
  return t.api('POST', `/api/proposals/${proposalId}`, { decision });
}

const learningsFile = (name: string) =>
  join(t.projectPath, '.agentcats', 'cats', name, 'learnings.md');

async function worker(): Promise<Cat> {
  const cat = Object.values((await board()).cats).find((c) => c.role === 'worker');
  if (!cat) throw new Error('no worker yet');
  return cat;
}

async function addLearnings(catId: string, lines: string[]) {
  for (const text of lines) {
    const res = await t.api('POST', `/api/cats/${catId}/learnings`, { text });
    expect(res.status).toBe(200);
  }
}

const FIXTURE = "Use the repo's makeUser test fixture, not raw inserts";

describe('cat folders', () => {
  it('gives every worker a folder with profile, learnings and stats, and ignores local state', async () => {
    await setup();
    await taskInReview('First task');
    const cat = await worker();
    const dir = join(t.projectPath, '.agentcats', 'cats', cat.name);
    await vi.waitFor(
      async () => {
        expect(await readFile(join(dir, 'profile.md'), 'utf8')).toContain('- Role: worker');
      },
      { timeout: 10_000 },
    );
    expect(await readFile(join(dir, 'learnings.md'), 'utf8')).toContain(
      `# ${cat.name}'s learnings`,
    );
    // Written in the background after the task is handed in.
    await vi.waitFor(
      async () => {
        expect(JSON.parse(await readFile(join(dir, 'stats.json'), 'utf8'))).toMatchObject({
          xp: 0,
          level: 1,
          tasksDone: 1,
        });
      },
      { timeout: 10_000 },
    );
    const gitignore = await readFile(join(t.projectPath, '.agentcats', '.gitignore'), 'utf8');
    expect(gitignore).toContain('!cats/*/learnings.md');
    expect(gitignore).not.toContain('!cats/*/stats.json');
  });
});

describe('debrief', () => {
  it('proposes learnings after an accepted task and writes them only when accepted', async () => {
    await setup();
    const task = await taskInReview('Add a login endpoint', FIXTURE);
    const cat = await worker();
    await review(task.id, 'accept');

    const pending = await proposal();
    expect(pending).toMatchObject({
      catId: cat.id,
      taskId: task.id,
      kind: 'add',
      trigger: 'debrief',
      lines: [{ text: FIXTURE, sourceTaskId: task.id }],
    });
    const debrief = completions.find(isDebrief)!;
    expect(debrief.model).toBe('mock-fast'); // the default adapter's fast tier
    expect(debrief.prompt).toContain('The user accepted the result.');
    expect(debrief.prompt).toContain('Tests: passed');
    expect(await readFile(learningsFile(cat.name), 'utf8')).not.toContain(FIXTURE);

    expect((await resolve(pending.id, 'accept')).status).toBe(200);
    expect(await readFile(learningsFile(cat.name), 'utf8')).toContain(
      `- ${FIXTURE} (task ${task.id})`,
    );
    await stream.waitFor(isType('learnings.changed', (e) => e.payload.reason === 'debrief'));
    expect((await worker()).learnings.map((l) => l.text)).toEqual([FIXTURE]);
    expect((await board()).proposals).toEqual({});
  });

  it('writes nothing when the user discards the proposal', async () => {
    await setup();
    const task = await taskInReview('Add a login endpoint', FIXTURE);
    await review(task.id, 'accept');
    const pending = await proposal();
    expect((await resolve(pending.id, 'discard')).status).toBe(200);
    expect((await worker()).learnings).toEqual([]);
    expect(await readFile(learningsFile((await worker()).name), 'utf8')).not.toContain(FIXTURE);
  });

  it('skips a rejection without a note, and learns from one with a note', async () => {
    await setup({}, (options) =>
      /Their note|The user's note: (?!\(none\))/.test(options.prompt)
        ? '- Keep handlers small; the user rejected a 300-line handler'
        : defaultCompletion(options),
    );
    const silent = await taskInReview('First try', FIXTURE);
    await review(silent.id, 'reject');
    const noted = await taskInReview('Second try');
    await review(noted.id, 'reject', 'The handler is far too long');

    const pending = await proposal();
    expect(pending.taskId).toBe(noted.id);
    expect(completions.filter(isDebrief)).toHaveLength(1);
    expect(completions[0]?.prompt).toContain("The user's note: The handler is far too long");
    expect(completions[0]?.prompt).toContain('The user rejected the result.');
  });

  it('proposes nothing when the cat already knows it, and says so', async () => {
    await setup();
    const first = await taskInReview('Seed', 'nothing new');
    const cat = await worker();
    await addLearnings(cat.id, [FIXTURE]);
    await review(first.id, 'accept');
    const again = await taskInReview('Repeat', 'use the makeUser test fixture, not raw inserts');
    await review(again.id, 'accept');
    await stream.waitFor(
      isType('notice', (e) => e.payload.code === 'debrief_empty' && e.taskId === again.id),
      10_000,
    );
    expect((await board()).proposals).toEqual({});
  });

  it('auto-accepts once the cat has enough accepted tasks, when turned on', async () => {
    await setup({ memory: { autoAcceptAfter: 1 } });
    const task = await taskInReview('Add a login endpoint', FIXTURE);
    await review(task.id, 'accept');
    await stream.waitFor(
      isType('learnings.proposal_resolved', (e) => e.payload.resolvedBy === 'auto'),
      10_000,
    );
    expect((await worker()).learnings.map((l) => l.text)).toEqual([FIXTURE]);
  });

  it('charges the debrief to the cat', async () => {
    await setup();
    const task = await taskInReview('Add a login endpoint', FIXTURE);
    const cat = await worker();
    const before = (await board()).usage[cat.id]!.inputTokens;
    await review(task.id, 'accept');
    await proposal();
    expect((await board()).usage[cat.id]!.inputTokens).toBeGreaterThan(before);
  });

  it('turns a debrief over the cap into a consolidation proposal', async () => {
    await setup({ memory: { cap: 5 } }, (options) =>
      options.systemPrompt.startsWith('# Consolidation')
        ? '- Merged line one about the fixtures (task 1111)\n- Merged line two about the routes'
        : defaultCompletion(options),
    );
    const first = await taskInReview('Seed', 'nothing new');
    const cat = await worker();
    await addLearnings(cat.id, [
      'alpha rule one',
      'beta rule two',
      'gamma rule three',
      'delta rule four',
      'epsilon rule five',
    ]);
    expect(
      (await t.api('POST', `/api/cats/${cat.id}/learnings`, { text: 'one too many' })).status,
    ).toBe(409);
    await review(first.id, 'accept');
    const task = await taskInReview('Over the cap', FIXTURE, cat.id);
    await review(task.id, 'accept');

    const rewrite = await proposal((p) => p.kind === 'rewrite');
    expect(rewrite.trigger).toBe('cap');
    const consolidation = completions.find((o) => o.systemPrompt.startsWith('# Consolidation'))!;
    expect(consolidation.systemPrompt).toContain('at most 5 lines');
    expect(consolidation.prompt).toContain(`- ${FIXTURE} (task ${task.id})`);
    expect(Object.values((await board()).proposals).filter((p) => p.kind === 'add')).toEqual([]);
  });
});

describe('editing learnings', () => {
  it('edits, deletes and adds from the board, changing the file each time', async () => {
    await setup();
    await taskInReview('Seed');
    const cat = await worker();
    await addLearnings(cat.id, [
      'first line to keep',
      'second line to change',
      'third line to drop',
    ]);
    let learnings = (await worker()).learnings;

    const edited = await t.api('PATCH', `/api/cats/${cat.id}/learnings/${learnings[1]!.id}`, {
      text: 'second line, changed',
    });
    expect(edited.status).toBe(200);
    learnings = (await worker()).learnings;
    const removed = await t.api('DELETE', `/api/cats/${cat.id}/learnings/${learnings[2]!.id}`);
    expect(removed.status).toBe(200);

    const file = await readFile(learningsFile(cat.name), 'utf8');
    expect(file).toContain('- first line to keep');
    expect(file).toContain('- second line, changed');
    expect(file).not.toContain('third line');
    expect((removed.body as { cat: Cat }).cat.learnings.map((l) => l.text)).toEqual([
      'first line to keep',
      'second line, changed',
    ]);
  });

  it('refuses an edit made against a stale line', async () => {
    await setup();
    await taskInReview('Seed');
    const cat = await worker();
    await addLearnings(cat.id, ['original line']);
    const stale = (await worker()).learnings[0]!.id;
    await t.api('PATCH', `/api/cats/${cat.id}/learnings/${stale}`, { text: 'changed once' });
    const again = await t.api('PATCH', `/api/cats/${cat.id}/learnings/${stale}`, { text: 'twice' });
    expect(again.status).toBe(409);
  });

  it('picks up hand edits of learnings.md', async () => {
    await setup();
    await taskInReview('Seed');
    const cat = await worker();
    await writeFile(
      learningsFile(cat.name),
      `# notes\n\n- Written by hand in an editor\n- Another hand-written line (task abcdef12)\n`,
    );
    await vi.waitFor(
      async () => {
        expect((await worker()).learnings.map((l) => [l.text, l.sourceTaskId])).toEqual([
          ['Written by hand in an editor', null],
          ['Another hand-written line', 'abcdef12'],
        ]);
      },
      { timeout: 10_000, interval: 50 },
    );
    await stream.waitFor(isType('learnings.changed', (e) => e.payload.reason === 'external'));
  });
});

describe('consolidation', () => {
  it('needs approval, keeps the old version, and can be undone', async () => {
    await setup({}, (options) =>
      options.systemPrompt.startsWith('# Consolidation')
        ? '- Tests use the makeUser fixture and live in test/ (task 1111)\n- Routes are registered in handle()'
        : defaultCompletion(options),
    );
    await taskInReview('Seed');
    const cat = await worker();
    const original = [
      'Tests use the makeUser fixture',
      'Test files live in test/',
      'Routes are registered in handle()',
    ];
    await addLearnings(cat.id, original);
    const before = await readFile(learningsFile(cat.name), 'utf8');

    expect((await t.api('POST', `/api/cats/${cat.id}/learnings/consolidate`)).status).toBe(202);
    const rewrite = await proposal((p) => p.kind === 'rewrite');
    expect(rewrite.trigger).toBe('user');
    expect(await readFile(learningsFile(cat.name), 'utf8')).toBe(before);

    expect((await resolve(rewrite.id, 'accept')).status).toBe(200);
    const changed = await stream.waitFor(
      isType('learnings.changed', (e) => e.payload.reason === 'consolidation'),
    );
    expect((await worker()).learnings.map((l) => l.text)).toEqual([
      'Tests use the makeUser fixture and live in test/',
      'Routes are registered in handle()',
    ]);

    const history = (await t.api('GET', `/api/cats/${cat.id}/learnings/history`)).body as {
      versions: LearningsVersion[];
    };
    expect(history.versions).toHaveLength(1);
    const backup = changed.type === 'learnings.changed' ? changed.payload.backup : null;
    expect(history.versions[0]?.id).toBe(backup);
    expect(history.versions[0]?.lines.map((l) => l.text)).toEqual(original);

    const undo = await t.api('POST', `/api/cats/${cat.id}/learnings/restore`, {
      versionId: backup,
    });
    expect(undo.status).toBe(200);
    expect((await worker()).learnings.map((l) => l.text)).toEqual(original);
    expect(await readFile(learningsFile(cat.name), 'utf8')).toBe(before);
    const after = (await t.api('GET', `/api/cats/${cat.id}/learnings/history`)).body as {
      versions: LearningsVersion[];
    };
    expect(after.versions).toHaveLength(2); // the consolidated version was saved too: redo is possible
  });

  it('keeps lines added after the rewrite was proposed', async () => {
    await setup({}, (options) =>
      options.systemPrompt.startsWith('# Consolidation')
        ? '- Tests use the makeUser fixture and live in test/'
        : defaultCompletion(options),
    );
    await taskInReview('Seed');
    const cat = await worker();
    await addLearnings(cat.id, ['Tests use the makeUser fixture', 'Test files live in test/']);
    await t.api('POST', `/api/cats/${cat.id}/learnings/consolidate`);
    const rewrite = await proposal((p) => p.kind === 'rewrite');
    await addLearnings(cat.id, ['Added while the rewrite was pending']);
    expect((await resolve(rewrite.id, 'accept')).status).toBe(200);
    expect((await worker()).learnings.map((l) => l.text)).toEqual([
      'Tests use the makeUser fixture and live in test/',
      'Added while the rewrite was pending',
    ]);
  });

  it('refuses a version id that points outside the history folder', async () => {
    await setup();
    await taskInReview('Seed');
    const cat = await worker();
    const res = await t.api('POST', `/api/cats/${cat.id}/learnings/restore`, {
      versionId: '../learnings.md',
    });
    expect(res.status).toBe(404);
  });
});

describe('XP and levels', () => {
  it('logs XP with its reason, and changes level both ways', async () => {
    await setup({ xp: { accepted: 30, rejectedPenalty: 20 } });
    const accepted = await taskInReview('Good work');
    const cat = await worker();
    await review(accepted.id, 'accept');
    const gained = stream.events.flatMap((e) =>
      e.type === 'xp.changed' ? [[e.payload.reason, e.payload.delta]] : [],
    );
    expect(gained).toEqual([
      ['accepted', 30],
      ['tests_first_try', 5],
    ]);
    await stream.waitFor(isType('cat.level_changed', (e) => e.payload.to === 2));

    const rejected = await taskInReview('Bad work', undefined, cat.id);
    await review(rejected.id, 'reject');
    await stream.waitFor(
      isType('xp.changed', (e) => e.payload.reason === 'rejected' && e.payload.xp === 15),
    );
    await stream.waitFor(
      isType('cat.level_changed', (e) => e.payload.from === 2 && e.payload.to === 1),
    );
    expect(await worker()).toMatchObject({
      xp: 15,
      level: 1,
      stats: { completed: 2, accepted: 1, rejected: 1 },
    });
    await vi.waitFor(
      async () => {
        const stats = JSON.parse(
          await readFile(join(t.projectPath, '.agentcats', 'cats', cat.name, 'stats.json'), 'utf8'),
        ) as { xp: number };
        expect(stats.xp).toBe(15);
      },
      { timeout: 10_000 },
    );
  });

  it('records what a task cost', async () => {
    await setup();
    const task = await taskInReview('Costed');
    expect(task.result?.costUsd).toBeGreaterThan(0);
  });

  it("folds a level-up's new learnings into one consolidation proposal", async () => {
    await setup({ xp: { accepted: 30 } }, (options) =>
      options.systemPrompt.startsWith('# Consolidation')
        ? `- Tests use the makeUser fixture; routes are registered in handle()\n- ${FIXTURE}`
        : defaultCompletion(options),
    );
    const task = await taskInReview('Seed', FIXTURE);
    const cat = await worker();
    await addLearnings(cat.id, [
      'Tests use the makeUser fixture',
      'Routes are registered in handle()',
    ]);
    await review(task.id, 'accept');
    const rewrite = await proposal((p) => p.kind === 'rewrite');
    expect(rewrite.trigger).toBe('level_up');
    const consolidation = completions.find((o) => o.systemPrompt.startsWith('# Consolidation'))!;
    expect(consolidation.prompt).toContain(`- ${FIXTURE} (task ${task.id})`);
    await new Promise((r) => setTimeout(r, 300));
    expect(Object.values((await board()).proposals)).toHaveLength(1); // no separate add
  });

  it('proposes nothing when a consolidation would change nothing', async () => {
    await setup({ xp: { accepted: 30 } }); // the mock returns the list unchanged
    const task = await taskInReview('Seed', 'nothing new');
    const cat = await worker();
    await addLearnings(cat.id, [
      'Tests use the makeUser fixture',
      'Routes are registered in handle()',
    ]);
    await review(task.id, 'accept');
    await stream.waitFor(
      isType('notice', (e) => e.payload.code === 'consolidation_unchanged'),
      10_000,
    );
    expect((await board()).proposals).toEqual({});
  });
});

describe('worker prompt', () => {
  it('carries the learnings a level allows, chosen by relevance', async () => {
    await setup();
    await taskInReview('Seed');
    const cat = await worker();
    const lines = [
      'Login handlers live in src/routes/auth.ts',
      'Old note about the build output',
      'Old note about the changelog',
      'Use the makeUser fixture for login tests',
      'Recent note about formatting',
      'Recent note about linting',
      'Recent note about commit messages',
    ];
    await addLearnings(cat.id, lines);
    await taskInReview('Add a login endpoint', undefined, cat.id);

    const prompt = spawns.at(-1)?.systemPrompt ?? '';
    expect(prompt).toContain(`You are ${cat.name}`);
    expect(prompt).toContain('## What you have learned');
    const loaded = lines.filter((l) => prompt.includes(`- ${l}`));
    expect(loaded).toEqual([
      'Login handlers live in src/routes/auth.ts',
      'Use the makeUser fixture for login tests',
      'Recent note about formatting',
      'Recent note about linting',
      'Recent note about commit messages',
    ]);
  });

  it('adds the persona from profile.md', async () => {
    await setup();
    await taskInReview('Seed');
    const cat = await worker();
    const profile = join(t.projectPath, '.agentcats', 'cats', cat.name, 'profile.md');
    await writeFile(profile, `${await readFile(profile, 'utf8')}\nYou love tiny diffs.\n`);
    await taskInReview('Second', undefined, cat.id);
    expect(spawns.at(-1)?.systemPrompt).toContain('## Your persona\n\nYou love tiny diffs.');
  });
});
