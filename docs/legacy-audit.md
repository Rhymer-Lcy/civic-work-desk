# Legacy audit — `工作记录台.html`

Audit of the single-file HTML prototype that CivicWorkDesk replaces. Every finding below was read
out of the file itself; line numbers refer to the preserved original at
`_private_reference/work-record-console.original.html`.

| Property          | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Original filename | `工作记录台.html`                                                              |
| Size              | 283,216 bytes                                                                  |
| Lines             | 3,590 (LF only, no CR bytes)                                                   |
| Encoding          | UTF-8, no BOM                                                                  |
| SHA-256           | `49833b63e541a79d63ac29ea6c3d34e6a25a92fd82d38f4c0840b0ab679d9cb4`             |
| Composition       | ~420 lines CSS, ~180 lines embedded data, ~2,440 lines JavaScript, rest markup |

**The file contains real personal data.** 178 work records and 2 honour records are embedded as
JavaScript object literals from line 969, carrying personal names, mobile and landline numbers,
named government bodies and descriptions of live work. It is therefore excluded from Git, from
builds, from fixtures and from review packages. See `_private_reference/README.md`.

---

## 1. Behaviour inventory

### Screens

| Screen                    | Implementation                          | Verdict                                       |
| ------------------------- | --------------------------------------- | --------------------------------------------- |
| Main list + sidebar       | always rendered; other views overlay it | preserved, restructured into routes           |
| 统计分析 (`#statsView`)   | `showStatsView()` L2404                 | preserved as **Reports**                      |
| 台账查询 (`#archiveView`) | `showArchiveView()` L2575               | preserved as **Ledger**                       |
| 设置 (`#settingsView`)    | `showSettingsView()` L2593              | preserved as **Settings**                     |
| Add/edit modal            | one modal for both record kinds, L771   | split into two purpose-built dialogs          |
| Progress modal            | L926                                    | folded into the record card                   |
| Confirm dialog            | L944                                    | preserved, two confirmation strengths added   |
| Info modal                | L957                                    | removed; content moved into the relevant view |

### Work-record fields (`normalizeRecord`, L1282–1328)

`id`, `category`, `date`, `title`, `requirement`, `deadlineType`, `deadline`, `dueType`, `due`,
`done`, `doneTime`, `unit`, `contact`, `phone`, `remark`, `longterm`, `progress[]`, `fixedGroup`,
`biz`, `createdAt`.

### Honour fields (same object, unused on work rows)

`hType` (type), `hLevel` (level), `hNo` (document number), `hRole` (personal role),
`hEvidence` (evidence location), `hRelated` (related work id). Issuing organisation reused `unit`.
An older shape (`name`/`type`/`level`/`from`/`no`/`role`/`evidence`/`related`) was still upgraded at
L1313–1326.

### Enumerations (`DEFAULT_OPTIONS`, L1163)

`hType` (8 values), `hLevel` (6), `hRole` (4), `done` (5: 完成/进行中/未完成/取消/推迟).
12 default business categories (L1158); 3 default groups (L1170). All user-editable.

### localStorage keys

| Key                     | Contents                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `gov_work_log_v2`       | the entire record array, `JSON.stringify`d on every mutation |
| `gov_honor_v1`          | pre-merge standalone honours, read once at first run         |
| `gov_groups_v1`         | group name array                                             |
| `gov_config_v1`         | title, subtitle, categories, option lists                    |
| `gov_groups_open`       | which sidebar groups are expanded                            |
| `gov_work_alert_seen`   | date the alert banner was last rendered                      |
| `gov_last_backup`       | date of last export — **written by the XLS export too**      |
| `gov_biz_migrated_v1`   | one-shot migration flag                                      |
| `gov_group_migrated_v1` | one-shot migration flag                                      |

### Other behaviour

Deadline evaluation (`deadlineInfo` L1348), status derivation (`statusOf` L1380), month calendar
(L1523), filters/sort (`getFilteredList` L1741), 40-row pagination (L1793), statistics (L2439),
period reports (L2666–2919), XLS export (L3404), honour-year print (L3492), JSON export/import
(L3355/L3368), install handling (L2920–2990), runtime manifest injection (L3565).

### Network access

