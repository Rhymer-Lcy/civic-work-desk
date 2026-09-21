#!/usr/bin/env node
/**
 * Build the review package for the phase named in `PHASE` below.
 *
 * Produces `_review_packages/civic-work-desk-<phase>-<YYYYMMDD>-<HHmmss>-<shortsha>.zip`
 * plus an adjacent `.sha256`.
 *
 * Design rules:
 *  - **Allow-list, never deny-list.** Only explicitly named roots are packaged. A deny-list is one
 *    forgotten entry away from shipping `_private_reference/` or a `.env`.
 *  - **Verification output is captured, not asserted.** `review/VERIFY_LOG.txt` holds the real
 *    stdout/stderr and exit code of each gate command, run by this script. A hand-written "all
 *    green" line would be worth nothing to a reviewer.
 *  - **The ZIP is written with Node's own deflate** (no archiver dependency, no shelling out to a
 *    zip binary that may not exist on the reviewer's machine).
 *
 * Usage:
 *   node scripts/create-review-package.mjs            # runs the gates, then packages
 *   node scripts/create-review-package.mjs --no-gates # packages using existing artefacts
 */

import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, '_review_packages');

/**
 * Which review phase this package documents.
 *
 * One constant feeding both the archive name and the summary heading, so a package cannot be named
 * after one phase while its summary claims another. Bump it deliberately when a phase closes; earlier
 * archives keep the label they were built with, which is what makes a directory of them readable.
 */
const PHASE = '1.3';
const PHASE_SLUG = `phase-${PHASE.replace(/\./g, '-')}`;

/* ------------------------------------------------------------------ packaging allow-list */

/** Directories packaged in full (minus `EXCLUDED_SEGMENTS`). */
const INCLUDE_DIRS = ['src', 'tests', 'docs', 'scripts', 'public', '.github', '.vscode', 'dist'];

/** Individual files packaged. Missing entries are skipped and reported. */
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.base.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'eslint.config.js',
  'index.html',
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.prettierrc.json',
  '.prettierignore',
  '_review_packages/.gitkeep',
];

/**
 * Path segments that are never packaged, whatever else matches.
 * This is a second line of defence behind the allow-list, not the primary control.
 */
const EXCLUDED_SEGMENTS = [
  'node_modules',
  '.git',
  '_private_reference',
  'coverage',
  'playwright-report',
  'test-results',
  'blob-report',
  '.playwright',
  'dev-dist',
];

/** Filenames never packaged. */
const EXCLUDED_NAMES = [/^\.env$/, /^\.env\..*/, /\.tsbuildinfo$/, /\.zip$/, /\.sha256$/];

function isExcluded(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => EXCLUDED_SEGMENTS.includes(part))) return true;
  const name = parts[parts.length - 1] ?? '';
  return EXCLUDED_NAMES.some((pattern) => pattern.test(name));
}

function collect(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full).replaceAll(sep, '/');
    if (isExcluded(rel)) continue;
    if (statSync(full).isDirectory()) collect(full, out);
    else out.push(rel);
  }
  return out;
}

/* ------------------------------------------------------------------ helpers */

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
      ...options,
    });
    return { ok: true, code: 0, output: stdout };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    return {
      ok: false,
      code: typeof error.status === 'number' ? error.status : 1,
      output: `${stdout}\n${stderr}`.trim() || String(error.message ?? error),
    };
  }
}

function gitInfo() {
  const sha = run('git', ['rev-parse', 'HEAD']);
  const short = run('git', ['rev-parse', '--short=12', 'HEAD']);
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = run('git', ['status', '--porcelain']);
  const describe = run('git', ['log', '-1', '--pretty=format:%H%n%an <%ae>%n%ad%n%s']);
  return {
    sha: sha.ok ? sha.output.trim() : 'unknown',
    short: short.ok ? short.output.trim() : 'nogit',
    branch: branch.ok ? branch.output.trim() : 'unknown',
    status: status.ok ? status.output : '(git status unavailable)',
    lastCommit: describe.ok ? describe.output : '(no commits)',
    clean: status.ok && status.output.trim() === '',
  };
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    iso: date.toISOString(),
  };
}

/* ------------------------------------------------------------------ minimal ZIP writer */

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

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

