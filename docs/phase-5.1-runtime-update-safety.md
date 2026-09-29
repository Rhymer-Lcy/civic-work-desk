# Phase 5.1 — Runtime Update Safety Correction

**Date:** 2026-09-29 (UTC+8). **Branch:** `phase-5.1/runtime-update-safety`, from `main` at
`3b71dbc86607186a80de06a3b852a857786eb5a2`. **Scope:** the shared application only: four product and
runtime defects that packaged Windows upgrade acceptance exposed after Phase 5 was signed off.

This is a post-signoff corrective phase. [phase-5-final-signoff.md](phase-5-final-signoff.md) stays as it
was signed; it only gains a pointer to this record. No platform artifact was built, tagged or published
here, and no Windows installer, server, launcher or UOS deployment code changed. The work stops at an
independent review; `main` is not advanced by this phase.

## 1. Why this phase exists

Phase 6 froze a Windows candidate and then paused before publishing it:

| item                   | value                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| file                   | `CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe`                                    |
| size                   | 6,951,434 bytes                                                                     |
| SHA-256                | `4fe9296dbbaf20a85a19d742cfd9a7ae86a2e99c16518ec125718a66fd10eae5`                  |
| releaseId              | `2026.09.29-win-0.2.0-rc.1`                                                         |
| deploymentSourceCommit | `a31cb4396ad2b72cd830aef92e96fffa13be6053` (branch `phase-6/windows-0.2.0-release`) |
| application payload    | byte-identical to a clean build of `3b71dbc`                                        |
| status                 | **REJECTED BEFORE PUBLICATION.** Never tagged, never attached to a release          |

The binary is not in this repository. Its bytes are kept unmodified, outside version control, with the
diagnosis that rejected it.

**The symptom.** After the installer opened the application in Edge at a 2047×1001 viewport, the brand
sat at a different x on different routes: about 159–165 on 台账, 506–512 on 报告 and 321–327 on 设置
(screen coordinates read by the user).

**The diagnosis**, run with the published RC3 installer and the frozen candidate on synthetic profiles:

| scenario                            | interface running                                     | worker states                 | brand-text left x at 2047×1001                         |
| ----------------------------------- | ----------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| A: clean profile, candidate         | candidate (`index-Czjj00lG.js`)                       | active, nothing waiting       | 115.5 on five routes, 108 on 设置                      |
| B: RC3 profile, candidate installed | **RC3** (`index-BF8bN2uI.js`), served by RC3's worker | active (RC3), nothing waiting | 台账 115.5, 设置 288, 概览/工作/荣誉 295.5, 报告 485.5 |
| C: after the prompt and 应用更新    | candidate                                             | active (new), nothing waiting | as A                                                   |

In B the page fetched `deployment-health.json` from the network and it named the candidate, while the
interface came from RC3's precache: metadata said "new" while the running code was old. The user's
differences (报告 − 台账 = 347, 设置 − 台账 = 162) are RC3's (370 and 172.5) at one common scale (0.938 and 0.939);
under the candidate 报告 and 台账 coincide, so the screenshot was RC3's interface. Before the prompt
appeared the browser needed 9 s, 201–214 s, and once, with two tabs open, more than 360 s.

The stale worker itself is a deployment matter for Phase 6 (section 8). The same investigation found
four defects in the shared application, which this phase corrects:

| #   | defect                                                                              | section |
| --- | ----------------------------------------------------------------------------------- | ------- |
| A   | a classic scrollbar moves the application bar between routes                        | 2       |
| B   | pressing 应用更新 in one tab reloads every other tab, losing unsaved input          | 3       |
| C   | an update page has no way to know whether other application windows are open        | 4       |
| D   | a page cannot tell that the interface it runs is older than the installed program's | 5       |

A fifth finding belongs to the deployment layer and is left to Phase 6: once a worker controls the
origin, a navigation to the launcher's `/__civic/platform` check page is answered with the application
shell (`status 200, fromServiceWorker=true`), while a navigation under `/api/` reaches the server
(`fromServiceWorker=false`), because `navigateFallbackDenylist` exempts only `/^\/api/`.

