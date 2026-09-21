#!/usr/bin/env node
/**
 * Build the Phase-1 review package.
 *
 * Produces `_review_packages/civic-work-desk-phase-1-<YYYYMMDD>-<HHmmss>-<shortsha>.zip`
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
  { id: 'unit', label: 'Unit + integration tests', command: 'npm', args: ['run', 'test:unit'] },
  { id: 'build', label: 'Production build', command: 'npm', args: ['run', 'build'] },
  { id: 'scan', label: 'Static security scan', command: 'npm', args: ['run', 'scan:static'] },
  { id: 'e2e', label: 'End-to-end tests', command: 'npm', args: ['run', 'test:e2e'] },
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

function testResults(results) {
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  const extract = (id, pattern) => {
    const match = pattern.exec(byId[id]?.output ?? '');
    return match ? match[0] : 'not captured';
  };
  return [
    '# Test results',
    '',
    'Counts parsed from the captured output in `VERIFY_LOG.txt`.',
    '',
    '| Suite | Command | Result |',
    '| --- | --- | --- |',
    `| Unit + integration (Vitest) | \`npm run test:unit\` | ${extract('unit', /Tests\s+\d+ passed[^\n]*/)} |`,
    `| Test files | \`npm run test:unit\` | ${extract('unit', /Test Files\s+\d+ passed[^\n]*/)} |`,
    `| E2E + responsive + privacy (Playwright) | \`npm run test:e2e\` | ${extract('e2e', /\d+ passed[^\n]*/)} |`,
    `| Accessibility (axe-core) | \`npm run test:a11y\` | ${extract('a11y', /\d+ passed[^\n]*/)} |`,
    '',
    '## Gate status',
    '',
    '| Gate | Exit code | Status |',
    '| --- | --- | --- |',
    ...results.map((r) => `| ${r.label} | ${String(r.code)} | ${r.ok ? 'PASS' : 'FAIL'} |`),
    '',
  ].join('\n');
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
  const zipName = `civic-work-desk-phase-1-${marks.date}-${marks.time}-${git.short}.zip`;
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
  };

  for (const [name, text] of Object.entries(review)) {
    entries.push({ name, data: Buffer.from(text, 'utf8') });
  }

  const summary = buildSummary({ git, marks, results, skipGates, entries, zipName });
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

function buildSummary({ git, marks, results, skipGates, entries, zipName }) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const gateRows = skipGates
    ? ['| (gates skipped) | — | — |']
    : results.map(
        (r) => `| ${r.label} | \`${r.command} ${r.args.join(' ')}\` | ${r.ok ? 'PASS' : 'FAIL'} |`,
      );

  return `# CivicWorkDesk — Phase 1 review package

| | |
| --- | --- |
| Package | \`${zipName}\` |
| Built | ${marks.date} ${marks.time} (local time) |
| Commit | \`${git.sha}\` on \`${git.branch}\` |
| Working tree | ${git.clean ? 'clean' : '**not clean** — see GIT_STATUS.txt'} |
| Entries | ${String(entries.length + 1)} |

## What this is

A local-first, installable PWA for keeping public-sector work records and an honour/award archive.
It replaces a single 3,590-line HTML file that used \`localStorage\` as its database, embedded ~180
real personal records in source, and loaded third-party analytics while describing itself as
offline. \`docs/legacy-audit.md\` documents that prototype finding by finding, with line numbers.

## Verification

| Gate | Command | Result |
| --- | --- | --- |
${gateRows.join('\n')}

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
