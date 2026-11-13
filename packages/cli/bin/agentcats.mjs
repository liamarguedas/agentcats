#!/usr/bin/env node
import { nodeVersionProblem } from './check-node.mjs';

const problem = nodeVersionProblem(process.version);
if (problem) {
  console.error(problem);
  process.exit(1);
}
const { main } = await import('../dist/main.js');
process.exitCode = await main(process.argv.slice(2));
