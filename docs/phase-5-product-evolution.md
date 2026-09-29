# Phase 5 — product evolution: design record

**Status:** design, written before implementation (2026-09-29, dates in UTC+8).
**Branch:** `phase-5/product-evolution`, from `40c8330` (the Phase-4 RC3 head).
**Scope:** the shared application and its data model. No platform package is built or published in this
phase — see §17.

This document is the plan the implementation follows. Where the implementation later has to deviate, the
deviation is recorded here in a dated note rather than by rewriting the decision it replaces.

---

## 0. Starting point and the restored baseline

The Phase-4 RC3 record listed two Chromium E2E failures as pre-existing. Both were reproduced before any
product work, and **neither was what the record said**:

| test                                      | RC3 attribution                            | what reproduction showed                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.spec.ts:191` ledger at phone width | `.first()` resolves to a hidden table cell | true, but secondary: `navigate()` returned before React committed the new route, so the assertion usually matched the record's card on 工作 and never looked at 台账. With the wait added and the old selector kept, the test failed 3/3.                                                     |
| `phase-2-ux.spec.ts:282` settings index   | `gotoApp` CDP clear not awaited            | **a product defect.** The section index used `href="#settings-*"`; the hash router read the id as an unknown route and rendered 概览, 5 of 5 times. `gotoApp` isolation held over 30 iterations (0 leaked records, 0 wrong routes). The skip link `#main` had the same defect on every route. |

Resolution, in three commits:

- `82c01d0` `test(tests)` — `navigate()` waits for the destination's `aria-current="page"`; the ledger test
  asserts exactly one _visible_ title. Test-only.
- `e1b5d7e` `fix(app)` — `InPageLink` performs in-page jumps itself (scroll + focus) without writing
  `location.hash`; the skip link and the Settings index use it. With its regression tests, which fail
  13 of 13 against the unfixed build and pass after the fix; the tightened Phase-2 test fails 3 of 3 on
  the unfixed product.
- `7a93fa8` `test(tests)` — the scale measurements in §13, committed before any hierarchy code so the
  "before" numbers are measured on the baseline.

> **Review correction, 2026-09-29.** `e1b5d7e` fixed ordinary activation only: the anchors still carried
> raw fragments (`#main`, `#settings-*`) as their real href, so a modified or middle click, a new tab or a
> copied link still opened an unknown route and landed on 概览. `InPageLink` now separates the two: a
> required `href` typed as a route (`routeHref(...)` — `#/settings` for the Settings index, the current
> route for the skip link) that every browser-handled activation follows, and `targetId` for the in-page
> jump an ordinary activation performs. The URL names the view, not the section. Details and tests:
> [phase-5-evidence.md](phase-5-evidence.md) §9.

Baseline gates, on the fix commit: unit 338/338; Chromium desktop + mobile 112/112 in three consecutive
full runs (the original 96 plus 16 new); Firefox/WebKit 21 passed, 1 skipped (the deliberate WebKit
offline-reload skip from `eb4fa43`); accessibility 14/14; static scan PASS.

One environmental fault was observed and is **not** a product or test defect: `net::ERR_NO_BUFFER_SPACE`
on loopback requests to the preview server (a Windows `WSAENOBUFS`), which caused four of the five
failures in the first run (two failed navigations, two blank pages). Traces show the failing subresource (`vendor-react-*.js`) with that error text; the host's
non-paged pool stood at ~1.25 GB at the time. Any recurrence is identified from the trace before a rerun,
never retried blindly.

---

## 1. Shell geometry

### 1.1 Defect and root cause

`AppShell.module.css` sets `--view-max` per route (reports 1180 px, standard 1560 px, ledger 1920 px) and
both the header's inner row and `main` read it. The header row is centred, so whenever two routes'
widths differ at the current viewport, the header's left edge moves. Measured on the baseline build
(Chromium, left x of the brand; every navigation item moves by the same amount):

| viewport  | 概览 / 工作 / 荣誉 / 设置 | 台账          | 报告          |
| --------- | ------------------------- | ------------- | ------------- |
| 1366×768  | 25 px                     | 25 px (0)     | 118 px (+93)  |
| 1920×1080 | 215 px                    | 35 px (−180)  | 405 px (+190) |
| 2560×1440 | 536 px                    | 356 px (−180) | 726 px (+190) |