## 2. Classic-scrollbar shell geometry (defect A)

**Mechanism.** Ordinary Edge on Windows draws a 15 px classic scrollbar, and only on routes whose content
is taller than the window; in a clean profile that is 设置 alone, at every tested size. The scrollbar
narrows the width the bar is laid out in. Up to the bar's `--shell-max` of 1920 px the bar fills that
width, so its right edge (the action slot) moves by the whole scrollbar; above it the bar is centred, so
everything in it moves by half. Playwright's default headless Chromium is launched with
`--hide-scrollbars` and reports a 0 px scrollbar, which is why `shell-geometry.spec.ts` passed.

**Correction.** One declaration, on the root element (`src/styles/globals.css`):

```css
html {
  scrollbar-gutter: stable;
}
```

It must be on the root: the document scrolls in the viewport, which takes `scrollbar-gutter` from the
root element and not from `body`. Measured with the same declaration moved to `body`: the action slot
still moved 15 px at 1366×768, and brand and slot 7.5 px at 2047×1001. No route-specific margin, no
hard-coded 7.5 or 15, no browser detection. Overlay scrollbars reserve nothing either way. A browser that
does not support the property ignores it and keeps the uncorrected layout.

**Measured**, largest route-to-route difference over the brand, all six destinations and the
action slot's right edge, in bundled Chromium without `--hide-scrollbars` and in installed Edge
(identical in both):

| viewport  | `main` (uncorrected)      | corrected | control: gutter forced back to `auto` |
| --------- | ------------------------- | --------- | ------------------------------------- |
| 1366×768  | 15 px (action-slot right) | 0         | 15 px (action-slot right)             |
| 1920×1080 | 15 px (action-slot right) | 0         | 15 px (action-slot right)             |
| 2047×1001 | 7.5 px (brand left)       | 0         | 7.5 px (brand left)                   |
| 2560×1440 | 7.5 px (brand left)       | 0         | 7.5 px (brand left)                   |

Corrected positions: brand left 24.3125 / 34.28125 / 92 / 348.5 and action-slot right 1326.6875 /
1870.71875 / 1940 / 2196.5 at the four sizes. The 1366 and 1920 shifts were not visible in the Phase-6
diagnosis, which measured the brand only.

A side effect, measured and now asserted: a modal dialog sets `body.dialog-open { overflow: hidden }`,
which removed the scrollbar and moved the bar 15 px behind a dialog opened on a page that scrolls; with
the root gutter reserved the shift is 0.

**Gate.** `tests/e2e/shell-geometry-scrollbars.spec.ts`, in `chromium-desktop` (bundled Chromium,
launched without `--hide-scrollbars`) and `msedge-desktop` (installed Edge). Before comparing it requires
that the browser reserves a scrollbar (probe element, 15 px here) and that each viewport has both a route
that scrolls and one that does not, so it cannot pass by comparing identical layouts. Each run then
forces `scrollbar-gutter: auto` through CSSOM and must measure a shift of at least 5 px, which is the
negative control required by this phase. The spec was committed first with the defect reproduced
(expected failure on `main`) and flipped by the correction.

## 3. Multi-tab update safety (defect B)

**Reproduced on the candidate:** tab 2 held an open 新增工作记录 dialog with typed text; tab 1 pressed
应用更新; tab 2 navigated once, its document was replaced, the dialog and the text were gone, and it came
back on the new interface. That reproduction did not inspect the database; a reload does not touch
IndexedDB, so the loss was the unsaved input, and after the correction the two-tab test below also shows
the record saved from that form present after the tab moves to the new version.

