# Phase 6 — Windows 0.2.0-rc.1 release engineering

**Dates** in this document are business dates in UTC+8; timestamps carry their offset.
**Status:** a new candidate is built from a pushed, publicly resolvable commit and frozen for independent
pre-publication review. **Nothing is published:** no tag, no GitHub Release, no uploaded asset. RC3 is
not marked superseded. `main` is unchanged.

| item               | value                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| product baseline   | `main` at `a0e0a4ce73e205823e3f6c0fa1d8931c7df6c69b` (Phase 5.1 sign-off)                                           |
| branch             | `phase-6/windows-0.2.0-release-v2`, created from exactly that commit                                                |
| engineering id     | `2026.09.30-win-0.2.0-rc.1` (new; the rejected `2026.09.29-win-0.2.0-rc.1` is spent)                                |
| displayVersion     | `0.2.0-rc.1`; Windows file version `0.2.0.0`; publisher `Rhymer-Lcy`                                                |
| data formats       | databaseSchemaVersion 2, backupFormatVersion 3                                                                      |
| rejected candidate | SHA-256 `4fe9296dbbaf20a85a19d742cfd9a7ae86a2e99c16518ec125718a66fd10eae5`: **remains REJECTED BEFORE PUBLICATION** |
| frozen candidate   | `ebb59400…`, section 12                                                                                             |

## 1. Branches and the port of the first Phase-6 work

The first Phase-6 branch, `phase-6/windows-0.2.0-release` at `b7ef70b`, diverged from `main` at the
Phase-5 sign-off (`3b71dbc`), before Phase 5.1 existed. It is kept exactly as it was — not rebased,
rewritten, merged into or deleted — because it is the provenance of the rejected candidate. Its paused
worktree, with eleven uncommitted release records naming the rejected digest, is also left untouched;
none of those files was copied.

The continuation branch was created from `a0e0a4c` in a separate worktree, and the twenty commits of the
first branch were cherry-picked in order. **All twenty applied cleanly, and each port has the same
`git patch-id --stable` as its original**: none was modified, dropped or squashed on the way.

| old       | new       | subject                                                                 |
| --------- | --------- | ----------------------------------------------------------------------- |
| `880e8c5` | `6011fb1` | feat(windows): accept windows 10 22h2 x64 and refuse server and arm64   |
| `35e80b8` | `b08367a` | feat(windows): refuse rollback or activation onto an older data schema  |
| `61510f4` | `26c94d9` | fix(windows): show launcher failures in a dialog and log each launch    |
| `12abe61` | `bf6db06` | feat(windows): mark non-canonical hosts and drop the rc1 server label   |
| `249a21b` | `d2efbf0` | feat(windows): add a failure-class conclusion and policy facts to diag  |
| `886c8ee` | `f3ea64c` | feat(scripts): derive the windows release identity and refuse spent ids |
| `0125f95` | `9a9dd31` | fix(scripts): require an explicit identity in the resource generator    |
| `0ded90b` | `62cbbf9` | build(windows): build 0.2.0 from source and wire its installer identity |
| `e0088c2` | `1e70533` | fix(scripts): require an explicit identity in the release audits        |
| `79cdbd9` | `b8af52b` | docs(windows): rewrite the tester notice for 0.2.0-rc.1                 |
| `55b0293` | `e670269` | chore(repo): set the product version to 0.2.0-rc.1                      |
| `d4a9d63` | `7486876` | fix(scripts): let a rebuild overwrite its own provenance outputs        |
| `622169f` | `c408e55` | fix(windows): show the upgrade note only on a real upgrade              |
| `755dba9` | `3cac15f` | docs(windows): add the esu note and the canonical security sentence     |
| `9bc6f7d` | `022d5cd` | fix(scripts): run the product build through npm without a shell         |
| `4a1fb74` | `78a2a8d` | test(windows): check dialogs, schema guards and the installed entry     |
| `cf7cd75` | `0476ec1` | test(windows): add the rc3 upgrade acceptance from published bytes      |
| `2733cac` | `12273d7` | test(windows): drive the installer to its ready page in ux acceptance   |
| `a31cb43` | `b10e9a9` | test(windows): run browser acceptance in edge and check the hierarchy   |
| `b7ef70b` | `42990c8` | feat(scripts): let audits examine a release after it is published       |

