#!/usr/bin/env node
/**
 * Verify the FINAL end-user release archive by reading its bytes.
 *
 *   node scripts/uos/archive-tests.mjs [archive.tar.gz]
 *
 * Defaults to the newest civic-work-desk-uos20-loongarch64-*.tar.gz under release/.
 *
 * ## Why parse the tar instead of shelling out to `tar -t`
 *
 * Because the properties under test are properties of the bytes that will be copied to the target:
 * the ownership metadata actually recorded in each header, the mode bits, the exact member list, and
 * whether the inner manifest describes the file contents that are really in the archive. `tar -tv`
 * would answer the first two through another program's formatting; the last one it cannot answer at
 * all. So the archive is inflated and the headers are read here.
 *
 * The check that matters most is the last: every `app/` member is compared byte-for-byte (by digest)
 * against `dist/`, from inside the archive. That is what makes "Phase 3 ships the Phase-2 build
 * unchanged" a measured claim about the delivered artifact rather than a statement about a staging
 * directory that was correct at some earlier moment.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanKindFor, wrongOriginHits } from './origin-scan.mjs';

const ROOT = process.cwd();
const RELEASE_DIR = join(ROOT, 'release');
const CANONICAL = 'http://127.0.0.1:8765';

let pass = 0;
let fail = 0;
const problems = [];

function ok(label) {
  pass += 1;
  console.log(`  ok   ${label}`);
}
function nok(label, detail) {
  fail += 1;
  problems.push(label);
  console.log(`  FAIL ${label}`);
  if (detail) console.log(`       ${detail}`);
}
function assert(condition, label, detail) {
  if (condition) ok(label);
  else nok(label, detail);
}
function group(name) {
  console.log(`\n--- ${name}`);
}

/* ---------------------------------------------------------------- locate the archive */

