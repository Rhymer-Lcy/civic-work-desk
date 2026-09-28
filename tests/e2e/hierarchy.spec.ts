import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { addSubtask, createWorkRecord, expandWorkCard, gotoApp, navigate } from './helpers';

/**
 * The work hierarchy through the interface (docs/phase-5-product-evolution.md §4–§11).
 *
 * Everything is driven the way a user drives it — the add-child action on a record, the 调整层级
 * dialog, the delete choices — and asserted through roles and accessible names, so the tests also
 * check that the hierarchy is operable without a pointer and legible without colour.
 */

const ROOT = '示范一级任务';
const CHILD = '示范二级子任务';
const GRANDCHILD = '示范三级子任务';

/** 一级 → 二级 → 三级, through the interface. */
async function buildThreeLevels(page: Page): Promise<void> {
  await gotoApp(page, 'work');
  await createWorkRecord(page, { title: ROOT, date: '2026-09-01' });
  await addSubtask(page, ROOT, CHILD);
  await addSubtask(page, CHILD, GRANDCHILD);
}

async function openStructure(page: Page): Promise<Locator> {
  await page
    .getByRole('group', { name: '工作视图' })
    .getByRole('button', { name: '任务结构' })
    .click();
  const tree = page.getByRole('list', { name: '任务结构' });
  await expect(tree).toBeVisible();
  return tree;
}

test.describe('building the hierarchy', () => {
  test('adds a 2级子任务 and a 3级子任务, and a level-3 task offers no fourth level', async ({
    page,
  }) => {
    await buildThreeLevels(page);

    // The list states each sub-task's level and parent on the row itself.
    const child = page.getByRole('article', { name: CHILD });
    await expect(child.getByText('2级子任务').first()).toBeVisible();
    await expect(child.getByText(`上级：${ROOT}`)).toBeVisible();
    const grandchild = page.getByRole('article', { name: GRANDCHILD });
    await expect(grandchild.getByText(`上级：${ROOT} / ${CHILD}`)).toBeVisible();

    const expanded = await expandWorkCard(page, GRANDCHILD);
    await expect(expanded.getByText('3级子任务').first()).toBeVisible();
    await expect(expanded.getByRole('button', { name: '添加下级任务', exact: true })).toHaveCount(
      0,
    );
    await expect(expanded.getByRole('button', { name: '调整层级', exact: true })).toBeVisible();
  });

  test('the dialog names the level a new sub-task will get, without a level input', async ({
    page,
  }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: ROOT });
    await addSubtask(page, ROOT, CHILD);
    const card = await expandWorkCard(page, CHILD);
    await card.getByRole('button', { name: '添加下级任务', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新增下级任务' });
    await expect(dialog.getByText(`上级任务：${CHILD}（将创建为 3级子任务）`)).toBeVisible();
    await expect(dialog.getByRole('spinbutton')).toHaveCount(0);
    await dialog.getByRole('button', { name: '取消' }).click();
  });
});

