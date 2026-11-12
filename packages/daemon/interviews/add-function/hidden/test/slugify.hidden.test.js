import assert from 'node:assert/strict';
import { test } from 'node:test';

import { slugify } from '../src/strings.js';

test('slugify (interview check)', () => {
  assert.equal(slugify('  Hello, World! '), 'hello-world');
  assert.equal(slugify('Cats & Dogs 2'), 'cats-dogs-2');
  assert.equal(slugify('---already-slugged---'), 'already-slugged');
  assert.equal(slugify('ÜBER cool'), 'ber-cool');
  assert.equal(slugify(''), '');
  assert.equal(slugify('!!!'), '');
});
