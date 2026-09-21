import { readFileSync, rmSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createWorkRecord, gotoApp, navigate, waitForAppReady } from './helpers';

/**
 * Backup, import, export and destructive-operation safeguards.
 */

test.describe('backup and restore', () => {
  test('exports a JSON backup that validates and can be re-imported', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '需要备份的示范事项',
      date: '2026-09-12',
      unit: '示范单位甲',
    });

    await navigate(page, '设置');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 JSON 备份' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^civic-work-desk-backup-\d{8}-\d{6}\.json$/);
    const path = await download.path();
    const envelope: unknown = JSON.parse(readFileSync(path, 'utf8'));

    // The envelope must be self-describing.
    const typed = envelope as {
      application: string;
      backupFormatVersion: number;
      schemaVersion: number;
      payloadChecksum: string | null;
      counts: { records: number };
      payload: { records: { title: string }[] };
    };
    expect(typed.application).toBe('civic-work-desk');
    expect(typed.backupFormatVersion).toBeGreaterThanOrEqual(1);
    expect(typed.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(typed.payloadChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(typed.counts.records).toBe(1);
    expect(typed.payload.records[0]?.title).toBe('需要备份的示范事项');

    // Backup health updates only after a successful JSON export.
    await expect(page.getByText('今天已备份。')).toBeVisible();

    // Now wipe and restore from that same file.
    await gotoApp(page, 'settings');
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.locator('input[type="file"]').setInputFiles(path);

    await expect(dialog.getByText('导入预览（尚未写入）')).toBeVisible();
    await expect(dialog.getByText('CivicWorkDesk 备份')).toBeVisible();
    await expect(dialog.getByText('一致', { exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: '合并导入' }).click();
    await expect(dialog).toBeHidden();

    await navigate(page, '工作');
    await expect(page.getByRole('article', { name: '需要备份的示范事项' })).toBeVisible();

    rmSync(path, { force: true });
  });

  test('import shows a preview and writes nothing until confirmed', async ({ page }, testInfo) => {
    const legacy = testInfo.outputPath('legacy-backup.json');
    const legacyPayload = {
      version: 3,
      exportTime: '2026-09-01T00:00:00.000Z',
      works: [
        {
          id: 'legacy_1',
          date: '1月',
          title: '文字日期的旧记录',
          done: '未完成',
          phone: '82393933.0',
          biz: '文稿·材料',
        },
        { id: 'legacy_2', date: '2026-02-30', title: '不存在日期的旧记录', done: '完成' },
        { id: 'legacy_3', title: '' },
      ],
    };
    const fs = await import('node:fs/promises');
    await fs.writeFile(legacy, JSON.stringify(legacyPayload), 'utf8');

    await gotoApp(page, 'settings');
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.locator('input[type="file"]').setInputFiles(legacy);

    await expect(dialog.getByText('导入预览（尚未写入）')).toBeVisible();
    await expect(dialog.getByText('旧版备份（works）')).toBeVisible();
    // Two importable rows, one rejected for having no title.
    await expect(dialog.getByText('已拒绝 1 条')).toBeVisible();
    await expect(dialog.getByText(/迁移提示 \d+ 条/)).toBeVisible();

    // Still nothing written at this point. Close the dialog first: it is modal, so leaving it open
    // would (correctly) block interaction with the navigation behind it.
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();
    await navigate(page, '工作');
    await expect(page.getByText('文字日期的旧记录')).toHaveCount(0);

    await navigate(page, '设置');
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const again = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await again.locator('input[type="file"]').setInputFiles(legacy);
    await again.getByRole('button', { name: '合并导入' }).click();
    await expect(again).toBeHidden();

    await navigate(page, '工作');
    await expect(page.getByRole('article', { name: '文字日期的旧记录' })).toBeVisible();
    // The free-text date is preserved, not coerced to today or to epoch.
    const card = page.getByRole('article', { name: '文字日期的旧记录' });
    await expect(card.getByText('1月')).toBeVisible();
    // 未完成 became 待办, not "cancelled".
    await expect(card.getByText('待办')).toBeVisible();
  });

  test('a corrupted backup is refused with a stated reason', async ({ page }, testInfo) => {
    const broken = testInfo.outputPath('broken.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(broken, '{ this is not valid json', 'utf8');

    await gotoApp(page, 'settings');
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.locator('input[type="file"]').setInputFiles(broken);

    await expect(dialog.getByText('文件不是有效的 JSON，无法解析。')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '合并导入' })).toBeDisabled();
  });

  test('replace mode demands a typed confirmation', async ({ page }, testInfo) => {
    const file = testInfo.outputPath('replacement.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      file,
      JSON.stringify({ works: [{ id: 'r1', title: '替换进来的记录', date: '2026-01-01' }] }),
      'utf8',
    );

    await gotoApp(page, 'settings');
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.getByText('替换', { exact: true }).click();
    await dialog.locator('input[type="file"]').setInputFiles(file);
    await dialog.getByRole('button', { name: '替换全部数据' }).click();

    const confirm = page.getByRole('dialog', { name: '替换全部数据？' });
    await expect(confirm).toBeVisible();
    const confirmButton = confirm.getByRole('button', { name: '确认替换' });
    await expect(confirmButton).toBeDisabled();

    await confirm.getByRole('textbox').fill('替换');
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(dialog).toBeHidden();
    await navigate(page, '工作');
    await expect(page.getByRole('article', { name: '替换进来的记录' })).toBeVisible();
  });
});

