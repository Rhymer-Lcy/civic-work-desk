#!/usr/bin/env node
/**
 * Build the Windows x64 release payload and, when Inno Setup is available, the installer.
 *
 *   node scripts/windows/build-release.mjs [--release-id <id>] [--skip-installer]
 *
 * ## The application is copied, not rebuilt
 *
 * There is one CivicWorkDesk web application, and the bytes that were validated on the UOS target are
 * the bytes that ship on Windows. So this script copies `app/` out of the frozen UOS release and
 * verifies every file against that release's own SHA256SUMS.txt before using it. Rebuilding from source
 * would be the obvious alternative and is the wrong one: it would make the Windows payload depend on
 * the current state of the toolchain and the working tree, and the first silent divergence between the
 * two platforms would be invisible.
 *
 * Exactly one file inside app/ differs, and it is deployment metadata rather than application code:
 * deployment-health.json names the release channel and id that the launcher checks. The rewrite is
 * declared here and asserted afterwards, so "only this one file differs" is a measurement.
 *
 * ## The frozen UOS release is read, never written
 *
 * Nothing under release/uos20/ is modified, and the tarball is not touched at all. The script fails if
 * the source payload does not verify, rather than repairing it.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* The frozen, signed-off UOS release. Its app/ is the single source of the application payload. */
const UOS_RELEASE = join(
  ROOT,
  'release',
  'uos20',
  'civic-work-desk-uos20-loongarch64-2026.09.23-5',
);
const UOS_ARCHIVE_DIGEST = '969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf';

/* Build-time tools. Neither is a runtime prerequisite for a user, and neither is installed
 * machine-wide: both are portable trees under D:\tools. */
const GO_ROOT = process.env.CIVIC_GOROOT ?? 'D:/tools/go1.27.1/go';
const GO_VERSION = 'go1.27.1';
const ISCC = process.env.CIVIC_ISCC ?? 'D:/tools/innosetup-7.1.0/ISCC.exe';
const INNO_VERSION = 'Inno Setup 7.1.0 (x64)';

const SERVER_BINARIES = [
  { out: 'civic-server.exe', pkg: './cmd/civic-server', gui: false },
  { out: 'civic-launch.exe', pkg: './cmd/civic-launch', gui: true },
  { out: 'civic-diag.exe', pkg: './cmd/civic-diag', gui: false },
  { out: 'civic-admin.exe', pkg: './cmd/civic-admin', gui: false },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const releaseId = arg('--release-id', '2026.09.24-win-rc1');
const skipInstaller = process.argv.includes('--skip-installer');

/* Must agree with layout.ReleaseIDPattern in the Go module. A release id becomes a directory name, and
 * the Go side refuses anything else, so a mismatch here would produce a payload the installer cannot
 * activate. */
if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[a-z0-9]([a-z0-9.-]{0,29}[a-z0-9])?$/.test(releaseId)) {
  fatal(`illegal release id: ${releaseId}`);
}

