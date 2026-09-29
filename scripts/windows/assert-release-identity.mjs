#!/usr/bin/env node
/**
 * Prove that every place claiming to describe the current release says the same thing about it.
 *
 *   node scripts/windows/assert-release-identity.mjs --release-id <id> [--installed] [--today YYYY.MM.DD]
 *
 * The expected identity is derived by release-identity.mjs from package.json, product-identity.json and
 * the release id -- the same derivation the build used -- and then read back out of every artifact that
 * carries it:
 *
 *   - the tracked installer script, which must take every identity field from a build define;
 *   - the built installer's version resource (Properties > Details);
 *   - the four payload executables' version resources and bytes;
 *   - VERSION and app/deployment-health.json;
 *   - the tester notice;
 *   - with --installed, the per-user Add/Remove Programs entry that installing the build wrote.
 *
 * ## The defect class this exists to catch
 *
 * RC2 shipped an installer whose Properties dialog said RC1; RC1-RC3 all named "CivicWorkDesk" as their
 * publisher and embedded "(windows-rc1)" in the server's health output. Each was a string nothing
 * downstream read. So this reads every such string, compares it with the derived identity, and fails on
 * the first disagreement. Contextual mentions of earlier releases in documents are not examined: they
 * are not claims about the current release.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessDateUtc8, loadReleaseIdentity } from './release-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/* A literal BOM in source is an invisible character. Built from its code point instead; PowerShell needs
 * it to read a UTF-8 script correctly. */
const BOM = String.fromCharCode(0xfeff);
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : undefined;
}
const INSTALLED = process.argv.includes('--installed');
/* The identity rule refuses a release date later than today; checking an artifact built yesterday is
 * fine, and --today lets a later audit name the day it is run against. */
const identity = loadReleaseIdentity(
  ROOT,
  argValue('--release-id'),
  argValue('--today') ?? businessDateUtc8(),
);
const RELEASE_ID = identity.releaseId;
const OUT = join(ROOT, 'release', 'windows');
const PAYLOAD = join(OUT, identity.payloadName);
const APP_ID_KEY = '{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}_is1';
const RC_LABEL = /\bRC[0-9]+\b|-rc[0-9]+\b|windows-rc[0-9]/i;

const results = [];
let failures = 0;
function check(ok, name, detail = '') {
  results.push({ ok, name, detail });
  if (!ok) failures += 1;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  --  ${detail}` : ''}`);
}
function section(t) {
  console.log('');
  console.log(`== ${t} ${'='.repeat(Math.max(0, 70 - t.length))}`);
}

function ps(script, ...args) {
  const scriptPath = join(process.env.TEMP ?? '.', 'civic-identity-probe.ps1');
  const outPath = join(process.env.TEMP ?? '.', 'civic-identity-probe.out');
  rmSync(outPath, { force: true });
  writeFileSync(scriptPath, `${BOM}${script}\n`, 'utf8');
  spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, outPath, ...args],
    { encoding: 'utf8', windowsHide: true },
  );
  const text = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(BOM, '').trim() : '';
  rmSync(outPath, { force: true });
  rmSync(scriptPath, { force: true });
  return text;
}

function parsePairs(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => {
        const [k, ...rest] = l.split('=');
        return [k.trim(), rest.join('=').trim()];
      }),
  );
}

/** Every string field of a file's version resource. */
function versionInfo(path) {
  return parsePairs(
    ps(
      `$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($args[1])
$lines = @()
foreach ($k in 'CompanyName','FileDescription','FileVersion','ProductName','ProductVersion','LegalCopyright','Comments') {
  $lines += $k + '=' + $v.$k
}
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`,
      path,
    ),
  );
}

const copyright = `© ${identity.releaseDate.slice(0, 4)} ${identity.publisher}. 保留所有权利。`;

console.log('CivicWorkDesk current-release identity assertion');
console.log('');
console.log(`  release id      : ${RELEASE_ID}`);
console.log(`  display version : ${identity.displayVersion}  (Windows ${identity.windowsVersion})`);
console.log(`  publisher       : ${identity.publisher}`);

// --------------------------------------------------------------------- 1. tracked installer script
section('1. the tracked installer script takes every identity field from the build');
const iss = readFileSync(
  join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.iss'),
  'utf8',
);
const directive = (name) =>
  iss
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? '(absent)';
for (const [name, want] of [
  ['AppVersion', '{#CivicDisplayVersion}'],
  ['AppVerName', '{#CivicAppName} {#CivicDisplayVersion}'],
  ['AppPublisher', '{#CivicPublisher}'],
  ['AppCopyright', '© {#CivicCopyrightYear} {#CivicPublisher}. 保留所有权利。'],
  ['VersionInfoVersion', '{#CivicAppVersion}'],
  ['VersionInfoProductVersion', '{#CivicAppVersion}'],
  ['VersionInfoTextVersion', '{#CivicAppVersion}'],
  ['VersionInfoProductTextVersion', '{#CivicDisplayVersion}'],
  ['VersionInfoCompany', '{#CivicPublisher}'],
  ['MinVersion', '10.0.19045'],
  ['ArchitecturesAllowed', 'x64os'],
]) {
  check(directive(name) === want, `${name}=${want}`, directive(name));
}

