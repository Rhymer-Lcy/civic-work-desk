#!/usr/bin/env node
/**
 * The upgrade a colleague will actually perform: Windows RC3, as published, to this release -- with
 * records in the browser, in the same browser and the same profile.
 *
 *   node scripts/windows/acceptance-upgrade.mjs --release-id <id> [--channel msedge|chromium]
 *
 * 1. Install RC3 from the installer on its GitHub Release (digest checked against the one recorded at
 *    publication), and give it records through its own interface: restore an RC3-era archive that holds
 *    every kind of relation (a work record, its progress entry, an honour linked to it, categories,
 *    groups), then add two more work records by hand. Take RC3's own JSON backup.
 * 2. Install this release over RC3 -- while RC3's local service is still running.
 * 3. Open the SAME browser profile. RC3's service worker still serves RC3's shell; the update arrives as
 *    RC3's own 有新版本可用 prompt, and 应用更新 loads this release, which migrates the database from
 *    schema 1 to schema 2.
 * 4. Prove the migration: every row RC3 wrote is still there, unchanged, and every work record gained
 *    exactly `parentWorkId: null`; the relations still resolve; nothing is reported invalid.
 * 5. Build a 2级 and a 3级 sub-task under a record RC3 created, take a format-3 backup, and restore it into
 *    a fresh profile: the restored rows must equal the source rows exactly.
 * 6. RC3's own backup still imports into this release.
 * 7. civic-admin refuses to roll back to RC3, and says why.
 *
 * The local server is started directly (civic-server.exe) rather than through the launcher, so the
 * operator's real default browser is never opened onto the origin; the launcher itself is exercised by
 * acceptance-deploy.mjs.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { obtainPublishedInstaller } from './published-installer.mjs';
import { businessDateUtc8, loadReleaseIdentity } from './release-identity.mjs';

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
const RC3_ID = '2026.09.24-win-rc3';
const CHANNEL = argValue('--channel', 'msedge');
const SETUP = join(ROOT, 'release', 'windows', IDENTITY.installerName);
const ORIGIN = 'http://127.0.0.1:8765';
const INSTALL_ROOT = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'CivicWorkDesk',
);
const WORK = join(tmpdir(), 'civic-upgrade-acceptance');
const PROFILE = join(WORK, 'profile-colleague');
const PROFILE_RESTORE = join(WORK, 'profile-restore');
const PROFILE_RC3_BACKUP = join(WORK, 'profile-rc3-backup');
const DOWNLOADS = join(WORK, 'downloads');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'phase-1-2-canonical-v3.json');
const APP_ID_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}_is1';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...options });
const bin = (name) => join(INSTALL_ROOT, 'bin', name);
const current = () =>
  existsSync(join(INSTALL_ROOT, 'current.txt'))
    ? readFileSync(join(INSTALL_ROOT, 'current.txt'), 'utf8').trim()
    : '';

async function health() {
  try {
    const r = await fetch(`${ORIGIN}/__civic/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Start the installed server the way the launcher does, without opening any browser. */
