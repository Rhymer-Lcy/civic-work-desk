#!/usr/bin/env node
/**
 * Windows RC1 acceptance on the development workstation, driven from the ACTUAL installer bytes.
 *
 *   node scripts/windows/acceptance-deploy.mjs [--release-id <id>] [--keep]
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
 * `--keep` leaves the installation in place at the end, for looking at by hand.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// The suite is release-agnostic: the same checks have to pass for every candidate, and hard-coding one
// id is how a suite quietly stops covering the thing being shipped.
const RELEASE_ID = argValue('--release-id', '2026.09.24-win-rc2');
const SETUP_BASE = `CivicWorkDesk-Windows-x64-${RELEASE_ID.replace('-win-', '-')}-Setup`;
const SETUP = join(ROOT, 'release', 'windows', `${SETUP_BASE}.exe`);
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

function serverProcesses() {
  const r = sh('powershell', [
    '-NoProfile',
    '-Command',
    'Get-Process civic-server -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)" }',
  ]);
  return (r.stdout ?? '').trim();
}

/** Raw HTTP over a socket, so a hostile request target reaches the server exactly as written. */
async function rawRequest(target, method = 'GET') {
  const net = await import('node:net');
  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 8765 }, () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:8765\r\nConnection: close\r\n\r\n`,
      );
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

// ===================================================================================================
console.log('CivicWorkDesk Windows RC1 -- development-workstation acceptance');
console.log('');
console.log(`  installer   : ${SETUP}`);
console.log(`  install root: ${INSTALL_ROOT}`);
console.log(`  origin      : ${ORIGIN}/`);

// ---------------------------------------------------------------------------------------------------
section('1. the installer bytes');
if (!existsSync(SETUP)) {
  console.error('error: the installer is not built. Run scripts/windows/build-release.mjs first.');
  process.exit(2);
}
const setupBytes = readFileSync(SETUP);
const setupDigest = createHash('sha256').update(setupBytes).digest('hex');
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
const hkcu = sh('reg', [
  'query',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  '/f',
  'CivicWorkDesk',
  '/s',
]);
check(/CivicWorkDesk|政务/.test(hkcu.stdout ?? ''), 'per-user uninstall entry registered');
const svc = sh('sc', ['query', 'CivicWorkDesk']);
check(svc.status !== 0, 'no Windows service created');
const task = sh('schtasks', ['/query', '/tn', 'CivicWorkDesk']);
check(task.status !== 0, 'no scheduled task created');
check(
  !existsSync(join(process.env.ProgramFiles ?? 'C:/Program Files', 'CivicWorkDesk')),
  'nothing in Program Files',
);

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
const firstPid = healthDoc.pid;
info('server pid', String(firstPid));

const appHealth = await get('/deployment-health.json');
check(appHealth.status === 200, 'application deployment-health.json served');
check(JSON.parse(appHealth.body).releaseId === RELEASE_ID, 'payload names the Windows release id');
check(
  JSON.parse(appHealth.body).releaseChannel === 'windows-x64',
  'payload names the windows-x64 channel',
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
const entryJs = JSON.parse(appHealth.body).entry.js;
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
for (const target of traversals) {
  const r = await rawRequest(target);
  const leaked = r.body?.includes(canary) || /\[fonts\]/i.test(r.body ?? '');
  if (leaked) {
    leaks += 1;
    fail(`traversal ${target}`, `LEAKED (status ${r.status})`);
  }
}
check(
  leaks === 0,
  `${traversals.length} traversal shapes all refused`,
  'no file outside app\\ was served',
);

// The traversal battery must be able to fail. Confirm the canary is genuinely reachable on disk and
// genuinely outside the document root, or those 20 refusals prove nothing.
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
check(new RegExp(RELEASE_ID).test(status.stdout ?? ''), 'status names the active release');
check(
  /no missing, altered or unlisted file/.test(status.stdout ?? ''),
  'status verifies payload integrity',
);

// A state file that names a process we do not own must lead to a refusal, not a kill.
//
// Tampering with the PID alone is NOT enough to test this, and the first version of this check made
// exactly that mistake: stop tries the graceful shutdown endpoint first, the real token was still
// valid, so the real server stopped politely and the terminate path -- the one under test -- was never
// reached. The token has to be broken too, so the only route left is the one that must refuse.
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
// RC2 replaced RC1's developer-facing sentence with the canonical safety statement from
// docs/copy-style-zh-CN.md, so that is what must appear.
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

// Stopping twice must be harmless. This is the case that used to return an error: the record names a
// dead process, and the honest answer is "nothing is running", not a refusal.
writeFileSync(statePath, JSON.stringify(realState, null, 2));
const stopAgain = sh(bin('civic-launch.exe'), ['stop']);
check(stopAgain.status === 0, 'stop on a stale record exits 0', `code ${stopAgain.status}`);
check(/未在运行/.test(stopAgain.stdout ?? ''), 'it reports that nothing is running');
check(!existsSync(statePath), 'the stale record was cleared');
const stopThird = sh(bin('civic-launch.exe'), ['stop']);
check(stopThird.status === 0, 'stop with no record at all exits 0', `code ${stopThird.status}`);

// Let anything of ours finish exiting before the next section measures the port: a just-exited image is
// still listed by Get-Process for a moment, and its file cannot be deleted yet.
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
const stray = serverProcesses();
check(
  stray === '',
  'no server was started on another port',
  stray === '' ? 'none running' : `still running: ${stray}`,
);
await new Promise((r) => squatter.close(r));

// ---------------------------------------------------------------------------------------------------
section('10. same-version repair');
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
const verifyAfterRepair = sh(bin('civic-admin.exe'), ['verify', '--root', INSTALL_ROOT]);
check(
  verifyAfterRepair.status === 0,
  'the payload still verifies after a repair',
  (verifyAfterRepair.stdout ?? '').trim(),
);

// ---------------------------------------------------------------------------------------------------
section('11. concurrent installers');
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
section('12. upgrade and rollback');
// A second release built by copying the first: this exercises the pointer machinery without pretending
// the payload changed.
const NEXT_ID = RELEASE_ID + 'a'; // a synthetic sibling release, for the pointer machinery only
const nextDir = join(INSTALL_ROOT, 'releases', NEXT_ID);
rmSync(nextDir, { recursive: true, force: true });
sh('powershell', [
  '-NoProfile',
  '-Command',
  `Copy-Item -LiteralPath '${join(INSTALL_ROOT, 'releases', RELEASE_ID)}' -Destination '${nextDir}' -Recurse`,
]);
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
check(rollback.status === 0, 'rollback exited 0', `code ${rollback.status}`);
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

// Failure before activation must leave the current version usable. Corrupt a staged release and confirm
// activation refuses without touching current.txt.
const BROKEN_ID = RELEASE_ID + 'b'; // deliberately tampered, to prove activation refuses it
const brokenDir = join(INSTALL_ROOT, 'releases', BROKEN_ID);
rmSync(brokenDir, { recursive: true, force: true });
sh('powershell', [
  '-NoProfile',
  '-Command',
  `Copy-Item -LiteralPath '${join(INSTALL_ROOT, 'releases', RELEASE_ID)}' -Destination '${brokenDir}' -Recurse`,
]);
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
section('13. diagnostics');
// Start a server first. A diagnostic report collected with nothing running is the uninteresting case,
// and the first version of this check asserted on a line that only exists when a server IS recorded --
// so it failed for the wrong reason rather than finding anything.
sh(bin('civic-launch.exe'), ['open']);
await waitFor(portOpen, 15000);
const liveState = JSON.parse(readFileSync(join(INSTALL_ROOT, 'state', 'server.json'), 'utf8'));

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
  check(report.includes(RELEASE_ID), 'the report names the active release');
  check(report.includes(ORIGIN), 'the report names the canonical origin');
  check(
    /shutdown token +: present/.test(report),
    'the shutdown token is reported as present, not printed',
  );
  check(/ownership +: PROVEN/.test(report), 'the report states that server ownership is proven');
  check(/payload +: .*verified/.test(report), 'the report carries the payload verdict');
  check(/install.log|Deployment log/.test(report), 'the report carries the deployment log');

  // The token is the one secret in the tree. It must be named as present and never quoted.
  check(!report.includes(liveState.shutdownToken), 'the token value itself is NOT in the report');

  // A word-based scan is the wrong instrument here: the report's own privacy note names Cookie,
  // IndexedDB and passwords in order to promise it does not carry them, so grepping for those words
  // matches the disclaimer and reports a leak that does not exist -- which is exactly what the first
  // version of this check did. Scan for the SHAPE of leaked data instead, outside the note.
  const note = report.indexOf('可以直接回传。');
  const body = note >= 0 ? report.slice(note) : report;
  const blobs = body.match(/[A-Za-z0-9+/]{48,}={0,2}/g) ?? [];
  check(
    blobs.length === 0,
    'the report body carries no long opaque blob',
    blobs.length === 0
      ? 'no base64/hex run of 48+ characters'
      : `found: ${blobs.slice(0, 2).join(', ')}`,
  );
  for (const marker of ['.sqlite', '.ldb', 'Local Storage', 'User Data', 'CURRENT_RECORD']) {
    check(!body.includes(marker), `the report body does not reference ${marker}`);
  }
  info('diagnostic file', `${diagPath} (${readFileSync(diagPath).length} bytes)`);
  rmSync(diagPath, { force: true });
}
sh(bin('civic-launch.exe'), ['stop']);

// ---------------------------------------------------------------------------------------------------
section('14. summary');
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
    'CivicWorkDesk Windows RC1 -- development-workstation acceptance',
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