function newestArchive() {
  const candidates = readdirSync(RELEASE_DIR)
    .filter((n) => /^civic-work-desk-uos20-loongarch64-.*\.tar\.gz$/.test(n))
    .map((n) => ({ name: n, mtime: statSync(join(RELEASE_DIR, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length > 0 ? join(RELEASE_DIR, candidates[0].name) : null;
}

const archivePath = process.argv[2] ? resolve(process.argv[2]) : newestArchive();
if (!archivePath || !existsSync(archivePath)) {
  console.error('error: no end-user release archive found under release/.');
  console.error('Build one first: sh scripts/uos/build-release.sh');
  process.exit(2);
}

console.log('CivicWorkDesk UOS release archive tests');
console.log(`archive: ${archivePath}`);

/* ---------------------------------------------------------------- tar parsing */

function octal(buffer) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (text === '') return 0;
  return Number.parseInt(text, 8);
}

/**
 * Minimal ustar reader. Regular files and directories are what this artifact contains; anything else
 * — a symlink, a hard link, a GNU long-name or a pax header — is reported rather than skipped, so a
 * change in how the archive is produced fails loudly instead of being silently mis-parsed.
 */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const mode = octal(header.subarray(100, 108));
    const uid = octal(header.subarray(108, 116));
    const gid = octal(header.subarray(116, 124));
    const size = octal(header.subarray(124, 136));
    const typeflag =
      String.fromCharCode(header[156]) === '\0' ? '0' : String.fromCharCode(header[156]);
    const uname = header.subarray(265, 297).toString('ascii').replace(/\0.*$/, '');
    const gname = header.subarray(297, 329).toString('ascii').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');

    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    const data = typeflag === '0' ? buffer.subarray(dataStart, dataStart + size) : Buffer.alloc(0);

    entries.push({ name: fullName, mode, uid, gid, size, typeflag, uname, gname, data });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const gz = readFileSync(archivePath);
const entries = readTar(gunzipSync(gz));
const files = entries.filter((e) => e.typeflag === '0');
const dirs = entries.filter((e) => e.typeflag === '5');
const others = entries.filter((e) => e.typeflag !== '0' && e.typeflag !== '5');

const roots = new Set(entries.map((e) => e.name.split('/')[0]));
const rootName = [...roots][0];

group('1. structure');
assert(
  others.length === 0,
  'archive contains only regular files and directories',
  others.map((e) => `${e.name} (type ${e.typeflag})`).join(', '),
);
assert(roots.size === 1, 'exactly one top-level directory', [...roots].join(', '));
assert(
  /^civic-work-desk-uos20-loongarch64-.+$/.test(rootName),
  'top-level directory is the release name',
  rootName,
);
assert(files.length > 0, 'archive is not empty');
console.log(`       ${files.length} files, ${dirs.length} directories`);

group('2. ownership and mode metadata are normalized');
const badOwner = files.concat(dirs).filter((e) => e.uid !== 0 || e.gid !== 0);
assert(
  badOwner.length === 0,
  'every entry records uid/gid 0/0',
  badOwner
    .slice(0, 3)
    .map((e) => `${e.name} ${e.uid}/${e.gid}`)
    .join(', '),
);
const badName = files.concat(dirs).filter((e) => e.uname !== '' || e.gname !== '');
assert(
  badName.length === 0,
  'no developer account name travels in the archive',
  badName
    .slice(0, 3)
    .map((e) => `${e.name} ${e.uname}/${e.gname}`)
    .join(', '),
);

const installer = files.find((e) => e.name === `${rootName}/install.sh`);
assert(installer !== undefined, 'install.sh is present');
if (installer) {
  assert(
    (installer.mode & 0o111) !== 0,
    'install.sh keeps an executable bit',
    installer.mode.toString(8),
  );
}
const worldWritable = files.filter((e) => (e.mode & 0o002) !== 0);
assert(
  worldWritable.length === 0,
  'nothing is world-writable',
  worldWritable
    .slice(0, 3)
    .map((e) => e.name)
    .join(', '),
);

group('3. required members, and nothing that should not ship');
const names = new Set(files.map((e) => e.name.slice(rootName.length + 1)));
const required = [
  'install.sh',
  'VERSION',
  'SHA256SUMS.txt',
  'README.md',
  'app/index.html',
  'app/deployment-health.json',
  'app/sw.js',
  'app/manifest.webmanifest',
  'runtime/httpd.conf',
  'runtime/civic-lib.sh',
  'runtime/civic-work-desk.sh',
  'runtime/civic-work-desk-status.sh',
  'runtime/civic-work-desk-stop.sh',
  'runtime/civic-work-desk-rollback.sh',
  'runtime/civic-work-desk-uninstall.sh',
  'runtime/civic-work-desk.desktop',
];
const missing = required.filter((n) => !names.has(n));
assert(missing.length === 0, `all ${required.length} required members present`, missing.join(', '));

const forbidden = [...names].filter(
  (n) =>
    /(^|\/)node_modules\//.test(n) ||
    /(^|\/)(src|tests|docs|scripts|_review_packages|release)\//.test(n) ||
    /\.(test|spec)\./.test(n) ||
    /\.map$/.test(n) ||
    /(^|\/)(package\.json|tsconfig.*\.json|vite\.config\.ts|\.git)/.test(n) ||
    /candidate\//.test(n) ||
    /acceptance\//.test(n) ||
    /(^|\/)server\.py$/.test(n),
);
assert(
  forbidden.length === 0,
  'no source tree, tests, sourcemaps, acceptance kit or Python server',
  forbidden.slice(0, 5).join(', '),
);

group('4. inner manifest describes the real contents');
const manifestEntry = files.find((e) => e.name === `${rootName}/SHA256SUMS.txt`);
const manifest = manifestEntry ? manifestEntry.data.toString('utf8') : '';
const manifestRows = manifest.split('\n').filter((line) => line.trim() !== '');
const manifestMap = new Map();
for (const row of manifestRows) {
  const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(row);
  if (match) manifestMap.set(match[2], match[1]);
}
assert(
  manifestRows.length === manifestMap.size,
  'every manifest row parses',
  `${manifestRows.length} rows, ${manifestMap.size} parsed`,
);
assert(
  manifestMap.size === files.length - 1,
  'manifest covers every file except itself',
  `manifest ${manifestMap.size}, files ${files.length - 1}`,
);

let digestMismatch = 0;
for (const entry of files) {
  const rel = entry.name.slice(rootName.length + 1);
  if (rel === 'SHA256SUMS.txt') continue;
  const expected = manifestMap.get(rel);
  if (!expected) {
    digestMismatch += 1;
    continue;
  }
  const actual = createHash('sha256').update(entry.data).digest('hex');
  if (actual !== expected) digestMismatch += 1;
}
assert(
  digestMismatch === 0,
  'every archived file matches its manifest digest',
  `${digestMismatch} mismatched`,
);

group('5. the application payload is the unmodified Phase-2 build');
const distDir = join(ROOT, 'dist');
if (!existsSync(distDir)) {
  nok('dist/ is present for comparison', 'run npm run build first');
} else {
  const distFiles = new Map();
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = full.slice(distDir.length + 1).replaceAll('\\', '/');
        distFiles.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    }
  })(distDir);

  const appFiles = files.filter((e) => e.name.startsWith(`${rootName}/app/`));
  const differing = [];
  const extra = [];
  for (const entry of appFiles) {
    const rel = entry.name.slice(`${rootName}/app/`.length);
    const digest = createHash('sha256').update(entry.data).digest('hex');
    if (!distFiles.has(rel)) extra.push(rel);
    else if (distFiles.get(rel) !== digest) differing.push(rel);
  }
  const absent = [...distFiles.keys()].filter(
    (rel) => !appFiles.some((e) => e.name === `${rootName}/app/${rel}`),
  );

  assert(differing.length === 0, 'no application file differs from dist/', differing.join(', '));
  assert(absent.length === 0, 'no application file is missing from the archive', absent.join(', '));
  assert(
    extra.length === 1 && extra[0] === 'deployment-health.json',
    'the only addition to the build is deployment-health.json',
    extra.join(', '),
  );
  console.log(`       ${appFiles.length - 1} application files byte-identical to dist/`);
}

group('6. canonical origin and release identity');
const versionText =
  files.find((e) => e.name === `${rootName}/VERSION`)?.data.toString('utf8') ?? '';
const healthText =
  files.find((e) => e.name === `${rootName}/app/deployment-health.json`)?.data.toString('utf8') ??
  '';

const versionRelease = /^releaseId=(.+)$/m.exec(versionText)?.[1]?.trim() ?? '';
const healthRelease = /"releaseId"\s*:\s*"([^"]+)"/.exec(healthText)?.[1] ?? '';
assert(versionRelease !== '', 'VERSION declares a releaseId', versionRelease);
assert(
  versionRelease === healthRelease,
  'VERSION and deployment-health.json agree on the release id',
  `VERSION=${versionRelease} health=${healthRelease}`,
);
assert(
  rootName === `civic-work-desk-uos20-loongarch64-${versionRelease}`,
  'the archive directory name carries the same release id',
  rootName,
);
assert(
  healthText.includes(`"canonicalOrigin": "${CANONICAL}"`),
  'deployment-health.json names the canonical origin exactly',
);
assert(
  /^targetTested=NO/m.test(versionText),
  'VERSION still records targetTested=NO',
  'a release may not claim target validation before physical evidence',
);