async function startServer(releaseId) {
  const child = spawn(bin('civic-server.exe'), ['--root', INSTALL_ROOT, '--release', releaseId], {
    cwd: INSTALL_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 60; i += 1) {
    const h = await health();
    if (h?.releaseId === releaseId) return h;
    await sleep(300);
  }
  return null;
}

function cleanSlate() {
  if (existsSync(bin('civic-launch.exe'))) sh(bin('civic-launch.exe'), ['stop']);
  if (existsSync(join(INSTALL_ROOT, 'unins000.exe'))) {
    sh(join(INSTALL_ROOT, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
  }
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
  sh('reg', ['delete', APP_ID_KEY, '/f']);
}

const external = [];
function watchExternal(p) {
  p.on('request', (req) => {
    const url = req.url();
    if (url.startsWith(ORIGIN)) return;
    if (/^(about|data|blob|chrome-extension|chrome|edge|devtools):/.test(url)) return;
    external.push(`${req.method()} ${url}`);
  });
}

const EDGE = join(
  process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
  'Microsoft',
  'Edge',
  'Application',
  'msedge.exe',
);
let debugPort = 9340;

/**
 * Open a browser on a persistent profile.
 *
 * ## Edge is started the ordinary way, not by Playwright
 *
 * Playwright's own Edge launch (`launchPersistentContext` with `channel: 'msedge'`) crashes the browser
 * with an access violation (exit 0xC0000005) when a page downloads a file in a profile that has been
 * opened before -- the first launch of a profile downloads fine, every later launch dies. Measured with
 * headless and headed Edge alike; Playwright's bundled Chromium does not do it, and neither does Edge
 * started with its ordinary command line and attached over CDP, which downloaded on three consecutive
 * launches of one profile. This harness reopens the SAME profile after the upgrade and then downloads,
 * so it starts Edge the way a person's shortcut does and attaches to it -- which is also the closer
 * rehearsal of a colleague's browser.
 */
async function openProfile(dir) {
  mkdirSync(dir, { recursive: true });
  if (CHANNEL !== 'msedge') {
    const context = await chromium.launchPersistentContext(dir, {
      headless: true,
      acceptDownloads: true,
      downloadsPath: DOWNLOADS,
      viewport: { width: 1400, height: 900 },
    });
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(30_000);
    watchExternal(page);
    return {
      page,
      async download(click) {
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          click(),
        ]);
        const target = join(DOWNLOADS, dl.suggestedFilename());
        await dl.saveAs(target);
        return target;
      },
      close: () => context.close(),
    };
  }

  debugPort += 1;
  const port = debugPort;
  const edge = spawn(
    EDGE,
    [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1400,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let exited = false;
  edge.on('exit', () => {
    exited = true;
  });
  let browser = null;
  for (let i = 0; i < 60 && !browser; i += 1) {
    await sleep(250);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
  }
  if (!browser) throw new Error(`Edge did not open a debugging port on ${port}`);
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);
  watchExternal(page);
  return {
    page,
    async download(click) {
      const begun = new Promise((ok) => cdp.once('Browser.downloadWillBegin', ok));
      const finished = new Promise((ok) => {
        const onProgress = (e) => {
          if (e.state === 'completed' || e.state === 'canceled') {
            cdp.off('Browser.downloadProgress', onProgress);
            ok(e);
          }
        };
        cdp.on('Browser.downloadProgress', onProgress);
      });
      await click();
      const start = await begun;
      const end = await finished;
      if (end.state !== 'completed') throw new Error(`the download was ${end.state}`);
      return join(DOWNLOADS, start.guid);
    },
    async close() {
      // Browser.close ends Edge the way closing its window does, so site storage is flushed to disk.
      await cdp.send('Browser.close').catch(() => {});
      for (let i = 0; i < 40 && !exited; i += 1) await sleep(250);
      if (!exited) edge.kill();
    },
  };
}

async function ready(page) {
  await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 30_000 });
  await page
    .getByText('正在读取本机数据…')
    .waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => {});
}

/** Every row of every store, read with the raw IndexedDB API so no application code is involved. */
function dumpDatabase(page) {
  return page.evaluate(
    () =>
      new Promise((done, fail) => {
        const open = indexedDB.open('civic-work-desk');
        open.onerror = () => fail(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names);
          const out = { version: db.version, stores: {} };
          let pending = names.length;
          for (const name of names) {
            const req = tx.objectStore(name).getAll();
            req.onsuccess = () => {
              out.stores[name] = req.result;
              pending -= 1;
              if (pending === 0) {
                db.close();
                done(out);
              }
            };
          }
        };
      }),
  );
}

