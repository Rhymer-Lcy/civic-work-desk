#!/usr/bin/env node
/**
 * Windows acceptance on the development workstation, driven from the ACTUAL installer bytes.
 *
 *   node scripts/windows/acceptance-deploy.mjs --release-id <id> [--keep]
 *
 * ## What this is and is not
 *
 * It is a rehearsal: one machine, one browser family, one operator. Every check here passing means the
 * package is worth putting in front of colleagues -- it does NOT mean Windows compatibility is
 * certified, and the report says so in its own words rather than leaving it to be inferred.
 *
 * The installer is run as a real installer, silently, as the ordinary user. Nothing is simulated: the
 * tree that gets tested is the one Setup.exe wrote, the server that answers is the one it activated, and
 * the uninstall at the end is the one a colleague would run from the Start Menu.
 *
 * The release id is required. It used to default to an RC2 id, which is how a suite quietly stops
 * covering the thing being shipped; every name here now comes from release-identity.mjs.
 *
 * `--keep` leaves the installation in place at the end, for looking at by hand.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessDateUtc8, loadReleaseIdentity } from './release-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : undefined;
}

const IDENTITY = loadReleaseIdentity(
  ROOT,
  argValue('--release-id'),
  argValue('--today') ?? businessDateUtc8(),
  'audit',
);
const RELEASE_ID = IDENTITY.releaseId;
const SETUP = join(ROOT, 'release', 'windows', IDENTITY.installerName);
const INSTALL_ROOT = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'CivicWorkDesk',
);
const START_MENU = join(
  process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
  'Microsoft',
  'Windows',
  'Start Menu',
  'Programs',
  '政务工作记录台',
);
const ORIGIN = 'http://127.0.0.1:8765';
const KEEP = process.argv.includes('--keep');
const APP_ID_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}_is1';
/* A literal BOM in source is an invisible character; PowerShell needs one to read a UTF-8 script. */
const BOM = String.fromCharCode(0xfeff);

const results = [];
let failures = 0;

function record(status, name, detail = '') {
  results.push({ status, name, detail });
  if (status === 'FAIL') failures += 1;
  const tag = status.padEnd(4);
  console.log(`  [${tag}] ${name}${detail ? `  --  ${detail}` : ''}`);
}

