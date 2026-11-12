import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createUser, updateUser, validateUser } from '../src/users.js';

test('validateUser is exported and throws the original messages (interview check)', () => {
  assert.equal(typeof validateUser, 'function');
  assert.throws(() => validateUser({ name: '', email: 'a@b.c' }), /name is required/);
  assert.throws(() => validateUser({ name: 'x'.repeat(51), email: 'a@b.c' }), /name is too long/);
  assert.throws(() => validateUser({ name: 'Ok', email: 'nope' }), /email is invalid/);
  assert.doesNotThrow(() => validateUser({ name: 'Ok', email: 'a@b.c' }));
});

test('create and update behave as before (interview check)', () => {
  const user = createUser({ name: ' Tofu ', email: 'TOFU@cats.dev' });
  assert.deepEqual(user, { id: user.id, name: 'Tofu', email: 'tofu@cats.dev' });
  assert.throws(
    () => updateUser(user.id, { name: ' ', email: 'tofu@cats.dev' }),
    /name is required/,
  );
  assert.throws(() => updateUser(9_999, { name: 'A', email: 'a@b.c' }), /user not found/);
  assert.equal(updateUser(user.id, { name: 'Nori', email: 'nori@cats.dev' }).name, 'Nori');
});
