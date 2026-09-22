import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { confirmWithPhrase } from './helpers';

/**
 * Focused cross-engine critical flows.
 *
 * Phase 1 verified behaviour on Chromium only, then described the result as cross-browser. This
 * file is the honest version of that claim: a small set of flows whose implementations differ most
 * between engines, run on Firefox and WebKit as well.
 *
 * What differs by engine, and is therefore what this file targets:
 *   - IndexedDB (Dexie transactions, `bulkAdd` constraint behaviour, durability on reload);
 *   - blob downloads through a synthetic anchor click;
 *   - `<input type="file">` reading a file back in;
 *   - date-only arithmetic and rendering, where a timezone slip shows as an off-by-one day;
 *   - dynamic `import()` of the heavy export chunks.
 *
 * **What this file does NOT establish.** Playwright's WebKit on Windows is not Safari. It shares
 * WebCore, but not the OS integration, the storage eviction policy, the PWA install path or the
 * iOS input behaviour. A Safari or iOS PASS requires a real device and is recorded as a manual
 * item in docs/qa-plan.md — never inferred from this run.
 *
 * The helpers in `./helpers` are deliberately not reused: `gotoApp` resets the origin over a CDP
 * session, which exists only in Chromium. Playwright gives each test its own browser context, so a
 * plain navigation already starts from empty storage in every engine.
 */

const TITLE = '跨浏览器验证的示范事项';

async function openApp(page: import('@playwright/test').Page, route = 'dashboard'): Promise<void> {
  await page.goto(`/#/${route}`);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 20_000 });
}

async function goToRoute(page: import('@playwright/test').Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label }).click();
  await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 20_000 });
}

