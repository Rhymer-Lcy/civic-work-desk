#!/usr/bin/env node
/**
 * Independently verify a review package.
 *
 * This script does NOT trust the packaging script. It opens the archive, reads the central
 * directory itself, and checks:
 *
 *   1. the ZIP exists and its SHA-256 matches the adjacent `.sha256`;
 *   2. every expected file is present;
 *   3. no forbidden path is present (`_private_reference/`, `.env`, `node_modules/`, `.git/`,
 *      nested review ZIPs, Playwright artefacts);
 *   4. no entry's *content* carries a legacy record id or a known telemetry host;
 *   5. `review/SHA256SUMS.txt` agrees with the actual entry contents;
 *   6. `review/VERIFY_LOG.txt` records a real run, and its summary is internally consistent;
 *   7. the archive is structurally sound (entry count, CRCs, inflatable payloads).
 *
 * Exit code 1 on any failure.
 *
 * Usage:
 *   node scripts/verify-review-package.mjs                # newest package in _review_packages
 *   node scripts/verify-review-package.mjs <path-to.zip>
 */

import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '_review_packages');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------ zip reader */

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Parse a ZIP via its End of Central Directory record. Throws on anything malformed. */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no End of Central Directory record — not a ZIP file');

  const total = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('central directory extends past end of file — archive is truncated');
  }

  const entries = [];
  let cursor = centralOffset;
  for (let i = 0; i < total; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`bad central directory signature at entry ${String(i)}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`bad local header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);

    if (data.length !== uncompressedSize) {
      throw new Error(`size mismatch for ${name}`);
    }
    if (crc32(data) !== crc) {
      throw new Error(`CRC mismatch for ${name}`);
    }

    entries.push({ name, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/* ------------------------------------------------------------------ expectations */

const REQUIRED_PATHS = [
  'package.json',
  'package-lock.json',
  'README.md',
  'index.html',
  'vite.config.ts',
  'eslint.config.js',
  'tsconfig.json',
  '.github/workflows/ci.yml',
  'docs/architecture.md',
  'docs/data-model.md',
  'docs/dependencies.md',
  'docs/legacy-audit.md',
  'docs/migration.md',
  'docs/security.md',
  'docs/ux-audit.md',
  'docs/qa-plan.md',
  'docs/release-checklist.md',
  'docs/decisions/0001-pwa-first.md',
  'src/main.tsx',
  'src/domain/dates.ts',
  'src/domain/deadlines.ts',
  'src/domain/query.ts',
  'src/db/schema.ts',
  'src/services/backup/envelope.ts',
  'src/services/import/legacy.ts',
  'scripts/create-review-package.mjs',
  'scripts/verify-review-package.mjs',
  'review/REVIEW_SUMMARY.md',
  'review/TREE.txt',
  'review/VERSIONS.txt',
  'review/VERIFY_LOG.txt',
  'review/TEST_RESULTS.md',
  'review/DEPENDENCIES.txt',
  'review/BUNDLE_SIZES.txt',
  'review/STATIC_SECURITY_SCAN.txt',
  'review/GIT_STATUS.txt',
  'review/LEGACY_SOURCE_METADATA.txt',
  'review/SHA256SUMS.txt',
];

const REQUIRED_PREFIXES = [
  { prefix: 'src/', label: 'application source' },
  { prefix: 'tests/', label: 'tests' },
  { prefix: 'dist/', label: 'production build' },
  { prefix: 'tests/fixtures/', label: 'sanitised fixtures' },
];

const FORBIDDEN_PATTERNS = [
  { pattern: /(^|\/)_private_reference\//, label: 'confidential legacy directory' },
  { pattern: /(^|\/)node_modules\//, label: 'node_modules' },
  { pattern: /(^|\/)\.git\//, label: 'Git object database' },
  { pattern: /(^|\/)\.env$/, label: '.env' },
  { pattern: /(^|\/)\.env\./, label: '.env.*' },
  { pattern: /\.zip$/, label: 'nested review ZIP' },
  { pattern: /(^|\/)playwright-report\//, label: 'Playwright HTML report' },
  { pattern: /(^|\/)test-results\//, label: 'Playwright test artefacts' },
  { pattern: /(^|\/)coverage\//, label: 'coverage output' },
  { pattern: /\.tsbuildinfo$/, label: 'TypeScript build info' },
];

/** Content that must not appear inside any packaged file. */
const FORBIDDEN_CONTENT = [
  {
    pattern: /\bimp_\d{3}\b/,
    label: 'legacy record id (imp_NNN)',
    allow: [/^docs\/legacy-audit\.md$/],
  },
  {
    pattern: /beacon\.cdn\.qq\.com/,
    label: 'Tencent Beacon host',
    /*
     * The check is "no live reference to a telemetry host in shippable code". Four places name
     * the host for the opposite reason — to record that it was removed, or to assert its absence:
     *   docs/            the legacy audit, security doc and dependency notes
     *   CHANGELOG.md     the "Removed" entry
     *   SECURITY.md      the privacy posture
     *   tests/           an E2E assertion, which must contain its own needle
     *   scripts/         this rule and the static scanner's rule list
     * A rule that flagged these would be pressure to delete the record of the removal.
     */
    allow: [
      /^docs\//,
      /^CHANGELOG\.md$/,
      /^SECURITY\.md$/,
      /^README\.md$/,
      /^tests\//,
      /^scripts\//,
      /^review\/STATIC_SECURITY_SCAN\.txt$/,
    ],
  },
];

const TEXT_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|txt|html|css|yml|yaml|webmanifest)$/;

/* ------------------------------------------------------------------ main */

function newestPackage() {
  if (!existsSync(OUT_DIR)) return null;
  const zips = readdirSync(OUT_DIR)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => ({ name, mtime: statSync(join(OUT_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return zips[0] ? join(OUT_DIR, zips[0].name) : null;
}

function main() {
  const argument = process.argv[2];
  const zipPath = argument
    ? existsSync(argument)
      ? argument
      : join(OUT_DIR, argument)
    : newestPackage();

  console.log('CivicWorkDesk — review package verification');
  console.log('');

  if (!zipPath || !existsSync(zipPath)) {
    console.log(`  FAIL  package exists — nothing found in ${OUT_DIR}`);
    process.exit(1);
  }
  console.log(`  target: ${zipPath}`);
  console.log('');

  const buffer = readFileSync(zipPath);
  check('package exists', true, `${String(buffer.length)} bytes`);

  // 1. checksum file
  const sumPath = `${zipPath}.sha256`;
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (!existsSync(sumPath)) {
    check('checksum file present', false, `${sumPath} is missing`);
  } else {
    const recorded = readFileSync(sumPath, 'utf8').trim();
    const [recordedDigest, recordedName] = recorded.split(/\s+/);
    check('checksum file present', true, basename(sumPath));
    check(
      'SHA-256 matches the archive',
      recordedDigest === digest,
      recordedDigest === digest ? digest : `recorded ${String(recordedDigest)} vs actual ${digest}`,
    );
    check(
      'checksum names this archive',
      recordedName === basename(zipPath),
      `${String(recordedName)}`,
    );
  }

  // 2. structure
  let entries;
  try {
    entries = readZip(buffer);
    check('archive parses; every CRC verified', true, `${String(entries.length)} entries`);
  } catch (error) {
    check('archive parses', false, error instanceof Error ? error.message : String(error));
    report();
    return;
  }

  const names = new Set(entries.map((entry) => entry.name));

  // 3. required files
  const missing = REQUIRED_PATHS.filter((path) => !names.has(path));
  check(
    'all expected files present',
    missing.length === 0,
    missing.length === 0
      ? `${String(REQUIRED_PATHS.length)} checked`
      : `missing: ${missing.join(', ')}`,
  );

  for (const { prefix, label } of REQUIRED_PREFIXES) {
    const count = [...names].filter((name) => name.startsWith(prefix)).length;
    check(`contains ${label} (${prefix})`, count > 0, `${String(count)} files`);
  }

  // 4. forbidden paths
  const offendingPaths = [];
  for (const name of names) {
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.pattern.test(name)) offendingPaths.push(`${name} (${rule.label})`);
    }
  }
  check(
    'no forbidden path present',
    offendingPaths.length === 0,
    offendingPaths.length === 0
      ? `${String(FORBIDDEN_PATTERNS.length)} rules`
      : offendingPaths.join('; '),
  );

  // 5. forbidden content
  const offendingContent = [];
  for (const entry of entries) {
    if (!TEXT_EXTENSIONS.test(entry.name)) continue;
    const text = entry.data.toString('utf8');
    for (const rule of FORBIDDEN_CONTENT) {
      if (rule.allow.some((allowed) => allowed.test(entry.name))) continue;
      if (rule.pattern.test(text)) offendingContent.push(`${entry.name} (${rule.label})`);
    }
  }
  check(
    'no forbidden content in any packaged file',
    offendingContent.length === 0,
    offendingContent.length === 0 ? 'scanned all text entries' : offendingContent.join('; '),
  );

  // 6. internal checksum manifest
  const sumsEntry = entries.find((entry) => entry.name === 'review/SHA256SUMS.txt');
  if (!sumsEntry) {
    check('SHA256SUMS.txt is consistent', false, 'manifest missing');
  } else {
    const recorded = new Map();
    for (const line of sumsEntry.data.toString('utf8').split('\n')) {
      const match = /^([0-9a-f]{64})\s{2}(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) recorded.set(match[2], match[1]);
    }
    const mismatched = [];
    for (const entry of entries) {
      if (entry.name === 'review/SHA256SUMS.txt') continue;
      const expected = recorded.get(entry.name);
      if (!expected) {
        mismatched.push(`${entry.name} (not listed)`);
        continue;
      }
      const actual = createHash('sha256').update(entry.data).digest('hex');
      if (actual !== expected) mismatched.push(`${entry.name} (digest differs)`);
    }
    check(
      'SHA256SUMS.txt matches every entry',
      mismatched.length === 0,
      mismatched.length === 0
        ? `${String(recorded.size)} digests verified`
        : mismatched.slice(0, 5).join('; '),
    );
  }

  // 7. verification log is real and self-consistent
  const logEntry = entries.find((entry) => entry.name === 'review/VERIFY_LOG.txt');
  if (!logEntry) {
    check('VERIFY_LOG.txt records a real run', false, 'missing');
  } else {
    const log = logEntry.data.toString('utf8');
    const hasSummary = log.includes('SUMMARY');
    const hasExitCodes = /exit code: \d+/.test(log);
    const failures = (log.match(/^FAIL\s+/gm) ?? []).length;
    const passes = (log.match(/^PASS\s+/gm) ?? []).length;
    const sections = (log.match(/^exit code: \d+$/gm) ?? []).length;
    check(
      'VERIFY_LOG.txt records a real run',
      hasSummary && hasExitCodes && passes > 0,
      `${String(passes)} PASS / ${String(failures)} FAIL lines, ${String(sections)} captured ` +
        `commands, ${String(log.length)} bytes`,
    );
    /*
     * `failures === 0` alone is not "every gate passed" — it is also true of a log with no gates in
     * it at all, which is exactly what `--no-gates` produces. A review package must contain a real
     * run, so require at least one PASS and one summary line per captured command.
     */
    check(
      'VERIFY_LOG.txt reports no failing gate',
      failures === 0 && passes > 0 && passes + failures === sections,
      failures > 0
        ? `${String(failures)} gate(s) failed — see the log`
        : passes === 0
          ? 'no gate was run (a --no-gates package is not a review package)'
          : passes + failures === sections
            ? `${String(passes)} gates passed, each with captured output`
            : `${String(passes + failures)} summary lines vs ${String(sections)} captured commands`,
    );
  }

  // 8. metadata consistency
  const summaryEntry = entries.find((entry) => entry.name === 'review/REVIEW_SUMMARY.md');
  if (summaryEntry) {
    const summary = summaryEntry.data.toString('utf8');
    check(
      'REVIEW_SUMMARY.md names this archive',
      summary.includes(basename(zipPath)),
      basename(zipPath),
    );

    /*
     * Read the claim back out of the document and compare it with the archive itself.
     *
     * Every Phase-1 package stated one fewer entry than it contained, and nothing noticed, because
     * the producer was the only thing that knew the number. This is the other direction: parse the
     * figure out of the shipped summary and measure the archive independently.
     *
     * A missing row is a failure, not a skip — otherwise renaming that row would silently retire
     * the check.
     */
    const claimed = /^\|\s*Entries\s*\|\s*(\d+)\s*\|$/m.exec(summary);
    if (!claimed?.[1]) {
      check(
        'REVIEW_SUMMARY.md states the entry count',
        false,
        'no "| Entries | N |" row found in the summary',
      );
    } else {
      const stated = Number(claimed[1]);
      check(
        'REVIEW_SUMMARY.md entry count matches the archive',
        stated === entries.length,
        stated === entries.length
          ? `${String(stated)} entries, agreed`
          : `summary says ${String(stated)}, archive holds ${String(entries.length)}`,
      );
    }
  }

  // 9. the file listing must account for every packaged payload path. TREE.txt is generated before
  // the review metadata exists, so it carries a placeholder line for those; what must hold is that
  // no payload path is missing from it.
  const treeEntry = entries.find((entry) => entry.name === 'review/TREE.txt');
  if (!treeEntry) {
    check('TREE.txt lists every packaged payload path', false, 'TREE.txt missing');
  } else {
    const listed = new Set(
      treeEntry.data
        .toString('utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const unlisted = [...names].filter((name) => !name.startsWith('review/') && !listed.has(name));
    check(
      'TREE.txt lists every packaged payload path',
      unlisted.length === 0,
      unlisted.length === 0
        ? `${String(listed.size)} paths listed`
        : `not listed: ${unlisted.slice(0, 5).join(', ')}`,
    );
  }

  const legacyEntry = entries.find((entry) => entry.name === 'review/LEGACY_SOURCE_METADATA.txt');
  if (legacyEntry) {
    const text = legacyEntry.data.toString('utf8');
    const hasHash = /SHA-256\s*:\s*[0-9a-f]{64}/.test(text);
    // It must carry the hash and NOT the document itself.
    const looksLikeContent = text.includes('<!DOCTYPE html>') || text.length > 4000;
    check(
      'LEGACY_SOURCE_METADATA.txt is metadata only',
      hasHash && !looksLikeContent,
      `${String(text.length)} bytes, hash present: ${hasHash ? 'yes' : 'no'}`,
    );
  }

  const pkgEntry = entries.find((entry) => entry.name === 'package.json');
  if (pkgEntry) {
    const pkg = JSON.parse(pkgEntry.data.toString('utf8'));
    const specifiers = [
      ...Object.values(pkg.dependencies ?? {}),
      ...Object.values(pkg.devDependencies ?? {}),
    ];
    const floating = specifiers.filter((value) => /[\^~*]|latest/.test(String(value)));
    check('every dependency is pinned exactly', floating.length === 0, floating.join(', '));
    check('package is marked private', pkg.private === true);
  }

  report();
}

function report() {
  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(`  ${String(checks.length - failed.length)}/${String(checks.length)} checks passed`);
  if (failed.length > 0) {
    console.log('');
    console.log('  FAILED:');
    for (const c of failed) console.log(`    - ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    process.exit(1);
  }
  console.log('  RESULT: PASS');
}

main();
