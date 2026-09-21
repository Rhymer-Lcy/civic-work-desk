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
      completeness: string;
      omittedInvalidRowIds: string[];
      dataRevision: number | null;
      checksum: { algorithm: string; scope: string; value: string | null };
      counts: { records: number };
      payload: { records: { title: string }[] };
    };
    expect(typed.application).toBe('civic-work-desk');
    expect(typed.backupFormatVersion).toBeGreaterThanOrEqual(1);
    expect(typed.schemaVersion).toBeGreaterThanOrEqual(1);
    // v3: the digest covers the whole envelope, and the file states its own completeness.
    expect(typed.checksum.algorithm).toBe('sha-256');
    expect(typed.checksum.scope).toBe('envelope');
    expect(typed.checksum.value).toMatch(/^[0-9a-f]{64}$/);
    expect(typed.completeness).toBe('complete');
    expect(typed.omittedInvalidRowIds).toEqual([]);
    expect(typed.dataRevision).toBeGreaterThan(0);
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
    // Target the value cells of the preview's definition list, not bare strings: the strategy
    // description names the format too, so an unscoped text match resolves to two elements.
    const values = dialog.getByRole('definition');
    await expect(values.filter({ hasText: 'CivicWorkDesk 备份' })).toHaveCount(1);
    // Anchored, because '不一致' contains '一致'.
    await expect(values.filter({ hasText: /^一致$/ })).toHaveCount(1);

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
    // With no plan there is nothing to name, so the button reads 导入 and is disabled. Phase 1.1
    // labelled it 合并导入 even when no file had parsed.
    await expect(dialog.getByRole('button', { name: '导入', exact: true })).toBeDisabled();
  });

  test('an incomplete archive is refused for exact restore, and merge is offered instead', async ({
    page,
  }) => {
    /*
     * Phase 1.1 wrote `omittedInvalidRowIds` into the file and then never consulted it, so an archive
     * that declared itself incomplete was still offered as 完整还原. This drives the whole flow through
     * the real UI: build the file the way the product does (corrupt a row, acknowledge the omission),
     * then try to restore it.
     */
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '不完整备份用的示范事项', date: '2026-09-12' });

    // Plant a corrupt row directly in IndexedDB — the only way to reproduce corruption honestly.
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('civic-work-desk');
        open.onerror = () => {
          reject(new Error('open failed'));
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put({ id: 'corrupt-row', kind: 'work', title: 7 });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            reject(new Error('write failed'));
          };
        };
      });
    });

    await navigate(page, '设置');
    await page.reload();
    await waitForAppReady(page);

    // The diagnostics panel must name the damage, per store.
    await expect(page.getByText('1 行数据未通过结构校验')).toBeVisible();

    // Exporting must refuse first, then allow a knowing export that declares itself incomplete.
    await page.getByRole('button', { name: '导出 JSON 备份' }).click();
    await expect(page.getByText('无法生成完整备份。')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '仍要导出（将缺少这些行）' }).click();
    const download = await downloadPromise;
    const incompletePath = await download.path();

    const envelope = JSON.parse(readFileSync(incompletePath, 'utf8')) as {
      completeness: string;
      omittedInvalidRowIds: string[];
    };
    expect(envelope.completeness).toBe('incomplete');
    expect(envelope.omittedInvalidRowIds).toEqual(['corrupt-row']);

    // Now try to use it as an exact restore source.
    await page.getByRole('button', { name: '导入 / 还原备份' }).click();
    const dialog = page.getByRole('dialog', { name: '导入 / 还原备份' });
    await dialog.getByRole('radio', { name: '替换 / 还原' }).check();
    await dialog.locator('input[type="file"]').setInputFiles(incompletePath);
    await expect(dialog.getByText('导入预览（尚未写入）')).toBeVisible();

    // The preview states completeness, the button refuses to call it 完整还原, and it is disabled.
    await expect(dialog.getByText('不完整（不能用于完整还原）')).toBeVisible();
    // Exact, because getByRole name matching is substring-based and 无法完整还原 contains 完整还原.
    await expect(dialog.getByRole('button', { name: '完整还原', exact: true })).toHaveCount(0);
    const refused = dialog.getByRole('button', { name: '无法完整还原' });
    await expect(refused).toBeVisible();
    await expect(refused).toBeDisabled();
    await expect(dialog.getByText(/无法用于“完整还原”/)).toBeVisible();

    /*
     * Merge of the same file is NOT blocked: the incompleteness refusal is specific to exact restore.
     * This particular file happens to add nothing — every record in it is already in the destination,
     * because it was exported from this very database — so the button is disabled for the ordinary
     * "nothing to write" reason rather than for a completeness reason. What must be true is that the
     * completeness refusal is gone and the operation is named as a merge.
     */
    await dialog.getByRole('radio', { name: '合并' }).first().check();
    await dialog.locator('input[type="file"]').setInputFiles(incompletePath);
    await expect(dialog.getByText('导入预览（尚未写入）')).toBeVisible();
    await expect(dialog.getByText(/无法用于“完整还原”/)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '合并导入' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '无法完整还原' })).toHaveCount(0);
  });

  test('an incomplete export does not silence the backup reminder', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '备份提醒用的示范事项', date: '2026-09-12' });

    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('civic-work-desk');
        open.onerror = () => {
          reject(new Error('open failed'));
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('records', 'readwrite');
          tx.objectStore('records').put({ id: 'corrupt-row', kind: 'work', title: 7 });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            reject(new Error('write failed'));
          };
        };
      });
    });

    await navigate(page, '设置');
    await page.reload();
    await waitForAppReady(page);

    await page.getByRole('button', { name: '导出 JSON 备份' }).click();
    await expect(page.getByText('无法生成完整备份。')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '仍要导出（将缺少这些行）' }).click();
    await downloadPromise;

    /*
     * Phase 1.1 recorded this as a successful backup and the panel switched to 今天已备份。 A file the
     * application itself calls incomplete must not establish freshness.
     */
    await expect(page.getByText('今天已备份。')).toHaveCount(0);
    await expect(page.getByText('尚未导出过 JSON 备份。')).toBeVisible();
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
    await dialog.getByRole('radio', { name: '替换 / 还原' }).check();
    await dialog.locator('input[type="file"]').setInputFiles(file);
    // The button names the strategy the file actually resolves to. A legacy `works` file carries
    // no categories, groups or settings, so it is a record-and-progress replacement and must not
    // be offered as 完整还原.
    await expect(dialog.getByRole('button', { name: '完整还原' })).toHaveCount(0);
    await dialog.getByRole('button', { name: '替换记录与进展' }).click();

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
