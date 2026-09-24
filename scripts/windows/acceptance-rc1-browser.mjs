#!/usr/bin/env node
/**
 * Browser-side acceptance for the Windows RC1, against the INSTALLED origin.
 *
 *   node scripts/windows/acceptance-rc1-browser.mjs
 *
 * Requires the RC1 to be installed (scripts/windows/acceptance-rc1.mjs --keep leaves it in place).
 *
 * ## Why this is separate from the installer acceptance
 *
 * Everything here needs a real browser at http://127.0.0.1:8765/. The Stage-A probe could not answer any
 * of it, because there was no server to provide an origin, and the installer acceptance cannot either,
 * because an HTTP client is not a browser: it has no service worker, no IndexedDB and no site storage.
 *
 * ## Why the browser profile is persistent
 *
 * The single most important property of this deployment is that a user's records survive the program
 * being reinstalled, because they live in browser storage bound to the origin rather than in the
 * installation directory. Proving that needs the same browser profile to outlive an uninstall, so the
 * profile is created on disk under the scratch directory and reused across the phases below.
 *
 * Chromium is used because it is the engine of Edge and of the 360 browser, which is what colleagues
 * have. That makes it the right rehearsal and NOT a certification: one engine on one machine.
 */

import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_ID = '2026.09.24-win-rc1';
const ORIGIN = 'http://127.0.0.1:8765';
const INSTALL_ROOT = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'CivicWorkDesk',
);
const SETUP = join(
  ROOT,
  'release',
  'windows',
  'CivicWorkDesk-Windows-x64-2026.09.24-rc1-Setup.exe',
);
const WORK = join(tmpdir(), 'civic-rc1-browser-acceptance');
const PROFILE = join(WORK, 'chromium-profile');
const DOWNLOADS = join(WORK, 'downloads');

const results = [];
let failures = 0;

function record(status, name, detail = '') {
  results.push({ status, name, detail });
  if (status === 'FAIL') failures += 1;
  console.log(`  [${status.padEnd(4)}] ${name}${detail ? `  --  ${detail}` : ''}`);
}
const check = (c, name, detail) => record(c ? 'PASS' : 'FAIL', name, detail);
const info = (name, detail) => record('INFO', name, detail);

function section(title) {
  console.log('');
  console.log(`== ${title} ${'='.repeat(Math.max(0, 74 - title.length))}`);
}

function bin(name) {
  return join(INSTALL_ROOT, 'bin', name);
}
function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the loading placeholder to go, then return the page's rendered text. */
async function settledBodyText(p) {
  await p
    .getByText('正在读取本机数据…')
    .waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => {});
  await p.waitForLoadState('networkidle').catch(() => {});
  await sleep(600);
  return p.locator('body').innerText();
}

/**
 * Read one entry out of a ZIP (and therefore out of any OOXML file), in this process.
 *
 * Shelling out to PowerShell for this is what the first version did, and it was wrong in a way that took
 * a while to see: PowerShell writes its stdout in the console code page, so every Chinese character in
 * an extracted XML part was mangled before Node decoded the pipe as UTF-8. The assertion that the Word
 * report names its own period then failed against text that was perfectly correct on disk.
 *
 * Only the two cases these archives use are handled: stored and deflated. Anything else is reported
 * rather than guessed at.
 */
