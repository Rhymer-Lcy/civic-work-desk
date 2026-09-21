import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

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
    await confirm.getByRole('textbox').fill('替换');
    await confirm.getByRole('button', { name: '确认替换' }).click();
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
});
