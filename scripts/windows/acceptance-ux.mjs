#!/usr/bin/env node
/**
 * Acceptance for the distribution surface: installation paths, icons, shortcuts, Start Menu, install-failure
 * diagnostics, diagnostic privacy, and copy.
 *
 *   node scripts/windows/acceptance-ux.mjs --release-id <id>
 *
 * The release id is required (it used to default to an RC3 id), and the upgrade is tested from the RC3
 * installer as published on GitHub, digest-verified, never from a local rebuild.
 *
 * The deployment and browser properties are re-proved by scripts/windows/acceptance-deploy.mjs and
 * scripts/windows/acceptance-browser.mjs, which this does not duplicate. Everything here is driven from
 * the ACTUAL installer bytes and asserts concrete final state — a shortcut's resolved target, the bytes
 * of an icon resource, the text of a report — rather than exit codes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { obtainPublishedInstaller } from './published-installer.mjs';
import { businessDateUtc8, loadReleaseIdentity } from './release-identity.mjs';
import { silentUninstall } from './silent-uninstall.mjs';
import { readyPageOf } from './wizard-probe.mjs';

/** The Ready page's pre-install warning, shown on a real upgrade only (Phase 6). */
const UPGRADE_WARNING = '升级前请保存并关闭已打开的政务工作记录台页面。';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const IDENTITY = loadReleaseIdentity(
  ROOT,
  argValue('--release-id', undefined),
  argValue('--today', undefined) ?? businessDateUtc8(),
  'audit',
);
const RELEASE_ID = IDENTITY.releaseId;
const SETUP = join(ROOT, 'release', 'windows', IDENTITY.installerName);
// The immediately previous PUBLISHED release, for the in-place upgrade test: RC3 is what a colleague
// already has when 0.2.0-rc.1 reaches them. Its published bytes, digest-verified -- a local rebuild would
// be a different artifact, since Inno Setup output is not reproducible.
const PREVIOUS_ID = '2026.09.24-win-rc3';
let PREVIOUS_SETUP = '';
let PREVIOUS_SOURCE;
try {
  const published = obtainPublishedInstaller(ROOT, PREVIOUS_ID);
  PREVIOUS_SETUP = published.path;
  PREVIOUS_SOURCE = `${published.sha256} (${published.source})`;
} catch (err) {
  PREVIOUS_SOURCE = String(err);
}
const DEFAULT_ROOT = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'CivicWorkDesk',
);
const APPDATA = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
const START_MENU = join(
  APPDATA,
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  '政务工作记录台',
);
const DESKTOP = join(process.env.USERPROFILE ?? homedir(), 'Desktop');
const ORIGIN = 'http://127.0.0.1:8765';
const WORK = join(tmpdir(), 'civic-ux-acceptance');
const SEP = String.fromCharCode(92);
const JOIN_D = 'D:' + SEP;
/* Identity-shaped directory names for the adversarial privacy cases. Written as escapes so this
 * source file carries nothing that could be mistaken for real personal data. */
const CHINESE_NAME = '\u5f20\u4e09';
const CHINESE_APP = '\u653f\u52a1\u5de5\u4f5c\u8bb0\u5f55\u53f0';
const CHINESE_ORG = '\u67d0\u5355\u4f4d';
const CHINESE_PERSON = '\u674e\u67d0';
const DIAGWORD = '\u8bca\u65ad\u4fe1\u606f';

/* Sentences the installer must contain, by meaning rather than by marker. Escapes keep this file
 * ASCII-clean while still asserting on the real user-facing text. */
// \u8be5\u76ee\u5f55\u4f1a\u5728\u5b89\u88c5\u7a0b\u5e8f\u9000\u51fa\u65f6\u88ab\u6e05\u7406\u3002
const TEMP_WARNING =
  '\u8be5\u76ee\u5f55\u4f1a\u5728\u5b89\u88c5\u7a0b\u5e8f\u9000\u51fa\u65f6\u88ab\u6e05\u7406\u3002';
// \u8bf7\u5148\u5c06\u8be5\u6587\u4ef6\u53e6\u5b58\u5230\u684c\u9762
const SAVE_FIRST = '\u8bf7\u5148\u5c06\u8be5\u6587\u4ef6\u53e6\u5b58\u5230\u684c\u9762';
// \u8bca\u65ad\u6587\u4ef6\u5df2\u4fdd\u5b58\u81f3\uff1a
const DIAG_SAVED = '\u8bca\u65ad\u6587\u4ef6\u5df2\u4fdd\u5b58\u81f3\uff1a';
// \u684c\u9762\u3001\u7528\u6237\u76ee\u5f55\u4e0e\u4e34\u65f6\u76ee\u5f55\u5747\u4e0d\u53ef\u5199
const ALL_UNWRITABLE =
  '\u684c\u9762\u3001\u7528\u6237\u76ee\u5f55\u4e0e\u4e34\u65f6\u76ee\u5f55\u5747\u4e0d\u53ef\u5199';
// \u684c\u9762\u4e0e\u7528\u6237\u76ee\u5f55\u90fd\u4e0d\u53ef\u5199  -- the RC2 wording, which omitted the temp directory
const OLD_TWO_PLACE = '\u684c\u9762\u4e0e\u7528\u6237\u76ee\u5f55\u90fd\u4e0d\u53ef\u5199';

const results = [];
let failures = 0;
function record(status, name, detail = '') {
  results.push({ status, name, detail });
  if (status === 'FAIL') failures += 1;
  console.log(`  [${status.padEnd(4)}] ${name}${detail ? `  --  ${detail}` : ''}`);
}
const check = (c, name, detail) => record(c ? 'PASS' : 'FAIL', name, detail);
const info = (name, detail) => record('INFO', name, detail);
const na = (name, detail) => record('N/A', name, detail);