const byId = (rows) => new Map(rows.map((r) => [r.id ?? r.key, r]));
/* A canonical form with keys sorted at every depth. JSON.stringify with a key-array replacer would not
 * do: that array filters keys at EVERY level, so nested fields absent from the top level would be
 * silently dropped from the comparison. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function exportBackup(session) {
  const { page } = session;
  await page.goto(`${ORIGIN}/#/settings`);
  await ready(page);
  return session.download(() =>
    page.getByRole('button', { name: '导出 JSON 备份' }).first().click(),
  );
}

async function restoreReplacing(page, file) {
  await page.goto(`${ORIGIN}/#/settings`);
  await ready(page);
  await page.getByRole('button', { name: '导入 / 还原备份' }).click();
  const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
  await dialog.waitFor();
  await dialog.getByRole('radio', { name: '替换 / 还原' }).check();
  await dialog.locator('input[type="file"]').setInputFiles(file);
  await dialog.getByText('导入预览（尚未写入）').waitFor({ timeout: 20_000 });
  await dialog.getByRole('button', { name: '完整还原', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '替换全部数据？' });
  const input = confirm.getByRole('textbox');
  await input.click();
  await input.pressSequentially('替换');
  await confirm.getByRole('button', { name: '确认替换' }).click();
  await confirm.waitFor({ state: 'hidden', timeout: 30_000 });
  await sleep(1500);
}

async function createWork(page, title) {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: /事项/ }).first().fill(title);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

// ===================================================================================================
console.log(`CivicWorkDesk Windows -- RC3 to ${IDENTITY.displayVersion} upgrade acceptance`);
console.log('');
console.log(`  release under test : ${RELEASE_ID}`);
console.log(`  browser            : ${CHANNEL}`);
if (!existsSync(SETUP)) {
  console.error(`error: ${SETUP} is not built`);
  process.exit(2);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });

// ---------------------------------------------------------------------------------------------------
section('1. RC3 as published, with records');
let rc3;
try {
  rc3 = obtainPublishedInstaller(ROOT, RC3_ID);
  check(true, 'the RC3 installer is the published one', `${rc3.sha256} (${rc3.source})`);
} catch (err) {
  check(false, 'the RC3 installer is the published one', String(err));
  process.exit(1);
}
cleanSlate();
const rc3Install = sh(rc3.path, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
check(
  rc3Install.status === 0 && current() === RC3_ID,
  'RC3 installed from its published bytes',
  `code ${rc3Install.status}`,
);
const rc3Health = await startServer(RC3_ID);
check(rc3Health !== null, 'RC3 serves the origin', rc3Health?.serverVersion ?? '(no answer)');

let session = await openProfile(PROFILE);
let { page } = session;
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
await restoreReplacing(page, FIXTURE);
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
await createWork(page, 'RC3 时期的上级事项');
await createWork(page, 'RC3 时期的另一事项');
await page.reload();
await ready(page);
// Wait for RC3's service worker to control the page, as it does for a colleague who has used RC3.
await page.evaluate(() => navigator.serviceWorker.ready);
await page.reload();
await ready(page);
const rc3Controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
check(rc3Controlled, "RC3's service worker controls the page");
const beforeUpgrade = await dumpDatabase(page);
check(
  beforeUpgrade.version === 10,
  'RC3 holds the database at schema 1 (IndexedDB version 10)',
  `version ${beforeUpgrade.version}`,
);
const rc3Records = beforeUpgrade.stores.records ?? [];
info(
  'RC3 rows',
  Object.entries(beforeUpgrade.stores)
    .map(([k, v]) => `${k} ${v.length}`)
    .join(', '),
);
check(
  rc3Records.length === 4 && rc3Records.filter((r) => r.kind === 'work').length === 3,
  'RC3 holds the restored work record and honour plus the two it created',
  `${rc3Records.length} record(s)`,
);
const honour = rc3Records.find((r) => r.kind === 'honor');
check(
  Boolean(honour?.relatedWorkId),
  'the honour is linked to a work record',
  honour?.relatedWorkId ?? '(none)',
);
const rc3Backup = await exportBackup(session);
const rc3BackupDoc = JSON.parse(readFileSync(rc3Backup, 'utf8'));
check(
  rc3BackupDoc.schemaVersion === 1 && rc3BackupDoc.payload?.records?.length === 4,
  "RC3's own JSON backup was taken",
  `format ${rc3BackupDoc.backupFormatVersion}, schema ${rc3BackupDoc.schemaVersion}, ${rc3BackupDoc.payload?.records?.length} records`,
);
await session.close();

// ---------------------------------------------------------------------------------------------------
section('2. this release installed over RC3, while RC3 is running');
check((await health())?.releaseId === RC3_ID, 'RC3 is still serving when the upgrade starts');
const upgrade = sh(SETUP, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
check(upgrade.status === 0, 'the upgrade exited 0', `code ${upgrade.status}`);
check(current() === RELEASE_ID, 'this release is active', current());
check(
  readFileSync(join(INSTALL_ROOT, 'previous.txt'), 'utf8').trim() === RC3_ID,
  'previous.txt names RC3',
);
check(
  existsSync(join(INSTALL_ROOT, 'releases', RC3_ID)),
  'the RC3 release directory is retained, for the record',
);
check((await health()) === null, 'no server is left running by the upgrade');
const newHealth = await startServer(RELEASE_ID);
check(
  newHealth?.releaseId === RELEASE_ID,
  'this release serves the origin',
  newHealth?.serverVersion ?? '(no answer)',
);

// ---------------------------------------------------------------------------------------------------
section('3. the same profile picks up the update');
session = await openProfile(PROFILE);
({ page } = session);
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
const firstShell = await page.getByRole('group', { name: '工作视图' }).count();
info(
  'first load after the upgrade',
  firstShell > 0 ? 'already this release' : "RC3's cached shell (expected)",
);
let bannerAfter = null;
const started = Date.now();
if (firstShell === 0) {
  for (let second = 0; second < 300; second += 1) {
    if (second > 0 && second % 60 === 0) {
      await page.goto(`${ORIGIN}/#/work`);
      await ready(page);
    }
    if ((await page.getByText('有新版本可用').count()) > 0) {
      bannerAfter = Math.round((Date.now() - started) / 1000);
      break;
    }
    await sleep(1000);
  }
  check(
    bannerAfter !== null,
    "RC3's 有新版本可用 prompt appeared",
    bannerAfter === null ? 'not within 300 s' : `after ${bannerAfter} s`,
  );
  if (bannerAfter !== null) {
    await page.getByRole('button', { name: '应用更新' }).first().click();
    await sleep(6000);
    await ready(page);
  }
}
const upgradedShell = await page.getByRole('group', { name: '工作视图' }).count();
check(upgradedShell > 0, 'the page now runs this release (the 工作视图 switch exists)');

// ---------------------------------------------------------------------------------------------------
section('4. schema 1 to schema 2: nothing lost, one field added');
const afterUpgrade = await dumpDatabase(page);
check(
  afterUpgrade.version === 20,
  'the database is at schema 2 (IndexedDB version 20)',
  `version ${afterUpgrade.version}`,
);
const after = byId(afterUpgrade.stores.records ?? []);
let unchanged = 0;
let nullParents = 0;
for (const row of rc3Records) {
  const now = after.get(row.id);
  if (!now) continue;
  const { parentWorkId, ...rest } = now;
  if (stable(rest) === stable(row)) unchanged += 1;
  if (row.kind === 'work' && 'parentWorkId' in now && parentWorkId === null) nullParents += 1;
}
check(
  unchanged === rc3Records.length,
  'every row RC3 wrote is present and otherwise unchanged',
  `${unchanged}/${rc3Records.length}`,
);
check(nullParents === 3, 'every work record gained exactly parentWorkId: null', `${nullParents}/3`);
check(
  !('parentWorkId' in (after.get(honour?.id) ?? {})),
  'the honour was not given a parentWorkId',
);
for (const store of ['progressEntries', 'categories', 'groups', 'settings']) {
  check(
    stable(afterUpgrade.stores[store] ?? []) === stable(beforeUpgrade.stores[store] ?? []),
    `${store} are byte-for-byte what RC3 left`,
    `${(afterUpgrade.stores[store] ?? []).length} row(s)`,
  );
}
check(
  after.get(honour?.relatedWorkId)?.kind === 'work',
  "the honour's link still resolves to a work record",
);
const progress = afterUpgrade.stores.progressEntries ?? [];
check(
  progress.length > 0 && progress.every((p) => after.has(p.recordId)),
  'every progress entry still points at its record',
);
const metaRow = (afterUpgrade.stores.meta ?? [])[0] ?? {};
check(
  metaRow.value?.schemaVersion === 2,
  'the meta row records schema 2',
  `schemaVersion ${metaRow.value?.schemaVersion}`,
);
await page.goto(`${ORIGIN}/#/dashboard`);
await ready(page);
const dashboard = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
check(!/未通过校验/.test(dashboard), 'the dashboard reports no invalid rows');

// ---------------------------------------------------------------------------------------------------
section('5. new levels under an RC3 record, then an exact restore');
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
async function addChild(parentTitle, title) {
  const card = page.getByRole('article', { name: parentTitle });
  const toggle = card.getByRole('button', { name: /展开详情|收起详情/ }).first();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await card.getByRole('button', { name: '添加下级任务', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新增下级任务' });
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(title);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
await addChild('RC3 时期的上级事项', '升级后添加的二级任务');
await addChild('升级后添加的二级任务', '升级后添加的三级任务');
const withTree = await dumpDatabase(page);
const tree = new Map((withTree.stores.records ?? []).map((r) => [r.title, r]));
check(
  tree.get('升级后添加的三级任务')?.parentWorkId === tree.get('升级后添加的二级任务')?.id &&
    tree.get('升级后添加的二级任务')?.parentWorkId === tree.get('RC3 时期的上级事项')?.id,
  'a 2级 and a 3级 sub-task hang under the record RC3 created',
);
const v3Backup = await exportBackup(session);
const v3Doc = JSON.parse(readFileSync(v3Backup, 'utf8'));
check(
  v3Doc.backupFormatVersion === 3 && v3Doc.schemaVersion === 2 && v3Doc.completeness === 'complete',
  'the new backup is a complete format-3 backup of schema 2',
  `format ${v3Doc.backupFormatVersion}, schema ${v3Doc.schemaVersion}, ${v3Doc.completeness}`,
);
check(
  v3Doc.payload?.records?.length === 6,
  'it carries all six records',
  `${v3Doc.payload?.records?.length}`,
);
const sourceRows = withTree;
await session.close();

session = await openProfile(PROFILE_RESTORE);
({ page } = session);
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
await restoreReplacing(page, v3Backup);
const restored = await dumpDatabase(page);
for (const store of ['records', 'progressEntries', 'categories', 'groups', 'settings']) {
  check(
    stable(
      [...(restored.stores[store] ?? [])].sort((a, b) =>
        String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)),
      ),
    ) ===
      stable(
        [...(sourceRows.stores[store] ?? [])].sort((a, b) =>
          String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)),
        ),
      ),
    `the restore reproduces ${store} exactly`,
    `${(restored.stores[store] ?? []).length} row(s)`,
  );
}
await session.close();

// ---------------------------------------------------------------------------------------------------
section("6. RC3's own backup is still usable");
session = await openProfile(PROFILE_RC3_BACKUP);
({ page } = session);
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
let rc3BackupRestored = true;
try {
  await restoreReplacing(page, rc3Backup);
} catch (err) {
  rc3BackupRestored = false;
  info('restore error', String(err).split('\n')[0]);
}
const fromRc3Backup = await dumpDatabase(page);
const fromRc3 = byId(fromRc3Backup.stores.records ?? []);
check(
  rc3BackupRestored && rc3Records.every((r) => fromRc3.has(r.id)),
  "RC3's JSON backup restores into this release with every record",
  `${fromRc3.size} record(s)`,
);
check(
  [...fromRc3.values()].filter((r) => r.kind === 'work').every((r) => r.parentWorkId === null),
  'its work records arrive as top-level tasks',
);
await session.close();

// ---------------------------------------------------------------------------------------------------
section('7. going back to RC3 is refused');
sh(bin('civic-launch.exe'), ['stop']);
const rollback = sh(bin('civic-admin.exe'), ['rollback', '--root', INSTALL_ROOT]);
check(
  rollback.status === 4,
  'civic-admin rollback to RC3 is refused (exit 4)',
  `code ${rollback.status}`,
);
check(/older browser-database schema/.test(rollback.stderr ?? ''), 'the refusal names the reason');
check(current() === RELEASE_ID, 'this release stays active');
const status = sh(bin('civic-launch.exe'), ['status']);
check(
  new RegExp(
    `可回退版本 +: （无）上一版本 ${RC3_ID.replace(/\./g, '\\.')} 使用较旧的数据格式（第 1 版），回退可能损坏记录，已禁止`,
  ).test(status.stdout ?? ''),
  'status says RC3 is not a safe rollback target',
);
check(
  external.length === 0,
  'no request left the origin in any browser session',
  external.slice(0, 3).join('; ') || 'none',
);

// ---------------------------------------------------------------------------------------------------
section('8. summary');
cleanSlate();
console.log('');
console.log(`  checks : ${results.length}`);
console.log(`  passed : ${results.filter((r) => r.status === 'PASS').length}`);
console.log(`  failed : ${failures}`);
console.log('');
console.log(
  failures === 0
    ? '  RESULT: PASS on this development workstation. Windows compatibility is NOT certified.'
    : '  RESULT: FAIL -- see the [FAIL] lines above.',
);
writeFileSync(
  join(ROOT, 'release', 'windows', `acceptance-upgrade-${RELEASE_ID}.txt`),
  [
    `CivicWorkDesk Windows RC3 -> ${IDENTITY.displayVersion} upgrade acceptance`,
    '',
    `release under test : ${RELEASE_ID}`,
    `RC3 installer      : ${rc3.sha256} (${rc3.source})`,
    `browser            : ${CHANNEL}, persistent profiles`,
    `update prompt after: ${bannerAfter === null ? 'n/a' : `${bannerAfter} s`}`,
    `checks             : ${results.length} (${failures} failed)`,
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
process.exit(failures === 0 ? 0 : 1);