/**
 * Write a ZIP archive. Entries are stored deflated; ZIP64 is not needed at this scale and its
 * absence is asserted rather than assumed.
 */
function writeZip(target, entries, date) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    // Fall back to stored when deflate does not help; some tools dislike inflated "compression".
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    if (entry.data.length >= 0xffffffff) {
      throw new Error(`entry too large for a non-ZIP64 archive: ${entry.name}`);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    // Unix mode 0644 in the high 16 bits. `<<` is a signed 32-bit operation in JS and would
    // overflow to a negative number here, which `writeUInt32LE` rejects.
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const archive = Buffer.concat([...locals, centralBuffer, end]);
  writeFileSync(target, archive);
  return archive;
}

/* ------------------------------------------------------------------ review metadata */

function buildTree(paths) {
  const lines = [];
  const sorted = [...paths].sort();
  for (const path of sorted) lines.push(path);
  return lines.join('\n');
}

function bundleSizes() {
  const assets = join(ROOT, 'dist', 'assets');
  if (!existsSync(assets)) return 'dist/assets is missing — run `npm run build`.\n';
  const rows = readdirSync(assets)
    .filter((name) => !name.endsWith('.map'))
    .map((name) => {
      const size = statSync(join(assets, name)).size;
      const gzip = deflateRawSync(readFileSync(join(assets, name)), { level: 9 }).length;
      return { name, size, gzip };
    })
    .sort((a, b) => b.size - a.size);

  const total = rows.reduce((sum, row) => sum + row.size, 0);
  const lines = [
    'Built assets (dist/assets), source maps excluded.',
    'The "approx gzip" column is raw-deflate output, which tracks gzip closely but is not identical',
    "to what a server would emit; the build log in VERIFY_LOG.txt carries Vite's own gzip figures.",
    '',
    `${'file'.padEnd(46)}${'bytes'.padStart(12)}${'approx gzip'.padStart(14)}`,
    '-'.repeat(72),
  ];
  for (const row of rows) {
    lines.push(
      `${row.name.padEnd(46)}${String(row.size).padStart(12)}${String(row.gzip).padStart(14)}`,
    );
  }
  lines.push('-'.repeat(72));
  lines.push(`${'TOTAL'.padEnd(46)}${String(total).padStart(12)}`);
  return `${lines.join('\n')}\n`;
}

function legacyMetadata() {
  const file = join(ROOT, '_private_reference', 'work-record-console.original.html');
  const lines = [
    'Legacy source metadata — NON-SENSITIVE ONLY.',
    'The file itself is confidential (it embeds real names, phone numbers and work descriptions)',
    'and is excluded from Git, from builds and from this package. See _private_reference/README.md.',
    '',
  ];
  if (!existsSync(file)) {
    lines.push('Status        : not present on this machine');
    lines.push(
      'Expected SHA-256: 49833b63e541a79d63ac29ea6c3d34e6a25a92fd82d38f4c0840b0ab679d9cb4',
    );
    return `${lines.join('\n')}\n`;
  }
  const data = readFileSync(file);
  const text = data.toString('utf8');
  lines.push('Original filename : 工作记录台.html');
  lines.push('Stored as         : _private_reference/work-record-console.original.html');
  lines.push(`Size              : ${String(data.length)} bytes`);
  lines.push(`Lines             : ${String(text.split('\n').length - 1)}`);
  lines.push(`CR bytes          : ${String((text.match(/\r/g) ?? []).length)} (LF-only file)`);
  lines.push(
    `UTF-8 BOM         : ${data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf ? 'yes' : 'no'}`,
  );
  lines.push(`SHA-256           : ${sha256(data)}`);
  return `${lines.join('\n')}\n`;
}

function dependencyList() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lines = ['Exact pinned versions from package.json (no ranges are permitted).', ''];
  lines.push('runtime dependencies:');
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    lines.push(`  ${name.padEnd(36)} ${version}`);
  }
  lines.push('');
  lines.push('development dependencies:');
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    lines.push(`  ${name.padEnd(36)} ${version}`);
  }
  const floating = [
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
  ].filter(([, version]) => /[\^~*]|latest|x/.test(version));
  lines.push('');
  lines.push(
    floating.length === 0
      ? 'Range check: PASS — every specifier is an exact version.'
      : `Range check: FAIL — floating specifiers: ${floating.map(([n]) => n).join(', ')}`,
  );
  return `${lines.join('\n')}\n`;
}