Exactly one external resource: `https://beacon.cdn.qq.com/sdk/4.5.9/beacon_web.min.js` (L430),
followed by an inline `BeaconAction` initialisation (L431–450) reporting `preview_page_view` with
`location.href`, `document.referrer`, `document.title` and a sandbox id.

---

## 2. Worth preserving

These are good product decisions and are carried forward:

1. **Two deadlines per item** — an external reporting deadline and an internal completion
   deadline. This reflects how the work actually runs and is not redundancy.
2. **Free-text deadlines as a first-class option.** The three-way 无/具体日期/文字说明 selector was
   right; the real data genuinely contains `待定（4月前）` and `3月5日12时前`.
3. **The honour archive as a peer of work records**, with document number, level, personal role
   and evidence location — these are exactly the fields an annual appraisal requires.
4. **The 30-day backlog split.** Separating historical overdue items from live alerts keeps the
   alert list actionable.
5. **Business categories and the keyword auto-classifier** for legacy rows.
6. **The sidebar groups** (固定/长期/分管) as a persistent follow-up surface.
7. **Calendar-driven date filtering**, and per-day dots distinguishing work from honours.
8. **Progress notes on a record**, with their own dates.
9. **Period reports (month/quarter/year)** with an include-honours toggle.
10. **Local-only storage with no account.** The privacy posture was right even though the
    implementation contradicted it.

---

## 3. Implementation debt

| #   | Finding                                                                                            | Evidence                                                                                             |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| D1  | One 3,590-line file mixing markup, CSS, 180 embedded records and 2,440 lines of logic.             | whole file                                                                                           |
| D2  | 118 inline event handlers (`onclick`×97, `onchange`×15, `oninput`×2, `onkeydown`×4).               | throughout                                                                                           |
| D3  | 40 `innerHTML` assignments building markup from template strings.                                  | throughout                                                                                           |
| D4  | Record ids interpolated into inline `onclick` attribute strings.                                   | L1471, 1704, 1859–1978, 2053                                                                         |
| D5  | Two parallel progress-editing implementations that can disagree about which entry is being edited. | `editProgress`/`saveProgressEdit` L2288–2331 vs `editProgressCard`/`saveProgressEditCard` L2345–2382 |
| D6  | `window.prompt()` used for group creation and renames — unvalidated, blocking, untestable.         | L1428, 2088, 3061, 3127                                                                              |
| D7  | Dead code: `exportHonorList()` (L3463) is fully implemented and never called from any control.     | L3463                                                                                                |
| D8  | Dead variable `pre` computed and discarded in `deadlineInfo`.                                      | L1359                                                                                                |
| D9  | No build, no module system, no dependency manifest, no tests.                                      | —                                                                                                    |

---

## 4. Data-integrity defects

### D10 — Report period membership reads fields that do not exist

`parseWorkDate()` (L2696) tries `w.completedTime`, `w.deadline`, `w.due`, `w.createdAt`, `w.time`.
Of these, `completedTime` and `time` are not fields (the real ones are `doneTime` and `date`), and
**the record's own `date` is never consulted**. Consequences:

- a record dated 2026-04-16 with a reporting deadline of 2026-11-30 is reported under **November**;
- a record with a free-text date has `createdAt === NaN` (see D11) and is silently **absent from
  every report**.

### D11 — `createdAt` is computed by coercing a possibly non-date string

`createdAt: r.date ? new Date(r.date).getTime() : Date.now()` (L1310). For `date: "1月"` this is
`NaN`. For an ISO date it is a **UTC** instant, which the report window (built with local-midnight
`new Date(y, m-1, 1)`, L2672) then compares against — so in any negative-UTC-offset timezone a
record dated the 1st of a month falls into the previous month.

### D12 — The report's completion count treats any non-empty label as "done"

`buildSummary()` L2710: `w.status === '已完成' || w.done`. `w.status` is not a field, and `w.done`
is truthy for `取消`, `推迟`, `未完成` and `进行中`. Every one of those counts as completed, and the
printed 完成率 (L2856) is derived from it. The same expression gates the overdue count (L2715) and
the per-row status cell in the exported document (L2885).

### D13 — Long-term status overrides completion