function section(title) {
  console.log('');
  console.log(`== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sh(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options });
}
function ps(script) {
  // Write the script to a UTF-8 file and read the result back from a UTF-8 file. PowerShell's stdout is
  // the console code page, which mangles Chinese on the way out -- the same trap that made an earlier
  // suite report a correct file as wrong.
  mkdirSync(WORK, { recursive: true });
  const scriptPath = join(WORK, 'q.ps1');
  const outPath = join(WORK, 'q.out');
  rmSync(outPath, { force: true });
  writeFileSync(scriptPath, `\ufeff${script}\n`, 'utf8');
  sh('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, outPath]);
  return existsSync(outPath)
    ? readFileSync(outPath, 'utf8')
        .replace(/^\ufeff/, '')
        .trim()
    : '';
}

/** Does a Ready-page memo name exactly this directory as the installation directory? */
function statesDirectory(memo, dir) {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`安装位置： \\|\\s+${escaped}\\s+\\|`).test(memo);
}

/** Resolve a .lnk through the shell, returning target, arguments, working directory and icon. */
function readShortcut(lnk) {
  // Built with += rather than a multi-line @( ... ) literal: the literal form came back as ONE line
  // with the fields joined by spaces, i.e. the array had collapsed to a string before it was written.
  const out = ps(`
$ErrorActionPreference='SilentlyContinue'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}')
$lines = @()
$lines += 'target=' + $s.TargetPath
$lines += 'args=' + $s.Arguments
$lines += 'workdir=' + $s.WorkingDirectory
$lines += 'icon=' + $s.IconLocation
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`);
  const fields = {};
  for (const line of out.split(/\r?\n/)) {
    const [key, ...rest] = line.split('=');
    fields[key] = rest.join('=').trim();
  }
  return fields;
}

function installTo(dir, extraArgs = []) {
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...extraArgs];
  if (dir) args.push(`/DIR=${dir}`);
  return sh(SETUP, args);
}

/**
 * Uninstall silently and wait for the uninstaller's second phase (silent-uninstall.mjs). For this
 * release's own uninstaller the second phase must end by itself: a message box that ignored
 * /SUPPRESSMSGBOXES used to leave it waiting on the operator's screen. Pre-cleaning may meet another
 * version's uninstaller, so it only tidies up.
 */
async function uninstallFrom(root, { expectSilent = true, waitMs = 60_000 } = {}) {
  const r = await silentUninstall(root, { waitMs });
  if (expectSilent && r.code !== -1) {
    check(
      r.finishedByItself,
      'the silent uninstall finished by itself, with no dialog left waiting',
      r.dismissed ? 'a message box was still open and had to be closed' : '',
    );
  }
  return r.code;
}

async function waitFor(predicate, ms, every = 250) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

async function portOpen() {
  const net = await import('node:net');
  return new Promise((r) => {
    const s = net.createConnection({ host: '127.0.0.1', port: 8765 }, () => {
      s.destroy();
      r(true);
    });
    s.setTimeout(1200, () => {
      s.destroy();
      r(false);
    });
    s.on('error', () => r(false));
  });
}

/**
 * Remove any installation, wherever it is, so each phase starts from a genuinely known state.
 *
 * Removing the directory is not enough. Inno records the selected tasks in its HKCU uninstall key and
 * `UsePreviousTasks` restores them on the next install — so a tree deleted by hand leaves that key
 * behind, and the following "first" installation silently inherits the previous run's choices. That is
 * what made the desktop-shortcut check fail: the run before it had ended with `/TASKS=`, and the
 * supposedly fresh install faithfully reproduced an empty selection.
 *
 * Worth knowing beyond the harness: a user who deletes the folder instead of uninstalling gets the same
 * inheritance.
 */
async function cleanSlate(...roots) {
  for (const root of [DEFAULT_ROOT, ...roots]) {
    if (!existsSync(root)) continue;
    const launch = join(root, 'bin', 'civic-launch.exe');
    if (existsSync(launch)) sh(launch, ['stop']);
    await uninstallFrom(root, { expectSilent: false, waitMs: 15_000 });
    await sleep(1200);
    rmSync(root, { recursive: true, force: true });
  }
  ps(`
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}_is1'
if (Test-Path $key) { Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue }
[System.IO.File]::WriteAllText($args[0], 'done', [System.Text.Encoding]::UTF8)`);
  rmSync(join(DESKTOP, '政务工作记录台.lnk'), { force: true });
  await waitFor(async () => !(await portOpen()), 8000);
}

console.log(`CivicWorkDesk Windows ${RELEASE_ID} -- distribution-experience acceptance`);
console.log('');
console.log(`  release  : ${RELEASE_ID}`);
console.log(`  installer: ${SETUP}`);

if (!existsSync(SETUP)) {
  console.error('error: the installer is not built. Run scripts/windows/build-release.mjs first.');
  process.exit(2);
}

// ===================================================================================================
section('1. icon resources');

const icoPath = join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.ico');
check(existsSync(icoPath), 'the committed icon exists', icoPath);
const icoCheck = sh(process.execPath, [
  join(ROOT, 'scripts', 'windows', 'generate-ico.mjs'),
  '--check',
]);
check(
  icoCheck.status === 0,
  'the committed icon matches its generator',
  (icoCheck.stdout ?? '').trim(),
);

// Every size the shell asks for must load, including the PNG-compressed 256 entry, which .NET
// Framework's Icon class cannot read -- so that one is parsed directly rather than through it.
const icoBytes = readFileSync(icoPath);
const icoCount = icoBytes.readUInt16LE(4);
info('icon images', String(icoCount));
let has256Png = false;
const sizes = [];
for (let i = 0; i < icoCount; i += 1) {
  const o = 6 + i * 16;
  const w = icoBytes[o] || 256;
  const off = icoBytes.readUInt32LE(o + 12);
  sizes.push(w);
  if (w === 256 && icoBytes[off] === 0x89) has256Png = true;
}
check(
  sizes.includes(16) && sizes.includes(32) && sizes.includes(48) && sizes.includes(256),
  'the icon covers the shell sizes',
  sizes.join(', '),
);
check(has256Png, 'the 256 entry is PNG-compressed');

const loaded = ps(`
Add-Type -AssemblyName System.Drawing
$lines = @()
foreach ($s in 16,20,24,32,40,48,64) {
  $i = New-Object System.Drawing.Icon('${icoPath.replace(/\\/g, '\\\\')}', $s, $s)
  $lines += ('' + $s + '=' + $i.Width + 'x' + $i.Height)
  $i.Dispose()
}
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`);
check(
  loaded.split(/\r?\n/).filter(Boolean).length === 7,
  'Windows loads every DIB size',
  loaded.replace(/\r?\n/g, ' '),
);

// The installer's own icon.
const setupIcon = ps(`
Add-Type -AssemblyName System.Drawing
$i = [System.Drawing.Icon]::ExtractAssociatedIcon('${SETUP.replace(/\\/g, '\\\\')}')
$b = $i.ToBitmap()
$c = $b.GetPixel([int]($b.Width/2), [int]($b.Height*0.30))
$lines = @('size=' + $b.Width + 'x' + $b.Height, 'centre=' + $c.R + ',' + $c.G + ',' + $c.B)
$b.Dispose(); $i.Dispose()
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`);
check(
  /centre=255,255,255/.test(setupIcon),
  'the installer carries the CivicWorkDesk icon',
  setupIcon.replace(/\r?\n/g, ' '),
);

// ===================================================================================================
section('2. clean install at the default location');
await cleanSlate();

// The Ready page of a first installation, reached by clicking through the real wizard and then
// cancelled: it must state where the program is going and that this is a new installation.
const freshReady = readyPageOf(SETUP, IDENTITY.productNameZh);
check(freshReady.reached, 'a first installation reaches the Ready page', freshReady.pages);
check(/选择目标位置/.test(freshReady.pages), 'a first installation offers the directory page');
check(
  statesDirectory(freshReady.memo, DEFAULT_ROOT),
  'the Ready page states the effective installation directory',
  freshReady.memo.slice(0, 80),
);
check(
  freshReady.memo.includes('安装类型： |') && freshReady.memo.includes('全新安装'),
  'it says this is a new installation',
);
check(
  freshReady.memo.includes(`${IDENTITY.displayVersion}（${RELEASE_ID}）`) &&
    freshReady.memo.includes('http://127.0.0.1:8765/'),
  'it states the version and the fixed origin',
);
check(!freshReady.memo.includes(UPGRADE_WARNING), 'a clean install carries no upgrade warning');
check(
  freshReady.closed && freshReady.strayProcessesStopped === 0,
  'the wizard was cancelled cleanly',
);
check(
  !existsSync(join(DEFAULT_ROOT, 'current.txt')),
  'cancelling at the Ready page installed nothing',
);

const defaultInstall = installTo('');
check(defaultInstall.status === 0, 'default install exited 0', `code ${defaultInstall.status}`);
check(
  existsSync(join(DEFAULT_ROOT, 'current.txt')),
  'installed at the default location',
  DEFAULT_ROOT,
);
check(
  readFileSync(join(DEFAULT_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'this release is active',
  RELEASE_ID,
);

// --- launcher icon resource, from the installed binary ---
const launchIcon = ps(`
Add-Type -AssemblyName System.Drawing
$exe = '${join(DEFAULT_ROOT, 'bin', 'civic-launch.exe').replace(/\\/g, '\\\\')}'
$i = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
$b = $i.ToBitmap()
$c = $b.GetPixel([int]($b.Width/2), [int]($b.Height*0.30))
$v = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
$lines = @()
$lines += 'centre=' + $c.R + ',' + $c.G + ',' + $c.B
$lines += 'product=' + $v.ProductName
$lines += 'description=' + $v.FileDescription
$lines += 'company=' + $v.CompanyName
$lines += 'productversion=' + $v.ProductVersion
$lines += 'comments=' + $v.Comments
$b.Dispose(); $i.Dispose()
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`);
const launchField = (key) =>
  (launchIcon.split(/\r?\n/).find((l) => l.startsWith(`${key}=`)) ?? '').slice(key.length + 1);
check(/centre=255,255,255/.test(launchIcon), 'the launcher carries an icon resource');
check(
  launchField('product').startsWith('政务工作记录台'),
  'the launcher version block names the product in Chinese',
  launchField('product'),
);
check(
  launchField('productversion') === IDENTITY.displayVersion,
  'the launcher ProductVersion is the display version',
  launchField('productversion'),
);
check(
  launchField('company') === IDENTITY.publisher,
  'the launcher names the publisher',
  launchField('company'),
);
check(
  launchField('comments') === `release ${RELEASE_ID}`,
  'the version block carries the release id',
  launchField('comments'),
);

// The Ready page of a repair: the wizard skips the directory page, so the Ready page is the only place
// the person sees where the program is -- and it must say this is a repair.
const repairReady = readyPageOf(SETUP, IDENTITY.productNameZh);
check(repairReady.reached, 'a repair run reaches the Ready page', repairReady.pages);
check(!/选择目标位置/.test(repairReady.pages), 'a repair does not offer the directory page again');
check(
  statesDirectory(repairReady.memo, DEFAULT_ROOT),
  'the repair Ready page states the effective installation directory',
  repairReady.memo.slice(0, 80),
);
check(
  repairReady.memo.includes(`修复（重新安装同一版本 ${IDENTITY.displayVersion}，沿用原安装位置）`),
  'the repair Ready page says it is a repair',
);
check(!repairReady.memo.includes(UPGRADE_WARNING), 'a repair carries no upgrade warning');
check(
  repairReady.closed && repairReady.strayProcessesStopped === 0,
  'the wizard was cancelled cleanly',
);

// ===================================================================================================
section('3. Start Menu layout');
const topLevel = existsSync(START_MENU) ? readdirSync(START_MENU).sort() : [];
info('top level', topLevel.join(', '));
check(topLevel.includes('政务工作记录台.lnk'), 'the application is at the top level');
check(topLevel.includes('维护工具'), 'maintenance tools are in a subfolder');
check(
  topLevel.filter((n) => n.endsWith('.lnk')).length === 1,
  'exactly one shortcut at the top level',
  `${topLevel.filter((n) => n.endsWith('.lnk')).length}`,
);

const maintenance = existsSync(join(START_MENU, '维护工具'))
  ? readdirSync(join(START_MENU, '维护工具')).sort()
  : [];
info('维护工具', maintenance.join(', '));
for (const name of [
  '收集诊断信息.lnk',
  '查看运行状态.lnk',
  '停止本地服务.lnk',
  '浏览器兼容性检查.lnk',
]) {
  check(maintenance.includes(name), `maintenance contains ${name}`);
}
check(
  maintenance.some((n) => n.startsWith('卸载')),
  'uninstall is in the maintenance folder',
);

const appLnk = readShortcut(join(START_MENU, '政务工作记录台.lnk'));
check(
  appLnk.target?.toLowerCase() === join(DEFAULT_ROOT, 'bin', 'civic-launch.exe').toLowerCase(),
  'the application shortcut targets bin\\civic-launch.exe',
  appLnk.target,
);
check(
  (appLnk.workdir ?? '').toLowerCase() === DEFAULT_ROOT.toLowerCase(),
  'its working directory is the installation root',
  appLnk.workdir,
);
check(
  /civic-launch\.exe/i.test(appLnk.icon ?? ''),
  'its icon resolves to the launcher',
  appLnk.icon,
);

const diagLnk = readShortcut(join(START_MENU, '维护工具', '收集诊断信息.lnk'));
check(
  /civic-diag\.exe/i.test(diagLnk.target ?? ''),
  'diagnostics targets civic-diag.exe',
  diagLnk.target,
);

// ===================================================================================================
section('4. desktop shortcut');
const desktopLnk = join(DESKTOP, '政务工作记录台.lnk');
check(existsSync(desktopLnk), 'created by default on a first install', desktopLnk);
if (existsSync(desktopLnk)) {
  const d = readShortcut(desktopLnk);
  check(
    d.target?.toLowerCase() === join(DEFAULT_ROOT, 'bin', 'civic-launch.exe').toLowerCase(),
    'it targets the stable launcher, not a versioned release binary',
    d.target,
  );
  check(
    (d.workdir ?? '').toLowerCase() === DEFAULT_ROOT.toLowerCase(),
    'correct working directory',
    d.workdir,
  );
  check(/civic-launch\.exe/i.test(d.icon ?? ''), 'its icon resolves', d.icon);
}

// Repair must not disturb it.
const repair = installTo('');
check(repair.status === 0, 'repair install exited 0', `code ${repair.status}`);
check(existsSync(desktopLnk), 'the desktop shortcut survives a repair');

// Uninstall must remove it.
const uninstallCode = await uninstallFrom(DEFAULT_ROOT);
await sleep(1500);
check(uninstallCode === 0, 'uninstall exited 0', `code ${uninstallCode}`);
check(!existsSync(desktopLnk), 'uninstall removed the desktop shortcut — none is orphaned');
check(!existsSync(START_MENU), 'uninstall removed the Start Menu folder');

// Opt-out.
await cleanSlate();
const noDesktop = installTo('', ['/TASKS=']);
check(
  noDesktop.status === 0,
  'install with the task unticked exited 0',
  `code ${noDesktop.status}`,
);
check(!existsSync(desktopLnk), 'no desktop shortcut when the task is unticked');
check(existsSync(join(START_MENU, '政务工作记录台.lnk')), 'the Start Menu entry is still created');

// ===================================================================================================
section('5. custom installation paths');
const customCases = [
  { name: 'path with spaces', dir: join('D:\\', 'CivicWorkDesk Acceptance', 'Program Folder') },
  { name: 'path with Chinese characters', dir: join('D:\\', '政务工作记录台验收') },
  { name: 'another fixed local drive', dir: join('D:\\', 'Applications', 'CivicWorkDesk') },
];
const dHasFixed = ps(`
$v = Get-Volume -DriveLetter D -ErrorAction SilentlyContinue
$lines = @('type=' + $(if ($v) { $v.DriveType } else { 'none' }))
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`);
const dIsFixed = /type=Fixed/.test(dHasFixed);
info('D: drive', dIsFixed ? 'fixed volume present' : 'absent or not fixed');

for (const c of customCases) {
  if (!dIsFixed) {
    na(c.name, 'no writable fixed D: drive on this machine; not simulated');
    continue;
  }
  await cleanSlate(c.dir);
  rmSync(c.dir, { recursive: true, force: true });
  const r = installTo(c.dir);
  const ok = r.status === 0 && existsSync(join(c.dir, 'current.txt'));
  check(ok, `install to a ${c.name}`, `${c.dir} (code ${r.status})`);
  if (!ok) continue;

  check(
    readFileSync(join(c.dir, 'current.txt'), 'utf8').trim() === RELEASE_ID,
    `  ${c.name}: the release is active`,
  );
  check(
    !existsSync(join(DEFAULT_ROOT, 'current.txt')),
    `  ${c.name}: nothing was installed at the default location as well`,
  );

  const launched = sh(join(c.dir, 'bin', 'civic-launch.exe'), ['open']);
  const up = await waitFor(portOpen, 15000);
  check(launched.status === 0 && up, `  ${c.name}: launches and serves`, `code ${launched.status}`);
  if (up) {
    const health = await (await fetch(`${ORIGIN}/__civic/health`)).json();
    check(
      health.installRoot.toLowerCase() === c.dir.toLowerCase(),
      `  ${c.name}: health reports the custom root`,
      health.installRoot,
    );
    check(
      health.canonicalOrigin === ORIGIN,
      `  ${c.name}: the origin is unchanged`,
      health.canonicalOrigin,
    );
  }
  const status = sh(join(c.dir, 'bin', 'civic-launch.exe'), ['status']);
  check(/已核验属于本安装/.test(status.stdout ?? ''), `  ${c.name}: status proves ownership`);
  check(/校验通过/.test(status.stdout ?? ''), `  ${c.name}: program integrity verifies`);

  const diag = sh(join(c.dir, 'bin', 'civic-diag.exe'), []);
  const diagPath = /([A-Z]:\\[^\r\n]*CivicWorkDesk-诊断信息-[0-9-]+\.txt)/.exec(
    diag.stdout ?? '',
  )?.[1];
  if (diagPath && existsSync(diagPath)) {
    const report = readFileSync(diagPath, 'utf8');
    /* RC2 asserted here that the report kept the chosen path VERBATIM, on the reasoning that a path the
     * user typed identifies nobody. That reasoning was wrong — `D:\张三\政务工作记录台` is a person's
     * name — and this assertion was the thing holding the defect in place: it would have failed the fix.
     * It is inverted rather than deleted, so the property is still pinned, in the opposite direction. */
    check(!report.includes(c.dir), `  ${c.name}: diagnostics do NOT keep the custom path verbatim`);
    check(
      report.includes('<CUSTOM_INSTALL_ROOT>'),
      `  ${c.name}: the custom root is reported as a placeholder`,
    );
    check(
      /install root kind *: custom/.test(report),
      `  ${c.name}: diagnostics name it a custom directory`,
    );
    rmSync(diagPath, { force: true });
  } else {
    record('FAIL', `  ${c.name}: diagnostics produced a report`, '(not found)');
  }

  sh(join(c.dir, 'bin', 'civic-launch.exe'), ['stop']);
  check((await uninstallFrom(c.dir)) === 0, `  ${c.name}: uninstall exited 0`);
  await sleep(1200);
  check(!existsSync(join(c.dir, 'bin')), `  ${c.name}: program files removed`);
  rmSync(c.dir, { recursive: true, force: true });
}

// ===================================================================================================
section('6. rejected installation paths');
await cleanSlate();
const admin = join(ROOT, 'release', 'windows', '.build', RELEASE_ID, 'bin', 'civic-admin.exe');
const checker = existsSync(admin) ? admin : join(DEFAULT_ROOT, 'bin', 'civic-admin.exe');
if (!existsSync(checker)) {
  record('FAIL', 'a civic-admin checker is available for path validation', checker);
} else {
  const rejects = [
    { name: 'UNC path', dir: '\\\\server\\share\\CivicWorkDesk' },
    { name: 'drive root', dir: 'C:\\' },
    {
      name: 'Windows directory',
      dir: join(process.env.SystemRoot ?? 'C:\\Windows', 'CivicWorkDesk'),
    },
    {
      name: 'Program Files',
      dir: join(process.env.ProgramFiles ?? 'C:\\Program Files', 'CivicWorkDesk'),
    },
    {
      name: 'ProgramData',
      dir: join(process.env.ProgramData ?? 'C:\\ProgramData', 'CivicWorkDesk'),
    },
    { name: 'relative path', dir: 'CivicWorkDesk' },
    { name: 'trailing dot', dir: 'D:\\CivicWorkDesk.' },
    { name: 'trailing space', dir: 'D:\\CivicWorkDesk ' },
    { name: 'user profile root', dir: process.env.USERPROFILE ?? homedir() },
  ];
  for (const r of rejects) {
    const out = sh(checker, ['preflight', '--stage', 'directory', '--root', r.dir]);
    const refused = out.status !== 0 && /\[FAIL/.test(out.stdout ?? '');
    const reason =
      (out.stdout ?? '').split(/\r?\n/).find((l) => /directory is usable/.test(l)) ?? '';
    check(refused, `rejects a ${r.name}`, reason.replace(/\s+/g, ' ').trim().slice(0, 100));
  }
  // And the other direction: the checker must ACCEPT a good path, or every rejection above is vacuous.
  const goodDir = join(WORK, 'acceptable');
  const good = sh(checker, ['preflight', '--stage', 'directory', '--root', goodDir]);
  check(good.status === 0, 'accepts an ordinary writable local directory', goodDir);
  rmSync(goodDir, { recursive: true, force: true });
}

// ===================================================================================================
section('7. RC3 to this release, upgrade in place');
await cleanSlate();
if (!PREVIOUS_SETUP || !existsSync(PREVIOUS_SETUP)) {
  record('FAIL', 'the published RC3 installer is available', PREVIOUS_SOURCE);
} else {
  info('RC3 installer', PREVIOUS_SOURCE);
  const rc1 = sh(PREVIOUS_SETUP, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  check(
    rc1.status === 0 && existsSync(join(DEFAULT_ROOT, 'current.txt')),
    'RC3 installs from its published bytes',
    `code ${rc1.status}`,
  );
  const rc1Id = readFileSync(join(DEFAULT_ROOT, 'current.txt'), 'utf8').trim();
  check(rc1Id === PREVIOUS_ID, 'RC3 is the active release', rc1Id);

  // Leave the previous release's local service RUNNING across the upgrade: that is the case that
  // aborted during the RC1 rehearsal, and the reason PrepareToInstall exists.
  sh(join(DEFAULT_ROOT, 'bin', 'civic-launch.exe'), ['open']);
  await waitFor(portOpen, 15000);
  check(await portOpen(), 'the previous release is serving before the upgrade');

  // What the person sees before committing: the existing directory, and the word 升级.
  const upgradeReady = readyPageOf(SETUP, IDENTITY.productNameZh);
  check(upgradeReady.reached, 'the upgrade reaches the Ready page', upgradeReady.pages);
  check(!/选择目标位置/.test(upgradeReady.pages), 'the upgrade does not offer the directory page');
  check(
    statesDirectory(upgradeReady.memo, DEFAULT_ROOT),
    'the upgrade Ready page states the existing directory',
    upgradeReady.memo.slice(0, 80),
  );
  check(
    upgradeReady.memo.includes(
      `升级（从已安装的 ${PREVIOUS_ID} 升级到 ${IDENTITY.displayVersion}，沿用原安装位置）`,
    ),
    'it says this is an upgrade from RC3',
  );
  check(
    upgradeReady.memo.includes(UPGRADE_WARNING) && !upgradeReady.memo.includes('应用更新'),
    'it warns, before installing, to save and close the open pages',
  );
  check(
    upgradeReady.closed && upgradeReady.strayProcessesStopped === 0,
    'the wizard was cancelled cleanly',
  );
  check(await portOpen(), 'cancelling the wizard left RC3 serving');

  const upgrade = installTo('');
  check(
    upgrade.status === 0,
    'this release installs over it while it was running',
    `code ${upgrade.status}`,
  );
  check(
    readFileSync(join(DEFAULT_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
    'this release is now active',
  );
  check(
    readFileSync(join(DEFAULT_ROOT, 'previous.txt'), 'utf8').trim() === rc1Id,
    'previous.txt records it as the rollback target',
    rc1Id,
  );
  check(
    existsSync(join(DEFAULT_ROOT, 'releases', rc1Id)),
    'the previous release directory is retained',
  );

  // No second installation anywhere.
  const roots = ps(`
