import { expect, test } from '@playwright/test';
import {
  APP_ORIGIN,
  createWorkRecord,
  gotoApp,
  navigate,
  waitForAppReady,
  watchExternalRequests,
} from './helpers';

/**
 * Offline operation and the network-privacy guarantee.
 *
 * These two are the load-bearing product claims: the application is local-first and it talks to
 * nobody. The legacy prototype asserted both in its UI text while loading Tencent Beacon from
 * `beacon.cdn.qq.com` on every page view and shipping no service worker at all.
 */

test.describe('network privacy', () => {
  test('never requests anything outside its own origin', async ({ page }) => {
    const watcher = watchExternalRequests(page);

    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '隐私检查中的示范事项',
      date: '2026-09-18',
      unit: '示范单位甲',
    });

    // Walk every route, including the ones that lazy-load the export libraries.
    for (const route of ['概览', '工作', '荣誉', '台账', '报告', '设置']) {
      await navigate(page, route);
    }

    // Trigger both heavy dynamic imports.
    await navigate(page, '台账');
    const xlsx = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 XLSX' }).click();
    await xlsx;

    await navigate(page, '报告');
    await page.locator('input[type="month"]').fill('2026-09');
    const docx = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 Word 文档（.docx）' }).click();
    await docx;

    expect(
      watcher.violations,
      `the application requested external origins:\n${watcher.violations.join('\n')}`,
    ).toEqual([]);
  });

  test('carries no reference to analytics, CDN or font hosts in the built output', async ({
    request,
  }) => {
    const index = await request.get('/');
    const html = await index.text();

    const forbidden = [
      'beacon.cdn.qq.com',
      'BeaconAction',
      'google-analytics',
      'googletagmanager',
      'fonts.googleapis.com',
      'fonts.gstatic.com',
      'cdn.jsdelivr.net',
      'unpkg.com',
      'cdnjs.cloudflare.com',
    ];
    for (const needle of forbidden) {
      expect(html, `index.html references ${needle}`).not.toContain(needle);
    }

    // No remote script or stylesheet of any kind.
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
  });

  test('serves a restrictive Content Security Policy', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const match = /content="([^"]*default-src[^"]*)"/.exec(html);
    expect(match, 'no CSP meta tag found').not.toBeNull();
    const policy = match?.[1] ?? '';

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("form-action 'self'");
    // The two that would defeat the point.
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    // style-src used to carry 'unsafe-inline' on a justification that was simply untrue: CSS
    // modules compile to a linked stylesheet, which 'self' already permits. The production build
    // emits no inline <style> and no style attribute, so the policy must now be strict — and no
    // directive may carry it, not merely script-src.
    expect(policy).toContain("style-src 'self';");
    expect(policy, 'no directive may allow inline sources').not.toContain('unsafe-inline');
  });

  test('runs under the strict policy without a violation, and proves the check can fail', async ({
    page,
  }) => {
    // A policy that blocks something the app needs shows up here and nowhere else: the page still
    // renders well enough for most assertions to pass while a stylesheet is silently refused.
    //
    // The detector is the specified `securitypolicyviolation` event rather than console-text
    // matching, and it is **self-tested at the end of this test**: a listener that never fires
    // looks exactly like a policy with nothing to report, so the test deliberately triggers a real
    // violation and fails if that goes unreported.
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations = violations;
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(`${event.violatedDirective} <- ${event.blockedURI || 'inline'}`);
      });
    });

    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: 'CSP 检查中的示范事项',
      date: '2026-09-18',
      unit: '示范单位乙',
    });
    // Open a dialog — the scroll lock used to be the app's last inline-style write.
    await page.getByRole('button', { name: '新增记录' }).first().click();
    await expect(page.getByRole('dialog', { name: '新增工作记录' })).toBeVisible();
    // The lock must be in force as a class, not as an inline style on <body>.
    await expect(page.locator('body.dialog-open')).toHaveCount(1);
    await expect(page.locator('body[style]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('body.dialog-open')).toHaveCount(0);

    // The stylesheet must actually be in force: if `style-src` had blocked it, computed styles
    // would fall back to the UA defaults and this would be `rgba(0, 0, 0, 0)`.
    const background = await page
      .locator('body')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background, 'the linked stylesheet was not applied').not.toBe('rgba(0, 0, 0, 0)');

    const observed = await page.evaluate(
      () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    expect(observed, `CSP violations:\n${observed.join('\n')}`).toEqual([]);

    // Self-test. An inline <style> element is precisely what `style-src 'self'` forbids, so
    // injecting one must be reported. This is the assertion that makes the empty result above
    // mean something.
    //
    // The event is fired from a queued task, not synchronously during `appendChild`, so this
    // polls rather than reading the array in the same evaluate call.
    await page.evaluate(() => {
      const probe = document.createElement('style');
      probe.textContent = 'body { outline: 1px solid red; }';
      document.head.appendChild(probe);
    });
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
            )
          ).join(' '),
        { message: 'the violation detector never fired on a deliberate violation' },
      )
      .toMatch(/style-src/);

    // And the blocked stylesheet must genuinely not have taken effect.
    const outline = await page.locator('body').evaluate((el) => getComputedStyle(el).outlineWidth);
    expect(outline, 'the probe stylesheet was applied, so the policy did not block it').not.toBe(
      '1px',
    );
  });

  test('ships no source maps, so the built bundle discloses no source', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(scripts.length, 'no module script found in index.html').toBeGreaterThan(0);

    for (const src of scripts) {
      const asset = await request.get(src.replace(/^\.\//, '/'));
      expect(asset.status(), `${src} is not served`).toBe(200);
      const code = await asset.text();
      expect(code, `${src} points at a source map`).not.toMatch(/sourceMappingURL/);

      // And the map must not be retrievable by guessing its name. Asserting on the status alone
      // would be wrong: `vite preview` answers an unknown path with the SPA fallback, so a
      // missing map returns 200 with `index.html` in it. What matters is whether the body IS a
      // source map.
      const map = await request.get(`${src.replace(/^\.\//, '/')}.map`);
      if (map.status() === 200) {
        const body = await map.text();
        expect(
          map.headers()['content-type'] ?? '',
          `${src}.map is served as a document`,
        ).not.toContain('json');
        expect(body, `${src}.map returned a source map`).not.toMatch(/"mappings"\s*:/);
        expect(body, `${src}.map returned a source map`).not.toMatch(/"sourcesContent"\s*:/);
      }
    }
  });
});