/* Text members must not USE a wrong origin. Checked over the archive, not the working tree, because
 * the working tree is not what gets copied to the target.
 *
 * "Use", not "mention": the rule comes from origin-scan.mjs, shared with lint-shell.mjs. A raw text
 * scan here flagged the README's own table row explaining that `http://localhost:8765/` is the wrong
 * address — a check that would have been "fixed" by deleting the warning. The documentation has to be
 * allowed to name the mistake it is warning about. */
const textMembers = files.filter((e) =>
  /(\.(sh|md|conf|desktop|json|txt)|\/VERSION)$/.test(e.name),
);
const wrongOrigin = [];
for (const entry of textMembers) {
  const kind = entry.name.endsWith('/VERSION') ? 'raw' : scanKindFor(entry.name);
  for (const hit of wrongOriginHits(entry.data.toString('utf8'), kind)) {
    wrongOrigin.push(`${entry.name}:${String(hit.line)} ${hit.detail}`);
  }
}
assert(
  wrongOrigin.length === 0,
  'no text member uses a wrong origin',
  wrongOrigin.slice(0, 5).join(', '),
);
assert(
  textMembers.length >= 10,
  'the origin scan actually looked at the text members',
  `only ${textMembers.length} matched — the member filter is probably wrong`,
);

group('7. what the release must NOT contain, and what it must still declare');
/* Phase-3 constraints asserted against the delivered bytes rather than against the source tree: no
 * language runtime is required, BusyBox is still the selected server, Python is not a dependency, and
 * the artifact still declares that its installed form is unvalidated. */