test.describe('the structure view', () => {
  test('draws nested lists with written levels, progress and collapse, and is remembered', async ({
    page,
  }) => {
    await buildThreeLevels(page);
    const tree = await openStructure(page);
    await expect(
      page.getByRole('group', { name: '工作视图' }).getByRole('button', { name: '任务结构' }),
    ).toHaveAttribute('aria-pressed', 'true');

    const root = tree.getByRole('group', { name: ROOT });
    await expect(root.getByText('1级任务')).toBeVisible();
    await expect(root.getByText('下级任务 0/1 已完成')).toBeVisible();
    await expect(tree.getByRole('group', { name: CHILD }).getByText('2级子任务')).toBeVisible();
    const leaf = tree.getByRole('group', { name: GRANDCHILD });
    await expect(leaf.getByText('3级子任务')).toBeVisible();
    await expect(leaf.getByRole('button', { name: `添加下级任务：${GRANDCHILD}` })).toHaveCount(0);

    // Collapse the root: its sub-tasks leave the page, and the disclosure says so.
    const disclosure = root.getByRole('button', { name: `收起下级任务：${ROOT}` });
    await disclosure.click();
    await expect(root.getByRole('button', { name: `展开下级任务：${ROOT}` })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(tree.getByRole('group', { name: CHILD })).toBeHidden();

    await page.reload();
    await expect(page.getByRole('list', { name: '任务结构' })).toBeVisible();
  });

  test('a filter shows the match with its ancestors as labelled context', async ({ page }) => {
    await buildThreeLevels(page);
    await createWorkRecord(page, { title: '无关的一级任务' });
    const tree = await openStructure(page);
    await page.getByRole('searchbox', { name: '搜索记录' }).fill(GRANDCHILD);

    await expect(tree.getByRole('group', { name: GRANDCHILD })).toBeVisible();
    await expect(
      tree.getByRole('group', { name: GRANDCHILD }).getByText('上下文（未匹配筛选）'),
    ).toHaveCount(0);
    await expect(
      tree.getByRole('group', { name: ROOT }).getByText('上下文（未匹配筛选）'),
    ).toBeVisible();
    await expect(
      tree.getByRole('group', { name: CHILD }).getByText('上下文（未匹配筛选）'),
    ).toBeVisible();
    await expect(tree.getByRole('group', { name: '无关的一级任务' })).toHaveCount(0);
  });

  test('keyboard: the add-child action is reachable and opens the dialog', async ({ page }) => {
    await buildThreeLevels(page);
    const tree = await openStructure(page);
    const add = tree.getByRole('button', { name: `添加下级任务：${CHILD}` });
    await add.focus();
    await expect(add).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '新增下级任务' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '新增下级任务' })).toBeHidden();
  });

  test('on a phone the outline stacks without horizontal scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await buildThreeLevels(page);
    await openStructure(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('re-parenting, completing and deleting', () => {
  test('调整层级 moves a task with a dialog, not by dragging', async ({ page }) => {
    await buildThreeLevels(page);
    const tree = await openStructure(page);
    await tree.getByRole('button', { name: `调整层级：${GRANDCHILD}` }).click();
    const dialog = page.getByRole('dialog', { name: '调整层级' });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('listbox', { name: '新的上级任务' })
      .selectOption({ label: '（无上级）设为 1级任务' });
    await dialog.getByRole('button', { name: '确定调整' }).click();
    await expect(dialog).toBeHidden();
    await expect(tree.getByRole('group', { name: GRANDCHILD }).getByText('1级任务')).toBeVisible();
  });

  test('completing a parent with open sub-tasks asks first, and leaves them unchanged', async ({
    page,
  }) => {
    await buildThreeLevels(page);
    const card = await expandWorkCard(page, ROOT);
    await card.getByRole('button', { name: '编辑' }).click();
    const dialog = page.getByRole('dialog', { name: '编辑工作记录' });
    await dialog
      .getByRole('combobox', { name: '状态', exact: true })
      .selectOption({ label: '已完成' });
    await dialog.getByRole('button', { name: '保存', exact: true }).click();

    const notice = page.getByRole('dialog', { name: '仍标记为已完成？' });
    await expect(notice.getByText('2 项下级任务尚未完成')).toBeVisible();
    await notice.getByRole('button', { name: '仍标记为已完成' }).click();
    await expect(dialog).toBeHidden();

    await expect(
      page.getByRole('article', { name: ROOT }).getByText('已完成').first(),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: CHILD }).getByText('待办').first(),
    ).toBeVisible();
  });

  test('deleting a task with sub-tasks asks what to do, and the batch restores together', async ({
    page,
  }) => {
    await buildThreeLevels(page);
    const card = await expandWorkCard(page, ROOT);
    await card.getByRole('button', { name: '删除', exact: true }).click();

    const choice = page.getByRole('dialog', { name: '删除带有下级任务的任务' });
    await expect(choice).toBeVisible();
    // Cancel has focus first: nothing destructive happens on a reflexive Enter.
    await expect(choice.getByRole('button', { name: '取消' })).toBeFocused();
    await choice.getByRole('button', { name: '连同 2 项下级任务一并移入回收站' }).click();
    await expect(choice).toBeHidden();
    await expect(page.getByRole('article', { name: CHILD })).toHaveCount(0);

    await navigate(page, '设置');
    await page.getByRole('button', { name: '连同 2 项下级一并恢复' }).click();
    await navigate(page, '工作');
    await expect(page.getByRole('article', { name: GRANDCHILD })).toBeVisible();
  });

  test('restoring a sub-task alone while its parent is in the trash is refused with a reason', async ({
    page,
  }) => {
    await buildThreeLevels(page);
    const card = await expandWorkCard(page, ROOT);
    await card.getByRole('button', { name: '删除', exact: true }).click();
    await page
      .getByRole('dialog', { name: '删除带有下级任务的任务' })
      .getByRole('button', { name: '连同 2 项下级任务一并移入回收站' })
      .click();

    await navigate(page, '设置');
    // By its exact name: the grandchild's row also mentions CHILD, in its parent path.
    const item = page
      .getByRole('listitem')
      .filter({ has: page.getByText(`[工作] ${CHILD}`, { exact: true }) });
    await item.getByRole('button', { name: '恢复', exact: true }).click();
    await expect(page.getByText(`上级任务「${ROOT}」仍在回收站中`)).toBeVisible();
  });
});
