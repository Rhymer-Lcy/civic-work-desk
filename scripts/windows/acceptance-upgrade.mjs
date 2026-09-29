#!/usr/bin/env node
/**
 * The upgrade a colleague will actually perform: Windows RC3, as published, to this release -- in
 * persistent Microsoft Edge profiles, through the update check page the launcher opens.
 *
 *   node scripts/windows/acceptance-upgrade.mjs --release-id <id>
 *
 * RC3 is installed from the installer on its GitHub Release (digest checked against the one recorded at
 * publication) and used in five persistent profiles, each with RC3's service worker in control:
 *
 *   N  the negative control. After the upgrade `/` is opened directly, without the check page: RC3's
 *      worker still serves RC3's interface -- the defect that rejected the previous candidate -- and the
 *      packaged geometry gate must FAIL on it, as it must on RC3 before the upgrade. The same profile
 *      then goes through the check page and must PASS the same gate.
 *   A  one application tab, with records of every kind, closed before the upgrade as the installer's
 *      Ready page asks. The check page must find the new worker, offer 进入新版本, and enter the new
 *      interface. Every data check runs in this profile.
 *   B  two application tabs, the second with an unsaved 新增工作记录 dialog, both left open through the
 *      upgrade. The check page must refuse, leave both tabs and the typed text alone, and allow the
 *      switch only after the text is saved, the tabs are closed and 重试 asks again.
 *   C  three application tabs left open: the same rule, closed one at a time.
 *   D  no application tab, only the browser-check page and a service answer: they must not block.
 *
 * Then, in profile A: the migration from schema 1 to schema 2, a 2级 and a 3级 sub-task, a format-3
 * backup and its exact restore, the XLSX and DOCX exports, a browser restart, a program restart,
 * offline use, RC3's own backup, and the refusal to roll back to RC3 with this release left intact.
 *
 * Edge is started the way a person's shortcut starts it and attached over CDP (see openProfile), with
 * its ordinary classic scrollbars. The local server is started directly (civic-server.exe) rather than
 * through the launcher, so the operator's real default browser is never opened onto the origin; the
 * page the launcher opens is opened here by its URL, and acceptance-deploy.mjs proves the launcher opens
 * exactly that URL. All data is synthetic.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { obtainPublishedInstaller } from './published-installer.mjs';
import { silentUninstall } from './silent-uninstall.mjs';
import { businessDateUtc8, loadReleaseIdentity } from './release-identity.mjs';
import { readZipEntry, zipEntryNames } from './zip-read.mjs';

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
const SETUP = join(ROOT, 'release', 'windows', IDENTITY.installerName);
const ORIGIN = 'http://127.0.0.1:8765';
const INSTALL_ROOT = join(
  process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
  'CivicWorkDesk',
);
const WORK = join(tmpdir(), 'civic-upgrade-acceptance');
const PROFILE = {
  A: join(WORK, 'profile-A-records'),
  B: join(WORK, 'profile-B-unsaved-tab'),
  C: join(WORK, 'profile-C-three-tabs'),
  D: join(WORK, 'profile-D-utility-pages'),
  N: join(WORK, 'profile-N-negative-control'),
  restore: join(WORK, 'profile-restore'),
  rc3Backup: join(WORK, 'profile-rc3-backup'),
};
const DOWNLOADS = join(WORK, 'downloads');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'phase-1-2-canonical-v3.json');
const APP_ID_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8B3F2C71-4D5E-4A19-9C42-7E1D6F0B8A53}_is1';

/* The page the launcher and the installer's finish step open, read from the server source. */
const START = (() => {
  const go = readFileSync(
    join(ROOT, 'deploy', 'windows', 'src', 'internal', 'httpserve', 'httpserve.go'),
    'utf8',
  );
  const prefix = /CivicAPIPrefix\s*=\s*"([^"]+)"/.exec(go)?.[1];
  const leaf = /StartPath\s*=\s*CivicAPIPrefix\s*\+\s*"([^"]+)"/.exec(go)?.[1];
  if (!prefix || !leaf) throw new Error('httpserve.StartPath could not be read');
  return `${ORIGIN}${prefix}${leaf}`;
})();

/* Texts this script asserts on: the check page's refusal (the wording the brief requires) and the
 * product's own Phase-5.1 notice, which must never appear once the check page has entered. */
const BLOCKED_TEXT =
  '检测到其他政务工作记录台页面仍在打开。请先保存其中尚未保存的内容并关闭这些页面，然后再进入新版本。';
const MISMATCH_NOTICE = '本机已安装新版本，本页面仍在运行旧版本。';
const UNSAVED_TEXT = '场景B：尚未保存的合成验收文字（非真实数据）7F3A';

const ROUTES = [
  ['dashboard', '概览'],
  ['work', '工作'],
  ['honors', '荣誉'],
  ['ledger', '台账'],
  ['reports', '报告'],
  ['settings', '设置'],
];
const VIEWPORTS = [
  [1366, 768],
  [1920, 1080],
  [2047, 1001],
  [2560, 1440],
];
/* The size at which the user reported the moving bar. The negative control must fail there. */
const REPORTED_SIZE = '2047x1001';
const TOLERANCE_PX = 1;

const results = [];
const evidence = { geometry: {}, bootstrap: {}, probes: {} };
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
const ENTRY = /assets\/index-([A-Za-z0-9_-]{6,64})\.js/;
const generationOf = (text) => {
  const match = ENTRY.exec(text ?? '');
  return match ? `ui-${match[1]}` : null;
};

