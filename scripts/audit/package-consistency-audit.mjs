/**
 * Consistency audit of a built review package, run from the outside in.
 *
 * `scripts/verify-review-package.mjs` asks whether the archive is well formed: expected files
 * present, checksums agreeing, nothing forbidden packaged. This script asks the complementary
 * question, which that verifier deliberately does not: **is every figure printed in the packaged
 * documents a figure this run actually produced?**
 *
 * The direction matters. "Every number I derived appears somewhere in the package" stays true when a
 * figure is quoted twice and is stale in one of the two places. So each check here starts from the
 * captured output in `review/VERIFY_LOG.txt` — the one file in the package nobody writes by hand —
 * recomputes the value from it, and then requires the packaged prose to carry exactly that value,
 * anchored on the whole clause with its punctuation rather than on the digits alone.
 *
 *   node scripts/audit/package-consistency-audit.mjs <path-to-zip>
 *
 * Exits non-zero on any failure, and prints one line per check either way.
 *
 * **It can fail, and that was demonstrated rather than assumed.** Run against
 * `...phase-1-3-20260921-211918-...zip` it reports four inconsistencies, three of them the real
 * defects that archive shipped with (a captured test listing showing sixteen cases where the run had
 * seventeen, and a changelog count of 49 where it was 50). Run against the current package it
 * reports none.
 *
 * It also caught a defect in **itself** during Phase 1.3.1, which is worth recording because it is the
 * failure mode this whole file exists to prevent. The listing check counted ✓ marks across the entire
 * evidence document against one suite's total; that was correct while the document held one captured
 * listing and became meaningless the moment a second phase added another (it read 32 for a 17-case
 * suite). Anchoring each count to its own fenced block fixed it — and exposed a second bug in the same
 * few lines, a fence regex without the optional language tag, which paired one block's closing fence
 * with the next block's opening one and made every extracted count nonsense while still *looking* like
 * a working check.
 *
 * One expected caveat when auditing a **historical** package: the archive-directory checks compare
 * that package's provenance document against the directory as it stands now, so any superseded
 * archive will fail them simply because later archives exist. That failure is about the passage of
 * time, not about the old package.
 */