function fatal(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileDigest(path) {
  return sha256(readFileSync(path));
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split('\\').join('/'));
  }
  return out.sort();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fatal(`cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    console.error(result.stdout ?? '');
    console.error(result.stderr ?? '');
    fatal(`${command} exited ${String(result.status)}`);
  }
  return result;
}

console.log('CivicWorkDesk Windows release build');
console.log('');
console.log(`  release id   : ${releaseId}`);
console.log(`  Go toolchain : ${GO_VERSION} at ${GO_ROOT}`);
console.log(`  installer    : ${skipInstaller ? '(skipped)' : INNO_VERSION}`);
console.log('');

/* ------------------------------------------------------------------ 1. verify the source payload */
console.log('1. verifying the frozen UOS payload that supplies app/');
if (!existsSync(UOS_RELEASE)) fatal(`${UOS_RELEASE} is not present`);

const uosManifest = readFileSync(join(UOS_RELEASE, 'SHA256SUMS.txt'), 'utf8');
const uosEntries = [];
for (const line of uosManifest.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const match = /^([0-9a-f]{64}) \*?(.+)$/.exec(trimmed);
  if (!match) fatal(`unparseable UOS manifest line: ${trimmed}`);
  uosEntries.push({ digest: match[1], path: match[2] });
}
const uosAppEntries = uosEntries.filter((e) => e.path.startsWith('app/'));
if (uosAppEntries.length === 0) fatal('the UOS manifest lists no app/ files');

let verified = 0;
for (const entry of uosAppEntries) {
  const full = join(UOS_RELEASE, entry.path);
  if (!existsSync(full)) fatal(`the UOS payload is missing ${entry.path}`);
  if (fileDigest(full) !== entry.digest)
    fatal(`the UOS payload's ${entry.path} does not match its digest`);
  verified += 1;
}
/* And the other direction: a file inside app/ that the UOS manifest never listed would be copied into
 * the Windows document root without ever having been verified by anything. */
const uosAppListed = new Set(uosAppEntries.map((e) => e.path));
const uosAppOnDisk = walk(join(UOS_RELEASE, 'app')).map((p) => `app/${p}`);
const uosUnlisted = uosAppOnDisk.filter((p) => !uosAppListed.has(p));
if (uosUnlisted.length > 0)
  fatal(`the UOS payload carries unlisted files: ${uosUnlisted.join(', ')}`);
console.log(
  `   ${String(verified)} application file(s) verified against the UOS manifest, none unlisted`,
);

/* ------------------------------------------------------------------ 2. build the Go binaries */
console.log('2. building the Windows binaries');
const goExe = join(GO_ROOT, 'bin', 'go.exe');
if (!existsSync(goExe)) fatal(`${goExe} is not present; set CIVIC_GOROOT to a Go 1.27 tree`);

const srcDir = join(ROOT, 'deploy', 'windows', 'src');
const binStage = join(ROOT, 'release', 'windows', '.build', releaseId);
rmSync(binStage, { recursive: true, force: true });
mkdirSync(binStage, { recursive: true });

const goEnv = {
  ...process.env,
  GOROOT: GO_ROOT,
  GOPATH: join(dirname(GO_ROOT), 'gopath'),
  GOOS: 'windows',
  GOARCH: 'amd64',
  CGO_ENABLED: '0',
};

run(goExe, ['vet', './...'], { cwd: srcDir, env: goEnv });
run(goExe, ['test', './...', '-count=1'], { cwd: srcDir, env: goEnv, stdio: 'inherit' });

for (const binary of SERVER_BINARIES) {
  /* -trimpath strips the build machine's paths out of the binary, -s -w drop the symbol table, and
   * -buildvcs=false keeps the git commit out: without it every commit would change the binary and the
   * installer could never be reproduced from a source tree alone. The commit is recorded in VERSION,
   * which is the right place for provenance that changes independently of the code.
   *
   * -H=windowsgui on the launcher only. It is what a Start Menu shortcut runs, and a console subsystem
   * binary flashes a black window on every click. The server, admin and diag tools keep a console
   * because their output is the point. */
  const ldflags = binary.gui ? '-s -w -H=windowsgui' : '-s -w';
  run(
    goExe,
    [
      'build',
      '-trimpath',
      '-buildvcs=false',
      `-ldflags=${ldflags}`,
      '-o',
      join(binStage, binary.out),
      binary.pkg,
    ],
    { cwd: srcDir, env: goEnv },
  );
  const size = statSync(join(binStage, binary.out)).size;
  console.log(`   ${binary.out.padEnd(20)} ${String(size).padStart(9)} bytes`);
}

/* ------------------------------------------------------------------ 3. assemble the payload */
console.log('3. assembling the release payload');
const payloadName = `civic-work-desk-windows-x64-${releaseId}`;
const payload = join(ROOT, 'release', 'windows', payloadName);
rmSync(payload, { recursive: true, force: true });
mkdirSync(join(payload, 'app'), { recursive: true });
mkdirSync(join(payload, 'server'), { recursive: true });

