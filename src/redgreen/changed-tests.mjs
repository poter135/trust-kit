// Which test files a change adds or modifies, per runner.
import picomatch from 'picomatch';
import { diffNameStatus } from '../git.mjs';

/**
 * Files added (`A`) or modified (`M`) between base and head that match a runner's `testGlobs`
 * (globs are relative to the repo root). Deleted files never count; a file matching several runners is
 * listed once per runner.
 * @param {{ repoRoot: string, base: string, head: string, config: import('../config.mjs').TrustConfig }} opts
 * @returns {Promise<{ runnerId: string, file: string }[]>}
 */
export async function listChangedTests({ repoRoot, base, head, config }) {
  const changed = (await diffNameStatus(repoRoot, base, head)).filter((d) => d.status === 'A' || d.status === 'M');
  const out = [];
  for (const rc of config.runners) {
    const match = picomatch(rc.testGlobs, { dot: true });
    for (const d of changed) if (match(d.path)) out.push({ runnerId: rc.id, file: d.path });
  }
  return out;
}
