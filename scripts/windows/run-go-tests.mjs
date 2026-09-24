#!/usr/bin/env node
/**
 * Run the Windows deployment Go tests.
 *
 *   npm run test:windows
 *
 * ## No silent skip
 *
 * If the Go toolchain is not available this exits non-zero. A runner that reports success when it ran
 * nothing is worse than no runner at all, because the gate above it turns green — the same reasoning as
 * scripts/uos/run-deployment-tests.mjs. Skipping requires saying so explicitly with
 * CIVIC_WINDOWS_TESTS=skip, and it says loudly what it did.
 *
 * Go is a build-time tool only. It is not installed machine-wide and is not a prerequisite for anyone
 * running CivicWorkDesk; set CIVIC_GOROOT if the portable tree lives somewhere other than the default.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC = resolve('deploy/windows/src');
const GO_ROOT = process.env.CIVIC_GOROOT ?? 'D:/tools/go1.27.1/go';

if (!existsSync(join(SRC, 'go.mod'))) {
  console.error('error: deploy/windows/src/go.mod not found. Run from the repository root.');
  process.exit(2);
}

if (process.env.CIVIC_WINDOWS_TESTS === 'skip') {
  console.log('==================================================================');
  console.log('Windows deployment tests SKIPPED by CIVIC_WINDOWS_TESTS=skip.');
  console.log('Nothing was verified. Do not record a pass for the Windows deployment.');
  console.log('==================================================================');
  process.exit(0);
}

const goExe = join(GO_ROOT, 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
if (!existsSync(goExe)) {
  console.error('');
  console.error(`error: no Go toolchain at ${goExe}.`);
  console.error('These tests need Go 1.27 (build-time only; it is not a runtime prerequisite).');
  console.error('Point CIVIC_GOROOT at a portable Go tree, or state the skip explicitly:');
  console.error('    CIVIC_WINDOWS_TESTS=skip npm run test:windows');
  process.exit(1);
}

const env = {
  ...process.env,
  GOROOT: GO_ROOT,
  GOPATH: join(dirname(GO_ROOT), 'gopath'),
};

console.log(`Go toolchain: ${goExe}`);
console.log('');

// gofmt and vet first: a formatting or vet failure is cheaper to see before the tests scroll past.
for (const [label, args] of [
  ['vet', ['vet', './...']],
  ['test', ['test', './...', '-count=1']],
]) {
  const result = spawnSync(goExe, args, { cwd: SRC, env, stdio: 'inherit' });
  if (result.error) {
    console.error(`error: could not run go ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`error: go ${label} failed`);
    process.exit(result.status ?? 1);
  }
}

// `go fmt` rewrites files rather than reporting, so the gate has to notice that it rewrote something.
//
// Comparing against `git diff` was the obvious way and the wrong one: it reports every uncommitted
// edit under deploy/windows/src, so any work in progress failed the gate with a message about
// formatting. `gofmt -l` answers the actual question — which files are not formatted — without
// touching anything and without caring what is committed.
const unformatted = spawnSync(
  join(GO_ROOT, 'bin', process.platform === 'win32' ? 'gofmt.exe' : 'gofmt'),
  ['-l', '.'],
  {
    cwd: SRC,
    env,
    encoding: 'utf8',
  },
);
const drifted = (unformatted.stdout ?? '').trim();
if (drifted) {
  console.error('');
  console.error('error: these files are not gofmt-clean:');
  console.error(drifted);
  process.exit(1);
}

console.log('');
console.log('Windows deployment tests: PASS');
