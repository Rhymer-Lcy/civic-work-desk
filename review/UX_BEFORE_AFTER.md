# Phase 2 — before and after

Each entry states the problem found in the audit, the decision taken, the resulting behaviour, and
where to see it. Screenshots are in `review/screenshots/`, generated from the same deterministic
fixture at both ends (`tests/fixtures/demo-dataset.json`, 31 records, browser clock pinned to
2026-09-22).

Measurements of layout width are the `main` element's `getBoundingClientRect().width`, read in the
browser. An earlier pass used pixel-sampling of the screenshots instead and reported the new
dashboard as a 322 px column, because the sampler stopped at the first gap between two attention
cells; the numbers below are element geometry, not inferred from images.

---

## 1 · Layout width: one measure for every view → a measure per view

**Problem (audit C-1).** Every view stopped growing at 1360 px. At 1920 that left 591 px of viewport
unused while the ledger wrapped cells inside the column; at 2560, 1231 px.

**Decision.** `--view-max` is set per route on the shell and read by both the navigation bar and
`main`, so the content's left edge always aligns with the navigation's. Data-dense views grow, a
reading view does not.

**Result**, `main` width in px:

| viewport | before (all views) | after: 概览/工作/荣誉/设置 | after: 台账 | after: 报告 |
| -------- | ------------------ | -------------------------- | ----------- | ----------- |
| 1366     | 1360               | 1366                       | 1366        | 1180        |
| 1440     | 1360               | 1440                       | 1440        | 1180        |
| 1920     | 1360               | 1560                       | **1920**    | 1180        |
| 2560     | 1360               | 1560                       | **1920**    | 1180        |

Growth above 1920 is deliberately capped: a 2400 px ledger row is not scannable in one fixation, and
a settings form at 2560 would be a 200-character line. Evidence: `ledger-1920.png`,
`ledger-2560.png`, `dashboard-populated-2560.png`. Pinned by
`tests/e2e/phase-2-ux.spec.ts › the ledger uses more of a wide viewport than the dashboard does`.

---

## 2 · Application shell: two bands → one

**Problem (audit C-2).** A 56 px red bar carrying only the application title, plus a 45 px navigation
strip. With the page header, ~200 px of a 768 px viewport before the first row of data.

**Decision.** One 48 px band: wordmark, the six destinations, and the current view's primary action.
Brand red reduced to a 3 px top rule, the wordmark and the active destination's underline.

**Result.** Chrome height 101 px → 48 px. The primary action no longer moves as page headers grow,
and its meaning follows the route: 新增记录 on 概览/工作, 新增荣誉 on 荣誉, absent on 台账/报告/设置.
Evidence: any after screenshot. Pinned by three tests in `phase-2-ux.spec.ts › application shell`.

---

## 3 · Work list: six records per screen → sixteen