The Phase-2 comment justified the shared variable as keeping content aligned with the navigation; the
cost was chrome that moves under the pointer.

The primary-action button (新增记录 / 新增荣誉) is present on three routes and absent on three. Its
presence does not move the navigation's left edge today (the nav starts after the brand), but it changes
the nav's available width and it is not a reserved slot.

### 1.2 Invariant

> **The shell and the page content use separate width systems. The shell is route-independent; content
> keeps its per-route measure.**

- `--shell-max` (new token, 1920 px — the widest content measure, so no content is ever wider than the
  chrome above it) bounds the header row on every route.
- `--view-max` keeps its three per-route values and bounds `main` and the banner only.
- The header row becomes a grid: `brand | navigation | action slot`. The slot has a fixed width
  (`--shell-action-width`, sized for a four-character button with its icon) whether or not a primary
  action exists. An empty slot is an empty `div` with no role, no text and no focusable descendant, so
  it adds nothing to the accessibility tree.

Consequence accepted deliberately: on a wide screen, the reading-width 报告 page is centred under a wider
header, so its left edge no longer lines up with the brand. Content alignment per route is worth less than
chrome that does not move.

### 1.3 Mobile

Below 60 rem the bar already stacks (brand + action on the first line, the six destinations on a
scrollable second line). That behaviour is kept; the geometry invariant is **not** asserted there, because
a scrolling navigation line is expected to move horizontally with its own scroll position.

### 1.4 Acceptance

A new E2E spec measures, at 1366×768, 1920×1080 and 2560×1440, on all six routes: the brand's left x, each
destination's left x, and the action slot's right edge. Each must stay within 1 CSS px of its value on the
first route. It also asserts that content widths still differ by route (the ledger stays wider than the
dashboard, reports narrower), so the fix cannot be "make every page the same width".

---

## 2. Back-to-top control

- One `<button type="button" aria-label="回到顶部">` with an arrow-up icon, rendered by the shell on every
  route. 44×44 CSS px, fixed bottom-right, offset by `env(safe-area-inset-*)`.
- **Hidden** (`hidden` attribute, so out of the tab order and the accessibility tree) until the page has
  scrolled more than one viewport height (minimum 400 px). Scroll position is read in a passive listener
  throttled to one animation frame; it is re-evaluated on route change.
- Activation scrolls to the top — `behavior: 'smooth'` unless `prefers-reduced-motion: reduce`, in which
  case instant — and **moves focus to `<main>`** with `preventScroll`. Focus has to move somewhere
  deliberate: the button hides itself once the page is near the top, and a focused element that becomes
  `hidden` drops focus to `<body>`.
- Stacking: `--z-sticky`, below the header, dialogs and toasts. Toasts are bottom-centre and dialogs are
  modal, so either covers the button rather than the reverse.

---

## 3. What the reference prototype contributes

The reference is `_private_reference/work-record-console.original.html` (git-ignored, read-only, SHA-256
`49833b63…`). It contains real records; only its structure and CSS vocabulary are read, and nothing is
copied out of it. The newer friend-maintained version described in the brief — the one with a flat
`subtasks[]` model — is **not on this machine**; §7 designs against the fields the brief lists and says so.

