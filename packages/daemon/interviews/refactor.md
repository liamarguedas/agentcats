---
title: Remove duplicated validation
repo: fixture
check: node --test
lint: node scripts/lint.js
typecheck:
---

`createUser` and `updateUser` in `src/users.js` repeat the same validation of `name` and `email`.
Move it into one exported function, `validateUser({ name, email })`, that throws the same errors with the same messages, and use it in both.

Behavior must not change. Make sure `npm test` and `npm run lint` pass, and commit your work.