const scriptMembers = files.filter((e) => /\.(sh|conf|desktop)$/.test(e.name));
const runtimeInvocations = [];
for (const entry of scriptMembers) {
  const code = entry.data
    .toString('utf8')
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
  for (const bad of [
    /\bpython3?\b/,
    /\bnode\b/,
    /\bnpm\b/,
    /\bnpx\b/,
    /\belectron\b/,
    /\btauri\b/,
  ]) {
    if (bad.test(code)) runtimeInvocations.push(`${entry.name}: ${String(bad)}`);
  }
}
assert(
  runtimeInvocations.length === 0,
  'no shipped script invokes python, node, npm, electron or tauri',
  runtimeInvocations.slice(0, 4).join(', '),
);
assert(
  [...names].every((n) => !/\.py$/.test(n)),
  'the release ships no Python file at all',
  [...names].filter((n) => /\.py$/.test(n)).join(', '),
);
assert(
  /^server=busybox-httpd$/m.test(versionText),
  'VERSION still declares BusyBox as the selected server',
);
assert(/^pythonRequired=NO$/m.test(versionText), 'VERSION declares pythonRequired=NO');
assert(/^sudoRequired=NO$/m.test(versionText), 'VERSION declares sudoRequired=NO');
assert(
  /^installedFormTargetValidated=NO/m.test(versionText),
  'VERSION states the installed form is NOT yet validated on the target',
);
assert(
  /^genericPlatformSupportClaimed=NO/m.test(versionText),
  'VERSION states no generic UOS/Linux/LoongArch support is claimed',
);
/* The README has to distinguish the two facts: RC1.1 validated the application being served; this
 * installer lifecycle has not been validated there. A single "validated on" sentence reads as a
 * compatibility claim. */
const readmeText =
  files.find((e) => e.name === `${rootName}/README.md`)?.data.toString('utf8') ?? '';
assert(
  readmeText.includes('尚未在目标工作站上实测的'),
  'README names what has NOT been tested on the target',
);
assert(
  readmeText.includes('installedFormTargetValidated=NO'),
  'README points at the VERSION field that records it',
);

group('8. the acceptance kit archive');
/* §12: both delivered archives are verified, not just the application one. The kit is what the tester
 * runs, so a corrupt kit would invalidate every result it produced. */
const kitPath = join(
  RELEASE_DIR,
  `civic-work-desk-uos20-final-acceptance-${versionRelease}.tar.gz`,
);
let kitDigest = null;
/* Collected here so the next group can ask whether a document referenced from the release is
 * delivered in either archive — the tester receives both. */