There were no textual conflicts. Where Phase 5.1 or the rejection invalidated an assumption of a ported
commit, the commit was kept as it was and a new, narrow commit changed the behaviour afterwards:

| ported commit                     | assumption that no longer held                         | changed by                        |
| --------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `62cbbf9` build 0.2.0 from source | the product baseline is the Phase-5 sign-off `3b71dbc` | `b406a55` (baseline `a0e0a4c`)    |
| `f3ea64c` spent ids               | only published ids are spent                           | `756eff1` (rejected ids too)      |
| `c408e55`, `12273d7` upgrade note | its wording                                            | `2926ef8` (the required sentence) |
| `b8af52b` tester notice           | the launcher opens `/`                                 | `2926ef8`, `746f8fe`              |
| `0476ec1` RC3 upgrade acceptance  | RC3's own 有新版本可用 → 应用更新 is the upgrade path  | `9d4ad21`, `efb3bcc`              |
| `b10e9a9` browser acceptance      | the browser is sent to `/`                             | `5e32959`                         |

**Nothing of Phase 5.1 was lost.** `git diff --name-only a0e0a4c <source commit>` lists no path under
`src/` or `public/`, and none of `index.html`, `vite.config.ts`, `tsconfig*.json`, `.npmrc` or the CSS
type generator; `package.json` and `package-lock.json` differ in their `version` field only
(`0.2.0-dev.0` → `0.2.0-rc.1`). The build asserts both before it builds (section 12 records the output
comparison).

## 2. The update check page

### 2.1 Why it exists

The rejected candidate showed that after an upgrade from RC3 the browser can keep running RC3's
interface at `/` for seconds or many minutes: RC3's service worker answers every navigation from its own
precache until the browser finds, installs and activates the newer worker, while the server's
`deployment-health.json`, fetched from the network, already names the new release
(docs/phase-5.1-runtime-update-safety.md §1). RC3 cannot be changed after the fact, and its own
应用更新 reloads every open RC3 tab, taking unsaved input with it. The launcher therefore no longer
opens `/`. It opens a page that the installed program serves and that decides whether `/` is safe to enter.

### 2.2 Where it is served, and why that address

`GET /api/civic/start` (the page) and `GET /api/civic/start.js` (its one script) are embedded in
`civic-server` (`deploy/windows/src/internal/httpserve/bootstrap/`). `/api/` is the one namespace the
application's worker never answers with the application shell (`navigateFallbackDenylist: [/^\/api/]`
in `vite.config.ts`, unchanged since the first PWA commit and therefore present in RC3's worker too), so a
navigation there always reaches the installed server, whichever worker controls the origin. The page is
not part of the application payload, so no precache manifest can contain it.

Headers: `Content-Type: text/html; charset=utf-8` (script: `text/javascript; charset=utf-8`),
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and on the
page `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'unsafe-inline';
connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. GET and HEAD only.
The page loads nothing from any other origin, reads no IndexedDB, local storage or cookie, and inspects
nothing of the browser profile; the one browser storage it touches is one `sessionStorage` flag that
limits it to a single self-reload (step 5 below).

### 2.3 The decision

The page publishes each state on `<body data-state>`; every wait is bounded (`fetch` 10 s, `update()`
150 s, installation 60 s, the worker's answer 3 s, the switch 30 s).

1. **Expected generation.** `GET /api/civic/runtime` (section 3). An error, a non-200 answer or a
   malformed body ends in `error-runtime` with 重试.
2. **Origin.** If the page is not at the canonical origin the runtime names, `error-origin`: records
   live under `http://127.0.0.1:8765` and the user is told to start from the Start menu.