function versionsText(git) {
  const node = run('node', ['--version']);
  const npm = run('npm', ['--version']);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return [
    `package            : ${pkg.name}@${pkg.version} (private: ${String(pkg.private)})`,
    `node (this machine): ${node.ok ? node.output.trim() : 'unknown'}`,
    `npm  (this machine): ${npm.ok ? npm.output.trim() : 'unknown'}`,
    `.node-version      : ${readFileSync(join(ROOT, '.node-version'), 'utf8').trim()}`,
    `react              : ${pkg.dependencies?.react ?? '-'}`,
    `react-dom          : ${pkg.dependencies?.['react-dom'] ?? '-'}`,
    `typescript         : ${pkg.devDependencies?.typescript ?? '-'}`,
    `vite               : ${pkg.devDependencies?.vite ?? '-'}`,
    `vitest             : ${pkg.devDependencies?.vitest ?? '-'}`,
    `playwright         : ${pkg.devDependencies?.['@playwright/test'] ?? '-'}`,
    `dexie              : ${pkg.dependencies?.dexie ?? '-'}`,
    `zod                : ${pkg.dependencies?.zod ?? '-'}`,
    `exceljs            : ${pkg.dependencies?.exceljs ?? '-'}`,
    `docx               : ${pkg.dependencies?.docx ?? '-'}`,
    '',
    `git branch         : ${git.branch}`,
    `git commit         : ${git.sha}`,
    `working tree clean : ${git.clean ? 'yes' : 'NO'}`,
    '',
    'Last commit:',
    git.lastCommit,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ gates */

const GATES = [
  { id: 'format', label: 'Prettier format check', command: 'npm', args: ['run', 'format:check'] },
  { id: 'lint', label: 'ESLint (max-warnings=0)', command: 'npm', args: ['run', 'lint'] },
  { id: 'typecheck', label: 'TypeScript typecheck', command: 'npm', args: ['run', 'typecheck'] },
  {
    // `--reporter=verbose` so the log carries one line per test. That is the evidence the per-file
    // and per-category counts in TEST_RESULTS.md are summed from; see `vitestFileCounts`.
    id: 'unit',
    label: 'Unit + integration tests',
    command: 'npm',
    args: ['run', 'test:unit', '--', '--reporter=verbose'],
  },
  { id: 'build', label: 'Production build', command: 'npm', args: ['run', 'build'] },
  { id: 'scan', label: 'Static security scan', command: 'npm', args: ['run', 'scan:static'] },
  { id: 'e2e', label: 'End-to-end tests', command: 'npm', args: ['run', 'test:e2e'] },
  {
    // Firefox + WebKit, critical flows only. Present so the cross-engine claim rests on captured
    // output rather than on prose. Needs `npm run test:e2e:install:cross` once per machine.
    id: 'cross',
    label: 'Cross-engine tests (FF/WebKit)',
    command: 'npm',
    args: ['run', 'test:e2e:cross'],
  },
  { id: 'a11y', label: 'Accessibility tests', command: 'npm', args: ['run', 'test:a11y'] },
  {
    id: 'audit',
    label: 'npm audit (runtime deps)',
    command: 'npm',
    args: ['audit', '--omit=dev', '--audit-level=high'],
  },
];

function runGates() {
  const results = [];
  for (const gate of GATES) {
    process.stdout.write(`  running ${gate.label} ... `);
    const started = Date.now();
    const result = run(gate.command, gate.args);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} (${seconds}s)\n`);
    results.push({ ...gate, ...result, seconds });
  }
  return results;
}

function verifyLog(results, startedAt) {
  const lines = [
    'CivicWorkDesk — verification log',
    '',
    'Captured stdout/stderr and exit codes of the commands this script actually executed.',
    'Nothing here is hand-written.',
    '',
    `started: ${startedAt}`,
    '',
    '='.repeat(78),
    'SUMMARY',
    '='.repeat(78),
  ];
  for (const result of results) {
    lines.push(
      `${result.ok ? 'PASS' : 'FAIL'}  ${result.label.padEnd(34)} exit=${String(result.code)}  ${result.seconds}s`,
    );
  }
  lines.push('');
  for (const result of results) {
    lines.push('='.repeat(78));
    lines.push(`${result.label}   ($ ${result.command} ${result.args.join(' ')})`);
    lines.push(`exit code: ${String(result.code)}`);
    lines.push('='.repeat(78));
    lines.push(result.output.trimEnd() || '(no output)');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Per-file test counts, counted from Vitest's own per-test lines.
 *
 * The `unit` gate runs with `--reporter=verbose`, which emits one line per test:
 * `✓ tests/unit/dates.test.ts > date arithmetic > handles a leap day 2ms`. Counting those gives the
 * per-file and per-category totals *from the run*, so no subtotal is maintained by hand in a
 * document. A hand-typed subtotal has no owner and goes stale the next time a file is added — which
 * is how the Phase-1 documentation came to state test counts no run had produced.
 *
 * Returns an empty array if the output carries no such lines, and the caller then reports
 * "not captured" rather than a confident zero.
 */
function vitestFileCounts(output) {
  const counts = new Map();
  const pattern = /^\s*[✓×]\s+(tests\/[^\s>]+\.test\.tsx?)\s*>/gm;
  let match;
  while ((match = pattern.exec(output)) !== null) {
    const file = match[1];
    if (file) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts].map(([file, count]) => ({ file, count }));
}

function testResults(results) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const extract = (id, pattern) => {
    const match = pattern.exec(byId[id]?.output ?? '');
    return match ? match[0] : 'not captured';
  };

  const files = vitestFileCounts(byId['unit']?.output ?? '');
  const subtotal = (prefix) =>
    files.filter((row) => row.file.startsWith(prefix)).reduce((sum, row) => sum + row.count, 0);
  const inCategory = (prefix) => files.filter((row) => row.file.startsWith(prefix)).length;
  const describe = (prefix) =>
    files.length === 0
      ? 'not captured'
      : `${String(subtotal(prefix))} tests in ${String(inCategory(prefix))} files`;
  const unitTotal = subtotal('tests/unit/');
  const integrationTotal = subtotal('tests/integration/');

  const lines = [
    '# Test results',
    '',
    'Every number here is parsed from the captured output in `VERIFY_LOG.txt`. Nothing is typed by',
    'hand, and the per-category subtotals are summed from the per-file counts of the same run — so a',
    'new test file changes these figures without anyone remembering to.',
    '',
    '| Suite | Command | Result |',
    '| --- | --- | --- |',
    `| Unit + integration (Vitest) | \`npm run test:unit\` | ${extract('unit', /Tests\s+\d+ passed[^\n]*/)} |`,
    `| Test files | \`npm run test:unit\` | ${extract('unit', /Test Files\s+\d+ passed[^\n]*/)} |`,
    `| — of which unit (\`tests/unit/\`) | | ${describe('tests/unit/')} |`,
    `| — of which integration (\`tests/integration/\`) | | ${describe('tests/integration/')} |`,
    `| E2E: Chromium desktop + mobile | \`npm run test:e2e\` | ${extract('e2e', /\d+ passed[^\n]*/)} |`,
    `| E2E: Firefox + WebKit, critical flows | \`npm run test:e2e:cross\` | ${extract('cross', /\d+ passed[^\n]*/)} |`,
    `| Accessibility (axe-core) | \`npm run test:a11y\` | ${extract('a11y', /\d+ passed[^\n]*/)} |`,
    '',
  ];

  if (files.length > 0) {
    lines.push('## Vitest, per file', '', '| File | Tests |', '| --- | --- |');
    for (const row of [...files].sort((a, b) => (a.file < b.file ? -1 : 1))) {
      lines.push(`| \`${row.file}\` | ${String(row.count)} |`);
    }
    lines.push(
      `| **total** | **${String(unitTotal + integrationTotal)}** |`,
      '',
      'WebKit here is Playwright WebKit on Windows, which is not Safari and not iOS. See',
      '`docs/qa-plan.md` for what that does and does not establish.',
      '',
    );
  }

  lines.push(
    '## Gate status',
    '',
    '| Gate | Exit code | Status |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.label} | ${String(r.code)} | ${r.ok ? 'PASS' : 'FAIL'} |`),
    '',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ main */

function main() {
  const skipGates = process.argv.includes('--no-gates');
  const now = new Date();
  const startedAt = now.toISOString();
  const marks = stamp(now);

  mkdirSync(OUT_DIR, { recursive: true });

  console.log('CivicWorkDesk — review package');
  console.log('');

  let results = [];
  if (skipGates) {
    console.log('  gates skipped (--no-gates); VERIFY_LOG.txt will say so');
  } else {
    console.log('running quality gates:');
    results = runGates();
    console.log('');
  }

  const git = gitInfo();
  const zipName = `civic-work-desk-${PHASE_SLUG}-${marks.date}-${marks.time}-${git.short}.zip`;
  const zipPath = join(OUT_DIR, zipName);

  // Gather payload.
  const paths = [];
  for (const dir of INCLUDE_DIRS) collect(join(ROOT, dir), paths);
  for (const file of INCLUDE_FILES) {
    const full = join(ROOT, file);
    if (existsSync(full)) paths.push(file);
    else console.log(`  note: ${file} not found, skipped`);
  }

  const entries = paths.map((path) => ({
    name: path,
    data: readFileSync(join(ROOT, path)),
  }));

  // Review metadata.
  const gatesSummary = skipGates
    ? 'Gates were SKIPPED for this package (--no-gates).\n'
    : verifyLog(results, startedAt);

  const review = {
    'review/TREE.txt': `${buildTree([...paths, 'review/(metadata files)'])}\n`,
    'review/VERSIONS.txt': versionsText(git),
    'review/VERIFY_LOG.txt': gatesSummary,
    'review/TEST_RESULTS.md': skipGates
      ? '# Test results\n\nGates skipped.\n'
      : testResults(results),
    'review/DEPENDENCIES.txt': dependencyList(),
    'review/BUNDLE_SIZES.txt': bundleSizes(),
    'review/STATIC_SECURITY_SCAN.txt': run('node', ['scripts/static-security-scan.mjs']).output,
    'review/GIT_STATUS.txt': [
      `branch: ${git.branch}`,
      `commit: ${git.sha}`,
      `clean : ${git.clean ? 'yes' : 'NO — uncommitted changes below'}`,
      '',
      '$ git status --porcelain',
      git.status.trimEnd() || '(clean)',
      '',
    ].join('\n'),
    'review/LEGACY_SOURCE_METADATA.txt': legacyMetadata(),
    /*
     * Audit evidence, packaged rather than merely asserted.
     *
     * Phase 1.2's final report cited supplementary verification whose probe and output were not in the
     * package, so none of it could be re-run or inspected by a reviewer. This copies the tracked
     * evidence document into `review/`; the probes it refers to are under `scripts/audit/`.
     */
    'review/AUDIT_REGRESSION_RESULTS.md': readFileSync(
      join(ROOT, 'docs', 'audit-regression-results.md'),
      'utf8',
    ),
  };

  for (const [name, text] of Object.entries(review)) {
    entries.push({ name, data: Buffer.from(text, 'utf8') });
  }

  /*
   * The entry count printed in REVIEW_SUMMARY.md is a prediction, and Phase 1 got it wrong.
   *
   * The summary has to be written *before* SHA256SUMS.txt, because the manifest must cover it — so
   * at the moment the summary is built, two entries are still missing: itself and the manifest.
   * Phase 1 compensated with `entries.length + 1`, one short, so every package shipped claiming one
   * fewer entry than it contained. Nothing failed, because nothing compared the two numbers.
   *
   * Two changes here, and the second is the one that matters: the arithmetic is named and
   * explained, and it is then checked against reality below. `verify-review-package.mjs` also reads
   * the number back out of the shipped summary and compares it with the archive's own central
   * directory, closing the claim from the other side.
   */
  const TRAILING_ENTRIES = ['review/REVIEW_SUMMARY.md', 'review/SHA256SUMS.txt'];
  const predictedEntryCount = entries.length + TRAILING_ENTRIES.length;

  const summary = buildSummary({
    git,
    marks,
    results,
    skipGates,
    entryCount: predictedEntryCount,
    zipName,
  });
  entries.push({ name: 'review/REVIEW_SUMMARY.md', data: Buffer.from(summary, 'utf8') });

  // SHA256SUMS over every entry, added last so it covers everything before it.
  const sums = entries
    .map((entry) => `${sha256(entry.data)}  ${entry.name}`)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1))
    .join('\n');
  entries.push({
    name: 'review/SHA256SUMS.txt',
    data: Buffer.from(`${sums}\n`, 'utf8'),
  });

  if (entries.length !== predictedEntryCount) {
    throw new Error(
      `entry-count prediction is wrong: REVIEW_SUMMARY.md says ${String(predictedEntryCount)}, ` +
        `the archive holds ${String(entries.length)}. Update TRAILING_ENTRIES.`,
    );
  }
  for (const name of TRAILING_ENTRIES) {
    if (!entries.some((entry) => entry.name === name)) {
      throw new Error(`TRAILING_ENTRIES names ${name}, which was never added to the archive`);
    }
  }

  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const archive = writeZip(zipPath, entries, now);

  const digest = sha256(archive);
  const sumPath = `${zipPath}.sha256`;
  writeFileSync(sumPath, `${digest}  ${zipName}\n`, 'utf8');

  const failed = results.filter((r) => !r.ok);
  console.log(`  entries : ${String(entries.length)}`);
  console.log(`  size    : ${String(archive.length)} bytes`);
  console.log(`  zip     : ${zipPath}`);
  console.log(`  sha256  : ${sumPath}`);
  console.log(`  digest  : ${digest}`);
  console.log('');
  if (failed.length > 0) {
    console.log(
      `WARNING: ${String(failed.length)} gate(s) FAILED: ${failed.map((f) => f.id).join(', ')}`,
    );
    console.log(
      'The package was still produced so the failure is reviewable, and VERIFY_LOG.txt records it.',
    );
    process.exitCode = 1;
  } else if (!skipGates) {
    console.log('All gates passed.');
  }
}

/*
 * Actual test totals for the summary, parsed from the same captured output that produced
 * TEST_RESULTS.md. Kept here rather than hand-written because a summary that states a count is the
 * one place a stale number survives: the gate table only ever says PASS.
 */
function totalsRows(results) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const grab = (id, pattern) => {
    const match = pattern.exec(byId[id]?.output ?? '');
    return match ? match[0].replace(/\s+/g, ' ').trim() : 'not captured';
  };
  const files = vitestFileCounts(byId['unit']?.output ?? '');
  const subtotal = (prefix) =>
    files.filter((row) => row.file.startsWith(prefix)).reduce((sum, row) => sum + row.count, 0);
  const inCategory = (prefix) => files.filter((row) => row.file.startsWith(prefix)).length;
  const split =
    files.length === 0
      ? 'not captured'
      : `${String(subtotal('tests/unit/'))} unit in ${String(inCategory('tests/unit/'))} files, ` +
        `${String(subtotal('tests/integration/'))} integration in ` +
        `${String(inCategory('tests/integration/'))} files`;
  const skipped = /\d+ skipped/.exec(byId['cross']?.output ?? '');
  return [
    `| Vitest unit + integration | ${grab('unit', /Tests\s+\d+ passed[^\n]*/)} |`,
    `| — split | ${split} |`,
    `| Playwright, Chromium desktop + mobile | ${grab('e2e', /\d+ passed[^\n]*/)} |`,
    `| Playwright, Firefox + WebKit | ${grab('cross', /\d+ passed[^\n]*/)}${skipped ? `, ${skipped[0]}` : ''} |`,
    `| Playwright, accessibility (axe-core) | ${grab('a11y', /\d+ passed[^\n]*/)} |`,
  ];
}