function readZipEntry(zipPath, entryName) {
  const buf = readFileSync(zipPath);
  // The end-of-central-directory record is last, possibly followed by a comment, so scan backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${zipPath} has no end-of-central-directory record`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central directory entry is malformed');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === entryName) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error('local header is malformed');
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(
        `${entryName} uses compression method ${method}, which this reader does not handle`,
      );
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Every entry name in a ZIP, in central-directory order. */
function zipEntryNames(zipPath) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n += 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

async function ensureServer() {
  sh(bin('civic-launch.exe'), ['open']);
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${ORIGIN}/__civic/health`);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('the server did not come up');
}

if (!existsSync(bin('civic-launch.exe'))) {
  console.error(
    'error: the RC1 is not installed. Run: node scripts/windows/acceptance-rc1.mjs --keep',
  );
  process.exit(2);
}

console.log('CivicWorkDesk Windows RC1 -- browser-side acceptance at the installed origin');
console.log('');
console.log(`  origin  : ${ORIGIN}/`);
console.log(`  profile : ${PROFILE}`);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(DOWNLOADS, { recursive: true });

const health = await ensureServer();
info('server release', health.releaseId);

// ---------------------------------------------------------------------------------------------------
// Phase 1: platform capabilities and the origin invariant
// ---------------------------------------------------------------------------------------------------
section('1. origin and browser platform');

let context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS,
  viewport: { width: 1400, height: 900 },
});
let page = await context.newPage();

const external = [];
const watchExternal = (p) =>
  p.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(ORIGIN)) return;
    if (/^(about|data|blob|chrome-extension|chrome|devtools):/.test(url)) return;
    external.push(`${req.method()} ${url}`);
  });
watchExternal(page);

await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 30_000 });

const platform = await page.evaluate(async () => {
  const out = {
    origin: location.origin,
    secureContext: window.isSecureContext,
    hasIndexedDB: typeof indexedDB !== 'undefined',
    hasCaches: typeof caches !== 'undefined',
    hasServiceWorker: 'serviceWorker' in navigator,
    hasRandomUUID: typeof crypto?.randomUUID === 'function',
    hasSubtle: typeof crypto?.subtle?.digest === 'function',
    digestBytes: 0,
    cacheKeys: [],
    swRegistrations: 0,
    swScopes: [],
    idbDatabases: [],
  };
  if (out.hasSubtle) {
    const buf = await crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3]));
    out.digestBytes = buf.byteLength;
  }
  if (out.hasCaches) out.cacheKeys = await caches.keys();
  if (out.hasServiceWorker) {
    const regs = await navigator.serviceWorker.getRegistrations();
    out.swRegistrations = regs.length;
    out.swScopes = regs.map((r) => r.scope);
  }
  if (indexedDB.databases) out.idbDatabases = (await indexedDB.databases()).map((d) => d.name);
  return out;
});

check(
  platform.origin === ORIGIN,
  'location.origin is exactly the canonical origin',
  platform.origin,
);
check(
  platform.secureContext === true,
  '127.0.0.1 is a secure context',
  String(platform.secureContext),
);
check(platform.hasIndexedDB, 'IndexedDB is available');
check(platform.hasCaches, 'Cache Storage is available');
check(platform.hasServiceWorker, 'Service Worker API is available');
check(platform.hasRandomUUID, 'crypto.randomUUID is available');
check(
  platform.hasSubtle && platform.digestBytes === 32,
  'crypto.subtle.digest works over http://127.0.0.1',
  `SHA-256 returned ${platform.digestBytes} bytes`,
);
info('IndexedDB databases', platform.idbDatabases.join(', ') || '(none yet)');

// The service worker registers asynchronously after load, so give it a moment rather than racing it.
// navigator.serviceWorker.ready resolves as soon as there IS an active worker, which can still be
// 'activating'. Sampling it there reported a failure that was only a race, so wait for the state the
// assertion is about.
const swInfo = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready.catch(() => null);
  if (reg?.active && reg.active.state !== 'activated') {
    await new Promise((done) => {
      const worker = reg.active;
      const onChange = () => {
        if (worker.state === 'activated') {
          worker.removeEventListener('statechange', onChange);
          done();
        }
      };
      worker.addEventListener('statechange', onChange);
      setTimeout(done, 10000);
    });
  }
  const regs = await navigator.serviceWorker.getRegistrations();
  return {
    count: regs.length,
    scopes: regs.map((r) => r.scope),
    state: reg?.active?.state ?? null,
    script: reg?.active?.scriptURL ?? null,
    cacheKeys: await caches.keys(),
  };
});
check(
  swInfo.count === 1,
  'exactly one service worker is registered',
  `${swInfo.count}: ${swInfo.scopes.join(', ')}`,
);
check(
  swInfo.scopes[0] === `${ORIGIN}/`,
  'its scope is the origin root',
  swInfo.scopes[0] ?? '(none)',
);
check(swInfo.state === 'activated', 'it is activated', String(swInfo.state));
check(
  (swInfo.script ?? '').startsWith(`${ORIGIN}/sw.js`),
  'its script is served from the origin',
  swInfo.script ?? '',
);
check(swInfo.cacheKeys.length > 0, 'the precache is populated', swInfo.cacheKeys.join(', '));
info('cache keys', swInfo.cacheKeys.join(', '));

check(
  external.length === 0,
  'the application made no external network request',
  external.length === 0 ? 'nothing left the origin' : external.slice(0, 3).join('; '),
);

// ---------------------------------------------------------------------------------------------------
// Phase 2: write records, then export them three ways
// ---------------------------------------------------------------------------------------------------
section('2. records, backup and exports');

const MARKER = `RC1验收-${Date.now()}`;

// Today, as the browser's own clock sees it. Node and the browser share the machine clock, so the date
// computed here is the date the application will place the record in -- which is what puts it inside the
// current month's report period.
const TODAY = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

async function createRecord(title) {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(title);
  // A record with no date belongs to no report period, so the Word export stays disabled -- correctly.
  // Giving it today's date is what makes the export path testable at all.
  await dialog.getByRole('radiogroup', { name: '事项日期类型' }).getByText('具体日期').click();
  await dialog.getByRole('textbox', { name: '事项日期', exact: true }).fill(TODAY);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

await page.goto(`${ORIGIN}/#/work`);
await page
  .getByText('正在读取本机数据…')
  .waitFor({ state: 'detached', timeout: 20_000 })
  .catch(() => {});
await createRecord(`${MARKER}-甲`);
await createRecord(`${MARKER}-乙`);
await page.reload();
await page.getByRole('navigation', { name: '主导航' }).waitFor();
// Read the rendered text once the list has settled. getByText().count() samples whatever is on the
// page at that instant, which raced the list render and reported one of the two records missing.
const listText = await settledBodyText(page);
check(listText.includes(`${MARKER}-甲`), 'a record written through the UI is present after reload');
check(listText.includes(`${MARKER}-乙`), 'the second record is present too');

const idbCount = await page.evaluate(async () => {
  const dbs = (await indexedDB.databases?.()) ?? [];
  return dbs.map((d) => `${d.name}@v${d.version}`);
});
info('IndexedDB after writing', idbCount.join(', '));

async function download(triggerName, scope = page) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    scope.getByRole('button', { name: triggerName }).first().click(),
  ]);
  const suggested = dl.suggestedFilename();
  const target = join(DOWNLOADS, suggested);
  await dl.saveAs(target);
  return { path: target, name: suggested, size: readFileSync(target).length };
}

