# CivicWorkDesk（政务工作记录台）

A local-first, installable Progressive Web App for keeping public-sector work records and an
honour/award archive.

**All data stays in your browser.** No account, no server, no telemetry, no network request to any
third party — verified by an end-to-end test that fails if the application contacts any origin but
its own.

## What it does

| View               | Purpose                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **概览** Dashboard | What needs attention today: overdue, due today, in progress, active long-term work; month calendar; backup health    |
| **工作** Work      | The work record list — search, filter, sort, expand, edit, progress notes                                            |
| **荣誉** Honors    | The honour archive with its own fields: level, document number, personal role, evidence location                     |
| **台账** Ledger    | Every record as a dense table (desktop) or card list (phone); genuine `.xlsx` export; print                          |
| **报告** Reports   | Month / quarter / year reports with accurate counts; genuine `.docx` export                                          |
| **设置** Settings  | Product wording, categories, groups, option lists, backup & restore, storage diagnostics, trash, destructive actions |

## Privacy and offline model

- Records live in **IndexedDB** in your browser profile on your own device.
- `localStorage` holds only UI preferences (last route, sort order). Never record data.
- The service worker caches the **application shell only**. No record, backup or generated report
  enters the Cache API — asserted by a test that searches every cache entry for a planted string.
- Exports are downloads you initiate. Nothing is uploaded, ever.

**Local storage is not a security control.** Anyone with access to your unlocked OS account or
browser profile can read the data. Use full-disk encryption and lock your screen.
`docs/security.md` states the threat model, including what it does _not_ protect against.

**Back up regularly.** Clearing browser data, changing machine, or reinstalling will destroy the
store. The JSON backup is the only format that can restore it.

## Prerequisites

- **Node.js 24 LTS** (the pinned version is in `.node-version` / `.nvmrc`)
- npm 11 or newer (ships with Node 24)
- A modern Chromium, Firefox or Safari for use; Chromium for the E2E suite

## Setup

```bash
npm ci            # installs exactly what package-lock.json specifies
npm run dev       # http://127.0.0.1:5173
```

<details>
<summary>Windows note</summary>

This project was developed at `F:\CivicWorkDesk`. Nothing in the source, scripts, tests or
configuration depends on that path — everything resolves relative to the repository root. Clone or
copy it anywhere.

If the system Node is not 24, a portable Node 24 works without changing the machine:

```powershell
$ver = 'v24.21.0'
Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile "$env:TEMP\node.zip"
Expand-Archive "$env:TEMP\node.zip" -DestinationPath D:\tools
$env:Path = "D:\tools\node-$ver-win-x64;$env:Path"
node --version
```

</details>

## Scripts

| Command                           | Does                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`                     | Dev server with fast refresh                                                   |
| `npm run build`                   | Production build to `dist/` (regenerates CSS module types, typechecks, builds) |
| `npm run preview`                 | Serve `dist/` at `http://127.0.0.1:4173`                                       |
| `npm run typecheck`               | TypeScript, both projects                                                      |
| `npm run lint`                    | ESLint, `--max-warnings=0`                                                     |
| `npm run format` / `format:check` | Prettier                                                                       |
| `npm run test` / `test:unit`      | Vitest (unit + integration)                                                    |
| `npm run test:e2e`                | Playwright: flows, responsive, offline, privacy                                |
| `npm run test:a11y`               | axe-core over rendered states                                                  |
| `npm run scan:static`             | Forbidden-pattern scan over source and `dist/`                                 |
| `npm run verify`                  | format → lint → typecheck → unit → scan → build                                |
| `npm run review:package`          | Run every gate, then build the review ZIP                                      |
| `npm run review:verify`           | Independently verify a review ZIP                                              |

First E2E run needs the browser: `npm run test:e2e:install`.

## Running it locally

```bash
npm run build
npm run preview
```

Then open `http://127.0.0.1:4173`. Loopback is a secure context, so the service worker, storage
persistence and Web Crypto all work.

**`file://` is not supported.** Opening `dist/index.html` directly disables the service worker and
the storage persistence API, and IndexedDB behaviour under an opaque origin varies by browser. The
application detects this and says so in Settings. See `docs/decisions/0001-pwa-first.md`.

## Installing as an app

Load the application over HTTPS or on `localhost`, then:

- **Chrome / Edge** — an install button appears in Settings → 安装与离线使用, or use the address-bar
  install icon.
- **Firefox / Safari** — no automatic prompt exists (`beforeinstallprompt` is Chromium-only). Use
  the browser menu: "Install app" / "Add to Home Screen" / "Add to Dock". The result is identical.

Once installed it opens in its own window and works offline. Updates never apply themselves: a
banner offers the new version and you choose when to reload, so an update cannot discard a
half-filled form.

## Backup and restore

**JSON is the only backup.** XLSX and DOCX are reports — they have no ids, no progress entries and
no settings, and cannot restore an archive.

Export: Settings → 数据与备份 → 导出 JSON 备份. The filename is deterministic and sortable:
`civic-work-desk-backup-20260921-143052.json`.

The file carries an application id, its own format version, the database schema version, the export
timestamp, entity counts and a SHA-256 of its payload.

Restore: Settings → 导入 / 还原备份, choose **合并** or **替换**:

| Mode         | Behaviour                                                                             |
| ------------ | ------------------------------------------------------------------------------------- |
| 合并 Merge   | Adds records whose id is not already present. Never overwrites. Conflicts are listed. |
| 替换 Replace | Destroys everything, then writes the file. Requires typing a confirmation phrase.     |

Both show a full preview — counts, rejections, conflicts, migration warnings — and write nothing
until you confirm.

