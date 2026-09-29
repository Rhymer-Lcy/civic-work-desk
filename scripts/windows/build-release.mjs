#!/usr/bin/env node
/**
 * Build the Windows x64 release payload and, when Inno Setup is available, the installer.
 *
 *   node scripts/windows/build-release.mjs --release-id <YYYY.MM.DD-win-<version>> \
 *       --source-commit <40-hex sha> [--skip-installer] [--force-installer] [--offline-provenance]
 *
 * Both flags are required and neither has a default. The release id is derived and checked by
 * release-identity.mjs; the source commit must be HEAD, the working tree must be clean, and GitHub must
 * already resolve the commit (assert-release-provenance.mjs). Until Phase 6 this script defaulted to the
 * already-published id 2026.09.24-win-rc3 and took the commit from HEAD without asking whether anyone
 * else could ever see it.
 *
 * ## The application is built from the source commit and proven to be the signed-off product
 *
 * RC1-RC3 copied app/ out of the frozen UOS -5 release, because that was the application they shipped.
 * The 0.2.0 line ships the Phase-5 application, which no frozen release carries, so the payload is built
 * here -- and built twice, from two clean exports of committed trees rather than from the working tree:
 *
 *   1. the signed-off product baseline (PRODUCT_BASELINE: main at the Phase-5.1 sign-off);
 *   2. the deployment source commit this installer is built from.
 *
 * The two dist/ trees must be byte-identical, file for file. Before building, the input difference
 * between the two commits is checked as well: nothing under src/ or public/, no build configuration,
 * and in package.json / package-lock.json nothing but the version field may differ. Output identity
 * and input scope together are the proof that the Windows payload IS the signed-off product; either
 * alone could be satisfied by accident.
 *
 * Exactly one file inside app/ is added, and it is deployment metadata rather than application code:
 * deployment-health.json names the release and the data format that the launcher and civic-admin
 * check. The addition is declared here and asserted afterwards.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseIdentity } from './release-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* The signed-off product: main at the Phase-5.1 sign-off (docs/phase-5.1-final-signoff.md). The first
 * 0.2.0-rc.1 build used the Phase-5 sign-off, 3b71dbc; it was rejected before publication because that
 * product lacked the Phase-5.1 update-safety corrections (scripts/windows/rejected-releases.json). */
const PRODUCT_BASELINE = 'a0e0a4ce73e205823e3f6c0fa1d8931c7df6c69b';

/* Paths whose change between the baseline and the source commit would change the product. package.json
 * and package-lock.json are compared separately, field by field. */
const PRODUCT_INPUTS = [
  'src/',
  'public/',
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'scripts/generate-css-module-types.mjs',
  '.npmrc',
];

/* Build-time tools. None is a runtime prerequisite for a user, and none is installed machine-wide. */
const GO_ROOT = process.env.CIVIC_GOROOT ?? 'D:/tools/go1.27.1/go';
const GO_VERSION = 'go1.27.1';
const ISCC = process.env.CIVIC_ISCC ?? 'D:/tools/innosetup-7.1.0/ISCC.exe';
const INNO_VERSION = 'Inno Setup 7.1.0 (x64)';
const NODE_VERSION = process.version;

const SERVER_BINARIES = [
  { out: 'civic-server.exe', pkg: './cmd/civic-server', gui: false },
  { out: 'civic-launch.exe', pkg: './cmd/civic-launch', gui: true },
  { out: 'civic-diag.exe', pkg: './cmd/civic-diag', gui: false },
  { out: 'civic-admin.exe', pkg: './cmd/civic-admin', gui: false },
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : undefined;
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
    fatal(`${command} ${args.slice(0, 2).join(' ')} exited ${String(result.status)}`);
  }
  return result;
}

function git(...args) {
  return run('git', args, { cwd: ROOT }).stdout.trim();
}

/* ---------------------------------------------------------------------------------- 0. identity */
let identity;
try {
  identity = loadReleaseIdentity(ROOT, arg('--release-id'));
} catch (cause) {
  fatal(cause instanceof Error ? cause.message : String(cause));
}
const { releaseId } = identity;
const skipInstaller = process.argv.includes('--skip-installer');

console.log('CivicWorkDesk Windows release build');
console.log('');
console.log(`  release id      : ${releaseId}`);
console.log(`  display version : ${identity.displayVersion} (Windows ${identity.windowsVersion})`);
console.log(`  publisher       : ${identity.publisher}`);
console.log(`  Go toolchain    : ${GO_VERSION} at ${GO_ROOT}`);
console.log(`  Node            : ${NODE_VERSION} (build time only)`);
console.log(`  installer       : ${skipInstaller ? '(skipped)' : INNO_VERSION}`);
console.log('');

