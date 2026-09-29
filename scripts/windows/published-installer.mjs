/**
 * Obtain a PUBLISHED Windows installer -- the bytes on the GitHub Release, verified -- for an upgrade test.
 *
 * An upgrade test against a locally rebuilt "RC3" would test something no colleague has: Inno Setup output
 * is not reproducible, so a rebuild is a different artifact. The test must start from the installer that
 * was published, so it is downloaded from its release (or reused from a previous download) and its
 * digest is checked against the one scripts/windows/published-releases.json recorded at publication.
 * A mismatch stops the test; nothing is ever substituted.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'Rhymer-Lcy/civic-work-desk';

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * @param {string} root the repository root
 * @param {string} releaseId a release id listed in published-releases.json
 * @returns {{ path: string, sha256: string, tag: string, source: string }}
 */
export function obtainPublishedInstaller(root, releaseId) {
  const published = JSON.parse(
    readFileSync(join(root, 'scripts', 'windows', 'published-releases.json'), 'utf8'),
  );
  const entry = published.releases.find((r) => r.releaseId === releaseId);
  if (!entry) throw new Error(`${releaseId} is not a published release`);

  const dir = join(root, 'release', 'windows', '.build', 'published');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, entry.installer);
  if (existsSync(path) && digest(path) === entry.sha256) {
    return {
      path,
      sha256: entry.sha256,
      tag: entry.tag,
      source: 'cached download, digest verified',
    };
  }
  rmSync(path, { force: true });
  const url = `https://github.com/${REPO}/releases/download/${entry.tag}/${entry.installer}`;
  // Spaced retries: the link from this workstation to the asset CDN drops a connection now and then,
  // and hammering it is what makes that worse.
  const result = spawnSync(
    'curl',
    ['-sSL', '--retry', '4', '--retry-delay', '8', '--retry-all-errors', '-o', path, url],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0 || !existsSync(path)) {
    throw new Error(`cannot download ${url}: ${(result.stderr ?? '').trim()}`);
  }
  const got = digest(path);
  if (got !== entry.sha256) {
    rmSync(path, { force: true });
    throw new Error(
      `${entry.installer} from GitHub has sha256 ${got}, not the published ${entry.sha256}`,
    );
  }
  return { path, sha256: got, tag: entry.tag, source: `downloaded from ${url}, digest verified` };
}