**Mechanism, read from the installed package** (`node_modules/vite-plugin-pwa/dist/client/build/register.js`,
version 1.3.0, and `types/index.d.ts`): in prompt mode `registerSW` reacts to workbox-window's `waiting`
event, and to an external `installed` event, by calling `showSkipWaitingPrompt`, which adds a
`controlling` listener and then calls `onNeedRefresh`. That listener, when `event.isUpdate` is true,
calls `onNeedReload` if the caller supplied one and **`window.location.reload()` otherwise**.
`updateServiceWorker(_reloadPage)` ignores its argument and only posts `SKIP_WAITING`. A worker that calls
`skipWaiting()` becomes the controller of every page of the origin at once, so every tab that had shown
the prompt reloaded. `onNeedReload` is a typed, documented option of this version.

**Correction** (`src/app/pwa/service-worker-bridge.ts`, `src/app/App.tsx`): the bridge supplies
`onNeedReload`, and a small coordinator decides:

| page                                        | when a newer worker takes control                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the page where the user pressed 应用更新    | reloads, once                                                                                                                                                                                          |
| every other page                            | not reloaded; state `activated-elsewhere`, notice: 新版本已在其他页面中启用。本页面不会自动刷新，尚未保存的内容仍保留在本页面中；请先保存正在编辑的内容，再刷新到新版本。 with the button 刷新到新版本 |
| a page taken over before it showed a prompt | the same notice, through the page's own `controllerchange` listener (the plugin adds none there)                                                                                                       |
| a page that had no worker yet               | nothing: its first worker is not an update                                                                                                                                                             |

After a take-over later prompts are ignored, so the notice cannot be replaced by an 应用更新 button with
nothing left to apply. Prompt mode is unchanged: no auto-update, no global `skipWaiting`, and the worker
still does not claim clients.

**Tests.** `tests/e2e/update-safety.spec.ts`, each test in its own persistent profile served by
`tests/e2e/update-harness.ts`, which can put a newer worker in place while the tabs stay open:

| test                                    | proves                                                                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| one tab                                 | the accepting tab still reloads onto the new worker; nothing waits afterwards                                                                   |
| two tabs, unsaved 新增工作记录 in tab B | tab B keeps its document, dialog and text, shows the notice; saving does not reload it; its button then moves it, and the saved record is there |
| three tabs, two in the background       | only the accepting tab reloads; a plain browser reload of another is also an explicit request and lands on the new worker                       |
| reload while an update waits            | the reloaded tab stays on the old worker, the update stays waiting, the prompt is offered again                                                 |

Both multi-tab tests were committed first as expected failures, and on the uncorrected code both failed
on the reload itself ("tab B still shows the document it had"), in bundled Chromium and in installed Edge.
`tests/unit/service-worker-bridge.test.ts` pins the decision table and the wiring; removing
`onNeedReload`, or the `controllerchange` handling, each fails exactly one of its tests.

**What this cannot fix.** RC3 and earlier tabs run published code with the plugin's default reload. When
a newer worker is activated they still reload. Only the deployment can protect them, by not activating
while they are open; that is what section 4 prepares.

## 4. Waiting-worker window awareness (defect C)

**Question.** Before an update page activates a waiting worker, can that worker, still `installed`, see
the other windows of the origin, including windows the OLD worker controls, uncontrolled ones,
background ones, windows on other routes and windows opened before the upgrade? The API
(`clients.matchAll({ type: 'window', includeUncontrolled: true })`) exists; whether it covers those
states was measured, not assumed.

**Result: reliable in every configuration tested.**

| browser and driver                                       | old worker                         | windows                                                                                       | result                                                                                                    |
| -------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| bundled Chromium, headless (Playwright)                  | current build without the protocol | uncontrolled 概览, old-controlled 工作, old-controlled and CDP-frozen 台账, bootstrap page    | all four, 5 identical answers; a closed tab leaves the next answer; the old worker does not answer        |
| installed Edge, headless (Playwright)                    | same                               | same                                                                                          | same                                                                                                      |
| installed Edge and bundled Chromium, headed (Playwright) | **published RC3 worker**           | uncontrolled, RC3-controlled, frozen, bootstrap                                               | same                                                                                                      |
| plain installed Edge, headed, raw CDP (no Playwright)    | **published RC3 worker**           | 概览 uncontrolled and 工作, 台账 RC3-controlled, all three genuinely `hidden` background tabs | all four, `hidden` reported for the three, 5 identical answers; a closed background tab leaves the answer |