3. **No service-worker support**: enter `/`.
4. **No registration** (a first run): read what `/` serves; if it is the expected generation, enter at
   once, with no prompt. Otherwise `error-incoherent`.
5. **Registered but this page is uncontrolled** (a forced reload bypassed the worker): reload once, then
   `error-uncontrolled`.
6. **Ask the browser now.** `registration.update()`, then wait for a worker that is installing.
7. **Read what `/` would run.** `fetch('/index.html', { cache: 'no-store' })` from this controlled page
   is answered by the controlling worker exactly as a navigation to `/` would be: from its precache
   when it has one. The entry chunk named in it is the generation `/` would run. If that is the expected
   generation, enter.
8. **Stale, and nothing newer waiting**: `error-stale`, with 重试.
9. **Stale, a newer worker waiting**: ask the WAITING worker `CIVIC_WINDOW_CLIENTS` (the Phase-5.1
   protocol, version 1). The waiting worker is the new generation, which carries the protocol; RC3's
   active worker does not. The answer is read strictly:
   - another window of kind `application` is open → `blocked`: “检测到其他政务工作记录台页面仍在打开。
     请先保存其中尚未保存的内容并关闭这些页面，然后再进入新版本。” with the count and 重试;
   - no other application window → `ready`, with the button 进入新版本;
   - anything else → `unknown`, with 重试: no answer within 3 s, a malformed answer, another protocol
     version, a worker state other than `installed` (or `unknown`, which the protocol reports when the
     worker cannot read its own state), the requesting window not identified exactly once,
     the post failing, or a different worker waiting by the time the answer arrives. Unknown is never
     read as “no other window”.

   Windows of kind `bootstrap` (`/api/civic/start`), `platform` (`/api/civic/platform`), `service`
   (other `/api/` paths) and `outside-scope` never block.

10. **重试 always asks again.** No earlier answer is reused.

### 2.4 Activation

