# HarmonyOS — feasibility

**Date:** 2026-09-29 (UTC+8). **Status:** feasibility only. There is no HarmonyOS code, ArkTS shell, build
or store package in this repository, and Phase 5 adds none. A HarmonyOS edition would be a **separate
future project** that reuses the application source; this document is its starting brief.

## Sources

Huawei's documentation portal renders client-side, so each page was read on 2026-09-28 through the JSON
endpoint the page itself calls, which returns the same body and the page's `updatedDate`. Pages relied on
(all under `https://developer.huawei.com/consumer/cn/doc/`):

| topic                            | page                                                                                                                                                                                                                                     | updated    |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| device types                     | [module.json5配置文件](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/module-configuration-file)                                                                                                                          | 2026-09-23 |
| app model, packages              | [应用模型概述](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/stage-model-development-overview), [应用程序包结构](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/application-package-structure-stage)      | 2026-09-23 |
| ArkWeb engine versions           | [ArkWeb简介](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-component-overview)                                                                                                                                       | 2026-09-23 |
| local loading, cross-origin      | [使用Web组件加载页面](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-page-loading-with-web-components), [解决Web组件本地资源跨域问题](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-cross-origin) | 2026-09-23 |
| storage switches, sandbox        | [Web属性](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-attributes), [应用沙箱目录](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/app-sandbox-directory)                  | 2026-09-23 |
| upload and download              | [使用Web组件上传文件](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-file-upload), [使用Web组件的下载能力](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-download)                                | 2026-09-23 |
| signing and publishing           | [发布应用](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-publish-app)                                                                                                                                                | 2026-09-15 |
| review guidelines                | [应用审核指南](https://developer.huawei.com/consumer/cn/doc/app/50104)                                                                                                                                                                   | 2026-09-22 |
| qualifications                   | [应用资质审核要求](https://developer.huawei.com/consumer/cn/doc/app/80301)                                                                                                                                                               | 2026-08-31 |
| APP filing                       | [APP核准（APP备案）指引](https://developer.huawei.com/consumer/cn/doc/app/50130)                                                                                                                                                         | 2026-06-25 |
| hosted privacy policy            | [配置隐私政策（HarmonyOS应用）](https://developer.huawei.com/consumer/cn/doc/app/agc-help-privacy-policy-app-0000002282162168)                                                                                                           | 2026-06-25 |
| developer real-name verification | [实名认证介绍](https://developer.huawei.com/consumer/cn/doc/start/itrna-0000001076878172)                                                                                                                                                | 2026-04-22 |

Statements marked **(analysis)** are reasoning from those pages, not Huawei statements.

## Conclusion

Technically feasible as a **thin ArkTS shell around the same React application**: one Stage-model `entry`
HAP declaring `deviceTypes` `phone`, `tablet` and `2in1` (the value `default` “虽然可以正常编译构建，但是不支持发布上架”),
the built SPA in `resources/rawfile`, served through an https virtual domain, plus two small native bridges.
The regulatory path looks light for a genuinely offline app. **Two unknowns gate any commitment**, and
neither can be settled by reading:

1. whether ArkWeb's IndexedDB survives the system's automatic cache cleanup — a **device test**;
2. whether reviewers accept an offline bundled web app under guideline 3.5 — a **submission**.

## Why this is a separate project

- It needs an ArkTS/ArkUI shell, DevEco Studio, an AppGallery Connect account and an `.app` App Pack —
  none of which belongs to the desktop build or to its tests.
- What is shared is the application source (`src/`), built with a HarmonyOS-specific configuration. What
  is not shared is packaging, origin, storage location and file export (below).
- Nothing in this document changes the Windows or UOS products.

## The origin model does not transfer

The desktop editions run at one fixed origin, `http://127.0.0.1:8765/`, served by a local server; the
browser keys IndexedDB to it. ArkWeb has no such server, and its documented local-loading routes give a
different origin:

- `resource://rawfile/...` or `file://...`: “ArkWeb内核禁止file协议和resource协议访问跨域请求”, which breaks
  module and chunk loading; the storage origin string for these schemes is not documented.
- **https virtual domain with request interception** — Huawei's recommended fix: the app answers
  `https://<domain>/...` from `rawfile` through `onInterceptRequest` (or a `SchemeHandler`). This is the only
  documented route that gives an ordinary https origin, and the one to use.

Consequences:

- **Choose the domain once and never change it** — IndexedDB is keyed on it. Huawei's wording requires a
  self-constructed name that cannot collide with a real site; use one the project controls.
- **Data does not move between a desktop edition and a HarmonyOS edition** except through the JSON backup.
  The HarmonyOS UX must say so.
- **The CSP transfers unchanged** under this route: every directive in `index.html` is `'self'`-based
  (plus `data:`/`blob:` images) and names no host, so `'self'` becomes the virtual domain.
- **localStorage** is off by default in ArkWeb (`domStorageAccess`). The application uses it only for
  cosmetic preferences, and `src/services/storage/persistence.ts` already tolerates its absence; the shell
  should still enable it.
- **The service worker** (registered through `vite-plugin-pwa`) should be disabled in the HarmonyOS build:
  the assets are already inside the package, and a second cache over an intercepted origin is untested
  (analysis).

## Storage durability — the gating device test

- The sandbox `cache/` directory is cleaned automatically when over quota or when the system is short of
  space: “此路径下存储的数据可能会被系统自动清理，因此不要存储重要数据”.
- ArkWeb's default download and temporary directories are under `cache/web`. **Where IndexedDB is stored is
  not documented**, and no page says whether `cache/web` is exempt from cleanup (analysis: it may not be).
- If a device test shows IndexedDB can be lost, the shell must mirror the canonical JSON into `filesDir`
  through a JS-to-ArkTS bridge on save, and restore from it on start. IndexedDB is not trusted as the only
  copy until that test passes.
- **Uninstall deletes the sandbox**, and with it all records. Survival across an app update (same bundle
  name and signing identity) is expected but not stated on any page read.

## Files: import works, export needs native code

- **Import** (`<input type="file">`): ArkWeb's default chooser opens the file manager, so the current import
  works without native code.
- **Export**: every file the application produces — JSON backup, recovery file, XLSX ledger, DOCX report —
  is saved as a Blob through `<a download>` by one helper, `downloadBlob` in `src/services/download.ts`.
  In ArkWeb a download goes to a sandbox directory — “默认路径在应用沙箱的web目录内，用户无法查看” — unless
  app code sets the path. Whether `blob:` downloads reach the download delegate is undocumented. The
  predictable design is a bridge that passes the JSON to ArkTS, which writes it through
  `DocumentViewPicker.save()` (analysis); because all four exports share the helper, one bridge covers
  them.

## Engine floor

ArkWeb is Chromium: **M114** on HarmonyOS 4.1–5.1, M132 on 6.x, M144 by default on 7.0. The build targets
`es2023`, whose syntax M114 supports. A search of `src/` for a list of runtime APIs newer than M114
(`Object.groupBy`, `Promise.withResolvers`, the new `Set` methods, `Array.fromAsync` and others) found none,
and the CSS features in use (`:has()`, `dvh`, `color-mix()`) are all older than M114. That search is not an
exhaustive audit; the M114 device test is. The Web component's controller is available from API 12 on
phone and tablet and API 13 on `2in1`.

## Review risks

| guideline                 | text or rule                                                                                                       | exposure for this product                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.5                       | “应用不得是简单打包的网站页面或套用模板、内容聚合、罗列链接、广告推广等”                                           | **the main risk.** An offline app with its own data and exports differs from a URL wrapper, but there is no published safe harbour; the reviewer decides         |
| 3.7                       | saturated categories, whose examples include 记事本 and 记账, may be rejected unless the experience is distinctive | the listing must lead with the civic-work function, not present a generic notes or to-do tool                                                                    |
| 2.5, 3.13                 | no hot updates; no code downloaded to change the app                                                               | the SPA ships inside the `.app` and is never fetched at run time                                                                                                 |
| 1.1                       | name at most 15 Chinese characters, matching the name on the software-copyright certificate                        | 政务工作记录台 is 7 characters. The qualification page makes the certificate optional, so the name check presumably applies only when one is supplied (analysis) |
| 1.14, 1.15                | no “官方、权威” wording; no unauthorised government marks                                                          | **the name contains 政务.** The listing must not imply official status; and “如应用与政府官方存在合作关系行为的，需提供与官方的合作授权” (qualifications)        |
| common rejection reason 5 | UX defects such as display problems in dark mode or insufficient contrast                                          | the application is light-only (`color-scheme: light`); how that is judged under system dark mode is a device check and possibly a review question                |

Risk reducers (analysis): native ArkUI elements for the privacy consent, settings, about and export
screens; system back-gesture handling; no visible browser chrome; no external link as a main function.

## Privacy, identity, filings

- **Privacy policy** (7.1): a link in AppGallery Connect **and** in the app, with identical content, always
  reachable. AGC's hosted privacy policy (隐私托管) satisfies the reachable link for mainland apps on phone,
  tablet and PC/2in1, so no project web server is needed. The in-app copy may be bundled offline.
- **Privacy label**: a mandatory AGC form of data collected. For this product it declares none — and the
  policy text may say only what is true (offline, no account, no telemetry); nothing is invented.
- **Developer account**: individual or enterprise, with real-name verification. Individuals submit apps (the
  qualification page asks individual developers for a 个人开发者承诺函). The publisher identity stays
  unresolved until that account exists — see [versioning-and-publisher.md](versioning-and-publisher.md).
- **APP filing**: AGC offers the choice “您的APP为单机APP”, defined as
  “单机应用定义：未通过连接公共互联网提供互联网信息服务的移动应用程序”. A build with no telemetry, no update
  check, no remote fonts or CDN and no external link as core function fits that definition, so no APP filing
  appears to be needed (analysis). **Any later online feature ends the exemption** and requires filing before
  the next release.
- **Software copyright certificate (软著)**: the qualification page marks it 非必选资质 — recommended, not
  required.

## Signing

The store unit is an `.app` App Pack of Release type built in DevEco Studio.

- From version **26.0.0**, DevEco Studio re-signs the package on upload, with an AGC cloud-managed
  certificate or the developer's own (mainland China only).
- Below 26.0.0, the developer generates a `.p12` key and a CSR, then obtains a release certificate (`.cer`)
  and a release profile (`.p7b`) from AGC.

The page does not say whether 26.0.0 is the IDE or the SDK version. Either way, keep the bundle name and
signing key permanently: the APP-filing record carries the package name, public key and signature MD5.

## Device tests before any commitment

On one HarmonyOS 5.x (M114) device and one current device (M132/M144), phone and PC/2in1 at least:

1. Load the production build through the https virtual domain; confirm hash routing, chunk loading and the
   unchanged CSP.
2. Create about 10 MB of records; kill and relaunch; update the app with the same signature; relaunch;
   compare a full JSON backup before and after.
3. Trigger system storage cleanup and the app's clear-cache action; confirm whether IndexedDB survives, and
   record the on-device path where IndexedDB files are written.
4. Backup export: does `<a download href="blob:...">` reach the download delegate? Compare with the
   bridge-to-picker route. Repeat for XLSX and DOCX.
5. Backup import through `<input type="file" accept=".json">` on phone, tablet and PC.
6. Dark mode, contrast and text scaling with the light-only theme.
7. The Phase-5 schema v1 → v2 migration is irrelevant here (a HarmonyOS edition starts at the current
   schema); instead, restore a desktop JSON backup and confirm the task hierarchy, ids and counts round-trip.

## Entry criteria for the future project

A HarmonyOS project starts only when the owner decides to pursue it, a developer account exists, and
device tests 2 and 3 pass. Until then this document is the whole of the HarmonyOS work.