test.describe('PWA and offline', () => {
  test('serves a real static manifest with maskable icons', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    const manifest = (await response.json()) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      theme_color: string;
      background_color: string;
      icons: { sizes: string; purpose?: string; type: string }[];
    };

    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.start_url.length).toBeGreaterThan(0);
    expect(manifest.scope.length).toBeGreaterThan(0);
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);

    const png = manifest.icons.filter((icon) => icon.type === 'image/png');
    expect(png.some((icon) => icon.sizes === '192x192')).toBe(true);
    expect(png.some((icon) => icon.sizes === '512x512')).toBe(true);
    expect(png.some((icon) => icon.purpose === 'maskable')).toBe(true);

    // Every declared icon must actually exist.
    for (const icon of manifest.icons) {
      const src = (icon as unknown as { src: string }).src.replace(/^\.\//, '/');
      const iconResponse = await request.get(src);
      expect(iconResponse.status(), `${src} is missing`).toBe(200);
    }
  });

  test('registers a service worker that precaches the shell', async ({ page }) => {
    await gotoApp(page);
    await page.waitForFunction(
      async () => (await navigator.serviceWorker.getRegistrations()).length > 0,
      undefined,
      { timeout: 20_000 },
    );
    const count = await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    );
    expect(count).toBeGreaterThan(0);
  });

  test('opens offline, keeps its records, and still allows CRUD', async ({ page, context }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '断网前创建的事项',
      date: '2026-09-19',
      unit: '示范单位乙',
    });
    await expect(page.getByRole('article', { name: '断网前创建的事项' })).toBeVisible();

    // Let the service worker finish precaching before cutting the network.
    await page.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state === 'activated';
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(1_500);

    const watcher = watchExternalRequests(page);
    await context.setOffline(true);

    await page.reload();
    await waitForAppReady(page);

    // 1. The application opens at all.
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    // 2. Stored records are still there.
    await page.goto(`${APP_ORIGIN}/#/work`);
    await waitForAppReady(page);
    await expect(page.getByRole('article', { name: '断网前创建的事项' })).toBeVisible();

    // 3. CRUD still works offline.
    await createWorkRecord(page, { title: '断网后创建的事项', date: '2026-09-20' });
    await expect(page.getByRole('article', { name: '断网后创建的事项' })).toBeVisible();

    // 4. Nothing was attempted against a third party.
    expect(watcher.violations).toEqual([]);

    await context.setOffline(false);
  });

  test('does not put user records into the Cache API', async ({ page }) => {
    await gotoApp(page, 'work');
    await createWorkRecord(page, {
      title: '不得进入缓存的机密事项',
      date: '2026-09-21',
      unit: '机密单位',
    });
    await page.waitForFunction(
      async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state === 'activated';
      },
      undefined,
      { timeout: 20_000 },
    );

    const leaked = await page.evaluate(async () => {
      const names = await caches.keys();
      const hits: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          if (!response) continue;
          const type = response.headers.get('content-type') ?? '';
          // Only text-ish entries could carry record content.
          if (!/text|json|javascript|html/.test(type)) continue;
          const body = await response.text();
          if (body.includes('不得进入缓存的机密事项') || body.includes('机密单位')) {
            hits.push(request.url);
          }
        }
      }
      return hits;
    });

    expect(leaked, `record content found in the Cache API at:\n${leaked.join('\n')}`).toEqual([]);
  });
});
