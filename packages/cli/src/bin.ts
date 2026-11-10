// Development entry point (`pnpm agentcats`), run from sources with tsx.
// The published bin is bin/agentcats.mjs, which loads the built dist/.
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2));