Playwright emulates focus on every page it drives, so pages driven by it report `visible`; the raw-CDP
run is the one that observed really hidden tabs. In every run asking activated nothing: afterwards the old
worker was still active and the new one still `installed`. The 360 browser on UOS has not been tested; it
is to be checked in that platform's next release cycle.

**Implemented** as `public/sw-client-awareness.js`, loaded into the generated worker through
`workbox.importScripts` (`vite.config.ts`):

- Request, from a same-origin page to `registration.waiting`, with a `MessagePort`:
  `{ type: 'CIVIC_WINDOW_CLIENTS', version: 1 }`, exactly these two keys.
- Reply on the port: `{ type: 'CIVIC_WINDOW_CLIENTS_RESULT', version: 1, worker, windows }`, where each
  window is `{ requester, kind, route, visibility, focused }` and nothing else.
- `kind`: `bootstrap` for `/api/civic/start`, `platform` for `/api/civic/platform`, `service` for any
  other `/api/` path, `outside-scope` for a path outside the worker's scope, and `application` for every
  other path, `/__civic/platform` included, because under a controlling worker every non-`/api/`
  navigation can be the application shell. `route` is one of the six route names or `null`.
- Never returned: a URL, a query string, a fragment beyond the route name, a title, anything a page holds.
  Windows of another origin are dropped. A message that is not exactly the request, has no port, or comes
  from another origin or from a source without a URL gets no reply and triggers no enumeration.
- **Consumer rule** for a future update page: count entries with `requester: false` and
  `kind: 'application'`; if there is any, do not activate, say so, and ask the user to save and close
  those pages. No answer within the timeout (an older waiting worker, or none) is **unknown, never zero**,
  and falls back to the explicit manual warning. The update page itself is excluded as the requester; a
  second update page open elsewhere counts as `bootstrap`, which is safe to exclude because `/api/`
  navigations never run the application.

Coverage: `tests/e2e/client-awareness.spec.ts` (Chromium and Edge), `tests/unit/sw-client-awareness.test.ts`
(privacy of the reply, ignored messages; adding a `url` field to the reply fails one test, answering any
message fails five), and a static-scan rule, `window-client-enumeration`, which allows `clients.matchAll`
in this file and its copy in `dist/` only (documentation and tests aside).

## 5. Runtime UI-generation mismatch (defect D)

**Five version concepts**, deliberately distinct:

| concept                 | example                     | what it identifies                          | where it comes from                           |
| ----------------------- | --------------------------- | ------------------------------------------- | --------------------------------------------- |
| `productVersion`        | `0.2.0-dev.0`               | the product's SemVer line                   | `package.json#version`                        |
| `appGeneration`         | `ui-DY8buzpf`               | one built interface: its JavaScript and CSS | the bundler's content hash of the entry chunk |
| `databaseSchemaVersion` | `2`                         | the IndexedDB schema                        | `SCHEMA_VERSION`, `src/db/schema.ts`          |
| `backupFormatVersion`   | `3`                         | the JSON backup format                      | `BACKUP_FORMAT_VERSION`                       |
| platform `releaseId`    | `2026.09.29-win-0.2.0-rc.1` | one platform package build                  | the platform's release tooling                |

Two builds with the same product version can be different generations, and one generation can ship in
several platform releases.

**appGeneration, exactly.** `ui-` followed by the hash in the entry chunk's file name,
`assets/index-<hash>.js`. The hash changes with the entry's own code, with the hashed names of every
chunk it imports (lazily loaded ones included) and with the entry stylesheet: the CSS-only correction of
section 2 moved it from `Czjj00lG` to `BVfqecLS`, and two builds of the same tree produced the same value.
Files under `public/` are copied rather than bundled, so they are outside it: a change made only to
`public/sw-client-awareness.js` left the generation at `ui-DY8buzpf` and changed `sw.js`, so such a
change reaches browsers through the service worker's own update check, not through this comparison.

