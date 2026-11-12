import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUser, updateUser } from '../src/users.js';

test('creates and updates a user', () => {
  const user = createUser({ name: ' Mochi ', email: 'MOCHI@cats.dev' });
  assert.deepEqual(user, { id: user.id, name: 'Mochi', email: 'mochi@cats.dev' });
  assert.equal(updateUser(user.id, { name: 'Miso', email: 'miso@cats.dev' }).name, 'Miso');
});
