import type { Locator, Page, Request } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Shared E2E helpers.
 *
 * `gotoApp` always starts from a clean origin so a test never inherits another test's records.
 * Deleting the database before navigation (rather than after) means a failed test leaves its state
 * behind for inspection.
 */

export const APP_ORIGIN = 'http://127.0.0.1:4173';

/**
 * Load the application with a guaranteed-empty origin.
 *
 * `indexedDB.deleteDatabase()` from page script is NOT reliable here: the running application
 * holds an open Dexie connection, so the request fires `onblocked` and the data survives. A test
 * then starts with the previous test's records, and the symptom is remote from the cause (for
 * example an import plan that finds only conflicts, leaving its confirm button disabled).
 *
 * `Storage.clearDataForOrigin` over CDP clears the origin regardless of open connections. The
 * page is reloaded afterwards so the application re-seeds from a clean state. `cache_storage` is
 * deliberately NOT cleared — the service-worker precache is origin-level shell state, and wiping
 * it every test would slow the suite without isolating anything.
 */
export async function gotoApp(page: Page, route = 'dashboard'): Promise<void> {
  await page.goto('/');
  const client = await page.context().newCDPSession(page);
  await client.send('Storage.clearDataForOrigin', {
    origin: APP_ORIGIN,
    storageTypes: 'indexeddb,local_storage',
  });
  await client.detach();

  await page.goto(`/#/${route}`);
  await page.reload();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await waitForAppReady(page);
}

export async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByText('正在读取本机数据…')).toHaveCount(0, { timeout: 15_000 });
}

export async function navigate(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: label }).click();
  await waitForAppReady(page);
}

/** Create a work record through the UI. Returns the title used. */
export async function createWorkRecord(
  page: Page,
  options: {
    title: string;
    date?: string;
    status?: string;
    requirement?: string;
    reportDeadline?: string;
    unit?: string;
  },
): Promise<string> {
  await page.getByRole('button', { name: '新增记录' }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增工作记录' });
  await expect(dialog).toBeVisible();

  // Role + accessible name throughout. `getByLabel` matches the label element's *text*, which
  // includes the decorative required asterisk, so it is the wrong tool here.
  await dialog.getByRole('textbox', { name: '事项', exact: true }).fill(options.title);

  if (options.date) {
    await dialog.getByRole('radiogroup', { name: '事项日期类型' }).getByText('具体日期').click();
    await dialog.getByRole('textbox', { name: '事项日期', exact: true }).fill(options.date);
  }
  if (options.status) {
    await dialog
      .getByRole('combobox', { name: '状态', exact: true })
      .selectOption({ label: options.status });
  }
  if (options.requirement) {
    await dialog.getByRole('textbox', { name: '完成要求' }).fill(options.requirement);
  }
  if (options.reportDeadline) {
    await dialog
      .getByRole('radiogroup', { name: '要求上报时限类型' })
      .getByText('具体日期')
      .click();
    await dialog
      .getByRole('textbox', { name: '要求上报时限', exact: true })
      .fill(options.reportDeadline);
  }
  if (options.unit) {
    // `<summary>` has no stable ARIA role across engines; target the element itself.
    await openSection(dialog, '对接信息');
    await dialog.getByRole('textbox', { name: '对接单位' }).fill(options.unit);
  }

  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  return options.title;
}

/** Expand a `<details>` section by its summary text, if it is not already open. */
export async function openSection(scope: Locator, label: string): Promise<void> {
  const summary = scope.locator('summary').filter({ hasText: label }).first();
  // The parent of a <summary> is always its <details>.
  const details = summary.locator('xpath=..');
  const isOpen = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!isOpen) await summary.click();
}

/**
 * Record every request that leaves the application's own origin.
 *
 * `about:`, `data:` and `blob:` are not network egress and are excluded. Anything else — an
 * analytics beacon, a font CDN, a remote icon — is a violation.
 */
export function watchExternalRequests(page: Page): { violations: string[] } {
  const violations: string[] = [];
  const record = (request: Request): void => {
    const url = request.url();
    if (url.startsWith(APP_ORIGIN)) return;
    if (/^(about|data|blob|chrome-extension|chrome|devtools):/.test(url)) return;
    violations.push(`${request.method()} ${url}`);
  };
  page.on('request', record);
  return { violations };
}
