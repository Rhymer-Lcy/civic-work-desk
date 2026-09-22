# Phase-2 UX audit

The state of the application at the signed-off Phase-1 baseline
`94c5744bf6451a99cafc243c4df6769046de5185`, surface by surface, before any Phase-2 change.

## How this audit was produced

Not from reading the source alone, and not from an empty database. An empty CivicWorkDesk shows six
zeroes and a blank list, which is the one state where almost every density and hierarchy question is
invisible.

1. **A deterministic demo dataset** (`scripts/fixtures/demo-dataset.ts`, sealed into
   `tests/fixtures/demo-dataset.json`) — 24 live work records, 2 in the Trash, 5 honours, 13 progress
   entries, 13 categories, 4 groups. It deliberately contains overdue work at two depths, work due
   today, work due in 3 / 6 / 16 / 24 days, long-term work with and without a deadline, every status
   including deferred and cancelled, a date range, a free-text date, linked honours, very long titles
   and nearly-empty records. All content is fictional.
2. **Screenshots at 1366 / 1440 / 1920 / 2560 / 390** with the browser clock pinned, imported through
   the application's own restore path (`npm run screenshots` → `review/screenshots/`).
3. **Pixel measurement** of the captures where a claim is about size, so "the content column is too
   narrow at 1920" is a number rather than an impression.

Two things were caught by measuring instead of asserting, and both would have gone into this document
as fact:

- the wide-viewport margins _looked_ brand-red in the first capture; sampling them returned
  `#f7f5f2`, the ordinary page background. The red is the header band only.
- the first capture ran with the clock pinned in the runner's timezone rather than the browser's, so
  every deadline state was one day out: the record designed to be "due today" rendered as "overdue by
  1 day" and 今日到期 read 0. Fixed before any finding was written down.

## Severity

|        | meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| **P0** | usability blocker — a user cannot complete, or is actively misled      |
| **P1** | major daily-use friction — costs time or attention on every repetition |
| **P2** | meaningful polish — noticeably better, not blocking                    |
| **P3** | optional enhancement                                                   |

---

## Cross-cutting

### C-1 · P1 · The content column is a fixed 1360 px, so wide screens render a narrow island

Measured from the captures (content column edge to edge, page background sampled either side):

| viewport  | content column | unused            |
| --------- | -------------- | ----------------- |
| 1366×768  | 1329 px        | 37 px (3%)        |
| 1440×900  | 1329 px        | 111 px (8%)       |
| 1920×1080 | 1329 px        | **591 px (31%)**  |
| 2560×1440 | 1329 px        | **1231 px (48%)** |

At 1366 the layout is genuinely comfortable — this is not a "make everything wider" finding. The
defect is that **every view stops growing at the same 1360 px**, so at 1920 a data-dense table and a
form both sit in the same column with a third of the screen unused, and at 2560 nearly half is unused.
A ledger row that wraps to two lines is wrapping inside 1329 px while 591 px sit empty beside it.

The fix is not a bigger number. Different views need different comfortable maxima (§9).

### C-2 · P1 · Two full-width chrome bands cost ~115 px before any content

The red brand bar (56 px) carries a title and nothing else; the navigation strip (45 px) sits below
it; the page header adds ~80 px more. At 1366×768 — the most constrained target viewport — roughly
200 px of an 768 px viewport is consumed before the first row of data.

### C-3 · P2 · Card-for-everything

Dashboard metrics, follow-up list, calendar, groups, every settings section, every honour and every
work record are each a bordered white card on a cream page. With nine cards on screen the border
itself stops separating anything.

### C-4 · P2 · Status vocabulary is carried by both colour and text, but the text is inconsistent

`未设时限`, `已结束`, `完成时限剩 7 天`, `上报时限已逾期 1 天` and `上报时限今日到期` all appear as
badges of the same visual weight in the same row, mixing "this record has no deadline" with "this
record is late" and "this record is finished". The urgency badge and the status badge are visually
peers.