$lines = @()
foreach ($k in 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall') {
  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DisplayName -like '*政务工作记录台*') { $lines += ('entry=' + $p.InstallLocation) }
  }
}
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`);
  const entries = roots.split(/\r?\n/).filter(Boolean);
  check(
    entries.length === 1,
    'exactly one installed-program entry exists',
    entries.join(' | ') || '(none)',
  );
  check(
    entries[0]?.toLowerCase().includes(DEFAULT_ROOT.toLowerCase()),
    'it still points at the original location — the upgrade did not relocate anything',
    entries[0],
  );

  sh(join(DEFAULT_ROOT, 'bin', 'civic-launch.exe'), ['stop']);

  // RC3 is kept on disk as a record, but it must never again be put in front of the upgraded data.
  const rollback = sh(join(DEFAULT_ROOT, 'bin', 'civic-admin.exe'), [
    'rollback',
    '--root',
    DEFAULT_ROOT,
  ]);
  check(
    rollback.status === 4,
    'rolling back to RC3 is refused (exit 4)',
    `code ${rollback.status}`,
  );
  check(
    readFileSync(join(DEFAULT_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
    'this release is still active after the refusal',
  );
}

// ===================================================================================================
section('7b. RC3 at a chosen directory is upgraded in that directory');
const RC3_CUSTOM = join('D:\\', 'CivicWorkDesk 升级验收');
if (!dIsFixed || !PREVIOUS_SETUP) {
  na(
    'upgrade at a chosen directory',
    'no writable fixed D: drive, or no RC3 installer; not simulated',
  );
} else {
  await cleanSlate(RC3_CUSTOM);
  rmSync(RC3_CUSTOM, { recursive: true, force: true });
  const rc3Custom = sh(PREVIOUS_SETUP, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/DIR=${RC3_CUSTOM}`,
  ]);
  check(
    rc3Custom.status === 0 && existsSync(join(RC3_CUSTOM, 'current.txt')),
    'RC3 installs at a directory with a space and Chinese characters',
    RC3_CUSTOM,
  );
  const customReady = readyPageOf(SETUP, IDENTITY.productNameZh);
  check(
    statesDirectory(customReady.memo, RC3_CUSTOM),
    'the upgrade Ready page states the chosen directory, not the default',
    customReady.memo.slice(0, 90),
  );
  check(customReady.memo.includes('升级（从已安装的 '), 'it says this is an upgrade');
  const customUpgrade = installTo('');
  check(
    customUpgrade.status === 0 &&
      readFileSync(join(RC3_CUSTOM, 'current.txt'), 'utf8').trim() === RELEASE_ID,
    'the upgrade lands in the chosen directory',
    `code ${customUpgrade.status}`,
  );
  check(
    !existsSync(join(DEFAULT_ROOT, 'current.txt')),
    'nothing was installed at the default location',
  );
  sh(join(RC3_CUSTOM, 'bin', 'civic-launch.exe'), ['stop']);
  await uninstallFrom(RC3_CUSTOM);
  await sleep(1200);
  rmSync(RC3_CUSTOM, { recursive: true, force: true });
}

