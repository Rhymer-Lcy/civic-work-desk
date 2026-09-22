#!/usr/bin/env node
/**
 * Prove that a release bundle's `app/` payload is byte-identical to the application build.
 *
 *   node scripts/uos/verify-app-unchanged.mjs <bundle-app-dir> [--against dist] [--against other-app]
 *
 * The property RC1.1 has to preserve is narrow and worth stating precisely: repackaging the
 * acceptance harness must not change one byte of the application. So this does not compare summaries
 * or counts — it hashes every file on both sides and compares the sets.
 *
 * `deployment-health.json` is the single expected difference against a raw `dist/`: it is a
 * deployment artifact, written into the bundle rather than into the application build, exactly so
 * that the Phase-2 build stays unmodified. Against another *bundle* there should be no difference at
 * all, including that file.
 *
 * Exits non-zero on any mismatch, extra file or missing file.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const EXPECTED_BUNDLE_ONLY = new Set(['deployment-health.json']);

function walk(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, base, out);
    } else {
      const rel = relative(base, full).replaceAll('\\', '/');
      out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  }
  return out;
}

const [target, ...rest] = process.argv.slice(2);
if (!target) {
  console.error(
    'usage: verify-app-unchanged.mjs <bundle-app-dir> --against <dir> [--against <dir>]',
  );
  process.exit(2);
}

const references = [];
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === '--against') {
    const value = rest[index + 1];
    if (!value) {
      console.error('--against needs a directory');
      process.exit(2);
    }
    references.push(value);
    index += 1;
  }
}
if (references.length === 0) {
  console.error('at least one --against <dir> is required');
  process.exit(2);
}

const targetFiles = walk(resolve(target));
console.log(`payload under test: ${target}`);
console.log(`files hashed:       ${String(targetFiles.size)}`);

let failures = 0;

for (const reference of references) {
  const referenceFiles = walk(resolve(reference));
  console.log('');
  console.log(`--- against ${reference} (${String(referenceFiles.size)} files) ---`);

  const differing = [];
  const missing = [];
  const extra = [];

  for (const [path, hash] of targetFiles) {
    if (!referenceFiles.has(path)) {
      extra.push(path);
    } else if (referenceFiles.get(path) !== hash) {
      differing.push(path);
    }
  }
  for (const path of referenceFiles.keys()) {
    if (!targetFiles.has(path)) missing.push(path);
  }

  const unexpectedExtra = extra.filter((path) => !EXPECTED_BUNDLE_ONLY.has(path));
  const expectedExtra = extra.filter((path) => EXPECTED_BUNDLE_ONLY.has(path));

  if (differing.length === 0 && missing.length === 0 && unexpectedExtra.length === 0) {
    const shared = targetFiles.size - extra.length;
    console.log(`PASS — ${String(shared)} shared files byte-identical.`);
    if (expectedExtra.length > 0) {
      console.log(`       bundle-only (expected): ${expectedExtra.join(', ')}`);
    } else {
      console.log('       no bundle-only files; the two payloads are identical.');
    }
  } else {
    failures += 1;
    console.log('FAIL');
    for (const path of differing) console.log(`  differs: ${path}`);
    for (const path of missing) console.log(`  missing from payload: ${path}`);
    for (const path of unexpectedExtra) console.log(`  unexpected extra file: ${path}`);
  }
}

console.log('');
if (failures > 0) {
  console.log(`RESULT: FAIL — ${String(failures)} reference(s) did not match.`);
  process.exit(1);
}
console.log('RESULT: PASS — the application payload is unchanged.');