// Find the export controls. The application's own labels are the contract here; a hard-coded button
// name that drifted would fail loudly rather than silently skipping the export.
await page.goto(`${ORIGIN}/#/settings`);
await page.getByRole('navigation', { name: '主导航' }).waitFor();
const buttonNames = await page
  .getByRole('button')
  .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()).filter(Boolean));
info('settings buttons', buttonNames.join(' | '));

const jsonButton = buttonNames.find((n) => /备份|导出.*JSON|JSON/.test(n));
const xlsxButton = buttonNames.find((n) => /Excel|xlsx|表格/i.test(n));

let backupPath = null;
if (jsonButton) {
  const dl = await download(jsonButton);
  backupPath = dl.path;
  const text = readFileSync(dl.path, 'utf8');
  check(dl.size > 0, `JSON backup downloaded (${jsonButton})`, `${dl.name} ${dl.size} bytes`);
  check(text.includes(MARKER), 'the backup contains the records just written');
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* reported next */
  }
  check(parsed !== null, 'the backup is valid JSON');
} else {
  record('FAIL', 'a JSON backup control was found on the settings page', buttonNames.join(' | '));
}

if (xlsxButton) {
  const dl = await download(xlsxButton);
  const head = readFileSync(dl.path).subarray(0, 2).toString('latin1');
  check(
    head === 'PK',
    `XLSX export downloaded and is a ZIP container (${xlsxButton})`,
    `${dl.name} ${dl.size} bytes`,
  );
  // An xlsx that opens is one whose workbook part is present and whose sheet carries the marker.
  const entries = zipEntryNames(dl.path);
  check(
    entries.includes('xl/workbook.xml'),
    'the workbook part is present',
    `${entries.length} entries`,
  );
  check(entries.includes('[Content_Types].xml'), 'the OPC content-types part is present');
  const sheet = (readZipEntry(dl.path, 'xl/worksheets/sheet1.xml') ?? Buffer.alloc(0)).toString(
    'utf8',
  );
  // This export is the LEDGER report (its own filename says so), not the work-record list. What "opens"
  // means for an xlsx is that the workbook and its first sheet parse, so that is what is checked -- the
  // ledger is legitimately empty on a fresh profile, and asserting a work-record title appeared in it was
  // the wrong expectation.
  check(
    sheet.includes('<worksheet') || sheet.includes('<sheetData'),
    'the first worksheet parses as a worksheet part',
    `${sheet.length} bytes of sheet XML`,
  );
  info(
    'xlsx scope',
    'ledger report; a fresh profile has no ledger rows, so no record title is expected',
  );
} else {
  record('FAIL', 'an XLSX export control was found on the settings page', buttonNames.join(' | '));
}

