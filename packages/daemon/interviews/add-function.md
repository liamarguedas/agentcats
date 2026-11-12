---
title: Add a slugify function
repo: fixture
check: node --test
lint: node scripts/lint.js
typecheck:
---

Add a `slugify(text)` function to `src/strings.js` and export it.

It returns `text` in lower case, with every run of characters that are not a letter or a digit replaced by a single `-`, and no `-` at the start or the end.
For example `slugify('  Hello, World! ')` is `'hello-world'` and `slugify('Cats & Dogs 2')` is `'cats-dogs-2'`.

Add tests for it next to the existing ones, and make sure `npm test` and `npm run lint` pass. Commit your work.
