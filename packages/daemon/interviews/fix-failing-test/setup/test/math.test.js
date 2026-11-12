import assert from 'node:assert/strict';
import { test } from 'node:test';

import { average, median } from '../src/math.js';

test('average', () => {
  assert.equal(average([2, 4, 6]), 4);
  assert.equal(average([]), 0);
});

test('median does not reorder its input', () => {
  const input = [3, 1, 2];
  assert.equal(median(input), 2);
  assert.deepEqual(input, [3, 1, 2]);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
