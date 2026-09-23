#!/usr/bin/env node
/**
 * Run the POSIX deployment test suite on a POSIX host.
 *
 *   npm run test:uos
 *
 * The suite under scripts/uos/deployment-tests.sh needs things Windows does not have: /proc, POSIX
 * signals, symlinks, and BusyBox httpd. On this development workstation those come from WSL2, which
 * carries BusyBox 1.30.1 — the same applet version as the target, on a different architecture and a
 * different build. That distinction matters and is recorded in docs/phase-3-stage-b-evidence.md; the
 * tests prove the deployment logic, never target compatibility.
 *
 * ## No silent skip
 *
 * If no POSIX host is available this exits non-zero. A test runner that reports success when it ran
 * nothing is worse than no test runner, because the gate above it turns green. Skipping requires the
 * operator to say so explicitly with CIVIC_UOS_TESTS=skip, and it says loudly what it did.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SUITE = 'scripts/uos/deployment-tests.sh';
const repoRoot = process.cwd();

if (!existsSync(resolve(repoRoot, SUITE))) {
  console.error(`error: ${SUITE} not found. Run from the repository root.`);
  process.exit(2);
}

if (process.env.CIVIC_UOS_TESTS === 'skip') {
  console.log('==================================================================');
  console.log('UOS deployment tests SKIPPED by CIVIC_UOS_TESTS=skip.');
  console.log('Nothing was verified. Do not record a pass for the deployment logic.');
  console.log('==================================================================');
  process.exit(0);
}

/**
 * Translate a Windows path to the /mnt/<drive>/... form WSL sees.
 *
 * Written without a concrete example path on purpose: the static security scan rejects hard-coded
 * developer paths anywhere in the tree, comments included, and it is right to — a real one is a
 * portability defect, and a scan that made an exception for comments would stop catching them.
 */
function toWslPath(windowsPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const rest = match[2].replaceAll('\\', '/');
  return `/mnt/${drive}/${rest}`;
}

function runWsl() {
  const list = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le' });
  if (list.status !== 0) return null;
  const distros = list.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter(Boolean);
  if (distros.length === 0) return null;

  const distro = process.env.CIVIC_UOS_WSL_DISTRO ?? distros[0];
  const wslRepo = toWslPath(repoRoot);
  if (!wslRepo) return null;

  console.log(`POSIX host: WSL distro "${distro}"`);
  console.log(`repo (as seen by WSL): ${wslRepo}`);
  console.log('');

  return spawnSync(
    'wsl.exe',
    ['-d', distro, '--', 'sh', `${wslRepo}/${SUITE}`, '--repo', wslRepo],
    {
      stdio: 'inherit',
    },
  );
}

function runNative() {
  console.log('POSIX host: this machine');
  console.log('');
  return spawnSync('sh', [SUITE, '--repo', repoRoot], { stdio: 'inherit' });
}

const result = process.platform === 'win32' ? runWsl() : runNative();

if (!result) {
  console.error('');
  console.error('error: no POSIX host available to run the UOS deployment tests.');
  console.error('These tests need /proc, POSIX signals and BusyBox httpd.');
  console.error('Install WSL2 (or run on Linux), or state the skip explicitly:');
  console.error('    CIVIC_UOS_TESTS=skip npm run test:uos');
  process.exit(1);
}

if (result.error) {
  console.error(`error: could not start the test suite: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