`statusOf()` L1380 tests `w.longterm` **before** `isDone(w)`, so a completed long-term item renders
as 长期推进 permanently and is excluded from the completed count (`renderStats` L1622 returns early
on `w.longterm`).

### D14 — `未完成` is classified as cancelled/postponed

`isOther()` L1377 matches `未完成` alongside `取消` and `推迟`. Genuinely outstanding work is filed
under a tab labelled 取消/推迟 and excluded from the pending count.

### D15 — Five views compute "overdue" three different ways

`deadlineInfo()` (L1348) considers **both** deadlines. But `renderTabCounts` (L1609),
`renderStats` (L1628), `renderAlert` (L1656), `renderToday` (L1681) and the `stale` tab (L1748) all
re-test with `daysUntil(w.deadline)` — the **reporting deadline only**. A record whose urgency comes
from its completion deadline is overdue according to one row of numbers and undated according to the
row beneath it.

### D16 — Two independent filter implementations that disagree

`getFilteredList()` (L1741) and `renderArchiveView()` (L3259) duplicate filtering. Differences found:
the main view validates a year with `/^\d{4}$/` (L1725) while the ledger accepts any
`date.slice(0,4)` (L3243), so a record dated `1月` produces a bogus `1月年` option there; month
filtering uses `slice(5,7)` in one and `fmtMonth()` in the other; the searched field sets differ.

### D17 — The import loop can create duplicate primary keys

`importJSON()` L3384 builds `existIds` once, before the loop, and never adds to it (L3388). Two rows
sharing an id inside the _same_ file are both pushed.

### D18 — Silent drops on import

A row whose id already exists is skipped with no report; the toast (L3397) counts only what was
added. No validation of any kind is performed — `normalizeRecord()` coerces any object into a
record, so a wrong file produces a store full of empty rows.

### D19 — Derived state recomputed on every load, persisted only by accident

L1270 re-runs the category guesser on every `loadData()` outside any migration flag and does **not**
save. Whether a record has a category then depends on whether some later action happens to call
`saveData()`.

### D20 — The backup reminder is permanently disabled

`renderBackupTip()` (L3530) implements the warning correctly, and then L3563 — immediately after
`render()` — unconditionally removes the `show` class. The banner can never appear.

### D21 — A spreadsheet export marks the data as backed up

`exportExcel()` writes `gov_last_backup` (L3449), as does `exportJSON()` (L3363). Exporting a
report therefore silences the backup reminder for a week without a backup existing.

### D22 — Export success is asserted, never observed

Both exports call `URL.revokeObjectURL(url)` on the same tick as `a.click()` (L3362, L3448), which
can abort the transfer; and both show a success toast and write `gov_last_backup` regardless of
outcome. `exportPeriodReport()` uses a 1-second timeout instead (L2915) — the same product, two
behaviours.

### D23 — `clearAllData()` does not clear everything

L3234 empties `works` and saves, leaving `gov_groups_v1`, `gov_config_v1`, `gov_groups_open`,
`gov_work_alert_seen`, `gov_last_backup` and both migration flags in place.

### D24 — Progress entries addressed by array index

`editProgress(idx)` / `deleteProgress(idx)` (L2288, L2320) with the index baked into an inline
`onclick` string. Deleting entry 0 renumbers every later entry, so a pending edit writes to the
wrong note.

### D25 — Renaming a category detaches every record using it

Records store the category **name** in `biz`. `renameBiz()` (L3059) rewrites `appConfig.biz[i]` and
leaves every record pointing at a name that no longer exists. Same for groups (`fixedGroup`).

### D26 — `localStorage` as the primary database

Synchronous, string-only, quota-capped at a few MB, no transactions. `saveData()` (L1329) rewrites
the entire array on every change. `loadData()` wraps its read in `try/catch` and continues with an
empty array on failure (L1254), so a quota error is indistinguishable from data loss.

---

## 5. Privacy and security defects

### S1 — Third-party analytics in a product presented as offline

`<script src="https://beacon.cdn.qq.com/...">` (L430) plus an inline `BeaconAction` call reporting
page views (L443–448). The banner at L489 simultaneously reads 「本文件可脱离网络使用，数据保存在本机
浏览器」. Verified by grep: this is the only external resource in the file.