// ===================================================================================================
section('8. install-failure diagnostics are durable');
await cleanSlate();
// Occupy the canonical port with something unrelated, which is a runtime blocker, then install.
const net = await import('node:net');
const squatter = net.createServer((s) => s.end());
await new Promise((r) => squatter.listen(8765, '127.0.0.1', r));

const before = new Set(readdirSync(DESKTOP).filter((n) => n.startsWith('CivicWorkDesk-安装诊断-')));
const blocked = installTo('');
check(blocked.status !== 0, 'a blocked install does not report success', `code ${blocked.status}`);
const after = readdirSync(DESKTOP).filter(
  (n) => n.startsWith('CivicWorkDesk-安装诊断-') && !before.has(n),
);
check(
  after.length === 1,
  'exactly one install diagnostic was written to the Desktop',
  after.join(', '),
);
if (after.length === 1) {
  const path = join(DESKTOP, after[0]);
  const body = readFileSync(path, 'utf8');
  check(body.startsWith('\ufeff'), 'it is UTF-8 with a BOM so Notepad reads it');
  check(/RESULT: BLOCKED/.test(body), 'it states the blocked verdict');
  check(/port 8765/.test(body), 'it names the port as the blocker');
  check(!/C:\\Users\\/i.test(body), 'it contains no user-profile path', 'redacted to %VARIABLE%');
  info('install diagnostic', `${after[0]} (${readFileSync(path).length} bytes)`);
  rmSync(path, { force: true });
}
check(!existsSync(join(DEFAULT_ROOT, 'current.txt')), 'nothing was activated');
check(squatter.listening, 'the unrelated occupant survived');
await new Promise((r) => squatter.close(r));

