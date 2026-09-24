#!/usr/bin/env node
/**
 * Prove that everything claiming to describe the CURRENT release actually names it.
 *
 *   node scripts/windows/assert-release-identity.mjs --release-id <id> [--offline]
 *
 * ## The defect this exists to catch
 *
 * RC2 shipped an installer whose Windows Properties dialog read
 * "CivicWorkDesk Windows x64 RC1 (field-validation candidate)". The string was hard-coded in the .iss
 * and nothing downstream read it, so no test, no gate and no reviewer saw it. The artifact told a user
 * it was a release it was not.
 *
 * A grep for "RC1" cannot be the check, because RC1 and RC2 are named legitimately and often —
 * comparisons, upgrade tests, historical documents, "RC2 remains published". So this works the other way
 * round: it inspects the specific fields that CLAIM to describe the current release, reads them out of
 * the built bytes and the tracked sources, and requires each to name this release. Contextual mentions
 * are not examined at all, because they are not claims about the current release.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/* A literal BOM in source is an invisible character, which the linter rightly rejects and which is
 * impossible to review. Built from its code point instead; PowerShell needs it to read a UTF-8
 * script correctly. */
const BOM = String.fromCharCode(0xfeff);
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const RELEASE_ID = argValue('--release-id', '2026.09.24-win-rc3');
const LABEL = (RELEASE_ID.split('-').pop() ?? '').toUpperCase();
const SETUP_BASE = `CivicWorkDesk-Windows-x64-${RELEASE_ID.replace('-win-', '-')}-Setup`;
const OUT = join(ROOT, 'release', 'windows');
const PAYLOAD = join(OUT, `civic-work-desk-windows-x64-${RELEASE_ID}`);