### S2 — HTML injection through an imported record id

`normalizeRecord()` passes `r.id` through unescaped (L1284) and it is interpolated directly into
inline handler attributes: `onclick="openEdit('${w.id}')"` (L1704 and ~20 more). A crafted backup
file can execute script. `esc()` is applied to titles and units but never to ids.

### S3 — Stored XSS through a user-defined category or group name

Category and group names reach `innerHTML` unescaped — L2502, L2522 (statistics bars), L3151
(delete confirmation), L3166 (settings tabs).

### S4 — Real personal data embedded in source

178 records with names, mobile numbers and landlines inline from L969. Anyone receiving the file
receives the data.

### S5 — No Content Security Policy, and none possible

A CSP restricting `script-src` to `'self'` would break the file, which depends on inline handlers
and an external script.

### S6 — Data-at-rest posture asserted without qualification

Settings text (L708, L3218) states data lives only in this browser, with no mention of eviction,
quota, or what clearing site data does.

---

## 6. UX defects

### U1 — Eight equally weighted icon-only actions in the header

L460–484: statistics, ledger, settings, Excel, Word, honour compilation, JSON export, JSON import —
all 34×34px, distinguished only by a `title` attribute. The everyday action (add a record) is a
floating circle in the corner (L766).

### U2 — Brand red applied to everything

Header gradient, every primary button, statistics numbers, report table headers, export buttons and
destructive actions. 「清空全部数据」 (L725) and 「导出 Excel」 (L721) sit in the same row at the same
size; the destructive one is `btn-mini danger`, an _outlined_ red button — visually lighter than the
filled primary export button beside it.

### U3 — Honours are work records wearing a gold border

The same modal serves both, with six honour fields revealed by toggling `display` (L841). Work-only
controls (完成时限, 是否完成, 归属分组, 长期推进) stay in the DOM, so an honour can be saved carrying a
completion deadline and a long-term flag.

### U4 — Twenty controls in one scrolling form

No grouping, no progressive disclosure (L789–918).

### U5 — Accessibility gaps

- No `role="dialog"`, no `aria-modal`, no accessible name, no focus trap, no Escape handling, no
  focus restoration on any modal (L771, 926, 944, 957).
- `outline: none` on every focused input (L34); focus shown only as a border colour change.
- Calendar days are `div`s with `onclick` (L1523) — unreachable by keyboard.
- Timeline edit/delete controls are `opacity: 0` until `:hover` (L244) — unavailable to keyboard and
  touch users entirely.
- Status conveyed by colour alone in the deadline meta line and the `done`/`undone` badges.
- Placeholders used as the only field hint.
- The ledger's narrow-screen mode restyles `<td>` to `display:block` with `content: attr(data-label)`
  (L406–413), leaving table semantics announced over non-table visuals.

### U6 — No unsaved-work protection

Closing a modal by backdrop, X or Escape discards silently.

### U7 — Destructive actions without proportionate confirmation

One generic dialog for everything from deleting one record to clearing the database. Deletion is
immediate and unrecoverable — no trash.

### U8 — The 40-row cap is invisible

`PAGE_SIZE = 40` (L1793) with no indication that more results exist.

---

## 7. Technically misleading behaviour

### M1 — `.xls` that is not an Excel file

`exportExcel()` (L3404) hand-writes **SpreadsheetML 2003** XML, prefixes a UTF-8 BOM to a document
that already declares `encoding="UTF-8"`, serves it as `application/vnd.ms-excel` and names it
`.xls`. Every cell is `ss:Type="String"`, so dates are text and cannot be sorted or filtered.

### M2 — `.doc` that is HTML

`exportPeriodReport()` (L2794) emits an HTML string with an `application/msword` media type and a
`.doc` extension. **The markup is also malformed**: it opens with `<thead>` and no `<table>`
(L2868), so the `table { border-collapse … }` rules it defines can never apply, and the closing
`</table>` at L2900 is a stray tag.

### M3 — The report reads four fields that do not exist

`w.require`, `w.peer`, `w.name`, `w.note`, `w.status` (L2779–2785, L2889–2896). The real fields are
`requirement`, `contact`, `title`, `remark`. So 完成要求 is empty on every row and the contact person
never appears — in both the preview and the exported document.