- The build writes `app-generation.json` next to `index.html` (`emitAppGeneration`, `vite.config.ts`):
  `{ "schema": "civic-app-generation/1", "appGeneration": "ui-…", "entry": "assets/index-….js" }`. It is
  written after the hash is known and nothing in the bundle reads it, so there is no circular dependency;
  the build fails if the entry chunk is not exactly one `assets/index-<hash>.js`. It is not precached.
- The running page derives the same value from its own module URL (`import.meta.url`), in
  `src/app/pwa/runtime-generation.ts`, which is bundled into the entry chunk. Under the dev server or in
  a unit test that URL names no generation and the check stays silent.

**Endpoint contract (to be served by the deployment, Phase 6).** `GET /api/civic/runtime` returns
`application/json` with `{ "schema": "civic-runtime/1", "appGeneration": "<the active release's
app-generation.json value>" }`; other fields are allowed and ignored. The page sends a body-less GET with
`cache: 'no-store'`, `credentials: 'omit'`, `redirect: 'error'` and a 5 s timeout. Only this module may
call it (static-scan rule `runtime-endpoint-caller`).

**Behaviour.** The page checks on start and whenever it becomes visible, one check at a time.

| answer                                                       | outcome  | what the user sees                                                                                                      |
| ------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| well-formed, same generation                                 | match    | nothing                                                                                                                 |
| well-formed, another generation                              | mismatch | a lasting notice (text below); the browser is asked to look for the newer worker, whose ordinary prompt then takes over |
| 404                                                          | unknown  | nothing: a server without the endpoint (the Phase-6 candidate's answered 404 under `/api/`; UOS's was not checked)      |
| any other failure, dropped connection, timeout, offline      | unknown  | nothing; offline operation is unchanged                                                                                 |
| not JSON (a single-page fallback), another schema, bad value | unknown  | nothing                                                                                                                 |

The notice reads: 本机已安装新版本，本页面仍在运行旧版本。本页面不会自动刷新；请先保存正在编辑的内容，新版本准备就绪后，此处会出现「应用更新」按钮。

A mismatch never reloads the page, clears a cache, touches IndexedDB, or changes the origin.

**Tests.** `tests/e2e/runtime-generation.spec.ts` (Chromium and Edge): match; mismatch with an open,
unsaved dialog, where the page, its text, its caches and its databases are all unchanged; the endpoint
absent, failing, dropping the connection, answering with the application page, and answering with
another schema; offline, where no request leaves the browser; and a stale-worker simulation, in which
an older generation (the same build with its entry chunk renamed, `makeOlderGeneration`) is installed,
the server moves on, a reload still runs the older interface, the mismatch is detected, the prompt
appears and 应用更新 lands on the new interface. With the mismatch-triggered update check removed, the
prompt did not appear within 90 s, so that test depends on the new code.
`tests/unit/runtime-generation.test.ts` covers the answer table, the request shape, the timeout and the
visibility trigger.

## 6. Gates

Run at `e3dc764` (the last code commit), sequentially, on the development workstation:

| gate                                                              | command                  | result                                                                                                             |
| ----------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| format, lint, typecheck, unit and integration, static scan, build | `npm run verify`         | pass; 38 test files, 524 tests; static scan PASS with 15 rules                                                     |
| E2E, Chromium desktop and mobile (includes every new spec)        | `npm run test:e2e`       | 174 passed, 0 failed, 0 skipped                                                                                    |
| E2E, installed Edge                                               | `npm run test:e2e:edge`  | 20 passed                                                                                                          |
| E2E, Firefox and WebKit                                           | `npm run test:e2e:cross` | first run: 22 passed, 1 skipped, **1 failed** (see below); full re-run: 23 passed, 1 skipped                       |
| accessibility (axe)                                               | `npm run test:a11y`      | 16 passed                                                                                                          |
| deployment copy audit                                             | `npm run audit:copy`     | PASS                                                                                                               |
| UOS: shell lint, deployment tests, signed-off archive             | `npm run verify:uos`     | PASS; deployment tests 138/138; archive checks 56/56 against the signed-off `-5` archive (`969a2a74…`) and its kit |