/** Every earlier label that must not appear in a current-release field. */
const EARLIER = ['RC1', 'RC2', 'RC3', 'RC4'].filter((l) => l !== LABEL);

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
function section(t) {
  console.log('');
  console.log(`== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);
}

function ps(script, ...args) {
  const scriptPath = join(process.env.TEMP ?? '.', 'civic-identity-probe.ps1');
  const outPath = join(process.env.TEMP ?? '.', 'civic-identity-probe.out');
  rmSync(outPath, { force: true });
  writeFileSync(scriptPath, `${BOM}${script}\n`, 'utf8');
  spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, outPath, ...args],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  const text = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(BOM, '').trim() : '';
  rmSync(outPath, { force: true });
  rmSync(scriptPath, { force: true });
  return text;
}

/** Does this string name the current release and no earlier one? */
function namesThisRelease(value) {
  if (!value) return false;
  if (!value.includes(LABEL) && !value.includes(RELEASE_ID)) return false;
  const withoutCurrent = value.split(RELEASE_ID).join('').split(LABEL).join('');
  return !EARLIER.some((l) => withoutCurrent.includes(l));
}

console.log('CivicWorkDesk current-release identity assertion');
console.log('');
console.log(`  release : ${RELEASE_ID}  (label ${LABEL})`);

// ---------------------------------------------------------------- tracked source must not hard-code
section('1. tracked installer source carries no release-candidate literal');
const issPath = join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.iss');
const iss = readFileSync(issPath, 'utf8');
const versionInfoLine =
  iss.split(/\r?\n/).find((l) => l.startsWith('VersionInfoDescription=')) ?? '';
check(
  versionInfoLine.includes('{#CivicReleaseLabel}'),
  'VersionInfoDescription is parameterised, not hard-coded',
  versionInfoLine.trim(),
);
check(
  !EARLIER.some((l) => versionInfoLine.includes(l)) && !versionInfoLine.includes(LABEL),
  'VersionInfoDescription names no release-candidate literal at all',
);

// ---------------------------------------------------------------- built artifacts
section('2. built artifacts');
const setup = join(OUT, `${SETUP_BASE}.exe`);
if (!existsSync(setup)) {
  console.error(`error: ${setup} does not exist. Build ${RELEASE_ID} first.`);
  process.exit(2);
}

const setupInfo = ps(
  `$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($args[1])
$lines = @()
$lines += 'FileDescription=' + $v.FileDescription
$lines += 'ProductName=' + $v.ProductName
$lines += 'ProductVersion=' + $v.ProductVersion
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`,
  setup,
);
const fields = Object.fromEntries(
  setupInfo.split(/\r?\n/).map((l) => {
    const [k, ...rest] = l.split('=');
    return [k, rest.join('=').trim()];
  }),
);
info('installer FileDescription', fields.FileDescription ?? '(none)');
info('installer ProductVersion', fields.ProductVersion ?? '(none)');
check(
  namesThisRelease(fields.FileDescription),
  'installer FileDescription names THIS release and no earlier one',
  fields.FileDescription ?? '',
);
check(
  (fields.ProductVersion ?? '').includes(RELEASE_ID),
  'installer ProductVersion carries the release id',
  fields.ProductVersion ?? '',
);

for (const exe of ['civic-launch.exe', 'civic-diag.exe']) {
  const path = join(PAYLOAD, 'server', exe);
  if (!existsSync(path)) {
    check(false, `${exe} is present in the payload`, path);
    continue;
  }
  const out = ps(
    `$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($args[1])
[System.IO.File]::WriteAllText($args[0], $v.ProductVersion, [System.Text.Encoding]::UTF8)`,
    path,
  );
  check(out.includes(RELEASE_ID), `${exe} version resource carries the release id`, out);
  check(!EARLIER.some((l) => out.includes(l)), `${exe} version resource names no earlier release`);
}

// ---------------------------------------------------------------- payload metadata
section('3. payload metadata');
const versionPath = join(PAYLOAD, 'VERSION');
const version = readFileSync(versionPath, 'utf8');
const field = (k) =>
  version
    .split(/\r?\n/)
    .map((l) => l.split('='))
    .find(([n]) => n.trim() === k)
    ?.slice(1)
    .join('=')
    .trim() ?? '';

check(field('releaseId') === RELEASE_ID, 'VERSION releaseId', field('releaseId'));
check(namesThisRelease(field('phase')), 'VERSION phase names THIS release', field('phase'));

const health = JSON.parse(readFileSync(join(PAYLOAD, 'app', 'deployment-health.json'), 'utf8'));
check(health.releaseId === RELEASE_ID, 'deployment-health.json releaseId', health.releaseId);
check(
  health.releaseChannel === 'windows-x64',
  'deployment-health.json channel',
  health.releaseChannel,
);

// ---------------------------------------------------------------- forwardable text
section('4. user-facing release text');
const notice = readFileSync(
  join(ROOT, 'deploy', 'windows', 'installer', 'README-测试说明.txt'),
  'utf8',
);
check(
  notice.includes(`${SETUP_BASE}.exe`),
  'the tester notice names this release-candidate installer',
  `${SETUP_BASE}.exe`,
);
check(
  notice.includes(`Windows 11 x64 ${LABEL}`),
  `the tester notice identifies itself as ${LABEL}`,
);
// Earlier labels are permitted in the notice ONLY if a line also explains the relationship; a bare
// mention would be the RC2 defect in another place.
const strayLines = notice
  .split(/\r?\n/)
  .filter((l) => EARLIER.some((e) => l.includes(e)))
  .filter((l) => !/取代|替代|supersede|以前|此前|旧版本/.test(l));
check(
  strayLines.length === 0,
  'the tester notice has no stray earlier-release mention',
  strayLines.join(' | '),
);

// ---------------------------------------------------------------- summary
console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  failed : ${failures}`);
console.log('');
if (failures === 0) {
  console.log(`RESULT: PASS — every current-release field names ${RELEASE_ID}`);
  process.exit(0);
}
console.log('RESULT: FAIL');
process.exit(1);