// ===================================================================================================
section('9. diagnostic privacy at the default location');
await cleanSlate();
installTo('');
sh(join(DEFAULT_ROOT, 'bin', 'civic-launch.exe'), ['open']);
await waitFor(portOpen, 15000);
const diag = sh(join(DEFAULT_ROOT, 'bin', 'civic-diag.exe'), []);
const reportPath = /([A-Z]:\\[^\r\n]*CivicWorkDesk-诊断信息-[0-9-]+\.txt)/.exec(
  diag.stdout ?? '',
)?.[1];
check(Boolean(reportPath), 'a diagnostic report was produced', reportPath ?? '(none)');

if (reportPath && existsSync(reportPath)) {
  const body = readFileSync(reportPath, 'utf8');
  const username = process.env.USERNAME ?? '';
  const computer = process.env.COMPUTERNAME ?? '';

  check(
    username.length >= 3 && !body.toLowerCase().includes(username.toLowerCase()),
    'the Windows account name does not appear',
    `searched for a ${username.length}-character name`,
  );
  check(
    computer.length >= 3 && !body.toLowerCase().includes(computer.toLowerCase()),
    'the machine name does not appear',
    `searched for a ${computer.length}-character name`,
  );
  check(!/C:\\Users\\/i.test(body), 'no C:\\Users\\ path survives');
  check(body.includes('%LOCALAPPDATA%'), 'paths are reported as environment variables');
  check(/install root kind *: default/.test(body), 'it still says this is a default installation');

  // Build-machine and workspace paths must not reach a colleague's report either.
  //
  // Derived, never written down. The repository's own static security scan forbids a hard-coded
  // developer path anywhere in the tree — including inside a check whose whole purpose is to look for
  // one — and it is right to: a literal here is a portability defect that outlives this machine. ROOT
  // is where this checkout actually is, and the tool roots come from the same environment variables
  // the build script reads.
  const goRoot = process.env.CIVIC_GOROOT ?? join('D:', 'tools', 'go1.27.1', 'go');
  const innoExe = process.env.CIVIC_ISCC ?? join('D:', 'tools', 'innosetup-7.1.0', 'ISCC.exe');
  const leaks = new Set([
    ROOT,
    ROOT.replace(/\\/g, '/'),
    dirname(goRoot),
    dirname(goRoot).replace(/\\/g, '/'),
    dirname(innoExe),
    '_private_reference',
  ]);
  for (const leak of leaks) {
    check(!body.includes(leak), `no build-machine path: ${leak}`);
  }
  // And the things it must never carry at all.
  // Scan the report BODY, not the privacy note at the top -- that note names Cookie, passwords and site
  // storage precisely in order to promise the file does not carry them, so grepping the whole document
  // matches the disclaimer and reports a leak that does not exist. This is the second time that trap has
  // fired in this project, and it fired again here because the note was rewritten and the old anchor
  // silently stopped matching.
  const noteEnd = body.indexOf('也不含任何口令或密钥。');
  check(noteEnd > 0, 'the privacy note is present and anchorable', `index ${noteEnd}`);
  const reportBody = noteEnd > 0 ? body.slice(noteEnd) : body;
  for (const forbidden of [
    'Cookie',
    'IndexedDB',
    'Local Storage',
    'User Data',
    '.sqlite',
    '.ldb',
  ]) {
    check(!reportBody.includes(forbidden), `no browser artefact in the report body: ${forbidden}`);
  }
  const state = JSON.parse(readFileSync(join(DEFAULT_ROOT, 'state', 'server.json'), 'utf8'));
  check(!body.includes(state.shutdownToken), 'the control token value is absent');
  check(/shutdown token *: present/.test(body), 'the control token is reported as present only');

  // Still useful: the technical state a maintainer needs must survive the redaction.
  check(body.includes(RELEASE_ID), 'the release id survives');
  check(body.includes(ORIGIN), 'the canonical origin survives');
  check(/ownership *: PROVEN/.test(body), 'the ownership verdict survives');
  check(/程序完整性|payload *:/.test(body), 'the integrity verdict survives');
  info(
    'diagnostic report',
    `${reportPath.split('\\').pop()} (${readFileSync(reportPath).length} bytes)`,
  );
  rmSync(reportPath, { force: true });
}
sh(join(DEFAULT_ROOT, 'bin', 'civic-launch.exe'), ['stop']);