async function health() {
  try {
    const r = await fetch(`${ORIGIN}/__civic/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function runtimeAnswer() {
  try {
    const r = await fetch(`${ORIGIN}/api/civic/runtime`);
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

async function stopServer() {
  const stop = sh(bin('civic-launch.exe'), ['stop']);
  for (let i = 0; i < 40 && (await health()) !== null; i += 1) await sleep(250);
  return stop.status;
}

/** Uninstall whatever is installed, waiting for the uninstaller's second phase (silent-uninstall.mjs). */
async function cleanSlate({ waitMs = 15_000 } = {}) {
  if (existsSync(bin('civic-launch.exe'))) sh(bin('civic-launch.exe'), ['stop']);
  const result = await silentUninstall(INSTALL_ROOT, { waitMs });
  rmSync(INSTALL_ROOT, { recursive: true, force: true });
  sh('reg', ['delete', APP_ID_KEY, '/f']);
  return result;
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
 * Open Microsoft Edge on a persistent profile.
 *
 * ## Edge is started the ordinary way, not by Playwright
 *
 * Playwright's own Edge launch (`launchPersistentContext` with `channel: 'msedge'`) crashes the browser
 * with an access violation (exit 0xC0000005) when a page downloads a file in a profile that has been
 * opened before -- the first launch of a profile downloads fine, every later launch dies. Edge started
 * with its ordinary command line and attached over CDP downloaded on three consecutive launches of one
 * profile. This harness reopens the SAME profiles after the upgrade and then downloads, so it starts
 * Edge the way a person's shortcut does and attaches to it -- which is also the closer rehearsal of a
 * colleague's browser, including its classic scrollbars (no `--hide-scrollbars`).
 *
 * ## Sync is off
 *
 * On a Windows session signed in with a Microsoft account, Edge signs a NEW profile in to that account
 * implicitly and starts syncing it. The first rehearsal found the operator's own extensions installed
 * into these throwaway profiles a few minutes in, and their welcome pages were the only requests that
 * left the origin. The profiles must hold synthetic data only, so sync is disabled, as Playwright's own
 * launch already does for acceptance-browser.mjs. Rendering and scrollbars are unaffected.
 */
async function openProfile(dir) {
  mkdirSync(dir, { recursive: true });
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
      '--disable-sync',
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
  context.on('page', watchExternal);
  const page = context.pages()[0] ?? (await context.newPage());
  for (const p of context.pages()) watchExternal(p);
  const prepare = (p) => {
    p.setDefaultTimeout(30_000);
    return p;
  };
  prepare(page);
  return {
    page,
    context,
    async newPage(url) {
      const p = prepare(await context.newPage());
      if (url) await p.goto(url);
      return p;
    },
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
      return { path: join(DOWNLOADS, start.guid), name: start.suggestedFilename };
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

/** Open `/` under RC3 and wait until RC3's worker controls the page. */
async function adoptRc3(page, route = 'work') {
  await page.goto(`${ORIGIN}/#/${route}`);
  await ready(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await ready(page);
  return page.evaluate(() => Boolean(navigator.serviceWorker.controller));
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
const sortedRows = (rows) =>
  [...(rows ?? [])].sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
const sameDatabase = (a, b) =>
  a.version === b.version &&
  Object.keys(a.stores).length === Object.keys(b.stores).length &&
  Object.keys(a.stores).every(
    (store) => stable(sortedRows(a.stores[store])) === stable(sortedRows(b.stores[store])),
  );

async function exportBackup(session, page) {
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

/** RC3's own 新增工作记录 dialog: only the title is filled. */
async function createWorkRc3(page, title) {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: /事项/ }).first().fill(title);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

/* Today as the browser's clock sees it, which is the date the application files a record under. */
const TODAY = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

/** This release's 新增工作记录 dialog, with a specific date so the record falls in a report period. */
async function createDatedWork(page, title) {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(title);
  await dialog.getByRole('radiogroup', { name: '事项日期类型' }).getByText('具体日期').click();
  await dialog.getByRole('textbox', { name: '事项日期', exact: true }).fill(TODAY);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function addChild(page, parentTitle, title) {
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

/** What an application tab is running, and whether it is still the document it was. */
function tabState(page) {
  return page.evaluate(() => ({
    mark: window.__civicAcceptanceMark ?? null,
    entry:
      document.querySelector('script[type="module"][src*="assets/index-"]')?.getAttribute('src') ??
      null,
  }));
}

// ---------------------------------------------------------------------------------------------------
// The update check page
// ---------------------------------------------------------------------------------------------------

const SETTLED = /^(ready|blocked|unknown|error-[a-z-]+)$/;

/**
 * Wait until the check page settles: a state that waits for the user, an error, or the application
 * root (it entered). Bounded; the page's own longest wait is the 150 s update limit.
 */
async function settle(page, timeoutMs = 240_000) {
  const started = Date.now();
  const trail = [];
  while (Date.now() - started < timeoutMs) {
    let url = null;
    try {
      url = new URL(page.url());
    } catch {
      /* navigating */
    }
    if (url && url.origin === ORIGIN && url.pathname === '/') {
      return { state: 'entered', trail, ms: Date.now() - started };
    }
    const snap = await page
      .evaluate(() => ({
        state: document.body?.getAttribute('data-state') ?? null,
        message: document.getElementById('message')?.textContent ?? '',
        detail: document.getElementById('detail')?.textContent ?? '',
        facts: document.getElementById('facts')?.textContent ?? '',
      }))
      .catch(() => null);
    if (snap?.state && trail[trail.length - 1] !== snap.state) trail.push(snap.state);
    if (snap?.state && SETTLED.test(snap.state))
      return { ...snap, trail, ms: Date.now() - started };
    await sleep(200);
  }
  return { state: 'timeout', trail, ms: Date.now() - started };
}

const describe = (s) =>
  `${s.state} after ${(s.ms / 1000).toFixed(1)} s (${s.trail.join(' > ') || 'no intermediate state'})`;

/**
 * Ask the WAITING worker the Phase-5.1 question directly, from the check page, and the ACTIVE worker the
 * same question. The waiting worker is the candidate's; RC3's active worker has never heard of it.
 */
function probeWorkers(page) {
  return page.evaluate(async () => {
    const ask = (worker) =>
      new Promise((resolveAnswer) => {
        if (!worker) {
          resolveAnswer(null);
          return;
        }
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolveAnswer(null), 3000);
        channel.port1.onmessage = (event) => {
          clearTimeout(timer);
          resolveAnswer(event.data);
        };
        worker.postMessage({ type: 'CIVIC_WINDOW_CLIENTS', version: 1 }, [channel.port2]);
      });
    const registration = await navigator.serviceWorker.getRegistration('/');
    return {
      waitingScript: registration?.waiting?.scriptURL ?? null,
      waitingState: registration?.waiting?.state ?? null,
      waiting: await ask(registration?.waiting),
      active: await ask(registration?.active),
    };
  });
}

/**
 * After the check page entered `/`: prove the page runs exactly the installed generation. A profile's
 * very first page is never controlled (the worker does not claim clients), so `firstRun` asks only that
 * nothing is left waiting.
 */
async function verifyEntered(page, label, expected, { firstRun = false } = {}) {
  await ready(page);
  const facts = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return {
      href: location.href,
      entry:
        document
          .querySelector('script[type="module"][src*="assets/index-"]')
          ?.getAttribute('src') ?? null,
      controlled: Boolean(navigator.serviceWorker.controller),
      waiting: Boolean(registration?.waiting),
    };
  });
  const href = new URL(facts.href);
  check(
    href.origin === ORIGIN && href.pathname === '/',
    `${label}: the application root opened on the canonical origin`,
    facts.href,
  );
  const running = generationOf(facts.entry);
  const runtime = await runtimeAnswer();
  check(
    running === expected && runtime?.appGeneration === expected,
    `${label}: the page runs the installed interface generation`,
    `running ${running}, installed ${expected}, /api/civic/runtime ${runtime?.appGeneration}`,
  );
  check(
    (firstRun || facts.controlled) && !facts.waiting,
    firstRun
      ? `${label}: no worker is left waiting (a first page is not controlled)`
      : `${label}: the new worker controls the page and none is left waiting`,
  );
  // The product's own Phase-5.1 check asks /api/civic/runtime on start; give it time to speak.
  let notice = false;
  for (let i = 0; i < 20 && !notice; i += 1) {
    notice = (await page.getByText(MISMATCH_NOTICE).count()) > 0;
    if (!notice) await sleep(250);
  }
  check(!notice, `${label}: the application's own generation check raises no mismatch notice`);
  return running === expected;
}

// ---------------------------------------------------------------------------------------------------
// Packaged geometry (the gate of docs/phase-5.1-runtime-update-safety.md §2, run on installed bytes)
// ---------------------------------------------------------------------------------------------------

/**
 * One route's frame. The selectors are structural so the same measurement applies to RC3, which has no
 * data-shell-part hooks: the brand is the bar's first paragraph, the action slot the bar's last child
 * when that is a div (RC3 renders it only on routes with a primary action). The hooks are reported so
 * the candidate's measurement can be shown to be the Phase-5.1 gate's.
 */
function shellFrame(page) {
  return page.evaluate(
    (labels) => {
      const bar = document.querySelector('header.app-header > div');
      const brand = bar?.querySelector(':scope > p') ?? null;
      const slot = bar?.querySelector(':scope > div:last-child') ?? null;
      const nav = document.querySelector('nav[aria-label="主导航"]');
      const links = [...(nav?.querySelectorAll('a') ?? [])];
      const root = document.scrollingElement ?? document.documentElement;
      return {
        brandLeft: brand ? brand.getBoundingClientRect().left : null,
        brandPart: brand?.getAttribute('data-shell-part') ?? null,
        navLefts: labels.map((label) => {
          const link = links.find((a) => (a.textContent ?? '').trim() === label);
          return link ? link.getBoundingClientRect().left : null;
        }),
        slotRight: slot ? slot.getBoundingClientRect().right : null,
        slotPart: slot?.getAttribute('data-shell-part') ?? null,
        scrolls: root.scrollHeight > root.clientHeight,
      };
    },
    ROUTES.map(([, label]) => label),
  );
}

/** Width of a classic scrollbar in this browser: 0 where scrollbars are hidden or overlaid. */
function classicScrollbarWidth(page) {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.top = '-200px';
    probe.style.width = '100px';
    probe.style.height = '100px';
    probe.style.overflowY = 'scroll';
    document.body.append(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return width;
  });
}

async function goRoute(page, label) {
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('link', { name: label, exact: true }).click();
  await nav.locator('a[aria-current="page"]', { hasText: label }).waitFor();
  await page
    .getByText('正在读取本机数据…')
    .waitFor({ state: 'detached', timeout: 20_000 })
    .catch(() => {});
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
}

function worstDelta(frames) {
  let delta = 0;
  let where = 'none';
  const consider = (label, pick) => {
    const values = frames.map(pick).filter((v) => typeof v === 'number');
    if (values.length < 2) return;
    const spread = Math.max(...values) - Math.min(...values);
    if (spread > delta) {
      delta = spread;
      where = label;
    }
  };
  consider('brand left', (f) => f.brandLeft);
  ROUTES.forEach(([, label], index) => consider(`${label} left`, (f) => f.navLefts[index]));
  consider('action-slot right', (f) => f.slotRight);
  return { delta: Math.round(delta * 100) / 100, where };
}

async function measureGeometry(page) {
  const sizes = [];
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    const frames = [];
    for (const [, label] of ROUTES) {
      await goRoute(page, label);
      frames.push({ route: label, ...(await shellFrame(page)) });
    }
    sizes.push({
      size: `${width}x${height}`,
      scrollbar: await classicScrollbarWidth(page),
      frames,
      scrolling: frames.filter((f) => f.scrolls).map((f) => f.route),
      ...worstDelta(frames),
    });
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  return sizes;
}

const geometryLine = (sizes) =>
  sizes
    .map((s) => `${s.size} ${s.delta} px (${s.where}; scrolls: ${s.scrolling.join('/') || 'none'})`)
    .join('; ');

/** The gate itself, applied to this release's interface. */
function gateCandidate(label, sizes, { requireBothLayouts }) {
  evidence.geometry[label] = sizes;
  check(
    sizes.every((s) => s.scrollbar > 0),
    `${label}: Edge draws classic scrollbars here`,
    sizes.map((s) => `${s.size} ${s.scrollbar} px`).join(', '),
  );
  const hooked = sizes.every((s) =>
    s.frames.every(
      (f) =>
        f.brandPart === 'brand' &&
        f.slotPart === 'action-slot' &&
        f.brandLeft !== null &&
        f.slotRight !== null &&
        f.navLefts.every((x) => x !== null),
    ),
  );
  check(hooked, `${label}: brand, all six destinations and the action slot were measured`);
  const mixed = sizes.every((s) => s.scrolling.length > 0 && s.scrolling.length < ROUTES.length);
  if (requireBothLayouts) {
    check(mixed, `${label}: every size has a route that scrolls and one that does not`);
  } else {
    info(
      `${label}: routes that scroll`,
      sizes.map((s) => `${s.size} ${s.scrolling.length}`).join(', '),
    );
  }
  check(
    sizes.every((s) => s.delta <= TOLERANCE_PX),
    `${label}: largest route-to-route shift is within ${TOLERANCE_PX} CSS px at every size`,
    geometryLine(sizes),
  );
}

/** The negative control: RC3's interface must fail the same gate. */
function gateRc3(label, sizes) {
  evidence.geometry[label] = sizes;
  check(
    sizes.every((s) => s.scrollbar > 0),
    `${label}: Edge draws classic scrollbars here`,
    sizes.map((s) => `${s.size} ${s.scrollbar} px`).join(', '),
  );
  const reported = sizes.find((s) => s.size === REPORTED_SIZE);
  check(
    (reported?.delta ?? 0) > TOLERANCE_PX,
    `${label}: the gate FAILS on RC3's interface at ${REPORTED_SIZE}, the reported size`,
    reported ? `${reported.delta} px (${reported.where})` : 'not measured',
  );
  check(
    !sizes.every((s) => s.delta <= TOLERANCE_PX),
    `${label}: RC3's interface does not pass the gate`,
    geometryLine(sizes),
  );
}

// ===================================================================================================
console.log(`CivicWorkDesk Windows -- RC3 to ${IDENTITY.displayVersion} upgrade acceptance`);
console.log('');
console.log(`  release under test : ${RELEASE_ID}`);
console.log(`  update check page  : ${START}`);
if (!existsSync(SETUP)) {
  console.error(`error: ${SETUP} is not built`);
  process.exit(2);
}
if (!existsSync(EDGE)) {
  console.error(`error: Microsoft Edge is not installed at ${EDGE}`);
  process.exit(2);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(DOWNLOADS, { recursive: true });
const edgeVersion = sh('powershell', [
  '-NoProfile',
  '-Command',
  `(Get-Item '${EDGE}').VersionInfo.ProductVersion`,
]).stdout.trim();
info('Microsoft Edge', edgeVersion || '(version not read)');

// ---------------------------------------------------------------------------------------------------
section('1. RC3 as published, in five persistent profiles');
let rc3;
try {
  rc3 = obtainPublishedInstaller(ROOT, RC3_ID);
  check(true, 'the RC3 installer is the published one', `${rc3.sha256} (${rc3.source})`);
} catch (err) {
  check(false, 'the RC3 installer is the published one', String(err));
  process.exit(1);
}
await cleanSlate();
const rc3Install = sh(rc3.path, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
check(
  rc3Install.status === 0 && current() === RC3_ID,
  'RC3 installed from its published bytes',
  `code ${rc3Install.status}`,
);
const rc3Health = await startServer(RC3_ID);
check(rc3Health !== null, 'RC3 serves the origin', rc3Health?.serverVersion ?? '(no answer)');
const RC3_GENERATION = generationOf(
  readFileSync(join(INSTALL_ROOT, 'releases', RC3_ID, 'app', 'index.html'), 'utf8'),
);
info("RC3's interface generation (from its index.html)", String(RC3_GENERATION));
const rc3Worker = readFileSync(join(INSTALL_ROOT, 'releases', RC3_ID, 'app', 'sw.js'), 'utf8');
check(
  !rc3Worker.includes('CIVIC_WINDOW_CLIENTS') && !rc3Worker.includes('sw-client-awareness'),
  "RC3's service worker does not carry the window-awareness protocol",
);

// A: records of every kind, then closed, as the Ready page asks.
const sessionA = await openProfile(PROFILE.A);
let pageA = sessionA.page;
check(await adoptRc3(pageA), "A: RC3's service worker controls the page");
await restoreReplacing(pageA, FIXTURE);
await pageA.goto(`${ORIGIN}/#/work`);
await ready(pageA);
await createWorkRc3(pageA, 'RC3 时期的上级事项');
await createWorkRc3(pageA, 'RC3 时期的另一事项');
await pageA.reload();
await ready(pageA);
const beforeUpgrade = await dumpDatabase(pageA);
check(
  beforeUpgrade.version === 10,
  'A: RC3 holds the database at schema 1 (IndexedDB version 10)',
  `version ${beforeUpgrade.version}`,
);
const rc3Records = beforeUpgrade.stores.records ?? [];
info(
  'A: RC3 rows',
  Object.entries(beforeUpgrade.stores)
    .map(([k, v]) => `${k} ${v.length}`)
    .join(', '),
);
check(
  rc3Records.length === 4 && rc3Records.filter((r) => r.kind === 'work').length === 3,
  'A: RC3 holds the restored work record and honour plus the two it created',
  `${rc3Records.length} record(s)`,
);
const honour = rc3Records.find((r) => r.kind === 'honor');
check(
  Boolean(honour?.relatedWorkId),
  'A: the honour is linked to a work record',
  honour?.relatedWorkId ?? '(none)',
);
const rc3Backup = (await exportBackup(sessionA, pageA)).path;
const rc3BackupDoc = JSON.parse(readFileSync(rc3Backup, 'utf8'));
check(
  rc3BackupDoc.schemaVersion === 1 && rc3BackupDoc.payload?.records?.length === 4,
  "A: RC3's own JSON backup was taken",
  `format ${rc3BackupDoc.backupFormatVersion}, schema ${rc3BackupDoc.schemaVersion}, ${rc3BackupDoc.payload?.records?.length} records`,
);
await sessionA.close();

// N: RC3's interface measured before the upgrade -- the first negative control.
const sessionN = await openProfile(PROFILE.N);
check(await adoptRc3(sessionN.page, 'dashboard'), "N: RC3's service worker controls the page");
gateRc3('N, RC3 before the upgrade', await measureGeometry(sessionN.page));
await sessionN.close();

// D: RC3 used, then closed.
const sessionD = await openProfile(PROFILE.D);
check(await adoptRc3(sessionD.page), "D: RC3's service worker controls the page");
await sessionD.close();

// B: two application tabs; the second holds an unsaved 新增工作记录 dialog. Both stay open.
const sessionB = await openProfile(PROFILE.B);
const tabBA = sessionB.page;
check(await adoptRc3(tabBA), "B: tab A is controlled by RC3's service worker");
const tabBB = await sessionB.newPage(`${ORIGIN}/#/work`);
await ready(tabBB);
check(
  await tabBB.evaluate(() => Boolean(navigator.serviceWorker.controller)),
  "B: tab B is controlled by RC3's service worker",
);
await tabBB.getByRole('button', { name: '新增记录' }).first().click();
const dialogBB = tabBB.getByRole('dialog', { name: '新增工作记录' });
await dialogBB.waitFor();
const unsavedField = dialogBB.getByRole('textbox', { name: /事项/ }).first();
await unsavedField.fill(UNSAVED_TEXT);
await tabBA.evaluate(() => {
  window.__civicAcceptanceMark = 'B-tab-A';
});
await tabBB.evaluate(() => {
  window.__civicAcceptanceMark = 'B-tab-B';
});
check(
  (await unsavedField.inputValue()) === UNSAVED_TEXT,
  'B: tab B holds distinctive unsaved synthetic text in 新增工作记录',
);

// C: three application tabs on three routes. All stay open.
const sessionC = await openProfile(PROFILE.C);
const tabsC = [sessionC.page];
check(await adoptRc3(sessionC.page, 'dashboard'), "C: RC3's service worker controls the pages");
tabsC.push(await sessionC.newPage(`${ORIGIN}/#/work`));
tabsC.push(await sessionC.newPage(`${ORIGIN}/#/ledger`));
for (const [i, tab] of tabsC.entries()) {
  await ready(tab);
  await tab.evaluate(
    (mark) => {
      window.__civicAcceptanceMark = mark;
    },
    `C-tab-${i + 1}`,
  );
}

// ---------------------------------------------------------------------------------------------------
section('2. this release installed over RC3, while RC3 and two browsers are running');
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
const installed = JSON.parse(
  readFileSync(join(INSTALL_ROOT, 'releases', RELEASE_ID, 'app', 'app-generation.json'), 'utf8'),
);
const EXPECTED = installed.appGeneration;
const runtimeNow = await runtimeAnswer();
check(
  runtimeNow?.schema === 'civic-runtime/1' && runtimeNow?.appGeneration === EXPECTED,
  '/api/civic/runtime names the installed generation',
  `${runtimeNow?.appGeneration} (installed ${EXPECTED})`,
);
check(EXPECTED !== RC3_GENERATION, "the installed generation is not RC3's", `${EXPECTED}`);
const newWorker = readFileSync(join(INSTALL_ROOT, 'releases', RELEASE_ID, 'app', 'sw.js'), 'utf8');
check(
  newWorker.includes('sw-client-awareness.js') &&
    existsSync(join(INSTALL_ROOT, 'releases', RELEASE_ID, 'app', 'sw-client-awareness.js')),
  "this release's service worker imports the window-awareness protocol",
);

// ---------------------------------------------------------------------------------------------------
section('3. negative control: `/` opened directly after the upgrade runs RC3');
const reopenedN = await openProfile(PROFILE.N);
const pageN = reopenedN.page;
await pageN.goto(`${ORIGIN}/#/dashboard`);
await ready(pageN);
const staleN = await tabState(pageN);
check(
  generationOf(staleN.entry) === RC3_GENERATION,
  "the page opened at `/` runs RC3's interface, served by RC3's worker",
  `${generationOf(staleN.entry)} while the server expects ${EXPECTED}`,
);
gateRc3('N, RC3 served after the upgrade', await measureGeometry(pageN));
// The person closes the stale page and starts the program again. A blank tab keeps the browser open.
const bootN = await reopenedN.newPage();
await pageN.close();
await bootN.goto(START);
const settledN = await settle(bootN);
evidence.bootstrap.N = settledN;
check(settledN.state === 'ready', 'N: the check page offers 进入新版本', describe(settledN));
await bootN.getByRole('button', { name: '进入新版本' }).click();
const enteredN = await settle(bootN);
check(enteredN.state === 'entered', 'N: 进入新版本 entered the application', describe(enteredN));
if (await verifyEntered(bootN, 'N', EXPECTED)) {
  gateCandidate('N, this release after the check page', await measureGeometry(bootN), {
    requireBothLayouts: true,
  });
}
await reopenedN.close();

// ---------------------------------------------------------------------------------------------------
section('4. scenario B: an unsaved second tab refuses the switch until it is dealt with');
const bootB = await sessionB.newPage(START);
const blockedB = await settle(bootB);
evidence.bootstrap.B1 = blockedB;
check(blockedB.state === 'blocked', 'B: the check page refuses to switch', describe(blockedB));
check(blockedB.message === BLOCKED_TEXT, 'B: it says so in the required words', blockedB.message);
check(/：2 个/.test(blockedB.detail), 'B: it counts two other pages', blockedB.detail);
const probeB = await probeWorkers(bootB);
evidence.probes.B = probeB;
check(
  probeB.waiting?.type === 'CIVIC_WINDOW_CLIENTS_RESULT' &&
    probeB.waiting?.version === 1 &&
    probeB.waiting?.worker === 'installed',
  "B: the candidate's waiting worker answers the protocol (version 1, state installed)",
  JSON.stringify(probeB.waiting),
);
check(
  probeB.active === null,
  "B: RC3's active worker gives no answer, which is why the waiting worker is asked",
);
const appWindowsB = (probeB.waiting?.windows ?? []).filter(
  (w) => !w.requester && w.kind === 'application',
);
check(
  appWindowsB.length === 2 && appWindowsB.every((w) => w.route === 'work'),
  'B: the worker sees both RC3 tabs as application windows',
  JSON.stringify(probeB.waiting?.windows),
);
const stateBA = await tabState(tabBA);
const stateBB = await tabState(tabBB);
check(
  !tabBA.isClosed() &&
    !tabBB.isClosed() &&
    stateBA.mark === 'B-tab-A' &&
    stateBB.mark === 'B-tab-B',
  'B: both tabs are still open and neither was reloaded',
);
check(
  generationOf(stateBA.entry) === RC3_GENERATION && generationOf(stateBB.entry) === RC3_GENERATION,
  'B: both tabs still run RC3; nothing was switched under them',
);
check(
  (await dialogBB.isVisible()) && (await unsavedField.inputValue()) === UNSAVED_TEXT,
  "B: tab B's dialog is still open with the unsaved text intact",
);

await tabBA.close();
await bootB.getByRole('button', { name: '重试' }).click();
const retryB1 = await settle(bootB);
evidence.bootstrap.B2 = retryB1;
check(
  retryB1.state === 'blocked' && /：1 个/.test(retryB1.detail),
  'B: after tab A is closed, 重试 asks again and counts one',
  `${describe(retryB1)}; ${retryB1.detail}`,
);
await dialogBB.getByRole('button', { name: '保存', exact: true }).click();
await dialogBB.waitFor({ state: 'hidden' });
const savedInRc3 = await dumpDatabase(tabBB);
check(
  savedInRc3.version === 10 &&
    (savedInRc3.stores.records ?? []).some((r) => r.title === UNSAVED_TEXT),
  'B: the text was saved deliberately, by RC3, into its own database',
);
await tabBB.close();
await bootB.getByRole('button', { name: '重试' }).click();
const readyB = await settle(bootB);
evidence.bootstrap.B3 = readyB;
check(
  readyB.state === 'ready',
  'B: with both tabs closed, 重试 offers 进入新版本',
  describe(readyB),
);
await bootB.getByRole('button', { name: '进入新版本' }).click();
const enteredB = await settle(bootB);
check(enteredB.state === 'entered', 'B: 进入新版本 entered the application', describe(enteredB));
await verifyEntered(bootB, 'B', EXPECTED);
const afterB = await dumpDatabase(bootB);
const savedRecord = (afterB.stores.records ?? []).find((r) => r.title === UNSAVED_TEXT);
check(
  afterB.version === 20 && savedRecord?.parentWorkId === null,
  'B: the record saved in tab B survived the migration as a top-level task',
  `version ${afterB.version}, parentWorkId ${JSON.stringify(savedRecord?.parentWorkId)}`,
);
await sessionB.close();

// ---------------------------------------------------------------------------------------------------
section('5. scenario C: three RC3 tabs, closed one at a time');
const bootC = await sessionC.newPage(START);
const blockedC = await settle(bootC);
evidence.bootstrap.C1 = blockedC;
check(
  blockedC.state === 'blocked' && /：3 个/.test(blockedC.detail),
  'C: the check page refuses and counts three other pages',
  `${describe(blockedC)}; ${blockedC.detail}`,
);
for (const [i, tab] of tabsC.entries()) {
  const state = await tabState(tab);
  check(
    state.mark === `C-tab-${i + 1}` && generationOf(state.entry) === RC3_GENERATION,
    `C: tab ${i + 1} is untouched and still runs RC3`,
  );
}
await tabsC[0].close();
await tabsC[1].close();
await bootC.getByRole('button', { name: '重试' }).click();
const retryC = await settle(bootC);
evidence.bootstrap.C2 = retryC;
check(
  retryC.state === 'blocked' && /：1 个/.test(retryC.detail),
  'C: with one tab left, it still refuses and counts one',
  `${describe(retryC)}; ${retryC.detail}`,
);
await tabsC[2].close();
await bootC.getByRole('button', { name: '重试' }).click();
const readyC = await settle(bootC);
evidence.bootstrap.C3 = readyC;
check(
  readyC.state === 'ready',
  'C: with every RC3 tab closed it offers 进入新版本',
  describe(readyC),
);
await bootC.getByRole('button', { name: '进入新版本' }).click();
const enteredC = await settle(bootC);
check(enteredC.state === 'entered', 'C: 进入新版本 entered the application', describe(enteredC));
await verifyEntered(bootC, 'C', EXPECTED);
await sessionC.close();

// ---------------------------------------------------------------------------------------------------
section('6. scenario D: only the browser check and a service answer are open');
const sessionD2 = await openProfile(PROFILE.D);
await sessionD2.page.goto(`${ORIGIN}/api/civic/platform`);
await sessionD2.page.waitForLoadState('load');
const runtimeTab = await sessionD2.newPage(`${ORIGIN}/api/civic/runtime`);
await runtimeTab.waitForLoadState('load');
const bootD = await sessionD2.newPage(START);
const readyD = await settle(bootD);
evidence.bootstrap.D = readyD;
check(readyD.state === 'ready', 'D: the utility pages do not block 进入新版本', describe(readyD));
const probeD = await probeWorkers(bootD);
evidence.probes.D = probeD;
const kindsD = (probeD.waiting?.windows ?? [])
  .map((w) => `${w.requester ? 'requester:' : ''}${w.kind}`)
  .sort();
check(
  stable(kindsD) === stable(['platform', 'requester:bootstrap', 'service']),
  'D: the worker classifies them as platform and service pages, and the check page as itself',
  kindsD.join(', '),
);
await bootD.getByRole('button', { name: '进入新版本' }).click();
const enteredD = await settle(bootD);
check(enteredD.state === 'entered', 'D: 进入新版本 entered the application', describe(enteredD));
await verifyEntered(bootD, 'D', EXPECTED);
await sessionD2.close();

// ---------------------------------------------------------------------------------------------------
section('7. scenario A: one tab, closed before the upgrade, reopened by the launcher');
let session = await openProfile(PROFILE.A);
let page = session.page;
await page.goto(START);
const readyA = await settle(page);
evidence.bootstrap.A = readyA;
check(
  readyA.state === 'ready',
  'A: the check page found the new version and offers 进入新版本',
  describe(readyA),
);
const probeA = await probeWorkers(page);
evidence.probes.A = probeA;
check(
  probeA.waiting?.version === 1 &&
    (probeA.waiting?.windows ?? []).length === 1 &&
    probeA.waiting.windows[0].requester === true,
  'A: the waiting worker sees the check page alone',
  JSON.stringify(probeA.waiting?.windows),
);
await page.getByRole('button', { name: '进入新版本' }).click();
const enteredA = await settle(page);
check(enteredA.state === 'entered', 'A: 进入新版本 entered the application', describe(enteredA));
await verifyEntered(page, 'A', EXPECTED);
gateCandidate('A, this release with RC3-era records', await measureGeometry(page), {
  requireBothLayouts: false,
});

// ---------------------------------------------------------------------------------------------------
section('8. schema 1 to schema 2: nothing lost, one field added');
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
section('9. new levels under an RC3 record, a format-3 backup, XLSX and DOCX');
await page.goto(`${ORIGIN}/#/work`);
await ready(page);
await addChild(page, 'RC3 时期的上级事项', '升级后添加的二级任务');
await addChild(page, '升级后添加的二级任务', '升级后添加的三级任务');
await createDatedWork(page, '升级后添加的带日期事项');
const withTree = await dumpDatabase(page);
const tree = new Map((withTree.stores.records ?? []).map((r) => [r.title, r]));
check(
  tree.get('升级后添加的三级任务')?.parentWorkId === tree.get('升级后添加的二级任务')?.id &&
    tree.get('升级后添加的二级任务')?.parentWorkId === tree.get('RC3 时期的上级事项')?.id,
  'a 2级 and a 3级 sub-task hang under the record RC3 created',
);
const v3Backup = (await exportBackup(session, page)).path;
const v3Doc = JSON.parse(readFileSync(v3Backup, 'utf8'));
check(
  v3Doc.backupFormatVersion === 3 && v3Doc.schemaVersion === 2 && v3Doc.completeness === 'complete',
  'the new backup is a complete format-3 backup of schema 2',
  `format ${v3Doc.backupFormatVersion}, schema ${v3Doc.schemaVersion}, ${v3Doc.completeness}`,
);
check(
  v3Doc.payload?.records?.length === 7,
  'it carries all seven records',
  `${v3Doc.payload?.records?.length}`,
);

await page.goto(`${ORIGIN}/#/settings`);
await ready(page);
const xlsx = await session.download(() =>
  page.getByRole('button', { name: '导出 XLSX 报表' }).first().click(),
);
const xlsxParts = zipEntryNames(xlsx.path);
check(
  readFileSync(xlsx.path).subarray(0, 2).toString('latin1') === 'PK' &&
    xlsxParts.includes('xl/workbook.xml') &&
    xlsxParts.includes('[Content_Types].xml'),
  'the XLSX export is an OOXML workbook',
  `${xlsx.name}, ${xlsxParts.length} parts`,
);
const xlsxText = xlsxParts
  .filter((n) => /^xl\/(worksheets\/sheet\d+|sharedStrings)\.xml$/.test(n))
  .map((n) => (readZipEntry(xlsx.path, n) ?? Buffer.alloc(0)).toString('utf8'))
  .join('');
check(
  ['RC3 时期的上级事项', '升级后添加的三级任务'].every((t) => xlsxText.includes(t)),
  'it lists an RC3-era record and the 3级 sub-task created after the upgrade',
);

await page.goto(`${ORIGIN}/#/reports`);
await ready(page);
const docxControl = page.getByRole('button', { name: /导出 Word 文档/ }).first();
check(
  (await docxControl.count()) > 0 && (await docxControl.isEnabled()),
  'the Word export is enabled for the current period',
);
const docx = await session.download(() => docxControl.click());
const docXml = (readZipEntry(docx.path, 'word/document.xml') ?? Buffer.alloc(0)).toString('utf8');
const periodLabel = `${new Date().getFullYear()}年${new Date().getMonth() + 1}月`;
check(
  readFileSync(docx.path).subarray(0, 2).toString('latin1') === 'PK' &&
    docXml.includes('<w:document') &&
    docXml.includes(periodLabel),
  'the DOCX export is a WordprocessingML document naming the report period',
  `${docx.name}, ${periodLabel}`,
);
const sourceRows = await dumpDatabase(page);

// ---------------------------------------------------------------------------------------------------
section('10. the format-3 backup restores exactly, into a fresh profile');
const restoreSession = await openProfile(PROFILE.restore);
const restorePage = restoreSession.page;
await restorePage.goto(START);
const firstRun = await settle(restorePage);
evidence.bootstrap.cleanProfile = firstRun;
check(
  firstRun.state === 'entered' && !firstRun.trail.some((s) => /^(ready|blocked|unknown)$/.test(s)),
  'a fresh profile is taken straight into the application, without a prompt',
  describe(firstRun),
);
await verifyEntered(restorePage, 'fresh profile', EXPECTED, { firstRun: true });
await restoreReplacing(restorePage, v3Backup);
const restored = await dumpDatabase(restorePage);
for (const store of ['records', 'progressEntries', 'categories', 'groups', 'settings']) {
  check(
    stable(sortedRows(restored.stores[store])) === stable(sortedRows(sourceRows.stores[store])),
    `the restore reproduces ${store} exactly`,
    `${(restored.stores[store] ?? []).length} row(s)`,
  );
}
await restoreSession.close();

// ---------------------------------------------------------------------------------------------------
section("11. RC3's own backup is still usable");
const rc3BackupSession = await openProfile(PROFILE.rc3Backup);
const rc3BackupPage = rc3BackupSession.page;
await rc3BackupPage.goto(START);
await settle(rc3BackupPage);
await ready(rc3BackupPage);
let rc3BackupRestored = true;
try {
  await restoreReplacing(rc3BackupPage, rc3Backup);
} catch (err) {
  rc3BackupRestored = false;
  info('restore error', String(err).split('\n')[0]);
}
const fromRc3 = byId((await dumpDatabase(rc3BackupPage)).stores.records ?? []);
check(
  rc3BackupRestored && rc3Records.every((r) => fromRc3.has(r.id)),
  "RC3's JSON backup restores into this release with every record",
  `${fromRc3.size} record(s)`,
);
check(
  [...fromRc3.values()].filter((r) => r.kind === 'work').every((r) => r.parentWorkId === null),
  'its work records arrive as top-level tasks',
);
await rc3BackupSession.close();

// ---------------------------------------------------------------------------------------------------
section('12. browser restart, program restart, offline use');
await session.close();
session = await openProfile(PROFILE.A);
page = session.page;
await page.goto(START);
const afterBrowserRestart = await settle(page);
evidence.bootstrap.browserRestart = afterBrowserRestart;
check(
  afterBrowserRestart.state === 'entered',
  'after a browser restart the check page enters directly',
  describe(afterBrowserRestart),
);
await verifyEntered(page, 'browser restart', EXPECTED);
check(
  sameDatabase(await dumpDatabase(page), sourceRows),
  'after a browser restart every store is unchanged',
);

check((await stopServer()) === 0, 'the program was stopped (civic-launch stop)');
check((await health()) === null, 'nothing answers at the origin');
const restartedHealth = await startServer(RELEASE_ID);
check(restartedHealth?.releaseId === RELEASE_ID, 'the program started again on this release');
await page.goto(START);
const afterProgramRestart = await settle(page);
evidence.bootstrap.programRestart = afterProgramRestart;
check(
  afterProgramRestart.state === 'entered',
  'after a program restart the check page enters directly',
  describe(afterProgramRestart),
);
await verifyEntered(page, 'program restart', EXPECTED);
check(
  sameDatabase(await dumpDatabase(page), sourceRows),
  'after a program restart every store is unchanged',
);

check((await stopServer()) === 0, 'the program was stopped again, to work offline');
const offline = await session.newPage(`${ORIGIN}/#/work`);
await ready(offline);
check(
  generationOf((await tabState(offline)).entry) === EXPECTED,
  'with no local server the worker still serves this release',
);
check(
  (await offline.getByRole('article', { name: '升级后添加的带日期事项' }).count()) > 0,
  'offline, the records are shown',
);
await createDatedWork(offline, '离线时添加的事项');
const offlineRows = await dumpDatabase(offline);
check(
  (offlineRows.stores.records ?? []).some((r) => r.title === '离线时添加的事项'),
  'offline, a new record is saved',
);
await offline.close();
const backOnline = await startServer(RELEASE_ID);
check(backOnline?.releaseId === RELEASE_ID, 'the program started again');

// ---------------------------------------------------------------------------------------------------
section('13. going back to RC3 is refused, and this release stays intact');
await session.close();
await stopServer();
const rollback = sh(bin('civic-admin.exe'), ['rollback', '--root', INSTALL_ROOT]);
check(
  rollback.status === 4,
  'civic-admin rollback to RC3 is refused (exit 4)',
  `code ${rollback.status}`,
);
check(/older browser-database schema/.test(rollback.stderr ?? ''), 'the refusal names the reason');
check(current() === RELEASE_ID, 'this release stays active');
const verify = sh(bin('civic-admin.exe'), [
  'verify',
  '--root',
  INSTALL_ROOT,
  '--release',
  RELEASE_ID,
  '--expect-active',
]);
check(
  verify.status === 0,
  'civic-admin verify: this release is intact and active',
  `code ${verify.status}`,
);
const status = sh(bin('civic-launch.exe'), ['status']);
check(
  new RegExp(
    `可回退版本 +: （无）上一版本 ${RC3_ID.replace(/\./g, '\\.')} 使用较旧的数据格式（第 1 版），回退可能损坏记录，已禁止`,
  ).test(status.stdout ?? ''),
  'status says RC3 is not a safe rollback target',
);
const afterRefusal = await startServer(RELEASE_ID);
check(afterRefusal?.releaseId === RELEASE_ID, 'this release serves the origin after the refusal');
session = await openProfile(PROFILE.A);
page = session.page;
await page.goto(START);
const afterRollback = await settle(page);
check(afterRollback.state === 'entered', 'the check page enters directly', describe(afterRollback));
await verifyEntered(page, 'after the refused rollback', EXPECTED);
const finalRows = await dumpDatabase(page);
check(
  finalRows.version === 20 && sameDatabase(finalRows, offlineRows),
  'the records, including the one written offline, are all still there',
  `${(finalRows.stores.records ?? []).length} record(s)`,
);
await session.close();
check(
  external.length === 0,
  'no request left the origin in any browser session',
  external.slice(0, 3).join('; ') || 'none',
);
const signedIn = Object.values(PROFILE).filter((dir) => {
  try {
    const prefs = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'));
    return (prefs.account_info ?? []).length > 0;
  } catch {
    return false;
  }
});
info(
  'profiles Edge signed in to the Windows account (sync disabled; deleted after a pass)',
  `${signedIn.length} of ${Object.keys(PROFILE).length}`,
);

// ---------------------------------------------------------------------------------------------------
section('14. summary');
const finalUninstall = await cleanSlate({ waitMs: 60_000 });
check(
  finalUninstall.code === 0 && finalUninstall.finishedByItself,
  "this release's silent uninstall finished by itself, with no dialog left waiting",
  `code ${finalUninstall.code}${finalUninstall.dismissed ? '; a message box had to be closed' : ''}`,
);
// The profiles are throwaway and may carry the Windows account's name (see openProfile). Kept only when
// something failed, for diagnosis.
if (failures === 0) rmSync(WORK, { recursive: true, force: true });
const timings = Object.entries(evidence.bootstrap).map(
  ([k, v]) => `${k}: ${v.state} after ${(v.ms / 1000).toFixed(1)} s`,
);
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
const out = join(ROOT, 'release', 'windows', `acceptance-upgrade-${RELEASE_ID}`);
writeFileSync(
  `${out}.json`,
  `${JSON.stringify({ releaseId: RELEASE_ID, ...evidence }, null, 2)}\n`,
);
writeFileSync(
  `${out}.txt`,
  [
    `CivicWorkDesk Windows RC3 -> ${IDENTITY.displayVersion} upgrade acceptance`,
    '',
    `release under test : ${RELEASE_ID}`,
    `installed interface: ${EXPECTED}`,
    `RC3 interface      : ${RC3_GENERATION}`,
    `RC3 installer      : ${rc3.sha256} (${rc3.source})`,
    `browser            : Microsoft Edge ${edgeVersion}, persistent profiles, classic scrollbars`,
    `update check page  : ${START}`,
    `check page timings : ${timings.join('; ')}`,
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