/* ------------------------------------------------------ 1. the source commit: HEAD, clean, public
 *
 * RC2 recorded a commit GitHub cannot resolve: the build ran against an unpushed HEAD that a rebase then
 * rewrote. So the commit is named explicitly, must be exactly what is checked out, the tree must hold
 * nothing uncommitted, and GitHub must already resolve it -- before anything is written.
 */
console.log('1. source commit and provenance');
const sourceCommit = arg('--source-commit');
if (!sourceCommit || !/^[0-9a-f]{40}$/.test(sourceCommit)) {
  fatal('--source-commit <40-hex sha> is required and has no default');
}
const head = git('rev-parse', 'HEAD');
if (head !== sourceCommit) fatal(`--source-commit ${sourceCommit} is not HEAD (${head})`);
/* This build's own outputs are the only exception: a rebuild of the same release overwrites them, and
 * they are committed afterwards in the release-record commit. Nothing else may be uncommitted. */
const ownOutputs = new Set([
  `release/windows/provenance/${releaseId}-payload-SHA256SUMS.txt`,
  `release/windows/provenance/${releaseId}-VERSION.txt`,
  `release/windows/${identity.installerName}.sha256`,
]);
// Untrimmed: a porcelain line starts with a two-column status that may begin with a space.
const dirty = run('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT })
  .stdout.split('\n')
  .filter((line) => line.trim() !== '' && !ownOutputs.has(line.slice(3)));
if (dirty.length > 0) fatal(`the working tree is not clean:\n${dirty.join('\n')}`);
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch === 'HEAD') fatal('HEAD is detached; build from the pushed release branch');
const provenanceArgs = [
  join(ROOT, 'scripts', 'windows', 'assert-release-provenance.mjs'),
  '--commit',
  sourceCommit,
  '--release-id',
  releaseId,
  '--branch',
  branch,
];
if (process.argv.includes('--offline-provenance')) provenanceArgs.push('--offline');
run(process.execPath, provenanceArgs, { cwd: ROOT, stdio: 'inherit' });
console.log('');

/* --------------------------------------------------- 2. the product input is the signed-off one */
console.log('2. product baseline: input scope');
run('git', ['merge-base', '--is-ancestor', PRODUCT_BASELINE, sourceCommit], { cwd: ROOT });
const changed = git('diff', '--name-only', PRODUCT_BASELINE, sourceCommit)
  .split('\n')
  .filter(Boolean);
const touchedProduct = changed.filter((p) =>
  PRODUCT_INPUTS.some((input) => (input.endsWith('/') ? p.startsWith(input) : p === input)),
);
if (touchedProduct.length > 0) {
  fatal(`product inputs changed since the baseline: ${touchedProduct.join(', ')}`);
}

function withoutVersion(text, lock) {
  const json = JSON.parse(text);
  delete json.version;
  if (lock && json.packages?.['']) delete json.packages[''].version;
  return JSON.stringify(json);
}
for (const [file, lock] of [
  ['package.json', false],
  ['package-lock.json', true],
]) {
  const before = git('show', `${PRODUCT_BASELINE}:${file}`);
  const after = git('show', `${sourceCommit}:${file}`);
  if (withoutVersion(before, lock) !== withoutVersion(after, lock)) {
    fatal(`${file} differs from the baseline in more than its version field`);
  }
}
console.log(
  `   ${String(changed.length)} path(s) differ from ${PRODUCT_BASELINE.slice(0, 12)}; none is a product input,`,
);
console.log('   and package.json / package-lock.json differ in their version field only');

/* ---------------------------------------------- 3. build both trees and prove the outputs agree */
console.log('3. product baseline: output identity (two clean builds)');
const stage = join(ROOT, 'release', 'windows', '.build', releaseId);

function removeTree(dir) {
  const link = join(dir, 'node_modules');
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) rmSync(link);
  rmSync(dir, { recursive: true, force: true });
}

/* The lockfile says what node_modules must hold; a junctioned node_modules is only acceptable if it holds
 * exactly that. npm writes node_modules/.package-lock.json as the record of what it installed. */