function buildSummary({ git, marks, results, skipGates, entryCount, zipName }) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const gateRows = skipGates
    ? ['| (gates skipped) | — | — |']
    : results.map(
        (r) => `| ${r.label} | \`${r.command} ${r.args.join(' ')}\` | ${r.ok ? 'PASS' : 'FAIL'} |`,
      );
  const countRows = skipGates ? ['| (gates skipped) | — |'] : totalsRows(results);

  return `# CivicWorkDesk — Phase ${PHASE} review package

| | |
| --- | --- |
| Package | \`${zipName}\` |
| Built | ${marks.date} ${marks.time} (local time) |
| Commit | \`${git.sha}\` on \`${git.branch}\` |
| Working tree | ${git.clean ? 'clean' : '**not clean** — see GIT_STATUS.txt'} |
| Entries | ${String(entryCount)} |

## What this is

A local-first, installable PWA for keeping public-sector work records and an honour/award archive.
It replaces a single 3,590-line HTML file that used \`localStorage\` as its database, embedded ~180
real personal records in source, and loaded third-party analytics while describing itself as
offline. \`docs/legacy-audit.md\` documents that prototype finding by finding, with line numbers.

## What changed in Phase 1.3

Live-state integrity closure: the application's live database, its merges, its backups and its restores
now agree on one definition of a valid state. No new product features, no architectural change, no new
runtime dependency, and **no backup format change** — v3 is unchanged and existing v3 archives remain
restorable.

### The defect this pass exists to close

A normal workflow — link an honour to a work record, then permanently delete that work record from the
Trash — left Phase 1.2 holding a state where every row was individually schema-valid, a canonical
backup of it was labelled **complete** and recorded as successful, and restoring that same file was
**refused** for a dangling \`relatedWorkId\`. The application produced an archive it would not accept.
\`review/AUDIT_REGRESSION_RESULTS.md\` carries the probe, the reproduction steps and the captured
failure output from commit \`48480cf47fc6b9a6f5974de808e39f1576286a46\`.

### Final live relational invariants

Enforced on every mutation path, by the same rules a canonical restore applies
(\`src/domain/integrity.ts\`, one definition shared by restore validation, live diagnostics, backup
viability and the merge planner):

- every progress entry points to an existing record;
- every non-null work \`categoryId\` points to an existing category;
- every non-null work \`groupId\` points to an existing group;
- every non-null honour \`relatedWorkId\` points to an existing **work** record;
- record, progress, category and group ids are unique.

A **soft-deleted** record still satisfies a reference: the row exists and is carried in backups. Only
permanent deletion breaks a link.

### Hard-delete reference policy

Permanently deleting a work record **preserves any honour that references it and detaches the link**,
in one transaction that bumps the revision exactly once. Deleting the honour would destroy unrelated
user data; blocking the purge would leave the user unable to empty their own Trash. The detach is
never silent: the Trash confirmation states how many honours will be unlinked before the user commits,
and the toast states how many were.

### Canonical-backup viability rules

Before a backup may be labelled complete and recorded, the snapshot must satisfy schema validity, row
completeness, **relational integrity** and uniqueness. If the live store is relationally broken the
export is refused outright — not written and labelled incomplete, because an "incomplete" envelope
requires an omission list and relational damage produces none. The diagnostic recovery export remains
available and now carries the structured issues.

### Merge: projected final state

A reference is judged against \`finalState = destination + acceptedChanges\`, never against the file
alone. Consequences: a new progress entry for a record the **destination already holds** merges (Phase
1.2 skipped it); and an incoming row whose category, group or related-work reference would not resolve
after the write is refused with the reason stated — never written, never rewritten to null, never
resolved by inventing taxonomy. Id collisions remain non-overwriting and duplicates never collapse.

### Backup-health rule

Health describes whether the latest **complete** canonical backup captured the current
\`dataRevision\`. The count of live records is no longer an input: Phase 1.2 short-circuited to
\`fresh\` whenever it was zero, which is also true of a database whose every record is in the Trash, or
which has custom taxonomy, edited settings, or was emptied after holding data. Only a genuinely
pristine store (\`dataRevision === 0\`, never backed up) avoids nagging.

### v3 semantic consistency

A v3 envelope may not contradict itself: \`completeness: "complete"\` requires an empty omission list
and \`"incomplete"\` requires a non-empty one. Such a file is refused even when its shape, counts and
whole-envelope digest are all valid — a checksum proves the bytes were not altered, not that the
statements inside them agree. \`unknown-legacy\` (v1) is exempt, because that format had no omission
list at all.

### Phase-1.3 regression evidence

All twenty mandated regressions live in \`tests/integration/\`: \`live-integrity.test.ts\` (16),
\`merge-semantics.test.ts\` (13), \`backup-health-scope.test.ts\` (15) and \`v3-compatibility.test.ts\`
(5). \`review/AUDIT_REGRESSION_RESULTS.md\` maps each numbered requirement to its test, and carries
the reproduction steps plus the captured failure output for the two claims made about the previous
commit. Both probes are packaged and runnable rather than merely asserted:

- \`scripts/audit/phase-1-2-live-integrity-probe.test.ts\` — written against the Phase-1.2 API, so it
  runs unchanged at \`48480cf47fc6b9a6f5974de808e39f1576286a46\`, where it fails 3 of 3.
- \`scripts/audit/generate-phase-1-2-fixture.test.ts\` — the generator that produced
  \`tests/fixtures/phase-1-2-canonical-v3.json\` on that same commit, so the compatibility test
  restores an archive written by the previous version rather than by this one.

### Browser matrix

Chromium desktop + mobile (full suite), Firefox and WebKit (focused critical flows, including the new
linked-honour purge workflow end to end). WebKit's offline **reload** case is skipped with its reason
recorded in the test; the offline **write** path runs on every engine. Playwright's WebKit is not
Safari, and no real Safari or iOS device was used.

### Remaining limitations

- Safari and iOS on real hardware remain untested.
- Multi-tab coherence is unverified; last-write-wins between tabs is not exercised.
- No performance characterisation at 5,000+ records.
- The accepted moderate advisory (\`exceljs\` → \`uuid\`) is unchanged and documented in
  \`docs/security.md\`.
- \`docs/review-package-provenance.md\` records the history of the archives in
  \`_review_packages/\`, including the original Phase-1 archive restored by the user and verified
  byte-identical during this pass.

## Verification

| Gate | Command | Result |
| --- | --- | --- |
${gateRows.join('\n')}

Actual totals from that same run, parsed from its output rather than typed:

| Suite | Result |
| --- | --- |
${countRows.join('\n')}

The skipped cross-engine case is WebKit's offline **reload**, whose reason is recorded in the test
itself. Per-file counts are in \`review/TEST_RESULTS.md\`.

Raw output and exit codes: \`review/VERIFY_LOG.txt\`. Nothing in that file is hand-written.

## Where to start

| Question | File |
| --- | --- |
| What was wrong with the old one? | \`docs/legacy-audit.md\` |
| Why a PWA and not Electron/Tauri? | \`docs/decisions/0001-pwa-first.md\` |
| How is it put together? | \`docs/architecture.md\` |
| What does the data look like? | \`docs/data-model.md\` |
| How does legacy data get in? | \`docs/migration.md\` |
| What is the threat model? | \`docs/security.md\` |
| What changed in the UI and why? | \`docs/ux-audit.md\` |
| What was tested, and what was not? | \`docs/qa-plan.md\` |
| Why each dependency? | \`docs/dependencies.md\` |

The most load-bearing code is \`src/domain/\` — it is pure, has no I/O, and holds the single
implementation of every rule (dates, status, deadlines, filtering, reporting) that the legacy
prototype had scattered and inconsistent.

## Confidentiality

This package contains **no** user data. \`_private_reference/\` is excluded by the packaging
allow-list and \`scripts/verify-review-package.mjs\` fails if any path under it appears.
\`review/LEGACY_SOURCE_METADATA.txt\` carries only filename, size, line count and SHA-256.

## Runtime versions

Node ${readFileSync(join(ROOT, '.node-version'), 'utf8').trim()} · React ${pkg.dependencies?.react ?? '?'} ·
TypeScript ${pkg.devDependencies?.typescript ?? '?'} · Vite ${pkg.devDependencies?.vite ?? '?'}.
Full list in \`review/VERSIONS.txt\` and \`review/DEPENDENCIES.txt\`.

## Reproducing

\`\`\`bash
npm ci
npm run verify      # format, lint, typecheck, unit+integration, static scan, build
npm run test:e2e    # Playwright (builds and serves dist)
npm run test:a11y   # axe-core over rendered states
\`\`\`

## Phase-1 scope

No cloud sync, no accounts, no collaboration, no native wrapper, no encryption layer, no telemetry.
Open items are listed honestly at the end of \`docs/qa-plan.md\`.
`;
}

main();