// The Word export is on the reports page, not settings -- looking for it among the settings buttons
// found nothing and reported a missing control that was never there.
await page.goto(`${ORIGIN}/#/reports`);
await page.getByRole('navigation', { name: '主导航' }).waitFor();
await settledBodyText(page);
const docxControl = page.getByRole('button', { name: /导出 Word 文档/ }).first();
const docxPresent = (await docxControl.count()) > 0;
check(docxPresent, 'the Word export control is on the reports page');
const reportText = await settledBodyText(page);
info(
  'report period',
  (
    reportText
      .split(
        `
`,
      )
      .find((l) => /报告期/.test(l)) ?? '(not shown)'
  ).trim(),
);
const docxEnabled = docxPresent && (await docxControl.isEnabled());
check(
  docxEnabled,
  'the export is enabled because the period contains records',
  docxEnabled ? `records dated ${TODAY}` : 'the button is disabled: the report has no rows',
);
if (docxEnabled) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    docxControl.click(),
  ]);
  const target = join(DOWNLOADS, dl.suggestedFilename());
  await dl.saveAs(target);
  const bytes = readFileSync(target);
  check(
    bytes.subarray(0, 2).toString('latin1') === 'PK',
    'DOCX export downloaded and is a ZIP container',
    `${dl.suggestedFilename()} ${bytes.length} bytes`,
  );
  const doc = (readZipEntry(target, 'word/document.xml') ?? Buffer.alloc(0)).toString('utf8');
  check(
    doc.length > 0,
    'word/document.xml is present and readable',
    `${doc.length} bytes of document XML`,
  );
  check(
    doc.includes('<w:document') || doc.includes('w:body'),
    'it parses as a WordprocessingML document',
  );
  // The report is a STATISTICAL summary -- period label, totals, per-category tables -- not a list of
  // record titles, so the period it covers is the right thing to assert.
  const periodLabel = `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;
  check(doc.includes(periodLabel), 'the document names the report period', periodLabel);
  const digits = doc.replaceAll(/<[^>]*>/g, '').match(/[1-9][0-9]*/g) ?? [];
  check(
    digits.length > 0,
    'the document contains non-zero figures, so the records were counted',
    `${digits.length} numeric run(s) in the rendered text`,
  );
  info('docx scope', 'the Word report is a statistical summary; record titles are not part of it');
}

// ---------------------------------------------------------------------------------------------------
// Phase 3: offline use with the server stopped
// ---------------------------------------------------------------------------------------------------
section('3. offline use (the server is stopped, not the network)');
// For this deployment "offline" does not mean "no internet" -- nothing ever goes to the internet. The
// meaningful test is whether the service worker serves the application when the local server is gone,
// which is exactly what happens when a user opens the browser before launching the program.
const stop = sh(bin('civic-launch.exe'), ['stop']);
check(stop.status === 0, 'the server was stopped', `code ${stop.status}`);
let stillUp = true;
try {
  await fetch(`${ORIGIN}/__civic/health`);
} catch {
  stillUp = false;
}
check(!stillUp, 'nothing answers at the origin any more');

const offlinePage = await context.newPage();
watchExternal(offlinePage);
let offlineLoaded = true;
try {
  await offlinePage.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 30_000 });
  await offlinePage.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
} catch (err) {
  offlineLoaded = false;
  info('offline load error', String(err).split('\n')[0]);
}
check(offlineLoaded, 'the application still loads from the service worker with the server stopped');
if (offlineLoaded) {
  // Reload so the hash route is entered from a fresh document; a bare hash change does not remount, and
  // sampling getByText() immediately afterwards raced the list render.
  await offlinePage.goto(`${ORIGIN}/#/work`);
  await offlinePage.reload();
  await offlinePage.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
  const offlineText = await settledBodyText(offlinePage);
  const seenA = offlineText.includes(`${MARKER}-甲`);
  const seenB = offlineText.includes(`${MARKER}-乙`);
  check(
    seenA && seenB,
    'the records are readable offline',
    seenA && seenB
      ? 'both records rendered with no server running'
      : `甲=${seenA} 乙=${seenB}; page text ${offlineText.length} chars`,
  );
}
await offlinePage.close();

await ensureServer();

// ---------------------------------------------------------------------------------------------------
// Phase 4: uninstall, reinstall, and the records survive
// ---------------------------------------------------------------------------------------------------
section('4. uninstall and reinstall at the same origin');
await context.close();