---

## 概览 / Dashboard

**User goal.** What needs my attention today?
**Primary action.** Open the thing that is overdue. Secondary: create a record.

### D-1 · P1 · Six equal KPI tiles occupy the first screen and two of them are not decisions

`需要跟进` (10) is the union of `已逾期` + `今日到期` + upcoming + undated long-term, so the first tile
restates the next two. `已完成` and `工作记录共 24 条` describe history, not attention. On the empty
database all six render as large zeroes.

### D-2 · P1 · The KPI row and the 需要跟进 list say the same thing twice

`需要跟进 10` sits directly above a card titled 需要跟进 listing those same ten records. The tile adds
a number the list already implies.

### D-3 · P2 · The right column is 280 px and is used for two unrelated things

The calendar is legible but tight; the group panel's heading 固定 / 长期 / 分管工作 wraps mid-phrase
("工" / "作" on the next line at 1920) and its 按分组筛选 button is crushed beside it. Below the two
panels the column is empty for the rest of the page while the left column keeps scrolling.

### D-4 · P2 · The group panel repeats titles already listed above

Each group lists up to four record titles, most of which are already in 需要跟进 immediately to the
left. Situational awareness does not require repeating the same strings.

### D-5 · P1 · The empty dashboard is six zero boxes and a large empty area

First run shows `0 0 0 0 0 0`, a 250 px-tall empty card containing one line of text and an icon, an
empty calendar and three groups reading 未结束 0 条. Nothing explains what the product is for, and the
only affordance is 新增记录 in the top-right corner.

---

## 工作 / Work

**User goal.** Find a record, see its state, act on it, record progress.
**Primary action.** Scan; open; add progress. This is the highest-frequency surface.

### W-1 · P0 · Only six records fit on a 1920×1080 screen

Each collapsed card is ~115 px tall and carries three stacked lines (title / badges / meta). With 24
records the user scrolls four screens to see the list. The card occupies the full 1329 px width while
its content ends around x=700, so roughly half of every row is empty — vertical space is spent
generously and horizontal space is not spent at all.

This is the single largest daily-use cost in the application.

### W-2 · P1 · Nothing is aligned, so the list cannot be scanned by column

Date, category and unit are concatenated into one flowing line per record. Comparing deadlines across
records means reading each line rather than running the eye down a column.

### W-3 · P1 · The disclosure control is ~1200 px from the title it expands

The chevron is pinned to the right edge of a full-width card. Every expansion is a full-width pointer
journey, and the clickable target is the chevron only — not the row.

### W-4 · P2 · The filter bar spends 190 px of vertical space on seven equal controls

Search, 状态, 业务分类, 归属分组, 对接单位, 年份, 月份, 排序 are all equally prominent and always
expanded. 年份/月份/对接单位 are used far less often than search and 状态.

### W-5 · P2 · Edit and delete are only reachable after expanding the record

Correct as a safety decision, but it means a two-step interaction for the commonest edit.

---

## Record detail and progress

### R-1 · P2 · The detail grid is flat

Eleven label/value pairs at identical weight: 完成要求, 要求上报时限, 完成时限, 完成时间, 对接人,
联系方式, 归属分组, 备注 … Dates, people and classification are not grouped, so the eye has to read
labels rather than land on a region.

### R-2 · P2 · The progress timeline is visually as loud as the record

Each entry is a bordered block with its own edit and delete buttons. A record with three progress
entries looks like four records.

---

## 荣誉 / Honors

### H-1 · P1 · The 业务分类 filter can only ever return zero results here

The honours page hides 状态 and 归属分组 (`showWorkFilters={false}`) but still renders 业务分类, and
`matchesAssociations` rejects any non-work record when a category is selected. Selecting any category
on this page empties the list, every time.

### H-2 · P2 · The 对接单位 filter is labelled with work vocabulary

For an honour the underlying value is 授予单位 (`issuingOrg`), which the filter does match correctly —
only the label is wrong.

