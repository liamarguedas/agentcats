// Project rules: no console.log and no var in src/.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const problems = [];
for (const file of readdirSync('src')) {
  const text = readFileSync(join('src', file), 'utf8');
  if (/console\.log/.test(text)) problems.push(`src/${file}: no console.log`);
  if (/\bvar\s/.test(text)) problems.push(`src/${file}: use let or const, not var`);
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('lint ok');