cpSync(join(UOS_RELEASE, 'app'), join(payload, 'app'), { recursive: true });
for (const binary of SERVER_BINARIES) {
  cpSync(join(binStage, binary.out), join(payload, 'server', binary.out));
}

/* The one declared difference from the UOS payload. */
const appCommit =
  /applicationCommit=(\S+)/.exec(readFileSync(join(UOS_RELEASE, 'VERSION'), 'utf8'))?.[1] ??
  'unknown';
const appVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const uosHealth = JSON.parse(
  readFileSync(join(UOS_RELEASE, 'app', 'deployment-health.json'), 'utf8'),
);
const windowsHealth = {
  ...uosHealth,
  releaseChannel: 'windows-x64',
  releaseId,
  note: uosHealth.note,
};
writeFileSync(
  join(payload, 'app', 'deployment-health.json'),
  `${JSON.stringify(windowsHealth, null, 2)}\n`,
  'utf8',
);

/* Assert the claim rather than trusting it: every application file except the one declared rewrite must
 * be byte-identical to the UOS payload. This is the check that would catch an accidental fork. */
const declaredRewrites = new Set(['deployment-health.json']);
const differing = [];
for (const rel of walk(join(payload, 'app'))) {
  const mine = fileDigest(join(payload, 'app', rel));
  const theirs = fileDigest(join(UOS_RELEASE, 'app', rel));
  if (mine !== theirs) differing.push(rel);
}
const unexpected = differing.filter((p) => !declaredRewrites.has(p));
const missingRewrite = [...declaredRewrites].filter((p) => !differing.includes(p));
if (unexpected.length > 0) {
  fatal(
    `these application files differ from the UOS payload but were not declared: ${unexpected.join(', ')}`,
  );
}
if (missingRewrite.length > 0) {
  fatal(
    `${missingRewrite.join(', ')} was declared as rewritten but is identical; the rewrite did not happen`,
  );
}
console.log(
  `   app/ is byte-identical to the UOS payload except ${[...declaredRewrites].join(', ')}`,
);

/* ------------------------------------------------------------------ 4. VERSION and the manifest */
const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const sourceCommit =
  spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ??
  'unknown';

const version = [
  'CivicWorkDesk Windows release candidate',
  `releaseId=${releaseId}`,
  `releaseChannel=windows-x64`,
  `appVersion=${appVersion}`,
  `applicationCommit=${appCommit}`,
  `applicationPayloadSource=civic-work-desk-uos20-loongarch64-2026.09.23-5`,
  `applicationPayloadUnchanged=YES — byte-identical except deployment-health.json`,
  `deploymentCommit=${sourceCommit}`,
  `canonicalOrigin=http://127.0.0.1:8765`,
  `server=civic-server (Go net/http, standard library only)`,
  `goToolchain=${GO_VERSION}`,
  `installerToolchain=${INNO_VERSION}`,
  `nodeRequired=NO`,
  `pythonRequired=NO`,
  `powershellRequired=NO`,
  `dotnetRequired=NO`,
  `adminRequired=NO`,
  `builtAt=${builtAt}`,
  'builtOn=development workstation, Windows 11 x64',
  'phase=Phase 4 Windows RC1 (field-validation candidate)',
  'windowsCompatibilityCertified=NO — validated on the development workstation only',
  'targetTested=NO — no colleague machine has run this build yet',
  '',
].join('\n');
writeFileSync(join(payload, 'VERSION'), version, 'utf8');

const manifestLines = [];
for (const group of ['app', 'server']) {
  for (const rel of walk(join(payload, group))) {
    manifestLines.push(`${fileDigest(join(payload, group, rel))} *${group}/${rel}`);
  }
}
manifestLines.sort((a, b) => (a.slice(65) < b.slice(65) ? -1 : 1));
writeFileSync(join(payload, 'SHA256SUMS.txt'), `${manifestLines.join('\n')}\n`, 'utf8');
console.log(`   VERSION and SHA256SUMS.txt written (${String(manifestLines.length)} files)`);