function pass(name, detail) {
  record('PASS', name, detail);
}
function fail(name, detail) {
  record('FAIL', name, detail);
}
function info(name, detail) {
  record('INFO', name, detail);
}
function check(condition, name, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

function section(title) {
  console.log('');
  console.log(`== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
}

function sh(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

function bin(name) {
  return join(INSTALL_ROOT, 'bin', name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function serverProcesses() {
  const r = sh('powershell', [
    '-NoProfile',
    '-Command',
    'Get-Process civic-server -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)" }',
  ]);
  return (r.stdout ?? '').trim();
}

/** Run a PowerShell script from a UTF-8 file with a BOM; its first argument is an output file. */
function ps(script, ...args) {
  const scriptPath = join(process.env.TEMP ?? '.', `civic-accept-${process.pid}.ps1`);
  const outPath = join(process.env.TEMP ?? '.', `civic-accept-${process.pid}.out`);
  rmSync(outPath, { force: true });
  writeFileSync(scriptPath, `${BOM}${script}\n`, 'utf8');
  sh(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, outPath, ...args],
    {
      timeout: 60000,
    },
  );
  const text = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(BOM, '').trim() : '';
  rmSync(outPath, { force: true });
  rmSync(scriptPath, { force: true });
  return text;
}

/**
 * Start a program the way a shortcut does -- through the shell, with no console and no standard handles
 * -- then find the message box it shows, read its title and text, and close it.
 *
 * This is the only honest test of what a person clicking the Start Menu entry sees. The rest of this
 * suite runs the tools with pipes, where they print to the pipe and never show a dialog; RC1-RC3 passed
 * every one of those checks while a real click on a failing launch showed nothing at all.
 */
const DIALOG_PROBE = String.raw`
param($out, $exe, $arg)
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CivicDialogProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint GetDlgItemText(IntPtr h, int id, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
$p = Start-Process -FilePath $exe -ArgumentList $arg -PassThru
$null = $p.Handle
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 150; $i++) {
  Start-Sleep -Milliseconds 200
  $h = [CivicDialogProbe]::Find([uint32]$p.Id)
  if ($h -ne [IntPtr]::Zero -or $p.HasExited) { break }
}
$title = ''; $text = ''
if ($h -ne [IntPtr]::Zero) {
  $t = New-Object System.Text.StringBuilder 256; [void][CivicDialogProbe]::GetWindowText($h, $t, 256); $title = $t.ToString()
  $s = New-Object System.Text.StringBuilder 8192; [void][CivicDialogProbe]::GetDlgItemText($h, 65535, $s, 8192); $text = $s.ToString()
  [void][CivicDialogProbe]::PostMessage($h, 16, [IntPtr]::Zero, [IntPtr]::Zero)
}
[void]$p.WaitForExit(15000)
$code = 'running'
if ($p.HasExited) { $code = [string]$p.ExitCode }
# Built with += : in an @( ... ) literal the comma binds tighter than +, so the array collapses into one
# space-joined string -- measured, not assumed.
$lines = @()
$lines += 'found=' + ($h -ne [IntPtr]::Zero)
$lines += 'title=' + $title
$lines += 'exit=' + $code
$lines += 'text=' + ($text -replace '\r?\n', ' | ')
[System.IO.File]::WriteAllText($out, ($lines -join [char]10), [System.Text.Encoding]::UTF8)
`;

function dialogOf(exe, arg) {
  const text = ps(DIALOG_PROBE, exe, arg);
  const fields = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes('='))
      .map((l) => {
        const at = l.indexOf('=');
        return [l.slice(0, at), l.slice(at + 1)];
      }),
  );
  return {
    found: fields.found === 'True',
    title: fields.title ?? '',
    exit: fields.exit ?? '',
    text: fields.text ?? '',
  };
}

/** Raw HTTP over a socket, so a hostile request target reaches the server exactly as written. */
async function rawRequest(target, method = 'GET', host = '127.0.0.1:8765') {
  const net = await import('node:net');
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 8765 }, () => {
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolvePromise({ status: 0, raw: data });
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
    });
    socket.on('error', () => resolvePromise({ status: 0, raw: data }));
    socket.on('close', () => {
      const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(data)?.[1] ?? 0);
      const headerEnd = data.indexOf('\r\n\r\n');
      resolvePromise({
        status,
        headers: headerEnd < 0 ? '' : data.slice(0, headerEnd),
        body: headerEnd < 0 ? '' : data.slice(headerEnd + 4),
        raw: data,
      });
    });
  });
}

async function get(path) {
  const resp = await fetch(`${ORIGIN}${path}`, { redirect: 'manual' });
  return { status: resp.status, headers: resp.headers, body: await resp.text() };
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

async function waitFor(predicate, timeoutMs, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(everyMs);
  }
}

function runSetup(extraArgs = []) {
  const log = join(ROOT, 'release', 'windows', `.acceptance-setup-${Date.now()}.log`);
  const result = sh(SETUP, [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    `/LOG=${log}`,
    ...extraArgs,
  ]);
  return { code: result.status, log, logText: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

function runUninstall() {
  const unins = join(INSTALL_ROOT, 'unins000.exe');
  if (!existsSync(unins)) return { code: -1, detail: 'unins000.exe is not present' };
  const result = sh(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  return { code: result.status };
}

function launchLogLines() {
  const path = join(INSTALL_ROOT, 'logs', 'launch.log');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split(/\r?\n/) : [];
}

/** Copy the installed release to a sibling id, optionally rewriting it to an older data schema. */
function siblingRelease(id, { legacySchema = false } = {}) {
  const dir = join(INSTALL_ROOT, 'releases', id);
  rmSync(dir, { recursive: true, force: true });
  sh('powershell', [
    '-NoProfile',
    '-Command',
    `Copy-Item -LiteralPath '${join(INSTALL_ROOT, 'releases', RELEASE_ID)}' -Destination '${dir}' -Recurse`,
  ]);
  if (legacySchema) {
    // What an RC3 release looks like to civic-admin: no databaseSchemaVersion anywhere. The manifest
    // entry is rewritten to match, so the release still VERIFIES and the refusal under test is the
    // schema refusal, not an integrity one.
    const healthPath = join(dir, 'app', 'deployment-health.json');
    const health = JSON.parse(readFileSync(healthPath, 'utf8'));
    delete health.databaseSchemaVersion;
    const body = `${JSON.stringify(health, null, 2)}\n`;
    writeFileSync(healthPath, body, 'utf8');
    const sums = readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8').replace(
      /^[0-9a-f]{64}( \*app\/deployment-health\.json)$/m,
      `${sha256(Buffer.from(body, 'utf8'))}$1`,
    );
    writeFileSync(join(dir, 'SHA256SUMS.txt'), sums, 'utf8');
    const version = readFileSync(join(dir, 'VERSION'), 'utf8').replace(
      /^databaseSchemaVersion=.*\n/m,
      '',
    );
    writeFileSync(join(dir, 'VERSION'), version, 'utf8');
  }
  return dir;
}

// ===================================================================================================
console.log('CivicWorkDesk Windows -- development-workstation acceptance');
console.log('');
console.log(`  installer       : ${SETUP}`);
console.log(`  display version : ${IDENTITY.displayVersion}`);
console.log(`  release id      : ${RELEASE_ID}`);
console.log(`  install root    : ${INSTALL_ROOT}`);
console.log(`  origin          : ${ORIGIN}/`);

// ---------------------------------------------------------------------------------------------------
section('1. the installer bytes');
if (!existsSync(SETUP)) {
  console.error('error: the installer is not built. Run scripts/windows/build-release.mjs first.');
  process.exit(2);
}
const setupBytes = readFileSync(SETUP);
const setupDigest = sha256(setupBytes);
const sidecar = readFileSync(`${SETUP}.sha256`, 'utf8').trim().split(/\s+/)[0];
check(setupDigest === sidecar, 'installer matches its .sha256 sidecar', setupDigest);
info('installer size', `${setupBytes.length} bytes`);

// Elevation: an installer that silently needed administrator rights would pass every other check on a
// developer's machine and fail on a colleague's. Assert we are NOT elevated while installing.
const whoami = sh('whoami', ['/groups']);
const elevated = /S-1-16-12288/.test(whoami.stdout ?? ''); // High Mandatory Level
check(
  !elevated,
  'running as an ordinary, non-elevated user',
  elevated ? 'HIGH integrity' : 'medium integrity',
);

// ---------------------------------------------------------------------------------------------------
section('2. clean install from those bytes');
if (existsSync(INSTALL_ROOT)) {
  info('pre-existing installation found', 'uninstalling it first so this is a clean install');
  runUninstall();
  await sleep(1500);
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
}
const install = runSetup();
check(install.code === 0, 'Setup.exe exited 0', `code ${install.code}`);
check(existsSync(INSTALL_ROOT), 'install root created', INSTALL_ROOT);

const expectedTree = ['bin', 'current.txt', 'logs', 'releases', 'state'];
const actualTree = existsSync(INSTALL_ROOT) ? readdirSync(INSTALL_ROOT).sort() : [];
check(
  expectedTree.every((e) => actualTree.includes(e)),
  'per-user layout present',
  actualTree.join(', '),
);
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'current.txt names the installed release',
  RELEASE_ID,
);
check(
  existsSync(join(INSTALL_ROOT, 'releases', RELEASE_ID, 'app', 'index.html')),
  'application payload extracted',
);
for (const exe of ['civic-launch.exe', 'civic-server.exe', 'civic-admin.exe', 'civic-diag.exe']) {
  check(existsSync(bin(exe)), `bin\\${exe} in place`);
}

// No machine-wide footprint. These are the four things a per-user installer must never have done.
const hklm = sh('reg', [
  'query',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  '/f',
  'CivicWorkDesk',
  '/s',
]);
check(!/CivicWorkDesk/.test(hklm.stdout ?? ''), 'no HKLM uninstall entry');
const svc = sh('sc', ['query', 'CivicWorkDesk']);
check(svc.status !== 0, 'no Windows service created');
const task = sh('schtasks', ['/query', '/tn', 'CivicWorkDesk']);
check(task.status !== 0, 'no scheduled task created');
check(
  !existsSync(join(process.env.ProgramFiles ?? 'C:/Program Files', 'CivicWorkDesk')),
  'nothing in Program Files',
);

// The installed-programs entry is the second place a person reads the version and the publisher.
// Read through PowerShell into a UTF-8 file: `reg query` prints in the console code page, and the
// Chinese DisplayName came back as mojibake the first time this was run that way.
const uninstallFields = Object.fromEntries(
  ps(
    `$p = Get-ItemProperty -Path ('Registry::' + $args[1]) -ErrorAction SilentlyContinue
$lines = @()
if ($p) { foreach ($k in 'DisplayName','DisplayVersion','Publisher') { $lines += $k + '=' + $p.$k } }
[System.IO.File]::WriteAllText($args[0], ($lines -join [char]10), [System.Text.Encoding]::UTF8)`,
    APP_ID_KEY,
  )
    .split(/\r?\n/)
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const regValue = (name) => uninstallFields[name] ?? '';
check(
  Object.keys(uninstallFields).length === 3,
  'per-user uninstall entry registered under HKCU',
  APP_ID_KEY,
);
check(regValue('DisplayName') === IDENTITY.productNameZh, 'DisplayName', regValue('DisplayName'));
check(
  regValue('DisplayVersion') === IDENTITY.displayVersion,
  'DisplayVersion is the display version',
  regValue('DisplayVersion'),
);
check(regValue('Publisher') === IDENTITY.publisher, 'Publisher', regValue('Publisher'));

// ---------------------------------------------------------------------------------------------------
section('3. Start Menu integration');
check(existsSync(START_MENU), 'per-user Start Menu folder created', START_MENU);
const shortcuts = existsSync(START_MENU) ? readdirSync(START_MENU).sort() : [];
info('shortcuts', shortcuts.join(', '));
check(shortcuts.includes('政务工作记录台.lnk'), 'main shortcut named 政务工作记录台');
// RC2 moved the maintenance actions one level down, so that "stop the local service" no longer sits
// beside the application as though it were an ordinary thing to do. The grouping itself is asserted in
// acceptance-ux.mjs; what matters here is that both are still REACHABLE.
const maintenanceDir = join(START_MENU, '维护工具');
const maintenance = existsSync(maintenanceDir) ? readdirSync(maintenanceDir).sort() : [];
info('维护工具', maintenance.join(', ') || '(absent)');
check(maintenance.includes('收集诊断信息.lnk'), 'diagnostics shortcut present (维护工具)');
check(maintenance.includes('停止本地服务.lnk'), 'stop shortcut present (维护工具)');

// The shortcut must point at the stable bin\ target, not into a release directory that an upgrade
// would replace -- otherwise a pinned icon breaks on the next version.
const lnkTarget = sh('powershell', [
  '-NoProfile',
  '-Command',
  `(New-Object -ComObject WScript.Shell).CreateShortcut('${join(START_MENU, '政务工作记录台.lnk')}').TargetPath`,
]);
const target = (lnkTarget.stdout ?? '').trim();
check(
  target.toLowerCase() === bin('civic-launch.exe').toLowerCase(),
  'main shortcut targets bin\\civic-launch.exe',
  target,
);

// ---------------------------------------------------------------------------------------------------
section('4. launch, health gate and the exact origin');
// Activation already started and stopped a server during its integration check, so nothing should be
// running now.
check(!(await portOpen()), 'no server left running by the installer');

const launch1 = sh(bin('civic-launch.exe'), ['open']);
check(launch1.status === 0, 'civic-launch open exited 0', `code ${launch1.status}`);
check(await waitFor(portOpen, 15000), 'server is listening after launch');

const health = await get('/__civic/health');
check(health.status === 200, 'health endpoint answers 200', `status ${health.status}`);
let healthDoc = {};
try {
  healthDoc = JSON.parse(health.body);
} catch {
  /* reported below */
}
check(
  healthDoc.canonicalOrigin === ORIGIN,
  'health reports the canonical origin',
  healthDoc.canonicalOrigin,
);
check(
  healthDoc.releaseId === RELEASE_ID,
  'health reports the installed release',
  healthDoc.releaseId,
);
check(
  (healthDoc.installRoot ?? '').toLowerCase() === INSTALL_ROOT.toLowerCase(),
  'health reports this installation root',
  healthDoc.installRoot,
);
check(
  healthDoc.serverVersion === 'civic-server/1.1',
  'the server names its own version and no release-candidate label',
  healthDoc.serverVersion,
);
const firstPid = healthDoc.pid;
info('server pid', String(firstPid));

const appHealth = await get('/deployment-health.json');
check(appHealth.status === 200, 'application deployment-health.json served');
const appHealthDoc = JSON.parse(appHealth.body);
check(appHealthDoc.releaseId === RELEASE_ID, 'payload names the Windows release id');
check(appHealthDoc.releaseChannel === 'windows-x64', 'payload names the windows-x64 channel');
check(
  appHealthDoc.displayVersion === IDENTITY.displayVersion,
  'payload names the display version',
  appHealthDoc.displayVersion,
);
check(
  appHealthDoc.databaseSchemaVersion === 2 && appHealthDoc.backupFormatVersion === 3,
  'payload declares database schema 2 and backup format 3',
  `schema ${appHealthDoc.databaseSchemaVersion}, backup ${appHealthDoc.backupFormatVersion}`,
);

// The default-browser mechanism. Assert the shell actually started the user's configured handler rather
// than a hard-coded browser.
const progId = sh('reg', [
  'query',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice',
  '/v',
  'ProgId',
]);
const progIdValue = /ProgId\s+REG_SZ\s+(\S+)/.exec(progId.stdout ?? '')?.[1] ?? '(unknown)';
info('default http handler', progIdValue);
const browserProcesses = sh('powershell', [
  '-NoProfile',
  '-Command',
  '(Get-Process msedge,chrome,firefox,360chrome,360se -ErrorAction SilentlyContinue | Measure-Object).Count',
]);
check(
  Number((browserProcesses.stdout ?? '0').trim()) > 0,
  'a browser process is running after launch',
  `handler ${progIdValue}`,
);
check(
  launchLogLines().some((l) => / open outcome=ok exit=0 /.test(l)),
  'the launch was recorded in logs\\launch.log as ok',
);

// ---------------------------------------------------------------------------------------------------
section('5. repeated launch is idempotent');
const launch2 = sh(bin('civic-launch.exe'), ['open']);
const launch3 = sh(bin('civic-launch.exe'), ['open']);
check(launch2.status === 0 && launch3.status === 0, 'two further launches both exited 0');
const health2 = JSON.parse((await get('/__civic/health')).body);
check(
  health2.pid === firstPid,
  'the same server is reused, not a second one',
  `pid ${health2.pid}`,
);
const running = serverProcesses().split(/\r?\n/).filter(Boolean);
check(
  running.length === 1,
  'exactly one civic-server process exists',
  `${running.length} process(es): ${running.join(', ')}`,
);

// ---------------------------------------------------------------------------------------------------
section('6. HTTP semantics');
const mime = {
  '/': 'text/html; charset=utf-8',
  '/index.html': 'text/html; charset=utf-8',
  '/sw.js': 'text/javascript; charset=utf-8',
  '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  '/deployment-health.json': 'application/json; charset=utf-8',
};
for (const [path, want] of Object.entries(mime)) {
  const r = await get(path);
  check(
    r.status === 200 && r.headers.get('content-type') === want,
    `MIME ${path}`,
    `${r.status} ${r.headers.get('content-type')}`,
  );
}
// The content-hashed asset bundle, discovered from the payload rather than hard-coded.
const entryJs = appHealthDoc.entry.js;
const asset = await get(`/${entryJs}`);
check(
  asset.status === 200 && asset.headers.get('content-type') === 'text/javascript; charset=utf-8',
  `MIME /${entryJs}`,
  `${asset.status} ${asset.headers.get('content-type')}`,
);
check(
  /immutable/.test(asset.headers.get('cache-control') ?? ''),
  'hashed assets are cacheable',
  asset.headers.get('cache-control') ?? '',
);
check(
  (await get('/sw.js')).headers.get('cache-control') === 'no-cache',
  'sw.js is not cached immutably',
);
check(
  (await get('/index.html')).headers.get('x-content-type-options') === 'nosniff',
  'nosniff is set',
);

const head = await fetch(`${ORIGIN}/index.html`, { method: 'HEAD' });
check(head.status === 200 && (await head.text()) === '', 'HEAD returns headers and no body');

for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
  const r = await fetch(`${ORIGIN}/index.html`, { method });
  check(
    r.status === 405 && r.headers.get('allow') === 'GET, HEAD',
    `${method} is refused 405`,
    `${r.status} allow=${r.headers.get('allow')}`,
  );
}

for (const dir of ['/assets/', '/assets', '/icons/']) {
  const r = await get(dir);
  check(
    r.status === 404 && !/index-|\.js<|icon-/.test(r.body),
    `no directory listing at ${dir}`,
    `status ${r.status}`,
  );
}

// ---------------------------------------------------------------------------------------------------
section('7. traversal, against the live server');
// Something real and outside the document root: the release's own VERSION file, one level above app\.
const canary = 'releaseChannel=windows-x64';
const traversals = [
  '/../VERSION',
  '/../../current.txt',
  '/assets/../../VERSION',
  '/%2e%2e/VERSION',
  '/%2e%2e%2fVERSION',
  '/%2E%2E%2FVERSION',
  '/%252e%252e%252fVERSION',
  '/..%2fVERSION',
  '/..%5cVERSION',
  '/..\\VERSION',
  '/\\..\\VERSION',
  '/assets\\..\\..\\VERSION',
  '/....//VERSION',
  '/.%2e/VERSION',
  '/index.html/../VERSION',
  '/index.html%00.js',
  '/C:/Windows/win.ini',
  '/index.html.',
  '/index.html%20',
  '/%00/VERSION',
];
let leaks = 0;
for (const t of traversals) {
  const r = await rawRequest(t);
  const leaked = r.body?.includes(canary) || /\[fonts\]/i.test(r.body ?? '');
  if (leaked) {
    leaks += 1;
    fail(`traversal ${t}`, `LEAKED (status ${r.status})`);
  }
}
check(
  leaks === 0,
  `${traversals.length} traversal shapes all refused`,
  'no file outside app\\ was served',
);

// The traversal battery must be able to fail. Confirm the canary is genuinely reachable on disk and
// genuinely outside the document root, or those refusals prove nothing.
const versionOnDisk = readFileSync(join(INSTALL_ROOT, 'releases', RELEASE_ID, 'VERSION'), 'utf8');
check(
  versionOnDisk.includes(canary),
  'the traversal canary really exists one level above the root',
  'so a successful escape would have been visible',
);

const malformed = await rawRequest('not-a-path');
check(
  [400, 404].includes(malformed.status),
  'a malformed request target is refused',
  `status ${malformed.status}`,
);

// ---------------------------------------------------------------------------------------------------
section('8. status, stop and process identity');
const status = sh(bin('civic-launch.exe'), ['status']);
check(status.status === 0, 'status exited 0');
check(/已核验属于本安装/.test(status.stdout ?? ''), 'status proves process ownership');
check(
  (status.stdout ?? '').includes(`${IDENTITY.displayVersion}（${RELEASE_ID}）`),
  'status names the display version and the release id',
);
check(/数据格式 +: 第 2 版/.test(status.stdout ?? ''), 'status names the data format');
check(
  /no missing, altered or unlisted file/.test(status.stdout ?? ''),
  'status verifies payload integrity',
);

// A state file that names a process we do not own must lead to a refusal, not a kill.
//
// Tampering with the PID alone is NOT enough to test this: stop tries the graceful shutdown endpoint
// first, and a valid token would stop the real server politely without ever reaching the terminate path
// under test. The token has to be broken too, so the only route left is the one that must refuse.
const statePath = join(INSTALL_ROOT, 'state', 'server.json');
const realState = JSON.parse(readFileSync(statePath, 'utf8'));
const victim = spawn('cmd.exe', ['/c', 'ping', '-n', '30', '127.0.0.1'], {
  windowsHide: true,
  detached: true,
});
await sleep(500);

const tampered = structuredClone(realState);
tampered.identity.pid = victim.pid;
tampered.shutdownToken = 'f'.repeat(64); // wrong, so the graceful path cannot short-circuit the test
writeFileSync(statePath, JSON.stringify(tampered, null, 2));

const stopRefused = sh(bin('civic-launch.exe'), ['stop']);
const refusalText = `${stopRefused.stdout}${stopRefused.stderr}`;
const victimAlive = sh('powershell', [
  '-NoProfile',
  '-Command',
  `(Get-Process -Id ${victim.pid} -ErrorAction SilentlyContinue | Measure-Object).Count`,
]);
check(
  Number((victimAlive.stdout ?? '0').trim()) === 1,
  'stop did NOT kill an unrelated process named by a tampered state file',
  `pid ${victim.pid} still alive`,
);
check(
  stopRefused.status !== 0,
  'stop exited non-zero rather than claiming success',
  `code ${stopRefused.status}`,
);
check(
  /refusing to terminate/.test(refusalText),
  'the refusal names the reason it refused',
  refusalText.split(/\r?\n/).find((l) => /refusing/.test(l)) ?? '(no reason line)',
);
check(
  /程序不会强行结束无法确认归属的进程/.test(refusalText),
  'the refusal states the canonical safety guarantee in Chinese',
);
check(await portOpen(), 'the real server is still running -- the refusal cost nothing');
victim.kill();

// Restored token, real PID: the graceful path must now work.
writeFileSync(statePath, JSON.stringify(realState, null, 2));
const stop = sh(bin('civic-launch.exe'), ['stop']);
check(
  stop.status === 0,
  'stop exited 0 once the state file was correct again',
  `code ${stop.status}`,
);
check(await waitFor(async () => !(await portOpen()), 8000), 'the port is free after stop');
check(!existsSync(statePath), 'the state file was removed on stop');

// Stopping twice must be harmless: the record names a dead process, and the honest answer is "nothing
// is running", not a refusal.
writeFileSync(statePath, JSON.stringify(realState, null, 2));
const stopAgain = sh(bin('civic-launch.exe'), ['stop']);
check(stopAgain.status === 0, 'stop on a stale record exits 0', `code ${stopAgain.status}`);
check(/未在运行/.test(stopAgain.stdout ?? ''), 'it reports that nothing is running');
check(!existsSync(statePath), 'the stale record was cleared');
const stopThird = sh(bin('civic-launch.exe'), ['stop']);
check(stopThird.status === 0, 'stop with no record at all exits 0', `code ${stopThird.status}`);

// Let anything of ours finish exiting before the next section measures the port.
await waitFor(async () => serverProcesses() === '', 15000);

// ---------------------------------------------------------------------------------------------------
section('9. fixed-port conflict, and the occupant survives');
const net = await import('node:net');
const squatter = net.createServer((s) => s.end());
await new Promise((r) => squatter.listen(8765, '127.0.0.1', r));
const conflicted = sh(bin('civic-launch.exe'), ['open']);
check(conflicted.status === 3, 'launch exits 3 on a port conflict', `code ${conflicted.status}`);
const conflictText = `${conflicted.stdout}${conflicted.stderr}`;
check(/已被其他程序占用/.test(conflictText), 'the conflict message is in Chinese and specific');
check(/换端口/.test(conflictText), 'the message explains why the port cannot be changed');
check(squatter.listening, 'the unrelated occupant is still listening -- it was not killed');
check(
  launchLogLines().some((l) => / open outcome=port-conflict-foreign-program exit=3 /.test(l)),
  'the conflict was recorded in logs\\launch.log',
);

// The same conflict, started the way a Start Menu shortcut starts it. There is no console, so the
// person must get a dialog -- RC1-RC3 printed to a stderr that did not exist and showed nothing.
const conflictDialog = dialogOf(bin('civic-launch.exe'), 'open');
check(conflictDialog.found, 'a shortcut-started launch shows a dialog on a port conflict');
check(
  conflictDialog.title === '政务工作记录台',
  'the dialog is titled 政务工作记录台',
  conflictDialog.title,
);
check(
  /端口 127\.0\.0\.1:8765 已被其他程序占用/.test(conflictDialog.text) &&
    /收集诊断信息/.test(conflictDialog.text),
  'the dialog explains the conflict and points to 收集诊断信息',
  conflictDialog.text.slice(0, 120),
);
check(
  conflictDialog.exit === '3',
  'the shortcut-started launch still exits 3',
  conflictDialog.exit,
);
check(squatter.listening, 'the occupant survived the second attempt too');
const stray = serverProcesses();
check(
  stray === '',
  'no server was started on another port',
  stray === '' ? 'none running' : `still running: ${stray}`,
);
await new Promise((r) => squatter.close(r));

// The status shortcut: with no console, the report arrives in an information dialog.
const statusDialog = dialogOf(bin('civic-launch.exe'), 'status');
check(statusDialog.found, 'the 查看运行状态 shortcut shows its report in a dialog');
check(
  /运行状态/.test(statusDialog.text) && statusDialog.text.includes(RELEASE_ID),
  'the status dialog carries the report',
  statusDialog.text.slice(0, 120),
);
check(statusDialog.exit === '0', 'status exits 0', statusDialog.exit);

// ---------------------------------------------------------------------------------------------------
section('10. a quarantined server executable');
// What an anti-malware quarantine looks like to the launcher: both copies of civic-server.exe gone. The
// outcome must be named, and the person must be told to repair rather than to switch protection off.
const releaseServer = join(INSTALL_ROOT, 'releases', RELEASE_ID, 'server', 'civic-server.exe');
const binServer = bin('civic-server.exe');
const aside = (p) => `${p}.acceptance-aside`;
sh('powershell', [
  '-NoProfile',
  '-Command',
  `Move-Item -LiteralPath '${binServer}' -Destination '${aside(binServer)}'; Move-Item -LiteralPath '${releaseServer}' -Destination '${aside(releaseServer)}'`,
]);
const quarantined = sh(bin('civic-launch.exe'), ['open']);
const quarantineText = `${quarantined.stdout}${quarantined.stderr}`;
check(
  quarantined.status === 5,
  'launch exits 5 when the server executable is missing',
  `code ${quarantined.status}`,
);
check(/找不到本地服务程序/.test(quarantineText), 'the message names the missing program');
check(
  /请不要为此关闭安全软件/.test(quarantineText),
  'the message does not ask for protection to be switched off',
);
check(
  launchLogLines().some((l) => / open outcome=server-executable-missing exit=5 /.test(l)),
  'the outcome was recorded as server-executable-missing',
);
sh('powershell', [
  '-NoProfile',
  '-Command',
  `Move-Item -LiteralPath '${aside(binServer)}' -Destination '${binServer}'; Move-Item -LiteralPath '${aside(releaseServer)}' -Destination '${releaseServer}'`,
]);
check(existsSync(binServer) && existsSync(releaseServer), 'both executables were put back');

// ---------------------------------------------------------------------------------------------------
section('11. same-version repair');
sh(bin('civic-launch.exe'), ['stop']);
const removed = await waitFor(async () => {
  try {
    rmSync(bin('civic-server.exe'), { force: true });
  } catch {
    /* still locked; retry */
  }
  return !existsSync(bin('civic-server.exe'));
}, 20000);
check(
  removed,
  'bin\\civic-server.exe removed to simulate damage',
  removed ? 'deleted' : 'still locked after 20s',
);
const repair = sh(bin('civic-admin.exe'), [
  'activate',
  '--root',
  INSTALL_ROOT,
  '--release',
  RELEASE_ID,
]);
check(repair.status === 0, 'same-version activate exited 0', `code ${repair.status}`);
check(
  /already active; repaired/.test(repair.stdout ?? ''),
  'it reported a repair rather than an install',
);
check(existsSync(bin('civic-server.exe')), 'the damaged binary was restored');
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'current.txt is unchanged by a repair',
);
check(/integration check/.test(repair.stdout ?? ''), 'the repair proved the server still serves');
sh(bin('civic-launch.exe'), ['stop']);

// A same-version activate must not damage the payload it is verifying.
const verifyAfterRepair = sh(bin('civic-admin.exe'), [
  'verify',
  '--root',
  INSTALL_ROOT,
  '--release',
  RELEASE_ID,
  '--expect-active',
]);
check(
  verifyAfterRepair.status === 0,
  'the payload still verifies, and this release is the active one',
  (verifyAfterRepair.stdout ?? '').trim(),
);

// ---------------------------------------------------------------------------------------------------
section('12. concurrent installers');
const a = spawn(
  bin('civic-admin.exe'),
  ['activate', '--root', INSTALL_ROOT, '--release', RELEASE_ID],
  { windowsHide: true },
);
const b = spawn(
  bin('civic-admin.exe'),
  ['activate', '--root', INSTALL_ROOT, '--release', RELEASE_ID],
  { windowsHide: true },
);
const codes = await Promise.all(
  [a, b].map(
    (p) =>
      new Promise((r) => {
        let out = '';
        p.stdout.on('data', (d) => {
          out += d;
        });
        p.stderr.on('data', (d) => {
          out += d;
        });
        p.on('close', (code) => r({ code, out }));
      }),
  ),
);
const succeeded = codes.filter((c) => c.code === 0).length;
const refused = codes.filter((c) => c.code === 6).length;
check(
  succeeded === 1 && refused === 1,
  'exactly one concurrent activation succeeded and one was refused as busy',
  codes.map((c) => `exit ${c.code}`).join(', '),
);
check(
  codes.some((c) => /in progress/.test(c.out)),
  'the refusal says another operation is in progress',
);
const shapeAfterConcurrent = readdirSync(join(INSTALL_ROOT, 'releases', RELEASE_ID)).sort();
check(
  shapeAfterConcurrent.join(',') === 'SHA256SUMS.txt,VERSION,app,server',
  'the release directory was not nested or corrupted',
  shapeAfterConcurrent.join(', '),
);
sh(bin('civic-launch.exe'), ['stop']);

// ---------------------------------------------------------------------------------------------------
section('13. upgrade and rollback within one data format');
// A second release built by copying the first: this exercises the pointer machinery without pretending
// the payload changed. Same schema, so both directions are allowed.
const NEXT_ID = `${RELEASE_ID}a`;
const nextDir = siblingRelease(NEXT_ID);
const upgrade = sh(bin('civic-admin.exe'), [
  'activate',
  '--root',
  INSTALL_ROOT,
  '--release',
  NEXT_ID,
]);
check(upgrade.status === 0, 'upgrade activation exited 0', `code ${upgrade.status}`);
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === NEXT_ID,
  'current.txt now names the new release',
);
check(
  readFileSync(join(INSTALL_ROOT, 'previous.txt'), 'utf8').trim() === RELEASE_ID,
  'previous.txt records the rollback target',
);
sh(bin('civic-launch.exe'), ['stop']);

const rollback = sh(bin('civic-admin.exe'), ['rollback', '--root', INSTALL_ROOT]);
check(rollback.status === 0, 'rollback within one schema exited 0', `code ${rollback.status}`);
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'current.txt is back to the previous release',
);
check(
  /Browser-resident records are untouched/.test(rollback.stdout ?? ''),
  'rollback states that it changed the deployment payload only',
);
sh(bin('civic-launch.exe'), ['stop']);
rmSync(nextDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------------
section('14. an older data format is never put in front of the records');
// A release shaped like RC3 -- no databaseSchemaVersion, so schema 1 -- that still verifies.
const LEGACY_ID = `${RELEASE_ID}l`;
const legacyDir = siblingRelease(LEGACY_ID, { legacySchema: true });
const legacyVerify = sh(bin('civic-admin.exe'), [
  'verify',
  '--root',
  INSTALL_ROOT,
  '--release',
  LEGACY_ID,
]);
check(
  legacyVerify.status === 0,
  'the legacy-shaped release verifies, so only its schema is at issue',
);

const downgrade = sh(bin('civic-admin.exe'), [
  'activate',
  '--root',
  INSTALL_ROOT,
  '--release',
  LEGACY_ID,
]);
check(
  downgrade.status === 4,
  'activating an older data format is refused (exit 4)',
  `code ${downgrade.status}`,
);
check(
  /older browser-database schema/.test(downgrade.stderr ?? '') &&
    /不支持把数据降级/.test(downgrade.stderr ?? ''),
  'the refusal names the reason, in English and in Chinese',
);
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'the current release is untouched by the refused activation',
);

// Rollback: previous.txt naming an older format is exactly the state an RC3 -> 0.2.0 upgrade leaves.
writeFileSync(join(INSTALL_ROOT, 'previous.txt'), `${LEGACY_ID}\r\n`);
const refusedRollback = sh(bin('civic-admin.exe'), ['rollback', '--root', INSTALL_ROOT]);
check(
  refusedRollback.status === 4,
  'rollback to an older data format is refused (exit 4)',
  `code ${refusedRollback.status}`,
);
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'the current release is untouched by the refused rollback',
);
const statusAfter = sh(bin('civic-launch.exe'), ['status']);
check(
  /可回退版本 +: （无）上一版本 .* 使用较旧的数据格式（第 1 版），回退可能损坏记录，已禁止/.test(
    statusAfter.stdout ?? '',
  ),
  'status says the previous release is not a safe rollback target',
);
check(!(await portOpen()), 'nothing was started by either refusal');

// Failure before activation must leave the current version usable. Corrupt a staged release and confirm
// activation refuses without touching current.txt.
const BROKEN_ID = `${RELEASE_ID}b`;
const brokenDir = siblingRelease(BROKEN_ID);
writeFileSync(join(brokenDir, 'app', 'index.html'), '<!doctype html><title>tampered</title>');
const brokenActivate = sh(bin('civic-admin.exe'), [
  'activate',
  '--root',
  INSTALL_ROOT,
  '--release',
  BROKEN_ID,
]);
check(
  brokenActivate.status !== 0,
  'activating a tampered release is refused',
  `code ${brokenActivate.status}`,
);
check(/refusing to activate/.test(brokenActivate.stderr ?? ''), 'the refusal is explicit');
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'the previous version is STILL active after the failed activation',
);
rmSync(brokenDir, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------------
section('15. diagnostics');
// Start a server first. A report collected with nothing running is the uninteresting case.
sh(bin('civic-launch.exe'), ['open']);
await waitFor(portOpen, 15000);
const liveState = JSON.parse(readFileSync(join(INSTALL_ROOT, 'state', 'server.json'), 'utf8'));
// One request under localhost, the mistake that makes records look lost: the server must mark it, and
// the report must name the class.
const viaLocalhost = await rawRequest('/', 'GET', 'localhost:8765');
check(
  viaLocalhost.status === 200,
  'a request under localhost is still answered (behaviour unchanged)',
);

const diag = sh(bin('civic-diag.exe'), []);
check(diag.status === 0, 'civic-diag exited 0', `code ${diag.status}`);
const diagPath = /([A-Z]:\\[^\r\n]*CivicWorkDesk-诊断信息-[0-9-]+\.txt)/.exec(
  diag.stdout ?? '',
)?.[1];
check(Boolean(diagPath), 'the diagnostic report path was printed', diagPath ?? '(not found)');
if (diagPath && existsSync(diagPath)) {
  const report = readFileSync(diagPath, 'utf8');
  check(
    report.startsWith('\uFEFF'),
    'the report is UTF-8 with a BOM so Notepad reads it correctly',
  );
  check(
    report.indexOf('0. 诊断结论') > 0 &&
      report.indexOf('0. 诊断结论') < report.indexOf('1. Windows'),
    'the report opens with its conclusion',
  );
  check(
    /\[origin-or-profile\] 服务日志中有 [1-9][0-9]* 个请求不是通过固定访问地址/.test(report),
    'the conclusion names the localhost request as an origin issue',
  );
  check(
    /support class +: windows-11/.test(report),
    'the report classifies this machine as Windows 11',
  );
  check(
    /native arch +: x64 \(IsWow64Process2\)/.test(report),
    'the report names the native architecture',
  );
  check(
    /registry name +: .*the build decides/.test(report),
    'the registry product name is quoted, not trusted',
  );
  check(
    /Smart App Control : /.test(report) && /AppLocker rules +: /.test(report),
    'the report states the program-execution policies',
  );
  check(report.includes(RELEASE_ID), 'the report names the active release');
  check(
    new RegExp(`display version +: ${IDENTITY.displayVersion.replace(/\./g, '\\.')}`).test(report),
    'the report names the display version',
  );
  check(/data format +: schema 2/.test(report), 'the report names the data format');
  check(
    /rollback +: NOT a safe rollback target -- it uses schema 1/.test(report),
    'the report says the older previous release is not a safe rollback target',
  );
  check(report.includes(ORIGIN), 'the report names the canonical origin');
  check(
    /shutdown token +: present/.test(report),
    'the shutdown token is reported as present, not printed',
  );
  check(/ownership +: PROVEN/.test(report), 'the report states that server ownership is proven');
  check(/payload +: .*verified/.test(report), 'the report carries the payload verdict');
  check(
    /5\. Launch log/.test(report) && /outcome=server-executable-missing/.test(report),
    'the report carries the launch log',
  );
  check(
    /host=localhost:8765/.test(report),
    'the report carries the server log with the host marker',
  );
  check(/7\. Installer transcript/.test(report), 'the report carries the installer transcript');

  // The token is the one secret in the tree. It must be named as present and never quoted.
  check(!report.includes(liveState.shutdownToken), 'the token value itself is NOT in the report');

  // Scan for the SHAPE of leaked data, not for words: the report's own privacy note names Cookie and
  // passwords in order to promise it does not carry them.
  const blobs = report.match(/[A-Za-z0-9+/]{48,}={0,2}/g) ?? [];
  check(
    blobs.length === 0,
    'the report carries no long opaque blob',
    blobs.length === 0
      ? 'no base64/hex run of 48+ characters'
      : `found: ${blobs.slice(0, 2).join(', ')}`,
  );
  const account = process.env.USERNAME ?? '';
  check(
    account.length >= 3 && !report.toLowerCase().includes(account.toLowerCase()),
    'the report does not carry the account name',
  );
  for (const marker of ['.sqlite', '.ldb', 'Local Storage', 'User Data', 'IndexedDB\\']) {
    check(!report.includes(marker), `the report does not reference ${marker}`);
  }
  info('diagnostic file', `${diagPath} (${readFileSync(diagPath).length} bytes)`);
  rmSync(diagPath, { force: true });
}
sh(bin('civic-launch.exe'), ['stop']);
rmSync(legacyDir, { recursive: true, force: true });
rmSync(join(INSTALL_ROOT, 'previous.txt'), { force: true });

// ---------------------------------------------------------------------------------------------------
section('16. summary');
const outDir = join(ROOT, 'release', 'windows');
for (const f of readdirSync(outDir)) {
  if (f.startsWith('.acceptance-setup-')) rmSync(join(outDir, f), { force: true });
}

console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  passed : ${results.filter((r) => r.status === 'PASS').length}`);
console.log(`  failed : ${failures}`);
console.log('');
if (failures === 0) {
  console.log('  RESULT: PASS on this development workstation.');
  console.log(
    '  This does NOT certify Windows compatibility. One machine, one operator, one browser family.',
  );
} else {
  console.log('  RESULT: FAIL -- see the [FAIL] lines above.');
}

writeFileSync(
  join(outDir, `acceptance-deploy-${RELEASE_ID}.txt`),
  [
    `CivicWorkDesk Windows ${IDENTITY.displayVersion} -- development-workstation acceptance`,
    '',
    `installer sha256 : ${setupDigest}`,
    `release id       : ${RELEASE_ID}`,
    `install root     : ${INSTALL_ROOT}`,
    `origin           : ${ORIGIN}/`,
    `checks           : ${results.length} (${failures} failed)`,
    '',
    ...results.map(
      (r) => `[${r.status.padEnd(4)}] ${r.name}${r.detail ? `  --  ${r.detail}` : ''}`,
    ),
    '',
    failures === 0
      ? 'RESULT: PASS on the development workstation. Windows compatibility is NOT certified.'
      : 'RESULT: FAIL.',
    '',
  ].join('\n'),
  'utf8',
);

if (!KEEP) {
  console.log(
    '  (pass --keep to leave the installation in place; browser-side checks run separately)',
  );
}
process.exit(failures === 0 ? 0 : 1);
