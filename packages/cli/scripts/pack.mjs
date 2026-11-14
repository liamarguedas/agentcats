// Builds the publishable `agentcats` package in packages/cli/pack/:
// one bundled file for all agentcats code, the built UI, and the files the
// code reads at runtime, laid out so their `import.meta.url` paths still
// resolve. Third-party packages stay ordinary npm dependencies; the Claude
// Agent SDK must, since its license does not allow bundling it.
//
//   pnpm -F agentcats pack:build   (after `pnpm -F @agentcats/ui build`)
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const cli = fileURLToPath(new URL('..', import.meta.url));
const packages = join(cli, '..');
const root = join(packages, '..');
const out = join(cli, 'pack');

/** Workspace packages whose runtime dependencies the bundle needs. The UI ships prebuilt. */
const BUNDLED = [
  'protocol',
  'kit',
  'daemon',
  'cli',
  'adapters/claude',
  'adapters/acp',
  'adapters/codex',
  'adapters/mock',
];

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

/** Third-party runtime dependencies, with the one exact version every package agrees on. */
async function runtimeDependencies() {
  const deps = {};
  for (const dir of BUNDLED) {
    const pkg = await readJson(join(packages, dir, 'package.json'));
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (version.startsWith('workspace:')) continue;
      if (deps[name] && deps[name] !== version) {
        throw new Error(`${name} has two versions: ${deps[name]} and ${version} (${dir})`);
      }
      deps[name] = version;
    }
  }
  return Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)));
}

const uiDist = join(packages, 'ui', 'dist');
if (!(await stat(join(uiDist, 'index.html')).catch(() => null))) {
  throw new Error('Build the UI first: pnpm -F @agentcats/ui build');
}

const cliPackage = await readJson(join(cli, 'package.json'));
const dependencies = await runtimeDependencies();

await rm(out, { recursive: true, force: true });
await build({
  entryPoints: { main: join(cli, 'src', 'main.ts') },
  outdir: join(out, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  conditions: ['@agentcats/source'],
  external: Object.keys(dependencies),
  sourcemap: 'linked',
  sourcesContent: false,
  logLevel: 'warning',
});

const copies = [
  [join(packages, 'daemon', 'prompts'), 'prompts'],
  [join(packages, 'daemon', 'interviews'), 'interviews'],
  [join(packages, 'daemon', 'captions'), 'captions'],
  [join(packages, 'kit', 'bin', 'guardian.mjs'), 'bin/guardian.mjs'],
  [join(cli, 'bin', 'agentcats.mjs'), 'bin/agentcats.mjs'],
  [join(cli, 'bin', 'check-node.mjs'), 'bin/check-node.mjs'],
  [uiDist, 'ui'],
  [join(root, 'LICENSE'), 'LICENSE'],
];
for (const [from, to] of copies) {
  await mkdir(dirname(join(out, to)), { recursive: true });
  await cp(from, join(out, to), { recursive: true });
}

// npm shows the README without the repository around it: point its relative
// links and images at GitHub.
const REPO = 'https://github.com/liamarguedas/agentcats';
const readme = (await readFile(join(root, 'README.md'), 'utf8')).replace(
  /(!?)\[([^\]]*)\]\((?!https?:|#)([^)]+)\)/g,
  (_match, image, text, path) =>
    `${image}[${text}](${REPO}/${image ? 'raw' : 'blob'}/main/${path})`,
);
await writeFile(join(out, 'README.md'), readme);

const manifest = {
  name: cliPackage.name,
  version: cliPackage.version,
  description: cliPackage.description,
  license: cliPackage.license,
  type: 'module',
  bin: { agentcats: './bin/agentcats.mjs' },
  engines: cliPackage.engines,
  repository: { type: 'git', url: 'git+https://github.com/liamarguedas/agentcats.git' },
  keywords: ['agents', 'claude-code', 'codex', 'ai', 'whiteboard', 'cats'],
  files: ['bin', 'dist', 'ui', 'prompts', 'interviews', 'captions'],
  dependencies,
};
await writeFile(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Packed agentcats ${manifest.version} into ${out}`);
