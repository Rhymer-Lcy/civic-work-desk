# Phase 5 — visual delta against the reference prototype

**Date:** 2026-09-29 (UTC+8). **Companion to:** [phase-5-product-evolution.md](phase-5-product-evolution.md).

## Method and boundary

The reference is the prototype CivicWorkDesk replaced, kept at
`_private_reference/work-record-console.original.html` (git-ignored, read-only, SHA-256 `49833b63…`). It
embeds real records, so this audit reads **only its stylesheet and element structure**: its `:root`
variables, its layout selectors and their declarations. No record, name, number or text content was
read into this document, and the page was not rendered, because rendering it would put real data on
screen for no design gain.

The friend-maintained version described in the Phase-5 brief — the one with a flat `subtasks[]` model — is
not on this machine. Its confirmed characteristics (compact layout, left calendar/group column, clear card
hierarchy, a visible 子任务 treatment, restrained red and gold) are taken from the brief.

Nothing below copies markup, script or assets. The prototype carries a Tencent Beacon loader
(`beacon.cdn.qq.com/sdk/4.5.9/beacon_web.min.js`) and reporting calls; none of it is reproduced, and the
static scan now forbids that class of dependency (phase-5 record §15).

## What the prototype's stylesheet says

| aspect         | prototype                                                                                         | CivicWorkDesk today (Phase 2)                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| chrome         | a red gradient band (`#7F1313 → #B91C1C`) with white text; title row fixed at 1240 px             | one white 48 px band under a 3 px brand rule; six named destinations; width varied by route (fixed in this phase)       |
| page width     | `main` fixed at 1440 px on every view                                                             | per-route content measure: 1180 / 1560 / 1920 px                                                                        |
| context column | a 310 px **left** sidebar on the main view: month calendar + group list, sticky under the header  | calendar + groups only on 概览, as a 20 rem **right** aside from 80 rem; 工作 has none                                  |
| summary        | seven equal count tiles, each a filter                                                            | three attention counts (overdue, due today, due within 7 days), which Phase 2 put in place of a six-tile row            |
| work items     | 12 px-radius cards with shadow; 14.5 px title; an 11.5 px icon meta line; expand to a detail grid | one dense row per record on a shared column template; the whole row discloses details                                   |
| urgency        | coloured left border + coloured tag per item (`overdue` / `today` / `soon`)                       | a 3 px left edge for overdue + a text urgency badge on every row                                                        |
| accent colours | red primary; gold `#A8853E` for honours **and** for "due soon" **and** for group headings         | brand red for identity and selection; gold (`--honor-*`, the same `#A8853E`) for honours only; red kept off destructive |
| status colours | green / orange / blue / purple families                                                           | a status palette per canonical status, always paired with text                                                          |
| toolbar        | eight icon-only buttons with `title` tooltips                                                     | named actions; a single primary action per view                                                                         |
| mobile         | below 980 px the sidebar stacks **above** the content                                             | below 80 rem the aside stacks **after** the main column                                                                 |
| decomposition  | none in this copy; a flat `subtasks[]` in the friend's version (per the brief)                    | none                                                                                                                    |

## Decisions

### Adopted

1. **Decomposition visible on the work surface.** The 任务结构 view (phase-5 record §11): levels, connector
   lines, child progress and a quick 添加下级任务, built on first-class records rather than the reference's
   flat array.
2. **Calendar context beside the work list.** 工作 gains the month calendar the dashboard already has,
   wired to the canonical query's day filter (`onDay`) — the same filter, the same chip, the same clear
   action. From 80 rem it sits in the **right-hand** column, as on 概览: one layout rule across views, and
   the main column first in reading and tab order. Below 80 rem it follows the list, again as on 概览,
   so it never pushes the work itself down. (Corrected during implementation: the first draft said the
   calendar would appear only from 80 rem; hiding it below that would have left an empty 侧边信息
   landmark on phones.) The group panel is not added; groups are already a filter.
3. **Information density.** Hierarchy rows reuse the list's row height (`--row-h`) and cell padding tokens;
   a node carries its level, status, title, urgency and child progress on one line at desktop widths, and
   wraps rather than truncating what matters on a phone.
4. **Wide screens used deliberately.** The structure view indents by a fixed step instead of stretching
   titles across 1,900 px, and uses spare width for the per-node summary (child progress, nearest
   descendant deadline).

### Adopted with a change

5. **Gold.** The prototype spends gold on three unrelated meanings (honours, due-soon, group headings), so it
   signals nothing. CivicWorkDesk keeps gold for honours only. Hierarchy levels are expressed with
   **structure, not colour** — indentation, connector lines and a text level label — using the existing
   ink and border tokens. No new colour token is added for the tree.

### Rejected

6. **The red gradient header.** Phase 2 reduced red to identity and selection so that red that means "this
   will destroy data" stays distinguishable. A red field behind white text would undo that.
7. **Seven count tiles.** Phase 2 already replaced Phase 1's six-tile row with three attention counts, because
   most tiles described history rather than a decision (Phase-2 audit D-1, D-2).
8. **Icon-only toolbar and `title` tooltips.** Not reachable by touch, not announced reliably.
9. **A fixed 1440 px page and a fixed 1240 px chrome row.** The fixed-chrome half is right and is adopted in
   substance (`--shell-max`); the fixed page half would squeeze the ledger and widen the reading view.
10. **Sidebar above the content on phones.** It pushes the list below a calendar on every visit.
11. **Inline `onclick`, `localStorage` as the database, runtime CDN assets, telemetry.** Architecture, not
    appearance; permanently out.

## What the Phase-2 wins remain

Named navigation; real accessible names; the responsive ledger (table on desktop, cards on a phone);
exactly one primary action per view; readable forms; restrained destructive colour; per-route content
widths; semantic markup. The adoptions above were chosen so that none of these moves.

## Review checklist for the screenshots

At 1366×768, 1920×1080 and a phone viewport: the brand and destinations do not move between routes; the
structure view never scrolls horizontally on a phone; every level is readable without colour; the calendar
sits beside the list on 工作 from 80 rem and after it below that, and never displaces the list.