const installed = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', '.package-lock.json'), 'utf8'),
);
const locked = JSON.parse(git('show', `${sourceCommit}:package-lock.json`));
for (const [path, entry] of Object.entries(locked.packages)) {
  if (path === '' || entry.optional || entry.peer) continue;
  const have = installed.packages[path];
  if (!have || have.version !== entry.version || have.integrity !== entry.integrity) {
    fatal(`node_modules does not match package-lock.json at ${path}; run npm ci first`);
  }
}

/* A clean export of one commit, through a private index rather than `git archive | tar`: which `tar` a
 * child process finds depends on PATH, and Git for Windows' GNU tar reads "F:\..." as a remote host. */
function buildExport(commit, label) {
  const tree = join(stage, `tree-${label}`);
  removeTree(tree);
  mkdirSync(tree, { recursive: true });
  const indexEnv = { ...process.env, GIT_INDEX_FILE: join(stage, `index-${label}`) };
  run('git', ['read-tree', commit], { cwd: ROOT, env: indexEnv });
  run('git', ['checkout-index', '-a', `--prefix=${tree.split('\\').join('/')}/`], {
    cwd: ROOT,
    env: indexEnv,
  });
  rmSync(indexEnv.GIT_INDEX_FILE);
  symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'), 'junction');
  // npm's own entry point under the Node running this script, so the build uses exactly that Node and
  // no shell: npm.cmd can only be spawned through a shell, which concatenates arguments unescaped.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli))
    fatal(`${npmCli} is not present; run with a Node distribution that bundles npm`);
  run(process.execPath, [npmCli, 'run', 'build'], { cwd: tree });
  return join(tree, 'dist');
}

mkdirSync(stage, { recursive: true });
const baselineDist = buildExport(PRODUCT_BASELINE, 'baseline');
const sourceDist = buildExport(sourceCommit, 'source');
const baselineFiles = walk(baselineDist);
const sourceFiles = walk(sourceDist);
if (baselineFiles.join('\n') !== sourceFiles.join('\n')) {
  fatal(
    `the two builds emit different file sets:\n  baseline: ${baselineFiles.join(', ')}\n  source:   ${sourceFiles.join(', ')}`,
  );
}
if (baselineFiles.length === 0) fatal('the baseline build produced no files');
const differingBuild = sourceFiles.filter(
  (rel) => fileDigest(join(baselineDist, rel)) !== fileDigest(join(sourceDist, rel)),
);
if (differingBuild.length > 0) {
  fatal(`the source build differs from the baseline build in: ${differingBuild.join(', ')}`);
}
console.log(
  `   ${String(sourceFiles.length)} file(s): the source build is byte-identical to the baseline build`,
);

/* ------------------------------------------------ 4. data-format facts, derived from the source */
function sourceConstant(file, name) {
  const text = git('show', `${sourceCommit}:${file}`);
  const matches = [...text.matchAll(new RegExp(`^export const ${name} = ([0-9]+);$`, 'gm'))];
  if (matches.length !== 1)
    fatal(`expected exactly one ${name} in ${file}, found ${matches.length}`);
  return Number(matches[0][1]);
}
const databaseSchemaVersion = sourceConstant('src/db/schema.ts', 'SCHEMA_VERSION');
const backupFormatVersion = sourceConstant(
  'src/services/backup/compatibility.ts',
  'BACKUP_FORMAT_VERSION',
);
console.log(
  `4. data format: databaseSchemaVersion=${String(databaseSchemaVersion)}, backupFormatVersion=${String(backupFormatVersion)}`,
);

/* ------------------------------------------------------- 5. icon and Windows resource objects
 *
 * The icon is checked rather than regenerated: it is a committed artefact, and silently rebuilding it
 * during a release would let the committed file and the shipped one drift apart. The resource objects
 * ARE generated here, because they embed the release identity and so belong to the build.
 */
console.log('5. icon and Windows resources');
run(process.execPath, [join(ROOT, 'scripts', 'windows', 'generate-ico.mjs'), '--check'], {
  cwd: ROOT,
});
run(
  process.execPath,
  [join(ROOT, 'scripts', 'windows', 'generate-winres.mjs'), '--release-id', releaseId],
  { cwd: ROOT },
);
console.log('   icon verified against its generator; resource objects written');

/* ------------------------------------------------------------------ 6. the Go binaries */
console.log('6. building the Windows binaries');
const goExe = join(GO_ROOT, 'bin', 'go.exe');
if (!existsSync(goExe)) fatal(`${goExe} is not present; set CIVIC_GOROOT to a Go 1.27 tree`);
const srcDir = join(ROOT, 'deploy', 'windows', 'src');
const binStage = join(stage, 'bin');
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
   * -buildvcs=false keeps the git commit out, so the binaries are reproducible from a source tree; the
   * commit is recorded in VERSION. -H=windowsgui on the launcher only: it is what a shortcut runs, and a
   * console-subsystem binary flashes a black window on every click. */
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