// ===================================================================================================
section('9b. custom paths that look like people');
// RC2 emitted a user-chosen installation directory verbatim, on the stated grounds that it "identifies
// nobody". These are the paths that make that false. A forwardable report must not carry any of them.
const IDENTITY_CASES = [
  {
    name: 'a Latin personal name',
    dir: JOIN_D + 'Alice' + SEP + 'CivicWorkDesk',
    fragments: ['Alice'],
  },
  {
    name: 'a Chinese personal name',
    dir: JOIN_D + 'ZHANGSAN' + SEP + 'CWD',
    fragments: ['ZHANGSAN'],
  },
  {
    name: 'an organisation and a person',
    dir: JOIN_D + 'MOUDANWEI' + SEP + 'LIMOU' + SEP + 'CivicWorkDesk',
    fragments: ['MOUDANWEI', 'LIMOU'],
  },
];
// The Chinese cases are written with their real characters here; the ASCII placeholders above keep this
// source file free of anything that could be mistaken for real data.
IDENTITY_CASES[1].dir = JOIN_D + CHINESE_NAME + SEP + CHINESE_APP;
IDENTITY_CASES[1].fragments = [CHINESE_NAME];
IDENTITY_CASES[2].dir = JOIN_D + CHINESE_ORG + SEP + CHINESE_PERSON + SEP + 'CivicWorkDesk';
IDENTITY_CASES[2].fragments = [CHINESE_ORG, CHINESE_PERSON];