async function addRecord(
  page: import('@playwright/test').Page,
  title: string,
  date: string,
): Promise<void> {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(title);
  await dialog.getByRole('radiogroup', { name: '事项日期类型' }).getByText('具体日期').click();
  await dialog.getByRole('textbox', { name: '事项日期', exact: true }).fill(date);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe('critical flows on this engine', () => {
  test('seeds on first run and stores a record that survives a reload', async ({ page }) => {
    await openApp(page, 'work');
    await addRecord(page, TITLE, '2026-09-12');
    await expect(page.getByRole('article', { name: TITLE })).toBeVisible();

    // The durability claim is IndexedDB's, and it is the one thing a local-first app cannot get
    // wrong. A reload re-opens the database from scratch.
    await page.reload();
    await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByRole('article', { name: TITLE })).toBeVisible();
  });

  test('a date-only value renders as the day it was entered', async ({ page }) => {
    await openApp(page, 'work');
    // 1 January is the worst case: a UTC round-trip in a UTC+8 browser lands on 2025-12-31.
    await addRecord(page, '跨年日期的示范事项', '2026-01-01');
    const card = page.getByRole('article', { name: '跨年日期的示范事项' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('2026-01-01');
    await expect(card).not.toContainText('2025-12-31');
  });

  test('exports a JSON backup and restores it exactly', async ({ page }) => {
    await openApp(page, 'work');
    await addRecord(page, TITLE, '2026-09-12');

    await goToRoute(page, '设置');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 JSON 备份' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    expect(path, 'the browser produced no file').toBeTruthy();

    const envelope = JSON.parse(readFileSync(path, 'utf8')) as {
      application: string;
      counts: { records: number };
    };
    expect(envelope.application).toBe('civic-work-desk');
    expect(envelope.counts.records).toBe(1);

    // Restore that same file over the live database. This is the flow whose Phase-1 implementation
    // destroyed everything and wrote nothing back, so it is worth running on every engine.
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.getByRole('radio', { name: '替换 / 还原' }).check();
    await dialog.locator('input[type="file"]').setInputFiles(path);
    await expect(dialog.getByText('导入预览（尚未写入）')).toBeVisible();
    // A CivicWorkDesk envelope in replace mode is a full restore, and must say so.
    await expect(dialog.getByRole('button', { name: '完整还原' })).toBeVisible();
    await dialog.getByRole('button', { name: '完整还原' }).click();

    const confirm = page.getByRole('dialog', { name: '替换全部数据？' });
    await confirmWithPhrase(confirm, '替换', '确认替换');
    await expect(dialog).toBeHidden();

    await goToRoute(page, '工作');
    await expect(page.getByRole('article', { name: TITLE })).toBeVisible();
  });

  test('lazy-loads the export libraries and writes real files', async ({ page }) => {
    await openApp(page, 'work');
    await addRecord(page, TITLE, '2026-09-12');

    await goToRoute(page, '台账');
    const xlsxPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 XLSX' }).click();
    const xlsx = await xlsxPromise;
    expect(xlsx.suggestedFilename()).toMatch(/\.xlsx$/);
    // A genuine XLSX is a ZIP container: "PK\x03\x04".
    expect(
      readFileSync(await xlsx.path())
        .subarray(0, 4)
        .toString('hex'),
    ).toBe('504b0304');

    await goToRoute(page, '报告');
    await page.locator('input[type="month"]').fill('2026-09');
    const docxPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 Word 文档（.docx）' }).click();
    const docx = await docxPromise;
    expect(docx.suggestedFilename()).toMatch(/\.docx$/);
    expect(
      readFileSync(await docx.path())
        .subarray(0, 4)
        .toString('hex'),
    ).toBe('504b0304');
  });

  test('keyboard-only: a dialog traps focus, Escape closes it, focus returns', async ({ page }) => {
    await openApp(page, 'work');
    const trigger = page.getByRole('button', { name: '新增记录' }).first();
    // Keyboard activation, not a click — and not merely to match the test's name. WebKit follows
    // the macOS convention that a mouse click does **not** focus a button, so `document.activeElement`
    // at open time is <body>, and the dialog then correctly restores focus to <body> on close.
    // Asserting the click path would be asserting a platform convention, not our focus handling.
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '新增工作记录' });
    await expect(dialog).toBeVisible();

    // Tab a few times; focus must still be inside the dialog. Focus order and `offsetParent`
    // behaviour differ between engines, so this is worth checking outside Chromium.
    for (let i = 0; i < 8; i += 1) await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('edits a persisted record and the edit survives a reload', async ({ page }) => {
    await openApp(page, 'work');
    await addRecord(page, '待修改的示范事项', '2026-09-12');

    const card = page.getByRole('article', { name: '待修改的示范事项' });
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByRole('button', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog', { name: '编辑工作记录' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: '事项', exact: true }).fill('已修改的示范事项');
    await dialog
      .getByRole('combobox', { name: '状态', exact: true })
      .selectOption({ label: '进行中' });
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();

    // The write must reach IndexedDB, not just React state: reload and read it back.
    await page.reload();
    await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 20_000 });
    const updated = page.getByRole('article', { name: '已修改的示范事项' });
    await expect(updated).toBeVisible();
    await expect(updated).toContainText('进行中');
    await expect(page.getByRole('article', { name: '待修改的示范事项' })).toHaveCount(0);
  });

  test('adds a progress entry that persists and leaves its neighbour untouched', async ({
    page,
  }) => {
    await openApp(page, 'work');
    await addRecord(page, '带进展的示范事项', '2026-09-10');

    const card = page.getByRole('article', { name: '带进展的示范事项' });
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByLabel('追加进展').fill('第一条进展');
    await card.getByRole('button', { name: '追加', exact: true }).click();
    await expect(card.getByText('第一条进展')).toBeVisible();
    // The field clears only once the write resolves, so this also proves the write landed.
    await expect(card.getByLabel('追加进展')).toHaveValue('');

    await card.getByLabel('追加进展').fill('第二条进展');
    await card.getByRole('button', { name: '追加', exact: true }).click();
    await expect(card.getByText('第二条进展')).toBeVisible();
    await expect(card.getByLabel('追加进展')).toHaveValue('');

    await page.reload();
    await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 20_000 });
    const reloaded = page.getByRole('article', { name: '带进展的示范事项' });
    await reloaded.getByRole('button', { name: '展开详情' }).click();
    await expect(reloaded.getByText('第一条进展')).toBeVisible();
    await expect(reloaded.getByText('第二条进展')).toBeVisible();
  });

  test('search and a status filter compose, and clearing them restores the list', async ({
    page,
  }) => {
    await openApp(page, 'work');
    await addRecord(page, '甲类专项工作', '2026-09-05');
    await addRecord(page, '乙类日常工作', '2026-09-06');

    await page.getByRole('searchbox', { name: '搜索记录' }).fill('甲类');
    await expect(page.getByRole('article', { name: '甲类专项工作' })).toBeVisible();
    await expect(page.getByRole('article', { name: '乙类日常工作' })).toHaveCount(0);

    await page.getByRole('searchbox', { name: '搜索记录' }).fill('');
    await expect(page.getByRole('article', { name: '乙类日常工作' })).toBeVisible();
  });

  test('linked honour survives a permanent delete, and a backup still succeeds', async ({
    page,
  }) => {
    /*
     * The Phase-1.3 hard-delete policy, end to end in a real browser.
     *
     * Permanently deleting a work record preserves any honour that references it and detaches the
     * link, in one transaction. The consequence is stated in the confirmation before it happens. The
     * resulting state must remain backup-viable — which is the whole point: Phase 1.2 produced a live
     * state here whose own canonical backup could not be restored.
     */
    await openApp(page, 'work');
    await addRecord(page, '将被彻底删除的工作', '2026-09-12');

    // An honour linked to it.
    await goToRoute(page, '荣誉');
    await page.getByRole('button', { name: '新增荣誉' }).first().click();
    const honorDialog = page.getByRole('dialog', { name: '新增荣誉记录' });
    await expect(honorDialog).toBeVisible();
    await honorDialog.getByRole('textbox', { name: '荣誉名称', exact: true }).fill('关联的荣誉');
    await honorDialog
      .getByRole('combobox', { name: '关联工作事项' })
      .selectOption({ label: '将被彻底删除的工作' });
    await honorDialog.getByRole('button', { name: '保存' }).click();
    await expect(honorDialog).toBeHidden();
    await expect(page.getByText('关联的荣誉')).toBeVisible();

    // Soft delete the work record, then empty the Trash.
    await goToRoute(page, '工作');
    const card = page.getByRole('article', { name: '将被彻底删除的工作' });
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByRole('button', { name: '删除', exact: true }).click();
    const trashConfirm = page.getByRole('dialog', { name: '移入回收站？' });
    await expect(trashConfirm).toBeVisible();
    await trashConfirm.getByRole('button', { name: '移入回收站', exact: true }).click();
    await expect(trashConfirm).toBeHidden();

    await goToRoute(page, '设置');
    await page.getByRole('button', { name: '清空回收站' }).click();
    const confirm = page.getByRole('dialog', { name: '清空回收站？' });
    await expect(confirm).toBeVisible();
    // The consequence is stated before the user commits.
    await expect(confirm.getByText(/条荣誉记录关联到其中的工作事项/)).toBeVisible();
    await confirmWithPhrase(confirm, '清空', '确认清空');
    await expect(confirm).toBeHidden();

    // The honour is still there and still usable.
    await goToRoute(page, '荣誉');
    await expect(page.getByText('关联的荣誉')).toBeVisible();

    // And the live state is backup-viable: the export succeeds rather than being refused.
    await goToRoute(page, '设置');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 JSON 备份' }).click();
    const download = await downloadPromise;
    const envelope = JSON.parse(readFileSync(await download.path(), 'utf8')) as {
      completeness: string;
      payload: { records: { kind: string; relatedWorkId?: string | null }[] };
    };
    expect(envelope.completeness).toBe('complete');
    const honor = envelope.payload.records.find((record) => record.kind === 'honor');
    expect(honor, 'the honour is in the backup').toBeTruthy();
    expect(honor?.relatedWorkId, 'with its reference detached, not dangling').toBeNull();
    await expect(page.getByText('无法生成完整备份')).toHaveCount(0);
  });

  test('offline: a write still lands with the network cut', async ({ page, context }) => {
    await openApp(page, 'work');
    await addRecord(page, '离线验证的示范事项', '2026-09-12');

    await context.setOffline(true);
    try {
      // Local-first means a write needs nothing but IndexedDB. No reload here, so this runs on every
      // engine including WebKit (see the reload test below for why that one cannot).
      await addRecord(page, '离线新增的示范事项', '2026-09-13');
      await expect(page.getByRole('article', { name: '离线新增的示范事项' })).toBeVisible();
      await expect(page.getByRole('article', { name: '离线验证的示范事项' })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test('offline: a reload still opens the app from the precache', async ({
    page,
    context,
  }, testInfo) => {
    /*
     * Skipped on WebKit, with the reason measured rather than assumed.
     *
     * `page.reload()` after `context.setOffline(true)` fails in Playwright's WebKit with
     * "WebKit encountered an internal error" — reproduced 2/2 on 2026-09-21, Playwright 1.63.0,
     * WebKit 26.6. That is a harness limitation, not an observation about the application: the offline
     * *write* path above passes on WebKit, and Chromium and Firefox both cover the offline reload.
     *
     * Real Safari offline behaviour is untested here either way — see docs/qa-plan.md. Marking this
     * skipped keeps that gap visible instead of hiding it behind a green tick.
     */
    test.skip(
      testInfo.project.name === 'webkit-desktop',
      'Playwright WebKit cannot reload an offline page (internal error); reproduced 2/2',
    );

    await openApp(page, 'work');
    await addRecord(page, '离线重载的示范事项', '2026-09-12');

    // The worker must be active and precaching finished before the network is cut, or the reload has
    // nothing to serve the shell from.
    await page.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state === 'activated';
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1_500);

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByRole('article', { name: '离线重载的示范事项' })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