Only 进入新版本 activates. It reads the expected generation again, asks the waiting worker again, and
proceeds only on a fresh “no other application window”. It then posts `SKIP_WAITING` to that worker,
waits for the controller to change, and **reads what `/` would run once more**. Only the expected
generation enters `/` (`location.replace('/')`); anything else stays on `error-after-switch`, with 重试
and the diagnostic instruction, and never falls through to the old interface. A switch made elsewhere
(an RC3 tab's own 应用更新) changes the controller, and the page checks again from step 1.

The page never clears Cache Storage or IndexedDB, never unregisters a worker, never changes the origin or
port, never closes, reloads or saves another tab, and never disables service workers.

### 2.5 Who opens it

`civic-launch` opens `origin + httpserve.StartPath` in the default browser; when the browser cannot be
opened, the dialog gives that address to type. The installer's 立即打开 runs the launcher. The
tester notice and the installer's finish page describe the page in one sentence each.

## 3. `GET /api/civic/runtime`

```json
{
  "schema": "civic-runtime/1",
  "appGeneration": "ui-<hash>",
  "releaseId": "…",
  "canonicalOrigin": "http://127.0.0.1:8765"
}
```

`schema` and `appGeneration` are the contract the shared application reads
(`src/app/pwa/runtime-generation.ts`); `releaseId` and `canonicalOrigin` are deployment fields the check
page uses. The generation comes from the **active** release's `app/app-generation.json`, re-read on
every request and validated each time: a regular file of at most 64 KiB; JSON with exactly the fields
`schema`, `appGeneration`, `entry`; schema `civic-app-generation/1`; `appGeneration` of the form
`ui-<hash>` whose hash is the entry chunk's; the entry chunk present; and `index.html` loading exactly
that chunk. Anything else answers **503** with `{ "schema": "civic-runtime/1", "error": "<reason>" }` and
no generation, so neither the application nor the check page can mistake a broken release for a current
one. The reason names a file, never a location (`3f7d0db`: an operating-system error would otherwise
have put the install path, and with it the Windows user name, into the answer). Both answers are
`application/json; charset=utf-8`, `Cache-Control: no-store`, `nosniff`; GET and HEAD only. It carries
no user, business or browser data.

## 4. `GET /api/civic/platform`

The browser check page moved here from `/__civic/platform`, which a controlling worker answers with the
application shell. The probe itself is unchanged. `/__civic/platform` answers `302` to the new address
with `no-store`, so an old bookmark still arrives; nothing names the old address any more (launcher
menu, diagnostic text, tester notice, copy inventory). Every other `/api/` path is `404` and is never
read from disk; `civic-admin` refuses a payload with a file under `/api/` or `/__civic/`.

## 5. Installer and launcher

- **Ready page** (“准备安装”): always shows the effective directory, the install type (全新安装, 升级
  from a named release, or 修复), the version with its engineering id, and the canonical address. On a
  real upgrade only, it adds “升级前请保存并关闭已打开的政务工作记录台页面。”; a clean install and a repair
  do not show it.
- **Finish page**: one sentence on what the check page does after an upgrade.
- **Activation** refuses a release that cannot state its interface generation (`358cfab`).
- **Silent runs never wait on a dialog.** Every message box a silent install or uninstall can reach is a
  `SuppressibleMsgBox`, so `/SUPPRESSMSGBOXES` silences it; an interactive run shows the same boxes as
  before (`9f5aa4f`, section 10.5).

## 6. Release identity and the rejected-release registry

See docs/versioning-and-publisher.md, “Phase 6”. In short: every build and audit script requires an
explicit id; `scripts/windows/published-releases.json` and `scripts/windows/rejected-releases.json`
record the spent ids; a rejected id is refused for every purpose; `tests/unit/release-identity.test.ts`
proves both classes are refused and that a damaged registry fails closed. The rejected binary is not
tracked.

## 7. Windows target policy

| system                                  | policy                                                      |
| --------------------------------------- | ----------------------------------------------------------- |
| Windows 11 x64                          | primary target                                              |
| Windows 10 22H2 x64 (build 19045)       | legacy-compatibility target, with the end-of-support notice |
| Windows 7, Windows 8, Windows 8.1       | unsupported; refused before anything is written             |
| other Windows 10 builds, Windows Server | unsupported; refused                                        |
| x86 (32-bit) Windows                    | unsupported; refused                                        |
| ARM64                                   | unsupported for this x64 artifact; refused                  |

Neither target is certified. The candidate has been accepted on one Windows 11 development workstation
only; it has not run on a colleague's computer or on Windows 10 hardware, and nothing here claims it has.

## 8. Rollback policy

After this release has migrated the browser database to schema 2, RC3 (schema 1) is not a safe rollback
target: RC3 would edit records without knowing their parent links. `civic-admin rollback` refuses it
(exit 4, “older browser-database schema”) and leaves this release active and intact; `civic-launch
status` says RC3 is not a safe rollback target. There is no database downgrade.

## 9. Acceptance on the installed bytes

`scripts/windows/acceptance-upgrade.mjs` installs RC3 from the bytes on its GitHub Release (digest
checked) and uses it in persistent profiles of the installed Microsoft Edge, started with its ordinary
command line (classic scrollbars; sync off, see 10.2):

| scenario | before the upgrade                                                    | required after it                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A        | one RC3 tab with records of every kind, closed as the Ready page asks | 进入新版本 offered; after it, the installed generation runs; every data check below                                                                                                                                         |
| B        | tab A, and tab B with unsaved text in 新增工作记录, both left open    | refused, count 2; both tabs, their documents and the text intact; after tab A closes, 重试 counts 1; after the text is saved deliberately and tab B closes, 重试 offers 进入新版本; the saved record survives the migration |
| C        | three RC3 tabs left open                                              | refused, count 3; still refused with one left; offered only when none is left                                                                                                                                               |
| D        | no application tab; the browser check page and a service answer open  | not blocked; the worker classifies them as `platform` and `service`                                                                                                                                                         |
| N        | RC3 used, then closed                                                 | `/` opened directly runs RC3 (the rejected candidate's defect, reproduced); after the check page, the installed generation                                                                                                  |

In scenarios A, B and D the check page's own worker question is also asked directly, from the harness:
the candidate's waiting worker must answer `CIVIC_WINDOW_CLIENTS` version 1 in state `installed` and list
the windows the scenario opened; in B, RC3's active worker is asked the same question and gives no answer.

**Geometry** (section 19 of the brief): in scenario N and in A, at 1366×768, 1920×1080, 2047×1001 and
2560×1440, on all six routes, the brand's left edge, every destination's left edge and the action slot's
right edge are measured; the largest route-to-route difference must be at most 1 CSS px, measured after
the check page has entered and the generation has been verified. The measurement uses structural
selectors so that it applies to RC3 unchanged. **Negative control:** RC3's interface, measured the same
way before the upgrade and again when `/` is opened directly after it, must fail, at least at 2047×1001.
The gate refuses to pass unless Edge really draws classic scrollbars and, in N, every size has a route
that scrolls and one that does not.

**Data**, in profile A: the database moves from IndexedDB version 10 to 20; every RC3 row is present and
otherwise unchanged; every work record gains exactly `parentWorkId: null`; progress, categories, groups
and settings are byte-for-byte what RC3 left; the honour's link resolves. Then a 2级 and a 3级 sub-task
under an RC3 record; a complete format-3 backup; its exact restore into a fresh profile (which the check
page enters without any prompt); the XLSX and DOCX exports; RC3's own backup restored into this release;
a browser restart, a program restart and offline use with the server stopped, each with every store
unchanged; and the refused rollback with the data still there. No request may leave the origin.

## 10. Rehearsal builds and what they found

Rehearsal installers were built from intermediate pushed commits, under the same engineering id, to
develop the acceptance before freezing. **They are not candidates**: each was overwritten by the next, and
the last was deleted before the frozen build.

| rehearsal | source commit | bytes     | SHA-256 (not a candidate)                                          |
| --------- | ------------- | --------- | ------------------------------------------------------------------ |
| 1         | `9d4ad21`     | 6,968,115 | `5fa150365e03160e6a6cfa39bf01cd3f626e86f788ae0ba0a2faab0de452a379` |
| 2         | `746f8fe`     | 6,970,801 | `472c6e156ddba5d1c5cba9e652bcad297db0bfefaa3d8cf0012e4b80e0e51e51` |
| 3         | `efb3bcc`     | 6,970,712 | `d18de8d51c5c3fc66d16c383796f454a872e511ac3d9069c04a67ca655385b42` |
| 4         | `d104035`     | 6,974,318 | `42f9825c5e4826dc59febf19aa295e4fb7e73d926b1bad36d0c41db975473a0b` |

### 10.1 An RC3 upgrade blocked by this phase's own check (rehearsal 1, `9d4ad21`)

The installer exited with code 7 (“cannot proceed”). The pre-install runtime preflight runs civic-admin's
payload checks on the release that is **already active** — RC3 — and `830a604` had added “this release
states its interface generation” to those checks. RC3 predates `app-generation.json`, so every upgrade
from RC3 was blocked, and the installer then showed its port-conflict message. The Go test asserted
exactly that outcome, on the unexamined assumption that these checks only judge the release being
installed. `358cfab` reports the file's absence as `NOT PRESENT` (not
blocking), keeps a present-but-wrong file blocking, and moves the requirement to activation of the
release being installed. Both halves were mutation-tested.

### 10.2 The operator's browser sync inside throwaway profiles (rehearsal 2, `746f8fe`)

155 of 156 checks passed; the failure was two requests to extension websites. On a Windows session
signed in with a Microsoft account, Edge signs every new profile in to that account implicitly and starts
syncing it: a few minutes in, the operator's own extensions appeared in the test profiles and opened their
welcome pages. That also put the operator's synced data into profiles that must hold synthetic data only.
`efb3bcc` starts Edge with `--disable-sync` (as Playwright's launch already does) and deletes the
profiles after a passing run. Edge still signs the profiles in (7 of 7 in rehearsal 3); with sync off,
no request left the origin.

### 10.3 Rehearsal 3 (`efb3bcc`)

RC3 upgrade: 157 checks, none failed. Deploy: 168 checks, none failed. UX: 207 checks, one failed.
Browser: 81 checks, none failed. The UX failure was its provenance
check: during the run the local branch was ahead of origin by unpushed documentation commits, so
“reachable” could not be proven. That is the operator's fault, not the build's, and the frozen run is
made from a pushed, unchanged branch. The browser acceptance needs the installation `acceptance-deploy.mjs --keep` leaves behind; the
runner had called it first, so it was run again, separately, against that installation.

### 10.4 Found in review of this phase's own code

- The runtime refusal carried an operating-system error with the install path in it (section 3;
  `3f7d0db`).
- civic-admin's check that no payload file shadows the server's reserved paths built `//__civic/...`
  from `app/__civic/...` and could never fire (`830a604`, now tested for both namespaces).

### 10.5 A silent uninstall that waited for someone to press OK (pre-existing since RC1)

Preparing the product gates, a `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES` run was still alive five
minutes later. Inno's uninstaller copies itself to `%TEMP%` as `_unins.tmp` and returns at once; the copy
had finished the work (files and the uninstall key were gone) and was showing the closing notice
“政务工作记录台已卸载。……” in a window titled “政务工作记录台 卸载”, because a plain `MsgBox` ignores
`/SUPPRESSMSGBOXES`. Every scripted uninstall therefore left that dialog on the screen, and no acceptance
suite noticed, because each waited for `unins000.exe` alone. `9f5aa4f` makes that notice and the four
other message boxes a silent run can reach suppressible (the Windows 10 notice was already skipped when
silent). `6d3b693` adds `scripts/windows/silent-uninstall.mjs`, which waits, bounded, for the second phase
of an uninstall to end by itself; the UX acceptance asserts it for each of this release's uninstalls and
the upgrade acceptance for its last one. A second phase that is still waiting is closed the way its OK
button would close it, so no run leaves a dialog behind. RC3's uninstaller carries the same plain
`MsgBox` (the notice dates from the first installer commit, `ead96d2`) and cannot be changed.

### 10.6 The first product-gate runs: lint, then the static scan

Rehearsal 4 (`d104035`) passed every installer-level acceptance, and the product gates were then run on
that commit. During development only `scripts/windows/` had been linted and the static scan had not been
run, and `npm run verify` failed twice:

1. **Lint** (`d104035`): `eslint .` reached the new `bootstrap/start.js`, which belongs to no TypeScript
   project, so the type-aware parser refused it. `399c4ce` lints it as a classic browser script, the way
   `public/sw-client-awareness.js` already is, and removes what the linter then reported: three unused
   `catch` bindings, and an index loop now written as `for…of`. Behaviour is unchanged; the Go tests
   that serve the file and the update-check suites in Chromium and Edge cover it again in the gates.
2. **Static scan** (`789a030`): the Phase-5.1 rule `runtime-endpoint-caller`, which admits one caller of
   `/api/civic/runtime` in `src/`, reported eight lines in this phase's Windows tooling: a comment in
   `build-release.mjs`, and Node-side checks, labels and comments in `acceptance-deploy.mjs` and
   `acceptance-upgrade.mjs`. None is a caller inside the application. `f1091c7` rewords the comment and
   adds those two harnesses, by name, to the rule's documented exceptions beside `tests/`. The update
   check page's own call is in `deploy/`, which the scan does not cover (section 11).

Each time the gate run was stopped, and every gate was run again from the start on the new commit.

## 11. Known limitations

- **RC3 cannot be protected from itself.** An RC3 tab shows RC3's own 有新版本可用 once the new worker is
  waiting, and pressing its 应用更新 activates the new worker without asking anyone; RC3 then reloads
  its other tabs, and unsaved input in them is lost. The check page cannot prevent a click in another
  tab. What protects the upgrade is procedural: the Ready page asks to save and close the old pages
  before installing, the tester notice says the same, and the check page itself refuses while old tabs
  are open. From 0.2.0 on, the product's own guard (Phase 5.1) blocks this in the new generation.
- **The static scan does not read `deploy/`.** Its Phase-5.1 rules admit one caller of
  `/api/civic/runtime` and one sender of `SKIP_WAITING`, both in the application; the update check page
  is a second of each, by design. It is covered instead by the Go tests (the served bytes are the
  reviewed files, with no forbidden construct) and by the update-check suites in Chromium and Edge.
- **The check page needs the local server.** It is served by `civic-server` and not precached, so it
  cannot open while the program is stopped; offline use is `/` directly, served by the worker. The
  launcher always starts the server first.
- **Edge's delayed first `update()`** (about 60 s after a fresh install and reload, docs/phase-5.1 §9)
  was not observed in any run that reached the check page (the frozen run's timings are in section
  12.3). The 150 s bound and 重试 remain for the case where it happens.
- **The installer's pre-install message.** A failed runtime preflight is always reported as a port
  conflict, whatever check failed (pre-existing since RC2). The diagnostic file it writes names the real
  cause, which is how 10.1 was diagnosed. Left for review rather than changed in this phase.
- **Unsigned.** The installer carries no Authenticode signature; SmartScreen may warn. Users are never
  told to disable Defender or SmartScreen.
- **One workstation.** All acceptance ran on one Windows 11 development machine, one operator, with
  installed Edge. Windows compatibility is not certified; Windows 10 22H2 has not been tested on real
  hardware.
- The tester notice already says “本版本取代 RC3 用于新的现场验证”, which describes the intended use once
  published; nothing on GitHub marks RC3 superseded.

## 12. Frozen candidate and acceptance

Every figure below was composed by a script from the frozen run's own logs, its JSON records and the
installer file itself.

### 12.1 The frozen candidate

| item                                      | value                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deploymentSourceCommit                    | `5ccf809da96fa7ee72dc1fbc1b82debfef7d4514`                                                                                                                                 |
| GitHub                                    | `GET /repos/Rhymer-Lcy/civic-work-desk/commits/5ccf809` returns that SHA; the head of `phase-6/windows-0.2.0-release-v2` on GitHub is that SHA (2026-09-30T02:31:22+08:00) |
| product baseline                          | `a0e0a4ce73e205823e3f6c0fa1d8931c7df6c69b`                                                                                                                                 |
| engineering releaseId                     | `2026.09.30-win-0.2.0-rc.1`                                                                                                                                                |
| displayVersion / file version / publisher | `0.2.0-rc.1` / `0.2.0.0` / `Rhymer-Lcy`                                                                                                                                    |
| installer                                 | `CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe`                                                                                                                           |
| size                                      | 6,973,273 bytes                                                                                                                                                            |
| SHA-256                                   | `ebb594005f8765959bf91d3ef63624c885f249a3a095a4825ced9acf81e72c1d`                                                                                                         |
| Authenticode                              | NotSigned (unsigned)                                                                                                                                                       |
| payload                                   | 30 files in the release manifest                                                                                                                                           |

The commits that follow `5ccf809` on the branch add only this section and the candidate's provenance
files (`release/windows/provenance/2026.09.30-win-0.2.0-rc.1-*` and the installer's `.sha256`); they
change nothing the installer was built from.

### 12.2 Product payload parity (section 23 of the brief)

The build compared two clean builds, of `a0e0a4c` and of the source commit: 25
files, byte-identical. Independently of the build script, `main` was exported again with `git archive`,
built, and its `dist/` compared file by file with the candidate's staged `app/`:

| item             | clean `main` build          | packaged candidate                                                                    |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------- |
| appGeneration    | `ui-CNP0PG2u`               | `ui-CNP0PG2u`                                                                         |
| entry script     | `assets/index-CNP0PG2u.js`  | same file, SHA-256 `4a0d36e66544cd1e0564a6856501ad52c3f4fd37aa12d7f612a8cece7708d477` |
| entry stylesheet | `assets/index-Dx_Si0bo.css` | same file, SHA-256 `85276b7ceead693f3d9da971ed302fe14b0f57865fccc4ae4eca3eabdb5442a5` |
| files            | 25                          | 26                                                                                    |

25 files are identical on both sides; the only other file is `deployment-health.json`,
the deployment metadata the release adds. No file differs and none is missing.

### 12.3 Acceptance against the frozen bytes

| suite                    | checks   | failed     |
| ------------------------ | -------- | ---------- |
| identity (artifact)      | 66       | 0          |
| provenance (built)       | 13       | 0          |
| RC3 upgrade              | 158      | 0          |
| installer UX             | 215      | 0          |
| deploy                   | 168      | 0          |
| identity (installed)     | 70       | 0          |
| browser (installed Edge) | 81       | 0          |
| privacy scan             | 34 files | 0 findings |

Checks marked INFO are counted in “checks” and cannot fail.

**Update check page, measured in installed Microsoft Edge** (state reached, time from opening the page
or from pressing the button):

| scenario                                        | result                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| N: after the upgrade, RC3 had been used         | ready, 1.9 s                                                                                     |
| A: one tab, closed before the upgrade           | ready, 2.2 s                                                                                     |
| B: two tabs, one with unsaved text              | blocked, 0.2 s; tab A closed, 重试: blocked, 0.2 s; text saved, tab B closed, 重试: ready, 0.2 s |
| C: three tabs                                   | blocked, 0.2 s; two closed, 重试: blocked, 0.2 s; last closed, 重试: ready, 0.2 s                |
| D: browser check page and a service answer only | ready, 2.1 s                                                                                     |
| a fresh profile (first run)                     | entered, 0.2 s                                                                                   |
| after a browser restart                         | entered, 2.1 s                                                                                   |
| after a program restart                         | entered, 0.2 s                                                                                   |

The hold of about 60 s before a first `update()` that installed Edge showed in the Phase-5.1 suite
(docs/phase-5.1-runtime-update-safety.md §9) was not observed in any of these flows.

**Packaged geometry**: largest route-to-route shift over the brand, the six destinations and the action
slot, in CSS px (classic scrollbar width measured: 15 px):

| interface                                                       | 1366×768 | 1920×1080 | 2047×1001 | 2560×1440 |
| --------------------------------------------------------------- | -------- | --------- | --------- | --------- |
| RC3, before the upgrade (negative control)                      | 93 px    | 370 px    | 370 px    | 370 px    |
| RC3 served at `/` after the upgrade (negative control)          | 93 px    | 370 px    | 370 px    | 370 px    |
| this release, after the check page (profile N)                  | 0 px     | 0 px      | 0 px      | 0 px      |
| this release, after the check page, RC3-era records (profile A) | 0 px     | 0 px      | 0 px      | 0 px      |

### 12.4 Product and platform gates on the source commit

| gate                                                                          | result                                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run verify` (format, lint, typecheck, unit, static scan, build)          | pass; 570 unit tests                                                |
| Chromium desktop and mobile (`test:e2e`)                                      | 201 passed, 0 skipped, 0 flaky                                      |
| installed Edge (`test:e2e:edge`)                                              | 47 passed, 0 skipped, 0 flaky                                       |
| Firefox and WebKit (`test:e2e:cross`)                                         | 23 passed, 1 skipped, 0 flaky                                       |
| accessibility (`test:a11y`)                                                   | 16 passed, 0 skipped, 0 flaky                                       |
| copy audit                                                                    | pass                                                                |
| Go tests (`test:windows`)                                                     | pass; 9 packages                                                    |
| UOS regression (`verify:uos`, the signed-off -5 archive, digest-checked copy) | pass; 138 deployment tests (0 failed), 56 archive checks (0 failed) |

The one skipped test is WebKit's offline reload in `tests/e2e/cross-browser.spec.ts`, skipped since
before this phase for a Playwright WebKit harness fault documented in that file; the file is unchanged
from `main`, and Chromium and Firefox run the same case.