if (!dIsFixed) {
  na('identity-shaped custom paths', 'no writable fixed D: drive on this machine; not simulated');
} else {
  for (const c of IDENTITY_CASES) {
    await cleanSlate(c.dir);
    rmSync(c.dir, { recursive: true, force: true });
    const r = installTo(c.dir);
    if (r.status !== 0 || !existsSync(join(c.dir, 'current.txt'))) {
      check(false, `install to ${c.name}`, `${c.dir} (code ${r.status})`);
      continue;
    }
    check(true, `install to ${c.name}`, c.dir);

    sh(join(c.dir, 'bin', 'civic-launch.exe'), ['open']);
    await waitFor(portOpen, 15000);
    const diag = sh(join(c.dir, 'bin', 'civic-diag.exe'), []);
    // Built with RegExp rather than a literal: the diagnostic filename carries a Chinese word that is
    // held in a constant, and a regex literal cannot interpolate one.
    const reportRe = new RegExp(`([A-Z]:\\\\[^\\r\\n]*CivicWorkDesk-${DIAGWORD}-[0-9-]+\\.txt)`);
    const reportPath = reportRe.exec(diag.stdout ?? '')?.[1];
    if (!reportPath || !existsSync(reportPath)) {
      check(false, `  ${c.name}: a diagnostic report was produced`, reportPath ?? '(none)');
      sh(join(c.dir, 'bin', 'civic-launch.exe'), ['stop']);
      await uninstallFrom(c.dir);
      rmSync(c.dir, { recursive: true, force: true });
      continue;
    }
    const body = readFileSync(reportPath, 'utf8');

    for (const fragment of c.fragments) {
      check(
        !body.includes(fragment),
        `  ${c.name}: the report does not contain ${JSON.stringify(fragment)}`,
      );
    }
    check(!body.includes(c.dir), `  ${c.name}: the report does not contain the chosen path`);
    check(
      body.includes('<CUSTOM_INSTALL_ROOT>'),
      `  ${c.name}: the root is reported as a placeholder`,
    );
    // Masked, but still diagnosable. Matched tolerantly of label padding: what has to hold is that the
    // characteristic is reported, not that its colon lands in a particular column.
    check(/install volume *: D:/.test(body), `  ${c.name}: the volume survives`);
    check(/path has spaces *: (yes|no)/.test(body), `  ${c.name}: the space flag survives`);
    check(/path has non-ASCII *: (yes|no)/.test(body), `  ${c.name}: the character class survives`);
    check(/path depth *: [0-9]+/.test(body), `  ${c.name}: the depth survives`);
    check(/path length *: [0-9]+/.test(body), `  ${c.name}: the length survives`);
    check(/path writable *: (yes|no)/.test(body), `  ${c.name}: writability survives`);
    check(body.includes(RELEASE_ID), `  ${c.name}: the release id survives`);

    rmSync(reportPath, { force: true });
    sh(join(c.dir, 'bin', 'civic-launch.exe'), ['stop']);
    await uninstallFrom(c.dir);
    await sleep(1200);
    rmSync(c.dir, { recursive: true, force: true });
  }
}

