# ADR 0001 — PWA first; no native wrapper in Phase 1

- **Status:** Accepted
- **Date:** 2026-09-21
- **Supersedes:** the legacy prototype's `file://` single-file distribution

## Context

The product being replaced was one 3,590-line HTML file, opened by double-clicking it. Its Settings
text read 「本工具为纯本地单文件，不联网也能完整使用」, and it rendered an "install to desktop" button.

Three facts from the audit (`docs/legacy-audit.md`, findings M4 and M5) frame this decision:

1. **It was not actually installable.** `grep -ci serviceworker` over the file returns 0. Its
   manifest was built at runtime and attached as a `blob:` URL. Chrome requires a same-origin
   manifest _and_ a service worker with a fetch handler before firing `beforeinstallprompt`, so the
   install button could never appear in any browser.
2. **`file://` breaks the platform APIs this product needs.** Service Workers are unavailable, the
   Storage persistence API is unavailable, and IndexedDB behaviour under an opaque origin varies by
   browser and by browser version. The `downloadSelfFile()` feature meant to support this mode was
   itself broken under it: `fetch(location.href)` fails on `file://`.
3. **It needs no privileged OS capability.** Records, dates, filtering, reports, exports — all of it
   is browser-native. Nothing reads the filesystem outside a download, no OS notifications, no
   background process, no hardware access.

## Decision

The Phase-1 deliverable is a **local-first, installable Progressive Web App**.

Supported runtime modes:

1. **Production** — served over HTTPS from a static host.
2. **Local** — `localhost` / `127.0.0.1` loopback, for development, audit, demonstration and fully
   local operation. This is a _secure context_, so Service Workers, the Storage API and Web Crypto
   all work.
3. **Installed** — added to the desktop or home screen; works offline once the shell is cached.

**`file://` is explicitly not supported as a reliability guarantee.** The application detects it and
says so plainly in Settings rather than degrading silently.

Electron and Tauri are **not** part of Phase 1.

## Why not a native wrapper

|               |                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability    | Nothing in the product needs one. A wrapper would add an update channel, a code-signing requirement and a per-OS build matrix to deliver the same web view.                     |
| Surface       | Electron ships a Chromium and a Node runtime; both become this product's responsibility to patch. Tauri is lighter but still adds a Rust toolchain and a platform build matrix. |
| Reach         | One PWA codebase serves Windows desktop and mobile/tablet browsers. A wrapper serves whichever desktops are built and signed.                                                   |
| Reversibility | This is the cheap direction to change. A Tauri shell can wrap this build later with no change to the application; going the other way means unpicking native APIs.              |

## Why not keep the single file

Convenience of distribution was real, and it is what the `file://` mode bought. It is outweighed by:

- **No build, no modules, no tests.** The single file could not be split, type-checked or tested,
  which is precisely how five inconsistent definitions of "overdue" came to coexist in it.
- **Data was in the artefact.** ~180 real records lived in source. Sending someone the application
  meant sending them the data.
- **No dependency management, no CSP, no integrity story.**

## Consequences

**Accepted:**

- A static host or a local server is now required; the application cannot be emailed as one file.
  `README.md` documents `npm run preview` and a one-line static server for the local case.
- Users on Firefox and Safari have no one-click install prompt (`beforeinstallprompt` is
  Chromium-only). Settings detects this and explains the browser-menu route instead of showing a
  button that would do nothing — which is what the legacy build did in _every_ browser.
- The service worker precaches ~1.9 MB, including the XLSX and DOCX writers. That is deliberate:
  generating a report is a core workflow and must survive going offline.

**Gained:**

- Real offline operation, verified by an E2E test that creates a record, goes offline, reloads, and
  continues to read and write.
- A genuine install path, verified by a manifest test that checks every declared icon resolves.
- Update control: `registerType: 'prompt'` means a new version never swaps itself in under a
  half-filled form. The user is told and chooses when.
- Web Crypto for backup checksums, and the Storage persistence API for durability — both of which
  require a secure context and neither of which works under `file://`.

## Revisiting

A native wrapper becomes worth reconsidering if a concrete requirement appears that the web platform
cannot meet, for example:

- writing backups to a fixed filesystem path automatically, without a download prompt;
- OS-level scheduled reminders while the application is closed;
- deployment into an environment where no HTTPS origin or loopback server is permitted;
- integration with a desktop single-sign-on or smart-card credential store.

Absent one of those, the wrapper adds maintenance surface and removes nothing. This ADR should be
revisited only after the Phase-1 review, and only against a stated requirement.