### H-3 · P3 · The linked work record is displayed but is not a navigation affordance

关联工作事项 shows the target's title next to a link icon; it is text, so the obvious next action
("show me that record") is not available.

---

## 台账 / Ledger

### L-1 · P0 · Column widths make the table unreadable at its own default

At 1920 the 类别 column is narrow enough that its two-character value 工作 wraps to 工 / 作 on **every
row**. 业务分类, 时限判定 and 对接单位 / 人 wrap on most rows. Row heights alternate between one and
two lines, which destroys vertical scanning — in a view whose entire purpose is scanning.

### L-2 · P1 · The densest view in the product is capped at the same 1360 px as everything else

The table wraps inside 1329 px while 591 px of viewport sit unused at 1920 (1231 px at 2560).

### L-3 · P1 · No sticky header

Scrolling past the first screen leaves ten unlabelled columns.

### L-4 · P2 · 状态 mixes two facts

`进行中（长期）` packs status and the long-term flag into one cell, so neither can be scanned.

---

## 报告 / Reports

### Rep-1 · P2 · The export workflow is not staged

Period selection, inclusion toggles, preview and export all sit at one level. What will be included is
inferable but not stated as a step.

### Rep-2 · P1 · Nothing distinguishes a _report_ from a _backup_

导出 XLSX (Ledger) and 导出 Word (Reports) sit in the same visual register as 导出 JSON 备份
(Settings). Only prose distinguishes the one format that can restore the database from the two that
cannot.

### Rep-3 · P2 · Lazy exporter loading is reported only by a button's busy state

The first DOCX export loads a chunk that is not in the initial bundle. On a slow machine the only
feedback is the button.

---

## 设置 / Settings

### S-1 · P1 · Eight stacked sections with no index

应用信息 · 业务分类 · 显示选项 · 数据与备份 · 安装 · 数据诊断 · 回收站 · 危险操作 in one scroll.
Reaching 回收站 from the top is a long scroll past 13 category rows.

### S-2 · P1 · Every category row repeats the same hint

13 rows, each a full-width ~950 px text input for a 4-character name, each followed by
内置分类不可删除，可停用。 — the same sentence 12 times.

### S-3 · P2 · Backup state is explained in a paragraph rather than shown as a state

The information the user needs (do I have a complete backup? from when? has anything changed since?)
is present but must be read.

### S-4 · P2 · Diagnostics leads with internal vocabulary

`dataRevision`, storage estimates and relational-integrity issue kinds appear before the plain-language
answer.

---

## Empty / loading / error states

### E-1 · P1 · "No data" and "no matches" use the same wording

Both the empty Work list and a filtered Work list with no results read
没有符合条件的工作记录 with the same 新增记录 action. The distinction the user needs — nothing exists
versus your filter excluded everything — is not made.

### E-2 · P2 · The no-urgent-work state is a 250 px empty card

近期没有逾期或临近到期的事项 is good news and occupies the largest block on the dashboard.

---

## Accessibility (baseline is strong; these are the gaps)

### A-1 · P2 · The work card's expand affordance is icon-only

`aria-expanded` and a visually-hidden label are correct; the visible target is a 32 px chevron.

### A-2 · P2 · Ledger rows are not focusable

Keyboard users can reach the table but not act on a row.

### A-3 · P3 · Heading levels are per-card rather than per-page-structure

Several `h3`s appear without an intervening `h2` in some views.

---

## What is **not** wrong, and must survive Phase 2

Worth stating explicitly, because a redesign is the easiest way to lose these:

- the follow-up list on the dashboard is the best-designed thing in the product — sorted by urgency,
  one line per record, urgency stated in words as well as colour;
- status and urgency are never colour-only;
- destructive actions are separated, confirmed, and phrase-gated;
- the import preview genuinely previews;
- honours have their own vocabulary rather than being work records with a gold border;
- the filter chips echo active filters and can be removed individually;
- Chinese copy is already professional and consistent in tone.