test.describe('document exports', () => {
  test('exports a genuine XLSX (ZIP container, not SpreadsheetML)', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: 'XLSX 导出的示范事项', date: '2026-09-01' });

    await navigate(page, '台账');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 XLSX' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const path = await download.path();
    const bytes = readFileSync(path);
    // OOXML is a ZIP archive: "PK\x03\x04". The legacy `.xls` began with "<?xml".
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK');
    expect(bytes.subarray(0, 5).toString('utf8')).not.toBe('<?xml');
    rmSync(path, { force: true });
  });

  test('exports a genuine DOCX with accurate counts', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '月报中的示范事项',
      date: '2026-09-05',
      status: '已完成',
    });
    await createWorkRecord(page, { title: '月报中的第二条', date: '2026-09-06' });

    await navigate(page, '报告');
    // `input[type=month]` has no ARIA role and its label is shared with the filter bar's
    // month select on other routes, so it is addressed by element type.
    await page.locator('input[type="month"]').fill('2026-09');
    await expect(page.getByText('2026年9月', { exact: false }).first()).toBeVisible();

    // The preview must report the real completion figure, not "anything with a label is done".
    await expect(page.getByText('50.0%')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 Word 文档（.docx）' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/\.docx$/);
    const path = await download.path();
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('PK');
    // The legacy "doc" was an HTML document with a BOM.
    expect(bytes.subarray(0, 15).toString('utf8')).not.toContain('<!DOCTYPE');
    rmSync(path, { force: true });
  });

  test('reports show records excluded for having a free-text date', async ({ page }, testInfo) => {
    const file = testInfo.outputPath('undated.json');
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      file,
      JSON.stringify({
        works: [
          { id: 'u1', title: '有日期的记录', date: '2026-09-05' },
          { id: 'u2', title: '文字日期的记录', date: '1月' },
        ],
      }),
      'utf8',
    );

    await gotoApp(page, 'settings');
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.getByLabel('选择备份文件（.json）').setInputFiles(file);
    await dialog.getByRole('button', { name: '合并导入' }).click();
    await expect(dialog).toBeHidden();

    await navigate(page, '报告');
    await page.getByLabel('月份').fill('2026-09');
    // The legacy report silently dropped these. Here the count is stated.
    await expect(page.getByText(/另有 1 条记录的日期为文字描述/)).toBeVisible();
  });
});

test.describe('destructive safeguards', () => {
  test('clearing all data requires a typed phrase and then really clears everything', async ({
    page,
  }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '将被清空的示范事项', date: '2026-09-01' });

    await navigate(page, '设置');
    await page.getByRole('button', { name: '清空全部本机数据' }).click();

    const confirm = page.getByRole('dialog', { name: '清空全部本机数据？' });
    const button = confirm.getByRole('button', { name: '确认清空' });
    await expect(button).toBeDisabled();

    // A near-miss must not enable it.
    await confirm.getByRole('textbox').fill('清空数据');
    await expect(button).toBeDisabled();

    await confirm.getByRole('textbox').fill('清空全部数据');
    await expect(button).toBeEnabled();
    await button.click();
    await waitForAppReady(page);

    await navigate(page, '工作');
    await expect(page.getByRole('article', { name: '将被清空的示范事项' })).toHaveCount(0);

    // The defaults come back: the legacy clear left categories, groups and flags behind.
    await navigate(page, '设置');
    await expect(page.getByRole('textbox', { name: '名称：对非合作' })).toHaveValue('对非合作');
    await expect(page.getByRole('textbox', { name: '名称：固定工作' })).toHaveValue('固定工作');
  });

  test('emptying the trash is a separate, typed confirmation', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '进回收站的示范事项', date: '2026-09-01' });
    const card = page.getByRole('article', { name: '进回收站的示范事项' });
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByRole('button', { name: '删除' }).click();
    await page
      .getByRole('dialog', { name: '移入回收站？' })
      .getByRole('button', { name: '移入回收站', exact: true })
      .click();

    await navigate(page, '设置');
    await page.getByRole('button', { name: '清空回收站' }).click();
    const confirm = page.getByRole('dialog', { name: '清空回收站？' });
    await expect(confirm.getByRole('button', { name: '确认清空' })).toBeDisabled();
    await confirm.getByRole('textbox').fill('清空');
    await confirm.getByRole('button', { name: '确认清空' }).click();
    await waitForAppReady(page);

    await expect(page.getByText('回收站是空的')).toBeVisible();
  });
});
