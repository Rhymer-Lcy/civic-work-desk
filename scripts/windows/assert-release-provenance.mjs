#!/usr/bin/env node
/**
 * Prove that a release's recorded source commit is real, public and reachable — before it is baked into
 * an artifact, and again after publication.
 *
 *   node scripts/windows/assert-release-provenance.mjs --commit <sha> --branch <public branch>
 *       [--release-id <id>] [--offline]
 *   node scripts/windows/assert-release-provenance.mjs --verify-built --release-id <id> --branch <branch>
 *
 * Nothing has a default. Until Phase 6 the branch was fixed to the Phase-4 branch and the release id
 * defaulted to 2026.09.24-win-rc3, so a later release run without flags would have been checked against
 * the wrong branch and the wrong identity -- and would have passed.
 *
 * ## The defect this exists to make impossible
 *
 * RC2's tracked VERSION recorded `deploymentCommit=9adf28af…`, and GitHub cannot resolve that SHA. The
 * cause was ordinary and easy to repeat: the installer was built while HEAD pointed at an unpushed
 * commit, and that commit was then rewritten — by a rebase that reworded three subjects — before the
 * branch was pushed. The build had faithfully recorded a SHA that afterwards ceased to exist.
 *
 * ## Two commits, deliberately distinct
 *
 *   deploymentSourceCommit  the public commit holding ALL source that affects the payload and the
 *                           installer. Frozen BEFORE the build; never amended, rebased or reworded
 *                           afterwards. This is what goes into the artifact.
 *
 *   releaseRecordCommit     the later commit holding the generated provenance, reports and documentation
 *                           that can only be written once the artifact exists. It is what the tag points
 *                           at. The artifact does not, and must not, embed it.
 *
 * Checks, in the order a failure is cheapest to fix:
 *
 *   1. the SHA is exactly 40 hexadecimal characters;
 *   2. `git cat-file -e <sha>^{commit}` succeeds locally;
 *   3. it is an ancestor of the named public branch, and that branch matches origin;
 *   4. GitHub resolves it and reports it on that branch (skipped with --offline, which says so);
 *   5. with --verify-built: the built VERSION carries that exact SHA and this release's identity.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'Rhymer-Lcy/civic-work-desk';

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : '';
}
const OFFLINE = process.argv.includes('--offline');
const VERIFY_BUILT = process.argv.includes('--verify-built');
const releaseId = argValue('--release-id');
const BRANCH = argValue('--branch');

function usage(why) {
  console.error(`error: ${why}`);
  console.error(
    'usage: assert-release-provenance.mjs --commit <sha> --branch <branch> [--release-id <id>] [--offline]',
  );
  console.error(
    '       assert-release-provenance.mjs --verify-built --release-id <id> --branch <branch>',
  );
  process.exit(2);
}
if (!BRANCH) usage('--branch is required and has no default');
if (VERIFY_BUILT && !releaseId) usage('--verify-built needs --release-id; there is no default');

function sh(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
}

const results = [];
let failures = 0;
function check(ok, name, detail = '') {
  results.push({ ok, name, detail });
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  --  ${detail}` : ''}`);
}
function info(name, detail) {
  console.log(`  [INFO] ${name}${detail ? `  --  ${detail}` : ''}`);
}

console.log('CivicWorkDesk release-provenance assertion');
console.log('');
info('branch', BRANCH);
if (releaseId) info('release id', releaseId);

/** Read a key out of a VERSION-style key=value file. */
function versionField(text, key) {
  for (const line of text.split(/\r?\n/)) {
    const [k, ...rest] = line.split('=');
    if (k.trim() === key) return rest.join('=').trim();
  }
  return '';
}

