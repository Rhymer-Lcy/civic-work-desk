# Browser compatibility

What CivicWorkDesk actually requires of a browser, what it merely prefers, and what has been tested.

The deployment target is a UnionTech UOS / loongarch64 workstation whose browser version **is not yet
known**. Nothing in this document is a claim about that machine; the last section says exactly what
remains to be established there.

## Required — the application does not work without these

| Capability                    | Used for                                               | Consequence if absent                                                     |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| **IndexedDB** (via Dexie 4)   | the entire database                                    | the app shows its "无法打开本机数据库" error screen and does nothing else |
| **ES2023 JavaScript**         | the build output target (`vite.config.ts`)             | script parse error; blank page                                            |
| **CSS custom properties**     | every colour, spacing and width token                  | unstyled, unusable                                                        |
| **CSS Grid + Flexbox**        | every layout                                           | unusable                                                                  |
| **`<dialog>` element**        | all modal dialogs (create/edit, import, confirmations) | records cannot be created or edited                                       |
| **`crypto.randomUUID`**       | every record identifier                                | writes fail with an explicit error rather than inventing ids              |
| **`crypto.subtle` (SHA-256)** | the backup checksum                                    | backups cannot be sealed or verified                                      |
| **Blob + object URLs**        | JSON / XLSX / DOCX download                            | exports cannot be delivered                                               |
| **`FileReader` / file input** | import                                                 | backups cannot be restored                                                |
| **Dynamic `import()`**        | the lazily loaded XLSX and DOCX writers                | those two exports fail; the rest works                                    |

Practically this is "a Chromium ≥ 111 / Firefox ≥ 113 / Safari ≥ 16.4-era engine", because `<dialog>`
and ES2023 are the newest things in the list. **That is an inference from the feature list, not a
tested floor** — see the last section.

## Progressively enhanced — better with, fine without

| Capability                        | What it adds                                    | Without it                                                             |
| --------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| **Service worker + Cache API**    | offline start-up, update prompt                 | the app still runs online from the server; no offline reload           |
| **Web App Manifest / install**    | "install as app"                                | runs as an ordinary tab; Settings says installation is unavailable     |
| **`navigator.storage.persist()`** | asks the browser not to evict the database      | data is still stored; Settings reports that durability was not granted |
| **`prefers-reduced-motion`**      | suppresses the few transitions                  | transitions run at 120–180 ms                                          |
| **`pointer: coarse`**             | restores 44 px touch targets                    | the width query (≤ 40rem) covers phones anyway                         |
| **`forced-colors`**               | hands the palette to the OS high-contrast theme | the normal palette applies                                             |
| **`print` stylesheet**            | the ledger prints as a clean table              | the screen layout prints                                               |

Each of these is feature-detected at the point of use. None is assumed.

## Deliberately **not** used

Listed because their absence is a design decision rather than an oversight, and because a reviewer
should be able to check the claim:

- no `BroadcastChannel`, `SharedWorker` or cross-tab coordination;
- no `File System Access API` (`showSaveFilePicker`) — downloads go through an anchor and a blob URL,
  which works on every engine;
- no `structuredClone`, `Object.groupBy`, `Array.prototype.toSorted` or other very recent additions;
- no WebAssembly;
- no network at runtime: no fetch to any third-party origin, no CDN, no remote font, no telemetry.
  This is asserted by a test (`tests/e2e/offline-and-privacy.spec.ts`) rather than by policy alone.

## Test evidence

Automated, every release gate, against the production build served over `127.0.0.1`:

| Engine                            | Version                      | Scope                    | Result          |
| --------------------------------- | ---------------------------- | ------------------------ | --------------- |
| Chromium desktop (1440×900)       | bundled with Playwright 1.63 | full E2E suite           | pass            |
| Chromium mobile (Pixel 7 profile) | bundled                      | responsive + smoke       | pass            |
| Firefox desktop                   | bundled                      | focused critical flows   | pass            |
| WebKit desktop                    | bundled                      | focused critical flows   | pass, 1 skipped |
| Chromium (axe-core)               | bundled                      | accessibility, 14 checks | pass            |

The skipped WebKit case is an offline **reload** that fails inside Playwright's WebKit itself; the
offline **write** path does run there. Details in `docs/qa-plan.md`.

**What this evidence is not.** Playwright's WebKit is not Safari, and its Chromium is not the browser
on any particular Linux distribution. These runs establish engine behaviour, not product behaviour on
a specific machine.

## UOS validation: still pending

Nothing has been run on the target. The following are **unknown** and must not be assumed:

- the UOS edition and release;
- the bundled browser and its engine version (UOS commonly ships a Chromium-derived browser, but the
  build and version on this machine have not been observed);
- whether that browser applies enterprise policy to IndexedDB, service workers or storage
  persistence;
- whether `crypto.subtle` is available in the origin it will be served from — it requires a secure
  context, which `http://127.0.0.1` satisfies in Chromium and Firefox, but this has not been
  confirmed on the target browser;
- whether `<dialog>` is supported by that build.

The last two are the ones that would actually break the product, and both are cheap to check. A
one-page capability probe is the first task in `docs/phase-3-uos-deployment-handoff.md`.

**No minimum UOS browser version is stated here, because none has been measured.**