**Problem (audit W-1, the phase's only P0).** Each record was a ~115 px card stacking title, badges
and metadata on three lines. At 1920×1080, **6 of 24** records were visible, and roughly half of each
row's width was empty. Nothing was aligned, so deadlines could not be compared down a column (W-2),
and the only expand affordance was a 32 px chevron ~1200 px from the title (W-3).

**Decision.** Desktop renders one row per record on a shared column template — status, 事项, 业务分类,
对接单位, 日期, 时限 — with the whole row as the disclosure control. Below 72rem the same component
falls back to the stacked card, because six columns in 390 px is a squeeze rather than density.

**Result.** ~115 px → 42 px per row; **16 records** visible at 1920×1080 on the same data. The status
cell of every row starts at the same x, which is what makes a column scannable. Expanded detail is
grouped into 时间节点 / 对接信息 / 归属与分类 instead of eleven flat pairs. Evidence: `work-1920.png`,
`work-detail-1920.png`, `work-mobile-390.png`. Pinned by `phase-2-ux.spec.ts › a desktop screen shows
a working set, and the columns line up`, which caps the row at 56 px and asserts the alignment.

---

## 4 · Ledger: a two-character cell wrapping on every row → declared columns

**Problem (audit L-1, P0).** Automatic table layout sized 类别 to fit its two-character header, so its
value 工作 wrapped to 工 / 作 on **every row**; 业务分类, 时限判定 and 对接单位 / 人 wrapped on most.
Row heights alternated between one and two lines, in the view whose sole purpose is scanning. No
sticky header (L-3), and the table was capped at the same 1360 px as everything else (L-2).

**Decision.** `table-layout: fixed` with a declared `<colgroup>` in percentages, zebra striping in
place of per-row borders, and the ledger's own 1920 px measure.

**Result.** 类别 is one line on every row; ~12 rows → ~20 rows visible at 1920×1080; table width
1328 px → 1850 px. The header sticks below the application bar — and only where it can: above 80rem
the wrapper is not a scroll container, so the header pins to the page; below it, horizontal scrolling
wins and the header scrolls with the table, which is the honest trade rather than a broken pin.
Evidence: `ledger-1920.png`, `ledger-2560.png`, `ledger-mobile-390.png`. Pinned by `phase-2-ux.spec.ts
› columns are declared, so a short cell does not wrap on every row`.

---

## 5 · Dashboard: six equal tiles → three attention counts and a list

**Problem (audit D-1, D-2, D-5).** Six tiles filled the first screen. The first (需要跟进) was the
union of the next three and restated the contents of the list directly beneath it; two more described
history rather than a decision. On an empty database all six rendered as large zeroes.

**Decision.** Keep every number that changes what somebody does today and demote the rest: three
attention counts (已逾期 / 今日到期 / 7 天内到期), each a button into 工作; the 需要跟进 list, which
was already the best thing on the page; calendar and groups in a 20rem aside; one quiet line of
workload totals at the end.

**Result.** At 1920 the entire follow-up list, the counts, the calendar and the groups fit on one
screen. Evidence: `dashboard-populated-1366.png`, `dashboard-populated-1920.png`.

---

## 6 · First run: six zeroes → an explanation

**Problem (audit D-5).** An empty database showed `0 0 0 0 0 0`, a 250 px empty card containing one
line, an empty calendar and three groups reading 未结束 0 条. Nothing said what the product was for.

**Decision.** A different page, not the same page full of zeroes: what the application is for, where
the data lives, one primary action, and the three things a new user needs next (登记事项 / 导入旧数据
/ 定期备份).

**Result.** Evidence: `dashboard-empty-1366.png`, `dashboard-empty-1920.png`. Pinned by
`phase-2-ux.spec.ts › an empty database is explained instead of shown as zeroes`, which also asserts
that no attention count is rendered — a zero is not an attention state.

---

## 7 · Empty states: one sentence for two different situations → two

**Problem (audit E-1).** An empty Work list and a filtered Work list with no matches both read
没有符合条件的工作记录 and both offered 新增记录.

**Decision.** The live record count discriminates. Nothing exists → 还没有工作记录, offering
新增第一条记录. A filter excluded everything → 没有符合当前筛选条件的记录, stating how many records
exist and offering 清除全部筛选.

**Result.** Evidence: `work-empty-1366.png` versus `work-filter-empty-1366.png`. Pinned by
`phase-2-ux.spec.ts › no data and no matches are different answers with different offers`.

---

## 8 · Filters: eight always-expanded controls → two plus a disclosure

**Problem (audit W-4).** Search, 状态, 业务分类, 归属分组, 对接单位, 年份, 月份 and 排序 all equally
prominent, ~190 px of vertical space above every list.

**Decision.** Search, 状态 and 排序 stay; the rest collapse behind 更多筛选 — **and the panel opens
itself whenever one of them is in force**, so a filter can never be active while invisible.

**Result.** Filter bar height reduced by ~60 px; the active-filter chips are unchanged. Pinned by
`phase-2-ux.spec.ts › secondary filters collapse, but never while one is in force`, which is really a
test of the second half.

---

## 9 · Honours: a filter that could only ever return nothing → removed

**Problem (audit H-1).** The honours view hid 状态 and 归属分组 but still offered 业务分类, and the
query layer rejects every non-work record when a category is selected. Selecting any category emptied
the list, every time. The counterpart filter was labelled 对接单位 although for an honour the value is
授予单位 (H-2).

**Decision.** Do not offer a control that cannot return a result; name the one that can by what it
actually filters.

**Result.** Pinned by `phase-2-ux.spec.ts › the honours view does not offer a filter that cannot
return a result`. Evidence: `honors-1440.png`.

---

## 10 · Settings: eight stacked sections → a section index

**Problem (audit S-1).** Reaching 回收站 from the top meant scrolling past thirteen category rows;
危险操作 was last, which is right, but everything else was equally hard to find.

**Decision.** A sticky section index at ≥80rem — plain in-page anchors, no JavaScript, keyboard
reachable in document order — which also gives the wide viewport a use that is not decoration.
`scroll-margin-top` keeps an anchored section from landing under the sticky bar.

**Result.** Evidence: `settings-1440.png`. Pinned by `phase-2-ux.spec.ts › a section index reaches the
destructive block without scrolling past everything`.

---

## 11 · Density: one desktop default, touch sizing where it belongs

**Decision.** Controls 40/34/28 px on desktop (`--control-lg/md/sm`), rows 40 px, table cells tuned to
the line. Touch sizing (44/48 px, 48 px rows) is restored by `@media (pointer: coarse), (max-width:
40rem)`.

**Why the width clause is there, and it is not redundant.** A 360 px-wide _desktop_ window reports a
fine pointer, so the coarse query alone left the save button 34 px tall at phone width — caught by the
Phase-1 responsive suite, which asserts ≥40 px there and was right to. No user-selectable "compact
mode" was added: there is one default, and it is tuned.

---

## Bundle cost

Initial payload, approximate gzip, from the built `dist/assets`:

|                                                | Phase 1.3.1 | Phase 2     | delta              |
| ---------------------------------------------- | ----------- | ----------- | ------------------ |
| `index-*.js`                                   | 54 802      | 56 551      | +1 749 (+3.2%)     |
| `index-*.css`                                  | 8 589       | 9 992       | +1 403 (+16.3%)    |
| `vendor-icons-*.js`                            | 7 241       | 7 408       | +167               |
| `vendor-react` / `vendor-db` / `vendor-schema` | 121 451     | 121 459     | +8                 |
| **initial total**                              | **192 083** | **195 410** | **+3 327 (+1.7%)** |

No framework, component library or chart suite was added; no new runtime dependency of any kind. The
JavaScript increase is the shell's primary-action context, the first-run page, the collapsible filter
region and the settings index. The icons delta is five additional Lucide glyphs. The lazily-loaded
XLSX and DOCX writers are byte-identical and still lazy.