let commit = argValue('--commit');
if (VERIFY_BUILT) {
  const versionPath = join(
    ROOT,
    'release',
    'windows',
    `civic-work-desk-windows-x64-${releaseId}`,
    'VERSION',
  );
  if (!existsSync(versionPath)) {
    console.error(`error: ${versionPath} does not exist. Build ${releaseId} first.`);
    process.exit(2);
  }
  const version = readFileSync(versionPath, 'utf8');
  info('VERSION', versionPath.replace(ROOT, '.'));

  check(
    versionField(version, 'releaseId') === releaseId,
    'VERSION releaseId matches the release being checked',
    versionField(version, 'releaseId'),
  );
  const display = versionField(version, 'displayVersion');
  check(
    display !== '' && releaseId.endsWith(`-win-${display}`),
    'VERSION displayVersion is the version the release id names',
    display || '(absent)',
  );
  const phase = versionField(version, 'phase');
  check(
    phase.startsWith('Phase 6') && !/\bRC[0-9]+\b/.test(phase),
    'VERSION phase names this phase and carries no earlier RC label',
    phase,
  );
  check(
    versionField(version, 'deploymentCommit') === '',
    'the retired deploymentCommit field is gone',
    versionField(version, 'deploymentCommit') || '(absent)',
  );
  commit = versionField(version, 'deploymentSourceCommit');
  check(commit !== '', 'VERSION carries deploymentSourceCommit', commit || '(absent)');
  check(
    versionField(version, 'releaseRecordCommit') === '',
    'the artifact does NOT embed a release-record commit (that would be circular)',
  );
  const baseline = versionField(version, 'productBaselineCommit');
  const baselineIsAncestor =
    /^[0-9a-f]{40}$/.test(baseline) &&
    sh('git', ['merge-base', '--is-ancestor', baseline, commit]).status === 0;
  check(
    baselineIsAncestor,
    'productBaselineCommit is an ancestor of deploymentSourceCommit',
    baseline || '(absent)',
  );
}

if (!commit) usage('no commit given. Pass --commit <sha> or --verify-built.');

// 1. shape
check(/^[0-9a-f]{40}$/.test(commit), 'the SHA is 40 lowercase hexadecimal characters', commit);

// 2. resolvable locally, and is a commit rather than some other object
const catFile = sh('git', ['cat-file', '-e', `${commit}^{commit}`]);
check(catFile.status === 0, 'git resolves it locally as a commit');

// 3. reachable from the public branch — the check that RC2's SHA would have failed
const ancestor = sh('git', ['merge-base', '--is-ancestor', commit, BRANCH]);
check(
  ancestor.status === 0,
  `it is reachable from ${BRANCH}`,
  ancestor.status === 0
    ? 'an ancestor of the branch head'
    : 'NOT an ancestor — it was rewritten or never pushed',
);

// The local branch must itself match the remote, or "reachable" is a statement about this machine only.
const localHead = sh('git', ['rev-parse', BRANCH]).stdout?.trim() ?? '';
const remoteHead = sh('git', ['rev-parse', `origin/${BRANCH}`]).stdout?.trim() ?? '';
check(
  localHead !== '' && localHead === remoteHead,
  'the local branch matches origin (so "reachable" means publicly reachable)',
  `local ${localHead.slice(0, 8)} / origin ${remoteHead.slice(0, 8)}`,
);

// 4. GitHub resolves it
if (OFFLINE) {
  info('GitHub resolution', 'SKIPPED by --offline; this run does NOT prove the SHA is public');
} else {
  const api = sh('gh', ['api', `repos/${REPO}/commits/${commit}`, '--jq', '.sha']);
  const resolved = (api.stdout ?? '').trim();
  check(
    api.status === 0 && resolved === commit,
    'GitHub resolves the SHA',
    api.status === 0 ? resolved : (api.stderr ?? '').split('\n')[0],
  );

  const onBranch = sh('gh', [
    'api',
    `repos/${REPO}/commits?sha=${encodeURIComponent(BRANCH)}&per_page=100`,
    '--jq',
    '.[].sha',
  ]);
  const shas = (onBranch.stdout ?? '').split(/\r?\n/).filter(Boolean);
  check(
    shas.includes(commit),
    `GitHub reports it on ${BRANCH}`,
    `${shas.length} commit(s) examined`,
  );
}

console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  failed : ${failures}`);
console.log('');
if (results.length < 5) {
  console.log(
    'RESULT: FAIL — fewer checks ran than the minimum; the assertion cannot vouch for anything',
  );
  process.exit(1);
}
if (failures === 0) {
  console.log(`RESULT: PASS — ${commit} is a real, public, reachable source commit`);
  process.exit(0);
}
console.log('RESULT: FAIL — do not build or publish against this commit');
process.exit(1);