/* ------------------------------------------------------------------ 7. assemble the payload */
console.log('7. assembling the release payload');
const payload = join(ROOT, 'release', 'windows', identity.payloadName);
rmSync(payload, { recursive: true, force: true });
mkdirSync(join(payload, 'app'), { recursive: true });
mkdirSync(join(payload, 'server'), { recursive: true });
cpSync(sourceDist, join(payload, 'app'), { recursive: true });
for (const binary of SERVER_BINARIES) {
  cpSync(join(binStage, binary.out), join(payload, 'server', binary.out));
}

/* The entry points, read from the built index.html rather than guessed from a glob, so the health file
 * names what the page actually loads. */
const indexHtml = readFileSync(join(payload, 'app', 'index.html'), 'utf8');
const entryJs = [...indexHtml.matchAll(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"/g)];
const entryCss = [
  ...indexHtml.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"/g),
];
if (entryJs.length !== 1 || entryCss.length !== 1) {
  fatal(
    `index.html must load exactly one module script and one stylesheet (found ${entryJs.length} and ${entryCss.length})`,
  );
}
for (const entry of [entryJs[0][1], entryCss[0][1]]) {
  if (!existsSync(join(payload, 'app', entry)))
    fatal(`index.html loads ${entry}, which is missing`);
}

/* The interface generation (Phase 5.1): app-generation.json is part of the product build, and civic-server
 * serves it to the page and to the update check page from its runtime endpoint. It must name exactly the entry
 * script index.html loads, or the page and the server would disagree about which interface is current. */
const generationDoc = JSON.parse(readFileSync(join(payload, 'app', 'app-generation.json'), 'utf8'));
const entryHash = /^assets\/index-([A-Za-z0-9_-]{6,64})\.js$/.exec(entryJs[0][1])?.[1];
if (
  generationDoc.schema !== 'civic-app-generation/1' ||
  entryHash === undefined ||
  generationDoc.appGeneration !== `ui-${entryHash}` ||
  generationDoc.entry !== entryJs[0][1]
) {
  fatal(
    `app-generation.json does not describe the entry script index.html loads: ${JSON.stringify(generationDoc)}`,
  );
}
const appGeneration = generationDoc.appGeneration;
const baselineGeneration = JSON.parse(
  readFileSync(join(baselineDist, 'app-generation.json'), 'utf8'),
).appGeneration;
if (baselineGeneration !== appGeneration) {
  fatal(`the baseline build is ${baselineGeneration} but the payload is ${appGeneration}`);
}
console.log(`   interface generation ${appGeneration} (entry ${entryJs[0][1]}, ${entryCss[0][1]})`);

/* The server's own version string, read from its source rather than retyped here. */
const serverVersionMatches = [
  ...git('show', `${sourceCommit}:deploy/windows/src/cmd/civic-server/main.go`).matchAll(
    /^\s*serverVersion\s*=\s*"([^"]+)"/gm,
  ),
];
if (serverVersionMatches.length !== 1) fatal('expected exactly one serverVersion in civic-server');
const serverVersion = serverVersionMatches[0][1];
const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const health = {
  application: 'civic-work-desk',
  releaseChannel: 'windows-x64',
  releaseId,
  appVersion: identity.displayVersion,
  productVersion: identity.productVersion,
  displayVersion: identity.displayVersion,
  databaseSchemaVersion,
  backupFormatVersion,
  canonicalOrigin: 'http://127.0.0.1:8765',
  applicationCommit: PRODUCT_BASELINE,
  deploymentSourceCommit: sourceCommit,
  builtAt,
  entry: { js: entryJs[0][1], css: entryCss[0][1] },
  appGeneration,
  note: 'Deployment health probe. Contains no personal data and no secrets. The launcher fetches this to confirm the server at the canonical origin is serving the expected release before opening the browser; civic-admin reads databaseSchemaVersion to refuse a rollback that would put an older application in front of newer records.',
};
writeFileSync(
  join(payload, 'app', 'deployment-health.json'),
  `${JSON.stringify(health, null, 2)}\n`,
  'utf8',
);