Settings shows when the last successful JSON backup ran and how many records it held. Only a JSON
export updates it.

## Migrating from the legacy 工作记录台

Export a backup from the old application and import it here. It accepts the versioned envelope,
the `{works, honors}` split shape and the bare array.

Nothing is discarded or silently rewritten. Values that cannot be mapped cleanly — a date written
`1月`, a phone recorded as `82393933.0`, unrecognised status wording — are preserved verbatim and
listed as warnings for you to resolve. Full rules in `docs/migration.md`.

## Repository structure

```
.github/workflows/ci.yml     CI: Node 24, install → lint → typecheck → test → build → scan → e2e
_private_reference/          legacy source (git-ignored, never packaged) + its README
_review_packages/            generated review ZIPs (git-ignored; docs/review-package-provenance.md)
docs/                        architecture, data model, security, migration, UX, QA, ADRs
public/                      static manifest and icons
scripts/                     icon generation, CSS module types, security scan, packaging, verifier
src/
  app/                       router, data provider, PWA bridge
  components/common/         Button, Dialog, Field, Toast, Card, badges, DateValueInput
  components/layout/         AppShell, PageHeader, SplitLayout
  db/                        Dexie schema, migrations, repositories
  domain/                    pure logic: dates, status, deadlines, query, reports, validation
  features/                  one directory per destination
  services/                  backup, import, export, storage, download
  styles/                    tokens.css, globals.css, print.css
tests/
  fixtures/                  synthetic legacy fixtures (no real data)
  unit/  integration/  e2e/
```

The most load-bearing code is `src/domain/`. It is pure, has no I/O, and holds the single
implementation of every rule — dates, status, deadlines, filtering, reporting — that the legacy
prototype had scattered across five inconsistent copies.

## Review package

```bash
npm run review:package   # runs every gate, captures real output, writes the ZIP + .sha256
npm run review:verify    # re-opens the archive and checks it independently
```

The verifier does not trust the packager: it parses the ZIP itself, verifies every CRC, confirms the
expected files are present, confirms no confidential path or legacy record id appears, checks the
internal `SHA256SUMS.txt` against actual contents, and confirms `VERIFY_LOG.txt` records a real run
with no failing gate.

## Documentation

| File                               | Contents                                                         |
| ---------------------------------- | ---------------------------------------------------------------- |
| `docs/legacy-audit.md`             | What the prototype did, and 40+ findings with line numbers       |
| `docs/architecture.md`             | Layering, data flow, bundle strategy, PWA                        |
| `docs/data-model.md`               | Schema, the date model, invariants, soft delete                  |
| `docs/migration.md`                | Field-by-field legacy mapping and conflict policy                |
| `docs/security.md`                 | Trust boundary, threat model, CSP, dependency policy             |
| `docs/ux-audit.md`                 | UX problems, redesign decisions, responsive and a11y rules       |
| `docs/qa-plan.md`                  | What is tested, results, defects found, and what is _not_ tested |
| `docs/dependencies.md`             | Every dependency justified                                       |
| `docs/release-checklist.md`        | Gates before packaging and before deploying                      |
| `docs/decisions/0001-pwa-first.md` | Why a PWA and not a native wrapper                               |

## Deployment and supported platforms

CivicWorkDesk is a static PWA. Deployment means serving `dist/` from a local HTTP server on a fixed,
canonical origin and opening the default browser at it:

```
http://127.0.0.1:8765/
```

That origin is not a preference. Browser storage is keyed on scheme + host + port, so a different
origin is a different, empty IndexedDB — which presents to a user as data loss. Every deployment holds
that origin exactly, and fails loudly rather than falling back to another port or to `localhost`.

### UOS (LoongArch) — validated

> CivicWorkDesk release `2026.09.23-5`
> (SHA-256 `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`)
> was physically validated on UOS Desktop 20 Professional,
> loongarch64 / Loongson 3A6000,
> kernel 4.19.0-loongson-3-desktop,
> using 360 Browser 13.4.1140.83 / Chromium 126.0.6478.251.

That sentence is the whole claim. It is **not** a claim of support for Linux generally, for other UOS
versions, for other LoongArch systems, or for other browser versions. The deployment is user-level:
no root, no system service, no Node, no Python — BusyBox `httpd` serves the files and `xdg-open`
opens the browser. Sign-off and evidence: `docs/phase-3-final-signoff.md`.

### Windows 11 — in progress, not certified

Phase 4 is characterising Windows 11 before anything is built. There is no Windows release, and no
claim of Windows compatibility is made. Plan and probe: `docs/phase-4-windows-stage-a-plan.md`.

### Verifying a release download

Release archives are published as GitHub Releases, not committed to this repository. Verify one before
installing it:

```sh
sha256sum -c civic-work-desk-uos20-loongarch64-<version>.tar.gz.sha256   # must print OK
tar -xzf civic-work-desk-uos20-loongarch64-<version>.tar.gz
cd civic-work-desk-uos20-loongarch64-<version>
sha256sum -c SHA256SUMS.txt                                             # every file, individually
sh install.sh                                                           # no sudo, user-level
```

The outer `.sha256` authenticates the archive; the inner `SHA256SUMS.txt` covers every file inside it.
The installer re-verifies the bundle itself before it copies anything, and again after staging.

## Licence

**No licence is granted.** The source is published here so it can be read, reviewed and audited — not
so it can be reused. All rights are reserved by the copyright holder; there is no permission to use,
copy, modify, merge, publish, distribute, sublicense or sell any part of it, and `package.json`
records `"license": "UNLICENSED"` to say the same thing in machine-readable form.

If you want to do something with this code, ask first.