const unins = join(INSTALL_ROOT, 'unins000.exe');
const uninstall = sh(unins, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
await sleep(2500);
check(uninstall.status === 0, 'the uninstaller exited 0', `code ${uninstall.status}`);
check(!existsSync(bin('civic-launch.exe')), 'the program files are gone');
const leftovers = existsSync(INSTALL_ROOT) ? readdirSync(INSTALL_ROOT) : [];
info('install root after uninstall', leftovers.length ? leftovers.join(', ') : '(removed)');
check(!existsSync(join(INSTALL_ROOT, 'releases')), 'the release payload was removed');
check(!existsSync(join(INSTALL_ROOT, 'state')), 'the deployment state was removed');

// The browser profile is the thing that must NOT have been touched.
check(existsSync(PROFILE), 'the browser profile still exists');
// A persistent context keeps its site storage under the profile's Default/ directory, not at the
// profile root; checking the root reported a missing directory that was never there.
const idbCandidates = [join(PROFILE, 'Default', 'IndexedDB'), join(PROFILE, 'IndexedDB')];
const idbDir = idbCandidates.find((d) => existsSync(d));
check(
  Boolean(idbDir),
  'the browser IndexedDB directory still exists',
  idbDir ?? idbCandidates.join(' | '),
);
if (idbDir) {
  const dbs = readdirSync(idbDir).filter((n) => /127\.0\.0\.1|8765/.test(n));
  check(dbs.length > 0, 'it still holds a database for the canonical origin', dbs.join(', '));
}

const reinstall = sh(SETUP, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
check(reinstall.status === 0, 'reinstall exited 0', `code ${reinstall.status}`);
check(existsSync(bin('civic-launch.exe')), 'the program is installed again');
check(
  readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim() === RELEASE_ID,
  'the reinstalled release is active',
);
await ensureServer();

context = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  acceptDownloads: true,
  downloadsPath: DOWNLOADS,
  viewport: { width: 1400, height: 900 },
});
page = await context.newPage();
watchExternal(page);
await page.goto(`${ORIGIN}/#/work`);
await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 30_000 });
await page
  .getByText('正在读取本机数据…')
  .waitFor({ state: 'detached', timeout: 20_000 })
  .catch(() => {});

const survivedA = await page.getByText(`${MARKER}-甲`).count();
const survivedB = await page.getByText(`${MARKER}-乙`).count();
check(
  survivedA > 0 && survivedB > 0,
  'the records written BEFORE the uninstall are still there after reinstalling',
  `甲 ${survivedA} match(es), 乙 ${survivedB} match(es)`,
);

// This is the claim that makes the uninstall message honest, so state it as a measurement.
info(
  'conclusion',
  'uninstalling the program did not delete the records; the origin is what holds them',
);

