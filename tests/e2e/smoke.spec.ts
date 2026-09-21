import { expect, test } from '@playwright/test';
import { createWorkRecord, gotoApp, navigate } from './helpers';

test.describe('first run and core record flows', () => {
  test('fresh install seeds itself and shows an honest empty state', async ({ page }) => {
    await gotoApp(page);
    await expect(page.getByRole('heading', { name: '概览', level: 1 })).toBeVisible();
    await expect(page.getByText('近期没有逾期或临近到期的事项')).toBeVisible();

    // A brand-new install has nothing to lose, so it must not nag about backups.
    await expect(page.getByText('尚未导出过 JSON 备份')).toHaveCount(0);

    await navigate(page, '设置');
    await expect(page.getByText('全部记录通过结构校验')).toBeVisible();
    await expect(page.getByText('回收站是空的')).toBeVisible();
  });

  test('creates, edits and completes a work record', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '报送示范工作要点',
      date: '2026-09-15',
      requirement: '上报反馈意见',
      unit: '示范单位甲',
    });

    const card = page.getByRole('article', { name: '报送示范工作要点' });
    await expect(card).toBeVisible();
    await expect(card.getByText('待办')).toBeVisible();
    await expect(card.getByText('示范单位甲')).toBeVisible();

    // Edit it.
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByRole('button', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog', { name: '编辑工作记录' });
    await dialog
      .getByRole('combobox', { name: '状态', exact: true })
      .selectOption({ label: '已完成' });
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect(
      page.getByRole('article', { name: '报送示范工作要点' }).getByText('已完成'),
    ).toBeVisible();
  });

  test('adds and edits progress entries on a record', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '带进展的示范事项', date: '2026-09-10' });

    const card = page.getByRole('article', { name: '带进展的示范事项' });
    await card.getByRole('button', { name: '展开详情' }).click();

    await card.getByLabel('追加进展').fill('已联系相关单位收集材料');
    await card.getByRole('button', { name: '追加', exact: true }).click();
    await expect(card.getByText('已联系相关单位收集材料')).toBeVisible();
    // The field is cleared only once the write resolves. Typing before that gets overwritten by
    // the clear, which leaves the add button disabled.
    await expect(card.getByLabel('追加进展')).toHaveValue('');

    await card.getByLabel('追加进展').fill('初稿完成');
    await card.getByRole('button', { name: '追加', exact: true }).click();
    await expect(card.getByText('初稿完成')).toBeVisible();
    await expect(card.getByLabel('追加进展')).toHaveValue('');

    // Edit the first entry and check the second is untouched — the legacy index-addressed
    // implementation could write to the wrong row here.
    await card.getByRole('button', { name: /编辑进展：已联系相关单位收集材料/ }).click();
    await card.getByLabel('编辑进展内容').fill('已联系相关单位收集材料（已修订）');
    await card.getByRole('button', { name: '保存', exact: true }).click();
    await expect(card.getByText('已联系相关单位收集材料（已修订）')).toBeVisible();
    await expect(card.getByText('初稿完成')).toBeVisible();
  });

  test('long-term work stays visible and completion wins over the long-term flag', async ({
    page,
  }) => {
    await gotoApp(page, 'work');
    await page.getByRole('button', { name: '新增记录' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新增工作记录' });
    await dialog.getByRole('textbox', { name: '事项', exact: true }).fill('长期推进的示范专项');
    await dialog.getByRole('checkbox', { name: '长期推进事项' }).check();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();

    // A long-term item with no deadline must still be surfaced for follow-up.
    await navigate(page, '概览');
    await expect(page.getByText('长期推进的示范专项')).toBeVisible();

    // Complete it: the badge must read 已完成, not 长期推进.
    await navigate(page, '工作');
    const card = page.getByRole('article', { name: '长期推进的示范专项' });
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByRole('button', { name: '编辑' }).click();
    const edit = page.getByRole('dialog', { name: '编辑工作记录' });
    await edit
      .getByRole('combobox', { name: '状态', exact: true })
      .selectOption({ label: '已完成' });
    await edit.getByRole('button', { name: '保存', exact: true }).click();
    await expect(edit).toBeHidden();

    const updated = page.getByRole('article', { name: '长期推进的示范专项' });
    await expect(updated.getByText('已完成')).toBeVisible();
    await navigate(page, '概览');
    await expect(page.getByText('长期推进的示范专项')).toHaveCount(0);
  });

  test('creates an honour and links it to a work record', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '被关联的示范工作', date: '2026-05-01' });

    await navigate(page, '荣誉');
    await page.getByRole('button', { name: '新增荣誉' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新增荣誉记录' });
    await dialog.getByRole('textbox', { name: '荣誉名称', exact: true }).fill('示范工作感谢信');
    await dialog
      .getByRole('combobox', { name: '级别', exact: true })
      .selectOption({ label: '省级' });
    await dialog
      .getByRole('combobox', { name: '荣誉类型', exact: true })
      .selectOption({ label: '感谢信' });
    await dialog.getByRole('textbox', { name: '授予单位', exact: true }).fill('示范上级机关');
    await dialog
      .getByRole('textbox', { name: '文号 / 编号', exact: true })
      .fill('示范函〔2026〕1号');
    await dialog
      .getByRole('combobox', { name: '关联工作事项', exact: true })
      .selectOption({ label: '被关联的示范工作' });
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByText('示范工作感谢信')).toBeVisible();
    await expect(page.getByText('示范函〔2026〕1号')).toBeVisible();
    await expect(page.getByText('被关联的示范工作')).toBeVisible();
  });

  test('search and filters compose and can be cleared together', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '甲类示范事项', date: '2026-03-05', unit: '单位甲' });
    await createWorkRecord(page, { title: '乙类示范事项', date: '2026-09-20', unit: '单位乙' });

    await page.getByRole('searchbox', { name: '搜索记录' }).fill('甲类');
    await expect(page.getByRole('article', { name: '甲类示范事项' })).toBeVisible();
    await expect(page.getByRole('article', { name: '乙类示范事项' })).toHaveCount(0);

    // Composing a second filter narrows rather than resetting the first.
    await page.getByRole('combobox', { name: '年份', exact: true }).selectOption('2026');
    await expect(page.getByRole('article', { name: '甲类示范事项' })).toBeVisible();

    // Active filters are shown as removable chips.
    await expect(page.getByRole('button', { name: /搜索：甲类/ })).toBeVisible();
    await page.getByRole('button', { name: '清除全部筛选' }).click();
    await expect(page.getByRole('article', { name: '甲类示范事项' })).toBeVisible();
    await expect(page.getByRole('article', { name: '乙类示范事项' })).toBeVisible();
  });

  test('calendar selects a day and filters the dashboard', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '日历上的示范事项', date: '2026-09-15' });

    await navigate(page, '概览');
    // Anchored: the "clear date filter" button also contains the date.
    const day = page.getByRole('button', { name: /^2026-09-15/ });
    await day.click();
    await expect(page.getByRole('heading', { name: '2026-09-15 的记录' })).toBeVisible();
    await expect(page.getByText('日历上的示范事项')).toBeVisible();
    await expect(day).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: /清除日期筛选/ }).click();
    await expect(page.getByRole('heading', { name: '2026-09-15 的记录' })).toHaveCount(0);
  });

  test('ledger shows the record and keeps the page free of horizontal overflow', async ({
    page,
  }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '台账中的示范事项', date: '2026-07-07', unit: '单位丙' });

    await navigate(page, '台账');
    // This spec runs at desktop AND phone widths, where the ledger deliberately renders as a table
    // and as a card list respectively, so the assertion targets the record rather than the markup.
    await expect(page.getByText('台账中的示范事项').first()).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('deleting a record is recoverable from the trash', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '将被删除的示范事项', date: '2026-08-08' });

    const card = page.getByRole('article', { name: '将被删除的示范事项' });
    await card.getByRole('button', { name: '展开详情' }).click();
    await card.getByRole('button', { name: '删除' }).click();

    const confirm = page.getByRole('dialog', { name: '移入回收站？' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '移入回收站', exact: true }).click();
    await expect(page.getByRole('article', { name: '将被删除的示范事项' })).toHaveCount(0);

    await navigate(page, '设置');
    const trash = page
      .getByRole('heading', { name: '回收站（1）' })
      .locator('xpath=ancestor::section[1]');
    await expect(trash).toBeVisible();
    // Scoped to the trash card: the success toast also contains the record title.
    await expect(trash.getByText('将被删除的示范事项')).toBeVisible();

    await trash.getByRole('button', { name: '恢复', exact: true }).click();
    // The trash emptying is the observable proof the restore committed.
    await expect(page.getByText('回收站是空的')).toBeVisible();

    await navigate(page, '工作');
    await expect(page.getByRole('article', { name: '将被删除的示范事项' })).toBeVisible();
  });

  test('cancelling a dialog never mutates data', async ({ page }) => {
    await gotoApp(page, 'work');
    await page.getByRole('button', { name: '新增记录' }).first().click();
    const dialog = page.getByRole('dialog', { name: '新增工作记录' });
    await dialog.getByRole('textbox', { name: '事项', exact: true }).fill('不应被保存的事项');
    await dialog.getByRole('button', { name: '取消' }).click();

    // A dirty form asks before discarding.
    const discard = page.getByRole('dialog', { name: '放弃未保存的修改？' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: '继续编辑' }).click();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: '取消' }).click();
    await page
      .getByRole('dialog', { name: '放弃未保存的修改？' })
      .getByRole('button', { name: '放弃修改', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('不应被保存的事项')).toHaveCount(0);
  });
});