### M4 — The PWA is not a PWA

`grep -ci serviceworker` returns **0**. `injectManifest()` (L3565) builds a manifest object, wraps it
in a `Blob` and assigns a `blob:` URL to `<link rel="manifest">`. Chrome requires a same-origin
manifest _and_ a service worker with a fetch handler before firing `beforeinstallprompt`, so the
install button at L710 can never appear in any browser. The single icon is an inline SVG data URI
declared `purpose: 'any maskable'` with no safe-zone padding, so a maskable crop would clip it.

### M5 — `downloadSelfFile()` cannot do what it claims

`fetch(location.href)` (L2974) re-downloads the _server's_ copy, not the current document, and fails
outright under `file://` — the mode the button exists to support.

### M6 — `printHonorYear()` throws when popups are blocked

`window.open('', '_blank')` (L3497) then `win.document.write(...)` with no null check.

### M7 — The honour compilation is hard-wired to the current year

`getHonorYearData()` (L3458) uses `new Date().getFullYear()` with no selector, so prior years are
unreachable.

---

## 8. Intentionally removed

| Removed                       | Reason                                                            |
| ----------------------------- | ----------------------------------------------------------------- |
| Tencent Beacon analytics      | zero-telemetry requirement; contradicted the product's own claims |
| `file://` as a supported mode | see `docs/decisions/0001-pwa-first.md`                            |
| `downloadSelfFile()`          | meaningless once the app is a build artefact rather than one file |
| SpreadsheetML `.xls`          | replaced by genuine `.xlsx`                                       |
| HTML-as-`.doc`                | replaced by genuine `.docx`                                       |
| `window.prompt()` flows       | replaced by real forms                                            |
| Runtime blob manifest         | replaced by a static `manifest.webmanifest`                       |
| Info modal                    | content moved to the views that own it                            |
| `exportHonorList()`           | dead code; the ledger XLSX export covers it                       |
| The embedded 180 records      | real personal data must not be in source                          |

---

## 9. Correction map

| Legacy defect | Correction                                                             | Verified by                                              |
| ------------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| D10, D11      | `DateValue` tagged union; period membership from the record's own date | `tests/unit/dates.test.ts`, `status-and-reports.test.ts` |
| D12, D14      | canonical `WorkStatus` enum; completion counted from it                | `status-and-reports.test.ts`                             |
| D13           | `longTerm` orthogonal to status                                        | `deadlines.test.ts`, `smoke.spec.ts`                     |
| D15           | one `evaluateDeadline`                                                 | `deadlines.test.ts`                                      |
| D16           | one `runQuery`                                                         | `query.test.ts`                                          |
| D17, D18      | plan/preview/apply with in-file duplicate detection                    | `backup-round-trip.test.ts`                              |
| D19           | migrations only in `ensureSeedData`                                    | `database.test.ts`                                       |
| D20, D21, D22 | backup health from JSON exports only; success reported after the fact  | `backup-envelope.test.ts`, `data-safety.spec.ts`         |
| D23           | clear wipes every table and preference                                 | `data-safety.spec.ts`                                    |
| D24           | progress entries with stable ids                                       | `database.test.ts`, `smoke.spec.ts`                      |
| D25           | records reference category/group **ids**                               | `database.test.ts`                                       |
| D26           | IndexedDB via Dexie, transactional                                     | `database.test.ts`                                       |
| S1            | no third-party code at all                                             | `offline-and-privacy.spec.ts`                            |
| S2, S3        | React escaping; `innerHTML` banned by lint                             | `scripts/static-security-scan.mjs`                       |
| S4            | data excluded from repo, build and package                             | `verify-review-package.mjs`                              |
| S5            | restrictive CSP                                                        | `offline-and-privacy.spec.ts`                            |
| S6            | storage diagnostics stating real limits                                | `DiagnosticsSection.tsx`                                 |
| U1–U8         | see `docs/ux-audit.md`                                                 | `accessibility.spec.ts`, `responsive.spec.ts`            |
| M1, M2, M3    | genuine OOXML from canonical types                                     | `data-safety.spec.ts`                                    |
| M4            | static manifest + real service worker                                  | `offline-and-privacy.spec.ts`                            |