// ===================================================================================================
section('9c. install-diagnostic fallback semantics');
// The three fallback locations are not equivalent: Setup's temp directory is deleted when Setup exits.
// RC2's message said "saved to <path>" for all three, which for the last one is the same false promise
// RC1 made. What is asserted here is the SEMANTICS of the messages, read out of the installer source,
// because provoking an unwritable Desktop on a real machine would require changing the operator's own
// profile.
const issText = readFileSync(
  join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.iss'),
  'utf8',
);
check(
  /DiagnosticIsTemporary\s*:=\s*\(I = 2\)/.test(issText),
  'the temp location is recognised as the last resort',
);
check(
  issText.includes(TEMP_WARNING),
  'the temp case says the directory is cleaned when Setup exits',
);
check(issText.includes(SAVE_FIRST), 'the temp case asks the user to save the file before closing');
check(issText.includes(DIAG_SAVED), 'the durable case still says the file was saved');
check(issText.includes(ALL_UNWRITABLE), 'the no-location case names all three places, not two');
check(!issText.includes(OLD_TWO_PLACE), 'the RC2 two-place wording is gone');

// ===================================================================================================
section('9d. release identity and provenance, from the built bytes');
const identity = sh(process.execPath, [
  join(ROOT, 'scripts', 'windows', 'assert-release-identity.mjs'),
  '--release-id',
  RELEASE_ID,
]);
check(
  identity.status === 0,
  'every current-release field names this release',
  (identity.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => /FAIL|RESULT/.test(l))
    .join(' | '),
);

const branch = (sh('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout ?? '').trim();
const provenance = sh(process.execPath, [
  join(ROOT, 'scripts', 'windows', 'assert-release-provenance.mjs'),
  '--verify-built',
  '--release-id',
  RELEASE_ID,
  '--branch',
  branch,
]);
check(
  provenance.status === 0,
  'the recorded source commit is real, public and reachable',
  (provenance.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => /FAIL|RESULT/.test(l))
    .join(' | '),
);

// ===================================================================================================
section('10. copy audit');
const copy = sh(process.execPath, [join(ROOT, 'scripts', 'copy-audit.mjs'), '--mutate']);
check(
  copy.status === 0,
  'the copy audit passes with its mutation test',
  (copy.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => /caught|detectable|RESULT/.test(l))
    .join(' | '),
);

// ===================================================================================================
section('11. summary');
rmSync(WORK, { recursive: true, force: true });
console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  passed : ${results.filter((r) => r.status === 'PASS').length}`);
console.log(`  N/A    : ${results.filter((r) => r.status === 'N/A').length}`);
console.log(`  failed : ${failures}`);
console.log('');
console.log(
  failures === 0
    ? '  RESULT: PASS on this development workstation. Windows compatibility is NOT certified.'
    : '  RESULT: FAIL — see the [FAIL] lines above.',
);

writeFileSync(
  join(ROOT, 'release', 'windows', `acceptance-ux-${RELEASE_ID}.txt`),
  [
    `CivicWorkDesk Windows ${RELEASE_ID} -- distribution-experience acceptance`,
    '',
    `release : ${RELEASE_ID}`,
    `checks  : ${results.length} (${failures} failed)`,
    '',
    ...results.map(
      (r) => `[${r.status.padEnd(4)}] ${r.name}${r.detail ? `  --  ${r.detail}` : ''}`,
    ),
    '',
    failures === 0 ? 'RESULT: PASS. Windows compatibility is NOT certified.' : 'RESULT: FAIL.',
    '',
  ].join('\n'),
  'utf8',
);
process.exit(failures === 0 ? 0 : 1);