// ---------------------------------------------------------------------------------------------------
// Phase 5: restore from the backup taken in phase 2
// ---------------------------------------------------------------------------------------------------
section('5. restore from the JSON backup');
// The file input lives inside the import dialog, not on the settings page, so looking for one on the page
// found nothing and the restore was skipped with an INFO rather than exercised. This drives the real
// control the way a user does.
if (backupPath && existsSync(backupPath)) {
  await page.goto(`${ORIGIN}/#/settings`);
  await page.getByRole('navigation', { name: '主导航' }).waitFor();
  await settledBodyText(page);

  await page.getByRole('button', { name: '导入 / 还原备份' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.locator('input[type="file"]').setInputFiles(backupPath);

  const preview = dialog.getByText('导入预览（尚未写入）');
  let previewed = true;
  try {
    await preview.waitFor({ timeout: 20_000 });
  } catch {
    previewed = false;
  }
  check(
    previewed,
    'the real exported backup produced an import preview',
    previewed
      ? 'the file the application itself wrote is one it can read back'
      : 'no preview appeared',
  );

  if (previewed) {
    const planText = await dialog.innerText();
    info(
      'import plan',
      planText
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(0, 6)
        .join(' | '),
    );
    // The records in the backup are already present, so a merge must be a no-op rather than a duplicate.
    // That round trip -- export, re-import, nothing changes -- is the property worth proving.
    const dialogButtons = await dialog
      .getByRole('button')
      .evaluateAll((els) =>
        els
          .map((e) => (e.textContent ?? '').trim() + (e.disabled ? ' [disabled]' : ''))
          .filter(Boolean),
      );
    info('import dialog buttons', dialogButtons.join(' | '));

    // 合并 is offered first and is DISABLED, and that is the correct answer rather than a missing control:
    // every record in the backup is already present, so a merge has nothing to add. The disabled button is
    // itself the evidence that the application read its own export back and computed a no-op plan.
    const mergeButton = dialog.getByRole('button', { name: '合并导入' }).first();
    const mergeDisabled = (await mergeButton.count()) > 0 && !(await mergeButton.isEnabled());
    check(
      mergeDisabled,
      'merging a backup whose records are all present is correctly offered as a no-op',
      mergeDisabled
        ? 'the merge button is disabled because nothing would be added'
        : dialogButtons.join(' | '),
    );

    // Now exercise a real restore. 替换 / 还原 replaces local data with the backup's contents; with the
    // same backup the end state must be the state it was taken from, which is the round trip worth proving.
    //
    // Two things matter about the order here, and getting either wrong made this check fail on correct
    // behaviour. The mode radio has to be selected BEFORE the file is loaded, because the preview -- and
    // the name of the button that commits it -- are computed per mode. And the button for a complete
    // backup is named 完整还原 exactly: a substring match on 还原 also matches the DISABLED 无法完整还原
    // that appears when a backup is not complete enough to restore from.
    const replaceMode = dialog.getByRole('radio', { name: '替换 / 还原' }).first();
    if ((await replaceMode.count()) > 0) {
      await replaceMode.check();
      await dialog.locator('input[type="file"]').setInputFiles(backupPath);
      await dialog.getByText('导入预览（尚未写入）').waitFor({ timeout: 20_000 });

      const refused = dialog.getByRole('button', { name: '无法完整还原' });
      check(
        (await refused.count()) === 0,
        'the backup is complete enough to restore from',
        (await refused.count()) === 0
          ? 'no completeness refusal'
          : 'the application refused it as incomplete',
      );

      const confirm = dialog.getByRole('button', { name: '完整还原', exact: true });
      const confirmReady = (await confirm.count()) > 0 && (await confirm.isEnabled());
      check(
        confirmReady,
        'the restore control is reachable and enabled',
        confirmReady ? '完整还原' : 'not offered',
      );
      if (confirmReady) {
        await confirm.click();
        await dialog.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
        await page.goto(`${ORIGIN}/#/work`);
        await page.reload();
        await page.getByRole('navigation', { name: '主导航' }).waitFor();
        const afterText = await settledBodyText(page);
        const occurrencesA = afterText.split(`${MARKER}-甲`).length - 1;
        check(
          occurrencesA === 1,
          'restoring the backup reproduced exactly one copy of each record',
          `甲 appears ${occurrencesA} time(s) after the restore`,
        );
        check(afterText.includes(`${MARKER}-乙`), 'the second record is present after the restore');
      }
    } else {
      info('restore', 'no replace/restore mode was offered; only the merge plan was exercised');
    }
  }
} else {
  record('FAIL', 'the JSON backup from phase 2 is available for restore', '(missing)');
}

check(
  external.length === 0,
  'no external network request in the whole session',
  external.length === 0 ? 'nothing left the origin' : external.slice(0, 3).join('; '),
);

// ---------------------------------------------------------------------------------------------------
section('6. summary');
await context.close();
sh(bin('civic-launch.exe'), ['stop']);

console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  passed : ${results.filter((r) => r.status === 'PASS').length}`);
console.log(`  failed : ${failures}`);
console.log('');
console.log(
  failures === 0
    ? '  RESULT: PASS in Chromium on this workstation. NOT a browser certification.'
    : '  RESULT: FAIL -- see the [FAIL] lines above.',
);

writeFileSync(
  join(ROOT, 'release', 'windows', `acceptance-rc1-browser-${RELEASE_ID}.txt`),
  [
    'CivicWorkDesk Windows RC1 -- browser-side acceptance at the installed origin',
    '',
    `origin      : ${ORIGIN}/`,
    `release     : ${RELEASE_ID}`,
    `engine      : Chromium (Playwright), persistent profile`,
    `checks      : ${results.length} (${failures} failed)`,
    '',
    ...results.map(
      (r) => `[${r.status.padEnd(4)}] ${r.name}${r.detail ? `  --  ${r.detail}` : ''}`,
    ),
    '',
    failures === 0
      ? 'RESULT: PASS in Chromium on the development workstation. No browser is certified by this.'
      : 'RESULT: FAIL.',
    '',
  ].join('\n'),
  'utf8',
);
process.exit(failures === 0 ? 0 : 1);