/* The payload shape must match layout.RequiredReleaseEntries exactly, or civic-admin will refuse to
 * activate what this script just built. */
const shape = readdirSync(payload).sort();
const wantShape = ['SHA256SUMS.txt', 'VERSION', 'app', 'server'];
if (shape.join(',') !== wantShape.join(',')) {
  fatal(
    `payload shape is ${shape.join(', ')}; civic-admin requires exactly ${wantShape.join(', ')}`,
  );
}
console.log(`   payload shape: ${shape.join(', ')}`);

/* ------------------------------------------------------------------ 5. the installer */
let setupPath = null;
if (!skipInstaller) {
  console.log('4. compiling the installer');
  if (!existsSync(ISCC)) fatal(`${ISCC} is not present; set CIVIC_ISCC or pass --skip-installer`);
  const outDir = join(ROOT, 'release', 'windows');
  const setupBase = `CivicWorkDesk-Windows-x64-${releaseId.replace(/-win-/, '-')}-Setup`;
  run(
    ISCC,
    [
      `/DCivicPayload=${payload}`,
      `/DCivicReleaseId=${releaseId}`,
      `/DCivicAppVersion=${appVersion}`,
      `/DCivicOutDir=${outDir}`,
      `/DCivicOutBase=${setupBase}`,
      join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.iss'),
    ],
    { cwd: ROOT },
  );
  setupPath = join(outDir, `${setupBase}.exe`);
  if (!existsSync(setupPath)) fatal(`Inno Setup reported success but ${setupPath} does not exist`);
  const digest = fileDigest(setupPath);
  writeFileSync(`${setupPath}.sha256`, `${digest}  ${setupBase}.exe\n`, 'utf8');
  console.log(`   ${setupBase}.exe  ${String(statSync(setupPath).size)} bytes`);
  console.log(`   sha256  ${digest}`);

  // The tester instructions travel with the installer, not inside it. A colleague who has only the two
  // files must be able to read what they are about to run and what it will do; a document that only
  // exists in the repository is no use to them.
  const noticeSource = join(ROOT, 'deploy', 'windows', 'installer', 'README-测试说明.txt');
  const noticeTarget = join(outDir, 'README-测试说明.txt');
  // UTF-8 with a BOM: this is opened in Notepad on a Chinese-locale machine, where a BOM-less file can
  // still be guessed as the ANSI code page and render as mojibake.
  const noticeBody = readFileSync(noticeSource);
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(
    noticeTarget,
    noticeBody.subarray(0, 3).equals(bom) ? noticeBody : Buffer.concat([bom, noticeBody]),
  );
  console.log(`   ${'README-测试说明.txt'}  ${String(statSync(noticeTarget).size)} bytes`);

  // The instructions quote the installer's own filename in the hash-checking step. If the release id ever
  // changes and that line is not updated, a tester would check the wrong file and conclude nothing.
  const noticeText = noticeBody.toString('utf8');
  if (!noticeText.includes(`${setupBase}.exe`)) {
    fatal(
      `README-测试说明.txt does not name ${setupBase}.exe; the hash-checking instruction would be wrong`,
    );
  }
}

console.log('');
console.log('summary');
console.log(`  payload            : ${payload}`);
console.log(`  files in manifest  : ${String(manifestLines.length)}`);
console.log(`  UOS archive digest : ${UOS_ARCHIVE_DIGEST} (frozen, not touched)`);
if (setupPath) {
  console.log(`  installer          : ${setupPath}`);
  console.log(`  installer sha256   : ${fileDigest(setupPath)}`);
}
console.log('');
console.log('  Windows compatibility is NOT certified by this build.');