| adopt (as ideas, in this codebase's own components)                  | reject                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| decomposition made visible on the work surface                       | the flat `subtasks[]` model                                    |
| gold as the secondary accent next to brand red (already `--honor-*`) | Tencent Beacon (`beacon.cdn.qq.com`) and any reporting code    |
| compact, information-dense rows                                      | any CDN or third-party runtime dependency                      |
| a left contextual column on wide screens                             | the icon-only toolbar (eight unlabelled buttons)               |
| urgency visible at a glance                                          | inline `onclick` architecture and `localStorage` as a database |

The visual audit itself is `docs/phase-5-visual-delta.md`.

---

## 4. Work hierarchy: the domain model

### 4.1 Representation

```ts
interface WorkRecord {
  // … every existing field, unchanged …
  /** The work record this one decomposes, or null for a top-level task. */
  readonly parentWorkId: string | null;
}
```

- Hierarchy nodes are first-class `WorkRecord`s. There is no nested `subtasks[]`, and no second record
  type: a child has every field a task has — status, both deadlines, category, group, progress notes.
- **Depth is derived, never stored.** Level 1 is `parentWorkId === null`; a record's level is its parent's
  plus one. `MAX_WORK_DEPTH = 3`. A stored `level` would be a second source of truth that a re-parent
  could leave stale.
- Labels come from the relationship: 1级任务 / 2级子任务 / 3级子任务. The user never types a level.
- **Honours never participate.** `HonorRecord` carries no `parentWorkId` — its schema now rejects the key
  rather than silently stripping it — and an honour can never be a parent.

### 4.2 No `hierarchyOrder`

Sibling order is **derived** from the order the view already uses (the list's sort key, date then title),
not stored. A stored order field would need renumbering inside every insert, move and delete transaction,
would have to be reconciled on merge (two archives each with their own 1, 2, 3), and would invite drag
ordering the brief does not ask for. If manual ordering is ever wanted it arrives as its own change with its
own migration; nothing here precludes it.

### 4.3 Invariants

Enforced at the **write boundary** (repositories, inside the mutating transaction) and at the **integrity
boundary** (`validateRelationalIntegrity`, which already serves restore, merge, live diagnostics and backup
viability):

| invariant                                  | integrity kind            |
| ------------------------------------------ | ------------------------- |
| a non-null parent exists                   | `dangling-parent-work`    |
| the parent is a work record                | `parent-is-not-work`      |
| no record is its own ancestor (incl. self) | `work-hierarchy-cycle`    |
| no path is longer than 3                   | `work-hierarchy-too-deep` |

Two deliberate non-violations, matching the existing reference rules: a **soft-deleted** parent still
satisfies the reference (the row exists and travels in backups), and `null` is always valid.

Self-parenting is reported as a cycle of length one; the write boundary still gives it its own message.

### 4.4 Live-hierarchy policy (write boundary only)

A stronger rule applies to operations, not to archives:

- a record may only be created under, or moved under, a **live** parent;
- a record with **live** descendants cannot be moved to the trash on its own (§5);
- a record whose parent is in the trash cannot be restored on its own (§5).

This is not an integrity kind, on purpose. A state that violates it — a live child under a trashed parent —
still restores exactly and still resolves every reference, so refusing to back it up would turn a
presentation concern into data loss. It can only arise from outside the application's own operations (a
merge of an unusual archive, a hand-edited store). The UI tolerates it: such a child is shown at the top
level with the note 「上级任务在回收站中」.

### 4.5 Concurrency

Every hierarchy check runs **inside** the read-write transaction that performs the write, over
`records`. IndexedDB serialises overlapping read-write transactions on the same store, so of two
conflicting operations the second always observes the first:

- create-child-under-P vs purge-P — whichever runs second refuses;
- move A under B vs move B under A — the second sees the first's edge and refuses the cycle;
- add a level-3 child under B vs move B down a level — the second sees the extra depth and refuses.

Integration tests drive each pair concurrently, in both orders, and assert the final state is valid.

---

## 5. Delete, trash, restore and purge

Policy: **nothing happens to a descendant silently, and no operation can leave a dangling parent.**

| operation                   | behaviour                                                                                                                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| trash a leaf                | unchanged                                                                                                                                                                                                                                                  |
| trash a node with live kids | refused on its own. The dialog offers three explicit choices: **取消**; **连同 N 项下级任务一并移入回收站** (one stamp for the whole live subtree); **下级任务上移一级后删除本任务** (children re-parented to this node's parent, then this node trashed). |
| restore                     | refused while the parent is in the trash, naming it. Otherwise restores the one record.                                                                                                                                                                    |
| restore with subtree        | offered when descendants share the record's `deletedAt` stamp — i.e. were trashed by the same subtree operation. Restores exactly that batch; a child that had been trashed earlier on its own stays in the trash.                                         |
| purge                       | refused while any record (live or trashed) still names it as parent.                                                                                                                                                                                       |
| purge subtree               | offered when every descendant is already in the trash. Purges them together, their progress notes, and detaches honours linked to any of them (existing honour rule). The confirmation states both counts first.                                           |
| empty the trash             | refused, with the ids, if a trashed record has a **live** child. In the application's own operations that state cannot arise (§4.4).                                                                                                                       |

Every multi-record operation is one transaction and bumps `dataRevision` once.

---

## 6. Status and deadline semantics

**Status stays explicit on every record.**

- Completing children never completes the parent; completing a parent never touches its children.
- Marking a parent 已完成 while descendants are still open (待办 / 进行中 / 已推迟) shows a confirmation —
  「还有 N 项下级任务尚未完成。仍将本任务标记为已完成？下级任务的状态不会改变。」 — and changes only the
  record being edited.
- Derived display: 「下级任务 2/3 已完成」 over **direct** children that are live, with cancelled children
  excluded from the denominator (the report completion-rate rule) and mentioned separately when present.

**Deadlines stay per record.** A parent's deadline never overwrites a child's or the reverse. Derived,
never persisted: the number of overdue live descendants, and the nearest pending deadline among open live
descendants.

---

## 7. Legacy flat-subtask import

The existing legacy importer **silently drops** an unknown array field: `asString()` returns `''` for arrays
and objects, and `collectResidue()` skips empty values. A backup carrying `subtasks: [...]` would therefore
lose every subtask with no warning. That is fixed in two layers:

1. **Residue keeps non-scalar values.** An unknown field whose value is an object or array is preserved in
   `legacyResidue` as canonical JSON text, with the usual warning. Nothing unknown is discarded any more.
2. **`subtasks` becomes a known field.** Each element becomes a **level-2 work record** under the row it
   came from:

| subtask field (first present wins) | becomes                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `title`, `text`, `name`, `content` | `title` (an element with none is dropped, with a warning)       |
| `deadline`                         | `reportDeadline` (the legacy meaning of `deadline` on a parent) |
| `due`                              | `completionDeadline`                                            |
| `done` (boolean)                   | `completed` / `todo`                                            |
| `done`, `status` (string)          | the legacy status table, with its warnings                      |
| `doneTime`, `completedTime`        | `completedOn`                                                   |
| `remark`, `note`                   | `remark`                                                        |
| anything else                      | the child's `legacyResidue`, with a warning                     |

- Everything not listed is not invented: `occurredOn` is absent unless the element has a `date`; category,
  group and counterpart are **not** copied from the parent.
- **Ids are deterministic:** `<parentId>::sub-<key>`, where `<key>` is the element's own `id` if it has one
  and its 1-based position otherwise. Importing the same file twice therefore produces conflicts, not
  duplicates.
- A subtask is only placed if its parent row was placed (as with progress notes); when the parent row is a
  merge conflict the children still resolve against the existing record.
- **Caveat recorded:** the field names are the brief's; no real friend-version file was available, so the
  mapping is verified against synthetic fixtures only. The `deadline → reportDeadline` choice follows the
  existing legacy mapping and is the one to revisit when a real sample (with personal data removed)
  exists.

---

## 8. Search, filter and query

- **One query engine.** `runQuery` keeps filtering record by record: search, status, category, group, unit,
  year/month and the calendar day all apply to each record on its own, children included.
- **List view:** a matching child appears like any other record, with its level and its path
  (「上级：一级任务 / 二级子任务」) so the match is understandable out of context.
- **Structure view (任务结构):** with no filter, the whole live forest. With a filter, the matched records
  **plus their ancestors**; an ancestor that did not match is rendered as **context** — muted, labelled
  「上下文」 in text, not only by colour — and its non-matching descendants are not shown.
- A child is never hidden because its parent failed to match.
- Deleted records follow `includeDeleted` exactly as today; the tolerated live-under-trashed child is shown
  at the top level with its note (§4.4).

---

## 9. Ledger, reports and exports

- **Ledger (table, cards, print):** a 层级 column and, under the title, the parent path.
- **XLSX:** new columns 任务层级, 上级任务, 任务路径, plus 记录 ID and 上级记录 ID. Titles may repeat, so the
  ids are what makes a row unambiguously joinable; paths are always built by id, never by title.
- **DOCX period report:** a 层级 column and the parent path under the title. Period membership is still
  decided by each record's own date — a child is never omitted because its parent falls outside the period,
  and never pulled in because its parent falls inside it.
- **JSON backup:** carries `parentWorkId` exactly (§10).

Fixtures cover one root, several children, grandchildren, duplicate titles in different branches, a mix of
open and completed nodes, and an overdue descendant.

---

## 10. Schema migration and backup compatibility

### 10.1 IndexedDB v1 → v2

- `db.version(1)` is **not edited**. `db.version(2)` adds a `parentWorkId` index to `records` (children
  are looked up by parent inside every hierarchy transaction) and an upgrade that sets
  `parentWorkId = null` on every row that is an object with `kind === 'work'` and no `parentWorkId` key.
- Nothing else is touched: honours, progress, categories, groups, settings and meta rows are left as they
  are, and a work row that is invalid for another reason stays exactly as invalid — the migration adds a
  field, it does not repair. `meta.schemaVersion` becomes 2 through the existing backfill.
- Proven from a **real v1 database**: a Dexie instance declaring only version 1 writes the fixture, then the
  application's own class opens it. Covered: an ordinary archive, an empty database, trashed records,
  honours, progress, taxonomy, and invalid rows (which must stay invalid and reported).

### 10.2 Backups: `schemaVersion` changes, `backupFormatVersion` does not

`BACKUP_FORMAT_VERSION` stays **3**. The envelope — its fields, completeness semantics and digest scope —
is unchanged; what changed is the shape of the records inside the payload, and that is exactly what the
envelope's `schemaVersion` field exists to declare. It becomes **2**.

- **Forward safety comes free:** a Phase-4 build has `MAX_SUPPORTED_SCHEMA_VERSION = 1` and already refuses a
  schema-2 file with a precise message, before validating the payload.
- **Schema-1 files are read through a declared migration:** the payload is validated against the
  schema-1 record shape (which **rejects** a `parentWorkId` key — a schema-1 file cannot carry hierarchy),
  the checksum and counts are verified against the file **as received**, and only then are work records
  given `parentWorkId: null`. Migrating first would make every older file's digest fail.
- **Exactness:** a new archive round-trips its hierarchy exactly (build → backup → restore into an empty
  database → identical records). A schema-1 archive restores to its migrated form, the only form this
  build can hold.
- **Merge validates the projected final tree.** Individually valid incoming records can together form a
  cycle, a path longer than 3 or a dangling parent (for instance a parent rejected for an unresolved
  category). A CivicWorkDesk-envelope merge whose projected state has any hierarchy issue is **refused
  whole**, before anything is written, with the issues listed. The in-transaction preflight re-checks the
  same projection at commit time. A legacy file's derived subtasks are the exception: they are part of
  their parent row and are rejected with it, as progress notes are.

---

## 11. Structure view (任务结构)

- 工作 gains a two-way switch, 「列表 / 任务结构」. The list stays the default and is unchanged apart from the
  level and path context.
- The structure view is **nested semantic lists** (`ul > li`), not `role="tree"`: the full tree keyboard
  model (roving tabindex, arrow keys, type-ahead) is not implemented, and a partial `tree` is worse than
  honest lists. Every control is a normal button in document order.
- Each node shows its level label, status, title, urgency, child progress and actions: 编辑,
  添加下级任务 (levels 1 and 2 only — a level-3 node offers none), 调整层级. A disclosure button
  (`aria-expanded`, `aria-controls`) collapses its children.
- Connector lines are decorative CSS, and each level is also expressed in text, so the structure survives
  without colour or lines.
- Desktop indents by a fixed step; on a phone the indent shrinks and nothing scrolls horizontally.
- **Re-parenting** is a dialog, 「调整层级」: a filterable list of eligible parents (each candidate
  pre-checked with the same rule the repository enforces), plus 「设为 1级任务」. There is no drag and drop.
- Adding a child opens the ordinary record dialog with the parent fixed and named
  (「上级任务：…（将创建为 2级子任务）」).

---

## 12. Accessibility

WCAG 2.2 AA-oriented, as before: every action keyboard-reachable in document order; visible focus;
no colour-only state (levels, context rows and urgency all carry text); targets ≥ 24×24 CSS px, prominent
touch targets ≥ 40×40; dialogs labelled; the back-to-top button named and focus-safe; no drag-only
operation; reduced motion honoured. The axe gate is extended to the structure view, the move dialog, the
delete-with-children dialog and the back-to-top control.

---

## 13. Performance

Measured, not assumed. Two harnesses committed before any hierarchy code (`7a93fa8`), synthetic archive of
5,000 work records + 500 honours + ~3,300 progress notes (fictional, seeded):

**Domain (Node, median of 15 after 3 warm-ups; the three sessions agreed within 7%):**

| operation               | before (ms) |
| ----------------------- | ----------- |
| default work list query | 88–91       |
| search                  | 9.1–9.6     |
| open-status filter      | 13.3–13.5   |
| urgency sort            | 11.0–11.4   |
| follow-up list          | 2.1–2.2     |
| period summary          | 1.8–1.9     |
| relational integrity    | 1.3–1.4     |

**Browser (Chromium, production build, medians; two sessions):**

| operation              | before (ms)   |
| ---------------------- | ------------- |
| reload to ready (概览) | 101 / 104     |
| switch to 工作         | 128 / 150     |
| search                 | 65 / 72       |
| switch to 台账         | 1,455 / 1,516 |
| XLSX export            | 956 / 968     |

Two pre-existing costs stand out and are recorded, not hidden:

- **The default list sort (89 ms) is a collator-thrashing comparator.** It compares day keys with
  `localeCompare(b)` (the default locale) and breaks ties with `localeCompare(b, 'zh-Hans-CN')`.
  Measured on the same 4,902 records: that comparator 84 ms; the same comparator with one locale for
  both calls 5.5 ms; an ordinal comparison of the fixed-format ISO day keys plus one shared
  `Intl.Collator('zh-Hans-CN')` for titles 1.5 ms, **with an identical resulting order**. Collation
  itself is cheap (sorting all titles with `localeCompare` takes ~6 ms); alternating locales is not.
  Caching the day keys changed nothing (86.7 vs 88 ms), which is how the first guess — anchor-day
  derivation — was ruled out.
- **台账 renders every row twice** (table and cards) with no windowing: ~1.5 s at this scale.

Hierarchy work must not make either worse. The comparator fix is behaviour-preserving and measured, so it
is taken as its own commit; windowing the ledger is not taken in this phase.

Hierarchy assembly is O(n): one pass builds `Map<id, record>` and `Map<parentId, children[]>`; depth walks
are bounded by the depth cap (a corrupt chain is cut off after `MAX_WORK_DEPTH + 1` steps), never by
recursion over arbitrary depth. The same harnesses are re-run after the work; a regression over 20% on any
line is investigated before closeout.

**Installed footprint** is audited separately from installer size, from the RC3 installation on this
workstation: active release, previous release, native binaries, app assets, state and logs, installer
metadata — measured bytes, and the retention rule that bounds them. Nothing is deleted to improve the
number; the previous release is the only rollback.

> **Closeout note, 2026-09-29.** Results are in [phase-5-evidence.md](phase-5-evidence.md) §3–§4. Two
> deviations from the plan above:
>
> - The ledger **did** get worse: 台账 is about 25% slower at 5,000 records (≈0.4 s). The hierarchy
>   computation behind it costs about 2 ms; the rest is rendering the added cell and card fields on a page
>   that renders every row twice without windowing. It was first recorded as an open product decision;
>   the narrow closeout (next note) resolved it without windowing. The integrity pass is 82% slower (+1.2 ms), all of it the
>   new hierarchy check, which scales like the existing checks. Every other line held or improved; the
>   "before" figures above came from an earlier session, and the comparison was re-measured interleaved.
> - No RC3 installation existed on this workstation at closeout, and no installer was run, so the
>   footprint audit uses the RC3 payload and the installer's layout and retention code instead. It found
>   that Windows never prunes release directories.

> **Narrow closeout note, 2026-09-29.** A second pass closed three engineering issues before review;
> results in [phase-5-evidence.md](phase-5-evidence.md) §1 and §3–§7.
>
> - **台账** now renders only the presentation in use — the table at `(min-width: 60rem)` or when printing,
>   the card list otherwise — chosen synchronously on the first render, so the other one never exists in
>   the DOM. Interleaved over 15 samples per arm, switching to 台账 went from 1,594 ms before Phase 5 and
>   1,994 ms as first closed to 954 ms. No windowing was needed. A structural E2E spec asserts, on 1,000
>   records, that the unused presentation is absent at both widths, at the exact breakpoint, across a live
>   resize and when printing.
> - **The Windows numeric version** comes from one fail-closed parser: a pre-release never reaches the
>   fourth field (`0.2.0-rc.1` → `0.2.0.0`), and malformed versions stop the build. Nothing was built.
> - **The UOS archive gate** verifies a signed-off archive against its own registered digest and
>   provenance, and keeps parity with `dist/` for candidates only; it passes 56/56 with no expected
>   failures.
> - **Trash:** a trashed three-level tree can always be removed — as one subtree, leaf first, or by
>   emptying the trash — and tests at the repository and interface levels walk each path. The §5 refusal
>   to purge a record still named as parent stays; it never strands a tree.
> - One further measurement is accepted as a non-blocking observation, not changed: the 工作 search went
>   from about 70 to 87 ms (+17 ms, +24%) because each result card and the new calendar render more DOM,
>   for a fixed page of 30 results; the query itself is faster and the cost does not grow with the archive.
> - **Backlog before the next Windows build** (recorded, not implemented): the release scripts must stop
>   defaulting silently to an old release id (`build-release.mjs` to RC3, `generate-winres.mjs` to RC2) and
>   fail without an explicit one; `AppVersion`/`AppVerName` must use the displayVersion; `AppPublisher`
>   and the PE `CompanyName` must use the configured publisher identity (evidence §10,
>   `docs/versioning-and-publisher.md`).

---

## 14. Versioning and publisher

Specified in `docs/versioning-and-publisher.md`, which keeps six concepts apart:

| concept                 | now                  | this phase                                 |
| ----------------------- | -------------------- | ------------------------------------------ |
| product version         | 0.1.0                | **0.2.0** line (hierarchy + schema change) |
| display version         | —                    | `0.2.0-dev.0` while in development         |
| Windows file version    | 0.1.0 (from package) | derived numeric `0.2.0.0` by the parser    |
| release id              | `2026.09.24-win-rc3` | unchanged; provenance only                 |
| database schema version | 1                    | **2**                                      |
| backup format version   | 3                    | 3, unchanged (§10.2)                       |

Publisher display identity for community builds: **Rhymer-Lcy**. `StorePublisherIdentity` is a separate,
deliberately **unresolved** field. The installer sources changed only where the numeric version was wrong
(the narrow closeout: `VersionInfoVersion` and the stale `"0.1.0"` fallback); the rest of the mapping they
must adopt is specified for the next packaging phase.

---

## 15. Security and privacy

Unchanged boundary: no account, no cloud, no telemetry, no analytics SDK, no third-party runtime network
dependency, CSP untouched. The static scan gains patterns for the reference prototype's class of
dependency — Beacon SDK hosts, `sendBeacon`, common analytics hosts and remote script tags — so that kind of
code cannot enter `src/`, `index.html`, `public/` or the build. The existing offline and external-request
E2E checks stay mandatory.

---

## 16. Windows 10, UOS store and HarmonyOS

Planning only, each in its own document:

- `docs/windows-10-legacy-compatibility.md` — Windows 10 22H2 x64 as a legacy-compatibility target class;
  not an OS endorsement; preflight unchanged until a real Windows 10 machine passes; one x64 product, no
  fork; no Windows 7, no x86.
- `docs/uos-store-readiness.md` — what a UnionTech store submission requires, researched against current
  official sources; the signed-off `-5` artifact is not touched.
- `docs/harmonyos-feasibility.md` — a separate future platform project; the `127.0.0.1:8765` origin model
  does not transfer.

---

## 17. Release boundary

No Windows RC4, no Windows 10 build, no new UOS release, no HarmonyOS build and no store package are
produced. Windows RC3 and UOS `-5` remain exactly as published and signed off; their digests are
re-verified at closeout. Phase 5 ends ready for independent product review.

---

## 18. Commit plan

1. test-only baseline (done)
2. `fix(app)` in-page anchors (done)
3. scale harness (done)
4. this record and the visual-delta audit
5. comparator performance
6. shell geometry
7. back-to-top
8. hierarchy domain
9. v2 migration and backup schema
10. write-boundary operations
11. import and merge
12. hierarchy UX
13. ledger, reports, exports
14. visual adaptation
15. version and publisher
16. platform planning documents
17. gates and evidence

This list was first written as one wrapped paragraph; the formatter read its line-initial numbers as list
items and renumbered them before it was committed. It is restored here as a list (2026-09-29).