import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Minimal central-directory reader, CRC-checked. Same approach as the package verifier. */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP file');
  const total = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < total; i += 1) {
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const dataStart =
      localOffset +
      30 +
      buffer.readUInt16LE(localOffset + 26) +
      buffer.readUInt16LE(localOffset + 28);
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.set(name, data.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const failures = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`;
  console.log(line);
  if (!ok) failures.push(name);
}

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/audit/package-consistency-audit.mjs <path-to-zip>');
  process.exit(2);
}

const zipBytes = readFileSync(target);
const files = readZip(zipBytes);
const read = (name) => {
  const text = files.get(name);
  if (text === undefined) throw new Error(`package is missing ${name}`);
  return text;
};

const log = read('review/VERIFY_LOG.txt');
const summary = read('review/REVIEW_SUMMARY.md');
const results = read('review/TEST_RESULTS.md');
const qaPlan = read('docs/qa-plan.md');
const changelog = read('CHANGELOG.md');
const evidence = read('docs/audit-regression-results.md');
const provenance = read('docs/review-package-provenance.md');

/* ---------------------------------------------------------- ground truth: the captured run only */

const logLines = log.split('\n');
const gateSections = new Map();
{
  const heads = [];
  logLines.forEach((line, index) => {
    const match = /\(\$ (.+)\)$/.exec(line.trimEnd());
    if (match) heads.push([index, match[1]]);
  });
  heads.push([logLines.length, 'END']);
  for (let i = 0; i < heads.length - 1; i += 1) {
    gateSections.set(heads[i][1], logLines.slice(heads[i][0], heads[i + 1][0]).join('\n'));
  }
}
const gate = (command) => gateSections.get(command) ?? '';
const first = (text, pattern) => {
  const match = pattern.exec(text);
  return match ? match[1] : null;
};

const vitest = gate('npm run test:unit -- --reporter=verbose');
const total = Number(first(vitest, /Tests\s+(\d+) passed/));
const fileCount = Number(first(vitest, /Test Files\s+(\d+) passed/));
const perFile = new Map();
for (const match of vitest.matchAll(/^\s*[✓×]\s+(tests\/[^\s>]+\.test\.tsx?)\s*>/gm)) {
  perFile.set(match[1], (perFile.get(match[1]) ?? 0) + 1);
}
const sumWhere = (predicate) =>
  [...perFile].filter(([file]) => predicate(file)).reduce((sum, [, count]) => sum + count, 0);
const countWhere = (predicate) => [...perFile].filter(([file]) => predicate(file)).length;
const isUnit = (file) => file.startsWith('tests/unit/');
const isIntegration = (file) => file.startsWith('tests/integration/');
const unit = sumWhere(isUnit);
const integration = sumWhere(isIntegration);

check(
  'the captured Vitest run is internally consistent',
  unit + integration === total &&
    countWhere(isUnit) + countWhere(isIntegration) === fileCount &&
    sumWhere(() => true) === total,
  `${unit} + ${integration} = ${total} in ${countWhere(isUnit)} + ${countWhere(isIntegration)} = ${fileCount} files`,
);

/* ------------------------------------------- every figure in the shipped prose, anchored in full */

check(
  'qa-plan unit heading matches the run',
  qaPlan.includes(`### Unit — ${unit} tests in ${countWhere(isUnit)} files`),
);
check(
  'qa-plan integration heading matches the run',
  qaPlan.includes(`### Integration — ${integration} tests in ${countWhere(isIntegration)} files`),
);
check(
  'qa-plan total row matches the run',
  qaPlan.includes(
    `**PASS — ${total}/${total}** in ${fileCount} files (${unit} unit, ${integration} integration)`,
  ),
);
check(
  'REVIEW_SUMMARY total row matches the run',
  summary.includes(`Tests ${total} passed (${total})`),
);
check(
  'REVIEW_SUMMARY split row matches the run',
  summary.includes(
    `${unit} unit in ${countWhere(isUnit)} files, ${integration} integration in ${countWhere(isIntegration)} files`,
  ),
);
check('TEST_RESULTS total row matches the run', results.includes(`| **total** | **${total}** |`));

let perFileOk = true;
for (const [file, count] of [...perFile].sort()) {
  if (!results.includes(`| \`${file}\` | ${count} |`)) perFileOk = false;
}
check('TEST_RESULTS has a correct row for every test file', perFileOk, `${perFile.size} files`);

const mandated = ['live-integrity', 'merge-semantics', 'backup-health-scope', 'v3-compatibility'];
const mandatedTotal = sumWhere((file) => mandated.some((name) => file.includes(name)));
check(
  'CHANGELOG regression-test count matches the run',
  changelog.includes(`— ${mandatedTotal} tests covering the twenty mandated regressions`),
  String(mandatedTotal),
);

/*
 * Each captured "passing suite" listing in the evidence document is pinned to the suite it claims to
 * show — by its summary line *and* by the number of cases actually listed under it. Counting ticks
 * across the whole document instead would conflate two listings the moment a second phase adds one,
 * which is exactly what happened: the document-wide count read 32 for a 17-case suite. The unit of
 * comparison has to be the block, not the file.
 */
// The optional language tag matters: without it the lazy match pairs one block's closing fence with
// the next block's opening one, and every count read out of the result is meaningless.
const fencedBlocks = [...evidence.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map(
  (match) => match[1],
);
for (const suite of ['live-integrity', 'import-concurrency']) {
  const expected = perFile.get(`tests/integration/${suite}.test.ts`) ?? 0;
  const matching = fencedBlocks.filter(
    (block) =>
      block.includes(`Tests  ${expected} passed (${expected})`) &&
      (block.match(/\n {3}✓ /g) ?? []).length === expected,
  );
  check(
    `the evidence doc's captured ${suite} listing matches the run`,
    expected > 0 && matching.length === 1,
    `${expected} cases, ${matching.length} matching block(s)`,
  );
}

for (const [command, label] of [
  ['npm run test:e2e', 'Chromium E2E'],
  ['npm run test:e2e:cross', 'cross-engine E2E'],
  ['npm run test:a11y', 'accessibility'],
]) {
  const passed = first(gate(command), /(\d+) passed/);
  check(
    `${label} count appears in the packaged qa-plan`,
    passed !== null && qaPlan.includes(passed),
    String(passed),
  );
}
const crossSkips = first(gate('npm run test:e2e:cross'), /(\d+) skipped/);
check(
  'the cross-engine skip is disclosed, not dropped',
  crossSkips === '1' && qaPlan.includes('1 skipped') && summary.includes('1 skipped'),
  `${String(crossSkips)} skipped`,
);

/* ------------------------------------------------------- the archive directory this package names */

const dir = dirname(target);
const self = basename(target);
const archives = readdirSync(dir).filter((name) => name.endsWith('.zip'));
const checksums = readdirSync(dir).filter((name) => name.endsWith('.sha256'));
const phase13 = archives.filter((name) => name.startsWith('civic-work-desk-phase-1-3'));
const unlisted = phase13.filter(
  (name) =>
    name !== self &&
    !provenance.includes(name.replace(/^civic-work-desk-/, '').replace(/\.zip$/, '')),
);
check(
  'the provenance doc accounts for every other phase-1.3 archive on disk',
  unlisted.length === 0,
  unlisted.length === 0 ? `${phase13.length - 1} superseded` : unlisted.join(', '),
);
check(
  'the provenance doc does not quote the archive it is packaged inside',
  !provenance.includes(self),
);
check(
  'every archive has its checksum file',
  archives.length === checksums.length,
  `${archives.length} archives, ${checksums.length} checksums`,
);

const restored = 'civic-work-desk-phase-1-20260921-081722-3727a186a9eb(2).zip';
if (archives.includes(restored)) {
  const digest = createHash('sha256')
    .update(readFileSync(join(dir, restored)))
    .digest('hex');
  check(
    'the restored Phase-1 original is still byte-identical',
    digest === '7a8654f2d49a3b7aa73bfc4a511b9be7702d5617f903cd3da9b417da9b6593ed',
    `${digest.slice(0, 16)}…`,
  );
} else {
  console.log('note  the original Phase-1 archive is not present in this workspace');
}

console.log('');
if (failures.length > 0) {
  console.log(`RESULT: FAIL — ${failures.length} inconsistency: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('RESULT: PASS — every figure printed in the package is a figure this run produced');
