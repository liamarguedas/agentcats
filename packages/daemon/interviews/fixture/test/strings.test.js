import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capitalize, truncate } from '../src/strings.js';

test('capitalize', () => {
  assert.equal(capitalize('cat'), 'Cat');
  assert.equal(capitalize(''), '');
});

test('truncate', () => {
  assert.equal(truncate('kitten', 10), 'kitten');
  assert.equal(truncate('kittens', 4), 'kit…');
});
