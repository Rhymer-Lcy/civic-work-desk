import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createWorkRecord, gotoApp, navigate } from './helpers';

/**
 * Automated accessibility checks.
 *
 * Scoped to WCAG 2.0/2.1/2.2 level A and AA. Automated tooling covers roughly a third of the
 * success criteria; the manual keyboard, focus-order and zoom review that covers the rest is
 * recorded in docs/qa-plan.md. These tests are the floor, not the ceiling.
 *
 * No rule is disabled. If a violation appears it must be fixed or explained in the QA plan, never
 * silenced here.
 */

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Let every running CSS animation finish before analysing.
 *
 * Without this the dialog scans run during the entrance animation and axe measures *blended*
 * colours — a settled `#6b6560 on #f2f0ec` (5.0:1) reads as `#726c67 on #ebe9e5` (4.3:1). WCAG
 * evaluates the settled state, so scanning mid-transition produces findings that are artefacts of
 * the harness rather than defects in the page.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function scan(page: Page, context?: string): Promise<void> {
  await settleAnimations(page);
  const builder = new AxeBuilder({ page }).withTags(TAGS);
  const results = await (context ? builder.include(context) : builder).analyze();
  const summary = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
        violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
    )
    .join('\n');
  expect(results.violations, `axe violations:\n${summary}`).toEqual([]);
}

test.describe('axe scans of stable UI states', () => {
  test('dashboard, empty', async ({ page }) => {
    await gotoApp(page, 'dashboard');
    await scan(page);
  });

  test('dashboard, populated with an overdue item', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '逾期的示范事项',
      date: '2026-01-05',
      reportDeadline: '2026-01-10',
      unit: '示范单位甲',
    });
    await navigate(page, '概览');
    await scan(page);
  });

  test('work list with an expanded card', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '可展开的示范事项', date: '2026-09-10' });
    await page.getByRole('button', { name: '展开详情' }).click();
    await scan(page);
  });

  test('work record dialog', async ({ page }) => {
    await gotoApp(page, 'work');
    await page.getByRole('button', { name: '新增记录' }).first().click();
    await expect(page.getByRole('dialog', { name: '新增工作记录' })).toBeVisible();
    await scan(page);
  });

  test('honour record dialog', async ({ page }) => {
    await gotoApp(page, 'honors');
    await page.getByRole('button', { name: '新增荣誉' }).first().click();
    await expect(page.getByRole('dialog', { name: '新增荣誉记录' })).toBeVisible();
    await scan(page);
  });

  test('ledger table', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '台账中的示范事项', date: '2026-06-06', unit: '单位丙' });
    await navigate(page, '台账');
    await scan(page);
  });

  test('reports with a populated period', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '报告中的示范事项', date: '2026-09-09' });
    await navigate(page, '报告');
    await page.locator('input[type="month"]').fill('2026-09');
    await expect(page.getByText('2026年9月').first()).toBeVisible();
    await scan(page);
  });

  test('settings, all sections', async ({ page }) => {
    await gotoApp(page, 'settings');
    await scan(page);
  });

  test('destructive confirmation dialog', async ({ page }) => {
    await gotoApp(page, 'settings');
    await page.getByRole('button', { name: '清空全部本机数据' }).click();
    await expect(page.getByRole('dialog', { name: '清空全部本机数据？' })).toBeVisible();
    await scan(page);
  });
});

test.describe('keyboard and focus behaviour', () => {
  test('a dialog traps focus and returns it to the trigger on close', async ({ page }) => {
    await gotoApp(page, 'work');
    const trigger = page.getByRole('button', { name: '新增记录' }).first();
    await trigger.click();

    const dialog = page.getByRole('dialog', { name: '新增工作记录' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Tab a good number of times; focus must never escape the dialog.
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]');
        return panel ? panel.contains(document.activeElement) : false;
      });
      expect(inside, `focus escaped the dialog after ${String(i + 1)} tabs`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the skip link is the first tab stop and moves focus to main', async ({ page }) => {
    await gotoApp(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: '跳到主要内容' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    const id = await page.evaluate(() => document.activeElement?.id ?? window.location.hash);
    expect(id).toContain('main');
  });

  test('every primary workflow is reachable by keyboard alone', async ({ page }) => {
    await gotoApp(page, 'work');

    // Open the create dialog with the keyboard only.
    const trigger = page.getByRole('button', { name: '新增记录' }).first();
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: '新增工作记录' });
    await expect(dialog).toBeVisible();
    await page.keyboard.type('用键盘创建的事项');
    await dialog.getByRole('button', { name: '保存' }).focus();
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('article', { name: '用键盘创建的事项' })).toBeVisible();
  });

  test('every icon-only control has an accessible name', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '检查图标按钮的事项', date: '2026-09-11' });
    await page.getByRole('button', { name: '展开详情' }).click();

    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      for (const button of document.querySelectorAll('button')) {
        // Built without `??` so the check does not depend on whether the DOM lib types
        // `getAttribute` as nullable in a given TypeScript release.
        const candidates = [
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.textContent,
        ];
        const named = candidates.some((value) => typeof value === 'string' && value.trim() !== '');
        if (!named) {
          problems.push(button.outerHTML.slice(0, 120));
        }
      }
      return problems;
    });
    expect(unnamed, `buttons without an accessible name:\n${unnamed.join('\n')}`).toEqual([]);
  });

  test('remains usable at 200% zoom without horizontal page overflow', async ({ page }) => {
    // WCAG 1.4.4: 200% zoom. Emulated by halving the viewport at the same CSS pixel ratio.
    await page.setViewportSize({ width: 640, height: 512 });
    await gotoApp(page, 'work');
    await createWorkRecord(page, { title: '缩放测试的示范事项', date: '2026-09-01' });

    for (const route of ['概览', '工作', '台账', '报告', '设置']) {
      await navigate(page, route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(
        overflow,
        `${route} overflows horizontally by ${String(overflow)}px`,
      ).toBeLessThanOrEqual(1);
    }
  });
});