/* Assert the claim rather than trusting it: app/ is the verified build plus exactly the declared file. */
const declaredAdditions = new Set(['deployment-health.json']);
const appFiles = walk(join(payload, 'app'));
const extra = appFiles.filter((p) => !sourceFiles.includes(p));
const unexpected = extra.filter((p) => !declaredAdditions.has(p));
const missingAddition = [...declaredAdditions].filter((p) => !extra.includes(p));
const alteredInCopy = sourceFiles.filter(
  (rel) => fileDigest(join(payload, 'app', rel)) !== fileDigest(join(sourceDist, rel)),
);
if (unexpected.length > 0) fatal(`app/ carries undeclared files: ${unexpected.join(', ')}`);
if (missingAddition.length > 0) fatal(`declared additions missing: ${missingAddition.join(', ')}`);
if (alteredInCopy.length > 0) fatal(`app/ files altered in the copy: ${alteredInCopy.join(', ')}`);
console.log(
  `   app/ is the verified build (${String(sourceFiles.length)} files) plus ${[...declaredAdditions].join(', ')}`,
);

/* ------------------------------------------------------------------ 8. VERSION and the manifest */
const version = [
  'CivicWorkDesk Windows release candidate',
  `releaseId=${releaseId}`,
  'releaseChannel=windows-x64',
  `productVersion=${identity.productVersion}`,
  `displayVersion=${identity.displayVersion}`,
  `windowsVersion=${identity.windowsVersion}`,
  `appVersion=${identity.displayVersion}`,
  `databaseSchemaVersion=${String(databaseSchemaVersion)}`,
  `backupFormatVersion=${String(backupFormatVersion)}`,
  `publisher=${identity.publisher}`,
  `productBaselineCommit=${PRODUCT_BASELINE}`,
  `applicationCommit=${PRODUCT_BASELINE}`,
  'applicationPayloadSource=dist/ built from deploymentSourceCommit in a clean export of the committed tree (git read-tree + checkout-index)',
  // Derived from what the checks above verified, not retyped.
  `applicationPayloadUnchanged=YES — byte-identical to a clean build of productBaselineCommit (${String(sourceFiles.length)} files), plus ${[...declaredAdditions].join(', ')}`,
  `appGeneration=${appGeneration}`,
  `entryScript=${entryJs[0][1]}`,
  `entryStylesheet=${entryCss[0][1]}`,
  `deploymentSourceCommit=${sourceCommit}`,
  'canonicalOrigin=http://127.0.0.1:8765',
  `server=${serverVersion} (Go net/http, standard library only)`,
  `goToolchain=${GO_VERSION}`,
  'goBuildFlags=-trimpath -buildvcs=false -ldflags="-s -w" (civic-launch adds -H=windowsgui); CGO_ENABLED=0 GOOS=windows GOARCH=amd64',
  `nodeToolchain=${NODE_VERSION} (build time only)`,
  'windowsResources=hand-written COFF (.syso): icon + VERSIONINFO, no external resource tool',
  `installerToolchain=${INNO_VERSION}`,
  'supportedWindows=Windows 11 x64 (build 22000 or later, primary); Windows 10 22H2 x64 (build 19045, legacy target)',
  'nodeRequired=NO',
  'pythonRequired=NO',
  'powershellRequired=NO',
  'dotnetRequired=NO',
  'adminRequired=NO',
  'codeSigned=NO — unsigned; Authenticode signing is a backlog item',
  `builtAt=${builtAt}`,
  'builtOn=development workstation, Windows 11 x64',
  'phase=Phase 6 Windows 0.2.0 release engineering (field-validation candidate)',
  'windowsCompatibilityCertified=NO',
  'windows11Validation=development workstation only; not certified',
  'windows10Validation=NOT YET — awaits the Windows 10 22H2 x64 legacy-compatibility validation on a real machine',
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
console.log(`8. VERSION and SHA256SUMS.txt written (${String(manifestLines.length)} files)`);

/* The payload shape must match layout.RequiredReleaseEntries exactly, or civic-admin will refuse it. */
const shape = readdirSync(payload).sort();
const wantShape = ['SHA256SUMS.txt', 'VERSION', 'app', 'server'];
if (shape.join(',') !== wantShape.join(',')) {
  fatal(
    `payload shape is ${shape.join(', ')}; civic-admin requires exactly ${wantShape.join(', ')}`,
  );
}

/* ------------------------------------------------------------------ 9. the installer */
const outDir = join(ROOT, 'release', 'windows');
const setupPath = join(outDir, identity.installerName);
if (!skipInstaller) {
  console.log('9. compiling the installer');
  if (!existsSync(ISCC)) fatal(`${ISCC} is not present; set CIVIC_ISCC or pass --skip-installer`);
  const sidecarPath = `${setupPath}.sha256`;

  /*
   * The installer is NOT bit-reproducible; the payload IS. Inno Setup embeds non-deterministic data, so
   * the installer's digest identifies ONE published artifact, not "whatever this script produces".
   * Refusing to overwrite is what keeps a recompile from silently invalidating a digest already quoted
   * in release notes; --force-installer is the deliberate way to cut a new one.
   */
  if (existsSync(setupPath) && !process.argv.includes('--force-installer')) {
    const existing = fileDigest(setupPath);
    const recorded = existsSync(sidecarPath)
      ? readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0]
      : '(no sidecar)';
    console.log(`   ${identity.installerName} already exists; NOT recompiling it.`);
    console.log(`   on disk : ${existing}`);
    console.log(`   sidecar : ${recorded}`);
    if (existing !== recorded) {
      fatal('the existing installer does not match its sidecar; resolve that before building');
    }
    console.log('   Pass --force-installer to cut a new installer.');
  } else {
    run(
      ISCC,
      [
        `/DCivicPayload=${payload}`,
        `/DCivicReleaseId=${releaseId}`,
        // VersionInfoVersion takes up to four numbers; never the pre-release text.
        `/DCivicAppVersion=${identity.windowsVersion}`,
        `/DCivicDisplayVersion=${identity.displayVersion}`,
        `/DCivicPublisher=${identity.publisher}`,
        // The installer refuses, in words, to go over an installation with a newer browser database.
        `/DCivicSchemaVersion=${String(databaseSchemaVersion)}`,
        `/DCivicOutDir=${outDir}`,
        `/DCivicOutBase=${identity.setupBase}`,
        join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.iss'),
      ],
      { cwd: ROOT },
    );
    if (!existsSync(setupPath))
      fatal(`Inno Setup reported success but ${setupPath} does not exist`);
    const digest = fileDigest(setupPath);
    writeFileSync(sidecarPath, `${digest}  ${identity.installerName}\n`, 'utf8');
    console.log(`   ${identity.installerName}  ${String(statSync(setupPath).size)} bytes`);
    console.log(`   sha256  ${digest}`);
  }

  /* The tester instructions travel beside the installer. GitHub strips non-ASCII characters from asset
   * names, so the published copy has an ASCII name; UTF-8 with a BOM, because it is opened in Notepad on
   * a Chinese-locale machine. */
  const noticeSource = join(ROOT, 'deploy', 'windows', 'installer', 'README-测试说明.txt');
  const noticeBody = readFileSync(noticeSource);
  const noticeText = noticeBody.toString('utf8');
  /* The instructions quote the installer's own filename and version. If either changed and the notice was
   * not updated, a tester would check the wrong file and conclude nothing. */
  for (const required of [identity.installerName, identity.displayVersion]) {
    if (!noticeText.includes(required)) fatal(`README-测试说明.txt does not name ${required}`);
  }
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const notice = noticeBody.subarray(0, 3).equals(bom)
    ? noticeBody
    : Buffer.concat([bom, noticeBody]);
  writeFileSync(join(outDir, 'README-testing-zh-CN.txt'), notice);
  console.log(`   README-testing-zh-CN.txt  ${String(notice.length)} bytes`);
}

/* ------------------------------------------------------------ 10. reproducible provenance, tracked */
const provenanceDir = join(outDir, 'provenance');
mkdirSync(provenanceDir, { recursive: true });
writeFileSync(
  join(provenanceDir, `${releaseId}-payload-SHA256SUMS.txt`),
  readFileSync(join(payload, 'SHA256SUMS.txt')),
);
writeFileSync(
  join(provenanceDir, `${releaseId}-VERSION.txt`),
  readFileSync(join(payload, 'VERSION')),
);
console.log('10. provenance written to release/windows/provenance/ (payload manifest and VERSION)');

removeTree(join(stage, 'tree-baseline'));
removeTree(join(stage, 'tree-source'));

console.log('');
console.log('summary');
console.log(`  payload            : ${payload}`);
console.log(`  files in manifest  : ${String(manifestLines.length)}`);
console.log(`  product baseline   : ${PRODUCT_BASELINE}`);
console.log(`  deployment source  : ${sourceCommit}`);
if (!skipInstaller) {
  console.log(`  installer          : ${setupPath}`);
  console.log(`  installer sha256   : ${fileDigest(setupPath)}`);
}
console.log('');
console.log('  Windows compatibility is NOT certified by this build.');