let kitBasenames = null;
if (!existsSync(kitPath)) {
  nok('the matching acceptance kit exists', kitPath);
} else {
  const kitGz = readFileSync(kitPath);
  kitDigest = createHash('sha256').update(kitGz).digest('hex');
  const kitEntries = readTar(gunzipSync(kitGz));
  const kitFiles = kitEntries.filter((e) => e.typeflag === '0');
  const kitRoots = new Set(kitEntries.map((e) => e.name.split('/')[0]));
  const kitRoot = [...kitRoots][0];

  assert(kitRoots.size === 1, 'kit has exactly one top-level directory', [...kitRoots].join(', '));
  assert(
    kitEntries.every((e) => e.uid === 0 && e.gid === 0 && e.uname === '' && e.gname === ''),
    'kit ownership metadata is normalized to 0/0 with no account name',
  );
  const unsafe = kitEntries
    .concat(entries)
    .filter((e) => e.name.startsWith('/') || e.name.split('/').includes('..'));
  assert(
    unsafe.length === 0,
    'neither archive contains an absolute or parent-traversing member path',
    unsafe
      .slice(0, 3)
      .map((e) => e.name)
      .join(', '),
  );

  kitBasenames = new Set(kitFiles.map((e) => e.name.split('/').pop()));
  const kitNames = new Set(kitFiles.map((e) => e.name.slice(kitRoot.length + 1)));
  const kitRequired = [
    'FINAL_ACCEPTANCE.md',
    'RESULT_TEMPLATE.md',
    'VERSION',
    'SHA256SUMS.txt',
    'scripts/collect-results.sh',
    'scripts/port-conflict-test.sh',
    'scripts/post-uninstall-check.sh',
  ];
  const kitMissing = kitRequired.filter((n) => !kitNames.has(n));
  assert(
    kitMissing.length === 0,
    `kit holds all ${kitRequired.length} required members`,
    kitMissing.join(', '),
  );

  const kitManifest = kitFiles.find((e) => e.name === `${kitRoot}/SHA256SUMS.txt`);
  const kitRows = new Map();
  for (const row of (kitManifest?.data.toString('utf8') ?? '').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(row);
    if (m) kitRows.set(m[2], m[1]);
  }
  let kitBad = 0;
  for (const entry of kitFiles) {
    const rel = entry.name.slice(kitRoot.length + 1);
    if (rel === 'SHA256SUMS.txt') continue;
    if (kitRows.get(rel) !== createHash('sha256').update(entry.data).digest('hex')) kitBad += 1;
  }
  assert(
    kitRows.size === kitFiles.length - 1,
    'kit manifest covers every file except itself',
    `manifest ${kitRows.size}, files ${kitFiles.length - 1}`,
  );
  assert(kitBad === 0, 'every kit file matches its manifest digest', `${kitBad} mismatched`);

  const kitSidecar = `${kitPath}.sha256`;
  if (!existsSync(kitSidecar)) {
    nok('kit sidecar exists', kitSidecar);
  } else {
    assert(
      readFileSync(kitSidecar, 'utf8').trim().startsWith(kitDigest),
      'kit sidecar digest matches the kit archive',
    );
  }

  /* The ordering property, asserted on the DELIVERED manual rather than on the source. Uninstall
   * deletes exactly what the collector gathers, so a kit that instructs the tester to uninstall first
   * throws away the installed-form evidence — silently, because the collector still exits 0. */
  const manual =
    kitFiles.find((e) => e.name === `${kitRoot}/FINAL_ACCEPTANCE.md`)?.data.toString('utf8') ?? '';
  const collectAt = manual.indexOf('scripts/collect-results.sh');
  const uninstallAt = manual.indexOf('civic-work-desk-uninstall');
  assert(collectAt >= 0 && uninstallAt >= 0, 'the shipped manual mentions both steps');
  assert(
    collectAt >= 0 && uninstallAt >= 0 && collectAt < uninstallAt,
    'the shipped manual collects evidence BEFORE uninstall',
    `collect at ${collectAt}, uninstall at ${uninstallAt}`,
  );

  /* §9: the manual must not tell the tester to run bare command names — ~/.local/bin is not
   * necessarily on PATH, and "command not found" would read as a product failure. */
  const bareInvocations = manual
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /^\s*civic-work-desk(-[a-z]+)?\s*$/.test(line));
  assert(
    bareInvocations.length === 0,
    'the shipped manual invokes the commands by absolute path, never bare',
    bareInvocations
      .slice(0, 3)
      .map((b) => `line ${b.index}: ${b.line.trim()}`)
      .join(', '),
  );
  assert(
    manual.includes('$HOME/.local/bin/civic-work-desk-status'),
    'the shipped manual uses the absolute path form',
  );
}

group('9. every recovery document a shipped file points at actually ships');
/* An instruction is only a recovery path if the thing it names is reachable from what the operator
 * received. `install.sh` used to tell the user to read `docs/uos-upgrade-recovery.md`, which exists in
 * the repository and in no delivered archive — so the one message printed when something had already
 * gone wrong pointed at a file that was not there.
 *
 * Two rules. `docs/` must never appear as a path in shipped text, because that directory is never
 * part of a release. And any `*.md` a shipped file names must exist as a member of one of the two
 * delivered archives — the kit's RESULT_TEMPLATE.md is legitimately referenced from the kit's own
 * collector, so both archives count as "delivered". */
const shippedText = files.filter((e) => /\.(sh|md|conf|desktop)$/.test(e.name));
const deliveredBasenames = new Set(
  files.map((e) => e.name.split('/').pop()).filter((n) => n !== undefined),
);
if (kitBasenames) for (const n of kitBasenames) deliveredBasenames.add(n);