The skipped test is the WebKit offline-reload test, skipped since `eb4fa43` (2026-09-21) for a reproduced
Playwright WebKit limitation, as at the Phase-5 sign-off.

**The Firefox failure is a pre-existing teardown flake, not a Phase-5.1 regression.** The failing test
(`cross-browser.spec.ts`, "seeds on first run and stores a record that survives a reload") reported one
error only, from Playwright's own context teardown inside Firefox:
`browserContext.close: Protocol error (Browser.removeBrowserContext): can't access property
"_maybeDontRestoreTabs", this._windows[aWindow.__SSi] is undefined`. Run ten times in a row, it failed 7 of
10 on unmodified `main` (built in a temporary worktree) and 0 of 10 on this branch; over all 17 runs on
this branch (the gate run, a re-run of the suite, and repeats of 5 and 10) it failed twice. It was not retried away or masked, and no Phase-5 test was changed for it. It is
an open item for review.

The archive step of `verify:uos` reads the signed-off archive and its acceptance kit from `release/`,
where only the main checkout has them. Byte-identical copies (digests checked against the tracked
sidecars) were placed in this worktree's ignored `release/` for the run and removed afterwards; the
originals were not written, and their digests were unchanged afterwards. Without them the step stops at
"no end-user release archive found", which is what the first sequential run recorded.

## 7. Commits

On `phase-5.1/runtime-update-safety`, in order:

| commit    | subject                                                               |
| --------- | --------------------------------------------------------------------- |
| `8a48e5b` | test(tests): reproduce the classic-scrollbar shell shift              |
| `5f3f448` | fix(ui): stabilise the shell geometry with a root scrollbar gutter    |
| `b589804` | test(tests): reproduce the cross-tab reload on an accepted update     |
| `9c7369b` | fix(pwa): keep other tabs open when one tab applies an update         |
| `56f2886` | feat(pwa): let a waiting worker report open windows without urls      |
| `b2ea518` | test(tests): state only the observed edge update delay in the harness |
| `e3dc764` | feat(pwa): detect a stale interface generation without reloading      |

followed by the documentation commit that adds this record. The two `test(tests)` reproductions carry
expected-failure markers that the following `fix` commits remove, so every commit is green on its own.

## 8. Remaining Phase-6 responsibilities

- Serve `/api/civic/runtime` from `civic-server` with the contract of section 5, reading the active
  release's `app/app-generation.json`.
- A same-origin update page under `/api/` (for example `/api/civic/start`) that the launcher opens: look
  for the new worker, ask the waiting worker for open windows (section 4), refuse to activate while other
  application windows are open, fall back to the explicit warning when there is no answer, and activate
  only on the user's request.
- Move the browser check page from `/__civic/platform` to a path under `/api/`, and update the diagnostic
  text that points to it.
- A packaged-upgrade geometry gate: RC3 upgraded to the new build, measured immediately after the upgrade
  and not only after 应用更新, in a real browser with scrollbars, with RC3's positions as its negative
  control.
- Installer copy for a real upgrade: save and close open pages first.
- The payload gains `app-generation.json` and `sw-client-awareness.js`; the dual-build parity check and
  any file inventory must expect them.
- The rejected releaseId `2026.09.29-win-0.2.0-rc.1` must not be reused; the paused branch's uncommitted
  release records name the rejected digest and must be revised, not committed.

## 9. A timing note on installed Edge

In `update-safety.spec.ts`, where the profile's first page is reloaded right after the worker installs,
installed Edge held the first `registration.update()` back until about 60 s after that point (issued at
30 s, its script request left at 59.7 s; a second call straight after resolved in 16 ms). Bundled
Chromium started the same call at once, and so did Edge in `client-awareness.spec.ts`, whose pages are
never reloaded. Whether installation or the reload is the anchor, and the mechanism, were not established.
It lengthens the Edge project to about a minute per update test; it does not change any outcome.
