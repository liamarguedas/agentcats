// Plain JavaScript with no imports, so it runs on any Node and explains the
// problem before agentcats loads modules an older Node does not have
// (`node:sqlite`). Keep MINIMUM in step with `engines` in package.json.
export const MINIMUM = [22, 13];

/** A message for the user if `version` (like `v20.11.0`) is too old, else `null`. */
export function nodeVersionProblem(version) {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  const [needMajor, needMinor] = MINIMUM;
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return null;
  return `agentcats needs Node.js ${String(needMajor)}.${String(needMinor)} or newer (for its built-in SQLite); this is Node.js ${version}. Install a current LTS from https://nodejs.org, then run it again.`;
}