/* The Windows 10 end-of-support sentence is said by the installer, the preflight and civic-diag. It is
 * written twice -- once in Go, once in Pascal -- so the two copies are compared here, literal by literal. */
const platformGo = readFileSync(
  join(ROOT, 'deploy', 'windows', 'src', 'internal', 'platform', 'platform.go'),
  'utf8',
);
const goNotice = /const EndOfSupportNotice = ((?:"[^"]*"\s*\+?\s*)+)/
  .exec(platformGo)?.[1]
  .match(/"([^"]*)"/g)
  ?.map((s) => s.slice(1, -1))
  .join('');
const issNotice = /MsgBox\(('Windows 10 已于[\s\S]*?), mbInformation/
  .exec(iss)?.[1]
  .match(/'([^']*)'/g)
  ?.map((s) => s.slice(1, -1))
  .join('');
check(
  goNotice !== undefined && goNotice.length > 20 && goNotice === issNotice,
  'the installer and the Go tools say the same Windows 10 end-of-support sentence',
  issNotice ?? '(not found in the installer)',
);
check(
  /#ifndef CivicPublisher\s+#error/.test(iss) && !/#define CivicPublisher "/.test(iss),
  'the publisher is a required define, never a literal',
);
check(/#ifndef CivicDisplayVersion\s+#error/.test(iss), 'the display version is a required define');
const versionDirectives = iss.split(/\r?\n/).filter((l) => /^(App|VersionInfo)[A-Za-z]*=/.test(l));
check(
  versionDirectives.every((l) => !RC_LABEL.test(l)),
  'no version or identity directive carries a release-candidate literal',
);

section('1b. the build scripts carry no default release id');
for (const script of [
  'build-release.mjs',
  'generate-winres.mjs',
  'assert-release-provenance.mjs',
  'assert-release-identity.mjs',
  'scan-release-artifact.mjs',
]) {
  const text = readFileSync(join(ROOT, 'scripts', 'windows', script), 'utf8');
  const literal = /['"`][0-9]{4}\.[0-9]{2}\.[0-9]{2}-win-[^'"`]*['"`]/.exec(text);
  check(literal === null, `${script} has no quoted release-id literal`, literal?.[0] ?? '');
}

// --------------------------------------------------------------------- 2. the built installer
section('2. the built installer');
const setup = join(OUT, identity.installerName);
if (!existsSync(setup)) {
  console.error(`error: ${setup} does not exist. Build ${RELEASE_ID} first.`);
  process.exit(2);
}
const setupInfo = versionInfo(setup);
check(
  setupInfo.ProductVersion === identity.displayVersion,
  'installer ProductVersion',
  setupInfo.ProductVersion,
);
check(
  setupInfo.FileVersion === identity.windowsVersion,
  'installer FileVersion',
  setupInfo.FileVersion,
);
check(setupInfo.CompanyName === identity.publisher, 'installer CompanyName', setupInfo.CompanyName);
check(setupInfo.LegalCopyright === copyright, 'installer LegalCopyright', setupInfo.LegalCopyright);
check(
  (setupInfo.FileDescription ?? '').includes(identity.displayVersion) &&
    !RC_LABEL.test(setupInfo.FileDescription ?? ''),
  'installer FileDescription names this version and no RC label',
  setupInfo.FileDescription,
);
check(
  setupInfo.ProductName === `${identity.productNameZh} (${identity.productNameEn})`,
  'installer ProductName',
  setupInfo.ProductName,
);
const sidecar = `${setup}.sha256`;
check(existsSync(sidecar), 'the installer has a .sha256 sidecar');
if (existsSync(sidecar)) {
  const [digest, name] = readFileSync(sidecar, 'utf8').trim().split(/\s+/);
  const actual = spawnSync('certutil', ['-hashfile', setup, 'SHA256'], { encoding: 'utf8' })
    .stdout.split(/\r?\n/)[1]
    ?.replace(/\s+/g, '')
    .toLowerCase();
  check(name === identity.installerName, 'the sidecar names the installer', name);
  check(digest === actual, 'the sidecar digest is the installer digest', digest);
}

// --------------------------------------------------------------------- 3. payload executables
section('3. the payload executables');
for (const exe of ['civic-launch.exe', 'civic-diag.exe']) {
  const path = join(PAYLOAD, 'server', exe);
  if (!existsSync(path)) {
    check(false, `${exe} is present in the payload`, path);
    continue;
  }
  const v = versionInfo(path);
  check(v.ProductVersion === identity.displayVersion, `${exe} ProductVersion`, v.ProductVersion);
  check(v.FileVersion === identity.windowsVersion, `${exe} FileVersion`, v.FileVersion);
  check(v.CompanyName === identity.publisher, `${exe} CompanyName`, v.CompanyName);
  check(v.LegalCopyright === copyright, `${exe} LegalCopyright`, v.LegalCopyright);
  check(v.Comments === `release ${RELEASE_ID}`, `${exe} Comments names the release id`, v.Comments);
}
for (const exe of ['civic-server.exe', 'civic-launch.exe', 'civic-diag.exe', 'civic-admin.exe']) {
  const path = join(PAYLOAD, 'server', exe);
  const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
  const text = `${bytes.toString('latin1')}\n${bytes.toString('utf16le')}`;
  check(bytes.length > 0 && !/windows-rc[0-9]|win-rc[0-9]/.test(text), `${exe} embeds no RC label`);
}

// --------------------------------------------------------------------- 4. payload metadata
section('4. payload metadata');
const version = parsePairs(readFileSync(join(PAYLOAD, 'VERSION'), 'utf8'));
for (const [key, want] of [
  ['releaseId', RELEASE_ID],
  ['productVersion', identity.productVersion],
  ['displayVersion', identity.displayVersion],
  ['windowsVersion', identity.windowsVersion],
  ['appVersion', identity.displayVersion],
  ['publisher', identity.publisher],
  ['releaseChannel', 'windows-x64'],
  ['canonicalOrigin', 'http://127.0.0.1:8765'],
]) {
  check(version[key] === want, `VERSION ${key}`, version[key]);
}
check(
  (version.phase ?? '').startsWith('Phase 6') && !RC_LABEL.test(version.phase ?? ''),
  'VERSION phase is Phase 6 with no RC label',
  version.phase,
);
check(
  /^[1-9][0-9]*$/.test(version.databaseSchemaVersion ?? '') &&
    /^[1-9][0-9]*$/.test(version.backupFormatVersion ?? ''),
  'VERSION carries the data-format versions',
  `schema ${version.databaseSchemaVersion}, backup ${version.backupFormatVersion}`,
);
const health = JSON.parse(readFileSync(join(PAYLOAD, 'app', 'deployment-health.json'), 'utf8'));
for (const [key, want] of [
  ['releaseId', RELEASE_ID],
  ['releaseChannel', 'windows-x64'],
  ['displayVersion', identity.displayVersion],
  ['productVersion', identity.productVersion],
  ['databaseSchemaVersion', Number(version.databaseSchemaVersion)],
  ['backupFormatVersion', Number(version.backupFormatVersion)],
  ['deploymentSourceCommit', version.deploymentSourceCommit],
  ['applicationCommit', version.productBaselineCommit],
]) {
  check(health[key] === want, `deployment-health.json ${key}`, String(health[key]));
}

// --------------------------------------------------------------------- 5. the tester notice
section('5. the tester notice');
const notice = readFileSync(
  join(ROOT, 'deploy', 'windows', 'installer', 'README-测试说明.txt'),
  'utf8',
);
check(
  notice.includes(identity.installerName),
  'the notice names this installer',
  identity.installerName,
);
check(notice.includes(identity.displayVersion), 'the notice names this version');
check(notice.includes(identity.publisher), 'the notice names the publisher');
/* Earlier candidates may be mentioned only where the line explains the relationship. */
const strayLines = notice
  .split(/\r?\n/)
  .filter((l) => /\bRC[0-9]\b/.test(l))
  .filter((l) => !/取代|替代|不要|请勿|以前|此前|旧|回退|RC1–RC3|RC1-RC3/.test(l));
check(
  strayLines.length === 0,
  'no stray earlier-release mention in the notice',
  strayLines.join(' | '),
);
const published = readFileSync(join(OUT, 'README-testing-zh-CN.txt'));
const source = readFileSync(join(ROOT, 'deploy', 'windows', 'installer', 'README-测试说明.txt'));
check(
  published.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) &&
    published
      .subarray(3)
      .equals(
        source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? source.subarray(3) : source,
      ),
  'README-testing-zh-CN.txt is the tracked notice, byte for byte, with a BOM',
);

// --------------------------------------------------------------------- 6. installed-program entry
if (INSTALLED) {
  section('6. the installed-program entry (HKCU)');
  const reg = parsePairs(
    ps(
      `$p = Get-ItemProperty -Path ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $args[1]) -ErrorAction SilentlyContinue
$lines = @()
if ($p) { foreach ($k in 'DisplayName','DisplayVersion','Publisher','InstallLocation','DisplayIcon','URLInfoAbout') { $lines += $k + '=' + $p.$k } }
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`,
      APP_ID_KEY,
    ),
  );
  check(reg.DisplayName === identity.productNameZh, 'DisplayName', reg.DisplayName);
  check(reg.DisplayVersion === identity.displayVersion, 'DisplayVersion', reg.DisplayVersion);
  check(reg.Publisher === identity.publisher, 'Publisher', reg.Publisher);
  check(
    (reg.DisplayIcon ?? '').toLowerCase().includes('civic-launch.exe'),
    'DisplayIcon',
    reg.DisplayIcon,
  );
}

// --------------------------------------------------------------------- summary
console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  failed : ${failures}`);
console.log('');
if (results.length < 40) {
  console.log(
    'RESULT: FAIL — fewer checks ran than expected; the audit cannot vouch for the release',
  );
  process.exit(1);
}
if (failures === 0) {
  console.log(`RESULT: PASS — every current-release field agrees with ${RELEASE_ID}`);
  process.exit(0);
}
console.log('RESULT: FAIL');
process.exit(1);
