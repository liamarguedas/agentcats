import { describe, expect, it } from 'vitest';

import {
  cleanText,
  dedupe,
  isDuplicate,
  parseLearningsFile,
  parseProposal,
  serializeLearningsFile,
  withIds,
} from './learnings.js';

const TASK = '1a2b3c4d5e6f7a8b';

describe('learnings.md', () => {
  it('round-trips through the file format', () => {
    const drafts = [
      { text: 'Use the `makeUser` fixture in tests, not raw inserts.', sourceTaskId: TASK },
      { text: 'A line the user wrote', sourceTaskId: null },
    ];
    const file = serializeLearningsFile('Mochi', drafts);
    expect(file).toContain(
      `- Use the \`makeUser\` fixture in tests, not raw inserts. (task ${TASK})`,
    );
    expect(
      parseLearningsFile(file).map(({ text, sourceTaskId }) => ({ text, sourceTaskId })),
    ).toEqual(drafts);
  });

  it('reads only bullets, ignoring headings, comments, blank lines and empty bullets', () => {
    const file = [
      '# Notes',
      '<!-- - not a learning',
      '- still in the comment -->',
      '',
      '* star bullet works',
      '-',
      'plain prose is ignored',
      `  - indented bullet (task ${TASK.toUpperCase()})`,
    ].join('\r\n');
    expect(parseLearningsFile(file).map((l) => [l.text, l.sourceTaskId])).toEqual([
      ['star bullet works', null],
      ['indented bullet', TASK],
    ]);
  });

  it('gives lines stable ids from their content, unique even for repeated lines', () => {
    const a = withIds([
      { text: 'same', sourceTaskId: null },
      { text: 'same', sourceTaskId: null },
    ]);
    const b = withIds([{ text: 'same', sourceTaskId: null }]);
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[1]?.id).not.toBe(a[0]?.id);
  });

  it('cleans text to one line within the limit', () => {
    expect(cleanText('  two\nlines  ')).toBe('two lines');
    expect(cleanText('x'.repeat(400))).toHaveLength(300);
    expect(cleanText('   ')).toBe('');
  });
});

describe('dedupe', () => {
  const existing = [{ text: 'Use the `makeUser` fixture in tests, not raw inserts.' }];

  it('catches exact duplicates that differ only in case and punctuation', () => {
    expect(isDuplicate('use the makeUser fixture in tests not raw inserts', existing)).toBe(true);
  });

  it('catches near duplicates', () => {
    expect(
      isDuplicate('Tests should use the makeUser fixture instead of raw inserts', existing),
    ).toBe(true);
  });

  it('keeps lines that say something else', () => {
    expect(isDuplicate('Run pnpm test -- --run; plain pnpm test starts watch mode', existing)).toBe(
      false,
    );
  });

  it('drops repeats within the new lines too', () => {
    const drafts = [
      { text: 'Routes are registered in handle() in src/app.js', sourceTaskId: TASK },
      { text: 'Routes are registered in handle() inside src/app.js', sourceTaskId: TASK },
      { text: 'Use the makeUser fixture in tests', sourceTaskId: TASK },
    ];
    expect(dedupe(drafts, existing).map((d) => d.text)).toEqual([
      'Routes are registered in handle() in src/app.js',
    ]);
  });
});

describe('parseProposal', () => {
  it('reads up to the limit of bullet lines and tags them with the task', () => {
    const answer = [
      'Here you go:',
      '- Routes are registered in handle() in src/app.js',
      '- Run the tests with node --test, there is no test runner installed',
      '- Third useful line about the repository layout',
      '- Fourth line that goes over the limit of three',
    ].join('\n');
    const drafts = parseProposal(answer, TASK, 3);
    expect(drafts).toHaveLength(3);
    expect(drafts.every((d) => d.sourceTaskId === TASK)).toBe(true);
  });

  it('reads NONE, prose and too-short lines as nothing', () => {
    expect(parseProposal('NONE', TASK, 3)).toEqual([]);
    expect(parseProposal('Nothing worth keeping here.', TASK, 3)).toEqual([]);
    expect(parseProposal('- none\n- too short', TASK, 3)).toEqual([]);
  });

  it('drops lines that comment on learnings instead of stating one', () => {
    // Both from the first live run.
    const answer = [
      "- The worker's `resetStore()` note (it also resets `nextId`) is a repository fact that would change a future worker's choice, so it is worth keeping.",
      "- Its `deleteAllNotes()` addition is already a description of this task's change and should not be kept.",
      '- The worker\'s "Learned" note about `makeNote` bypassing POST is repo-specific and useful, so it\'s kept below.',
      '- resetStore() also resets nextId, so bulk deletes that must keep ids increasing need their own store function.',
    ].join('\n');
    expect(parseProposal(answer, TASK, 3).map((d) => d.text)).toEqual([
      'resetStore() also resets nextId, so bulk deletes that must keep ids increasing need their own store function.',
    ]);
  });

  it("strips a copied 'Learned:' label", () => {
    expect(parseProposal('- Learned: makeNote skips the POST /notes validation', TASK, 3)).toEqual([
      { text: 'makeNote skips the POST /notes validation', sourceTaskId: TASK },
    ]);
  });

  it('keeps the sources a consolidation wrote', () => {
    const drafts = parseProposal(`- Merged line about the test fixtures (task ${TASK})`, null, 10);
    expect(drafts).toEqual([{ text: 'Merged line about the test fixtures', sourceTaskId: TASK }]);
  });
});