const docsRefs = [];
const missingRefs = [];
for (const entry of shippedText) {
  const text = entry.data.toString('utf8');
  for (const match of text.matchAll(/(?:^|[\s'"(（])((?:[\w./-]*\/)?[\w.-]+\.md)\b/g)) {
    const ref = match[1];
    if (/(^|\/)docs\//.test(ref)) {
      docsRefs.push(`${entry.name}: ${ref}`);
      continue;
    }
    const base = ref.split('/').pop();
    if (base && !deliveredBasenames.has(base)) missingRefs.push(`${entry.name}: ${ref}`);
  }
}
assert(
  docsRefs.length === 0,
  'no shipped file points at a repository-only docs/ path',
  docsRefs.slice(0, 4).join(', '),
);
assert(
  missingRefs.length === 0,
  'every markdown file named by shipped text is itself delivered',
  missingRefs.slice(0, 4).join(', '),
);
/* And the specific instruction the installer prints on a same-release run must name the section that
 * now exists in the shipped README. */
const installerText =
  files.find((e) => e.name === `${rootName}/install.sh`)?.data.toString('utf8') ?? '';
assert(
  installerText.includes('README.md'),
  'the installer directs the operator to the shipped README for repair',
);
assert(
  readmeText.includes('## 六之二、修复'),
  'the shipped README contains the repair section the installer names',
);

group('10. the documented checksums are not stale');
/* A hash written into a document is a copy, and copies go stale the moment the artifact is rebuilt.
 * The tester verifies against the sidecar, so a wrong hash in the manual does not endanger the
 * install — it endangers the audit, because returned evidence is matched against the documented
 * value. Bound here to the file it describes rather than maintained by hand. */
const acceptanceDoc = join(ROOT, 'docs', 'uos-final-acceptance.md');
if (!existsSync(acceptanceDoc)) {
  nok('docs/uos-final-acceptance.md exists', acceptanceDoc);
} else {
  const docText = readFileSync(acceptanceDoc, 'utf8');
  const archiveDigest = createHash('sha256').update(gz).digest('hex');
  /* Both delivered archives now have to be verified by the tester, so both digests have to be in the
   * document — and nothing else, or a leftover from a superseded build is there to be matched against
   * by mistake. */
  const expected = kitDigest ? [archiveDigest, kitDigest] : [archiveDigest];
  assert(
    docText.includes(archiveDigest),
    'the acceptance document quotes the release digest',
    `expected ${archiveDigest}`,
  );
  assert(
    kitDigest !== null && docText.includes(kitDigest),
    'the acceptance document quotes the acceptance-kit digest',
    kitDigest ? `expected ${kitDigest}` : 'no kit archive was found to compare against',
  );
  assert(
    docText.includes(rootName),
    'the acceptance document names this release',
    `expected ${rootName}`,
  );
  const strayDigests = [...docText.matchAll(/\b[0-9a-f]{64}\b/g)]
    .map((m) => m[0])
    .filter((d) => !expected.includes(d));
  assert(
    strayDigests.length === 0,
    'the acceptance document quotes no digest from a superseded build',
    strayDigests.join(', '),
  );
}

group('11. outer checksum sidecar');
const sidecarPath = `${archivePath}.sha256`;
if (!existsSync(sidecarPath)) {
  nok('sidecar .sha256 exists', sidecarPath);
} else {
  const sidecar = readFileSync(sidecarPath, 'utf8').trim();
  const recorded = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(sidecar);
  const actual = createHash('sha256').update(gz).digest('hex');
  assert(recorded !== null, 'sidecar is in sha256sum format', sidecar);
  if (recorded) {
    assert(
      recorded[1] === actual,
      'sidecar digest matches the archive',
      `sidecar ${recorded[1]} actual ${actual}`,
    );
    assert(
      !recorded[2].includes('/') && !recorded[2].includes('\\'),
      'sidecar names a bare filename so it verifies from any directory',
      recorded[2],
    );
  }
}

console.log('\n==================================================================');
console.log(`checks run: ${pass + fail}   pass: ${pass}   fail: ${fail}`);
if (fail === 0) {
  console.log('RESULT: PASS');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${problems.length} problem(s)`);
process.exit(1);
