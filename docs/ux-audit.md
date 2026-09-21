# UX audit and redesign

What was wrong with the prototype's interface, what changed, and the rules the new one holds itself
to. Legacy line numbers refer to `_private_reference/work-record-console.original.html`.

## The core problem

The prototype had no hierarchy. Eight equally-weighted icon-only buttons sat in the header (L460–484
— statistics, ledger, settings, Excel, Word, honour compilation, JSON export, JSON import), each a
34×34px square whose only affordance was a `title` attribute. The everyday action — adding a record
— was a floating circle in the corner. Brand red was applied to the header, every primary button,
the statistics numbers, the report table headers, the export buttons _and_ the destructive actions,
so nothing stood out.

Most tellingly: 「导出 Excel」 and 「清空全部数据」 sat in the same row, at the same size, and the
destructive one was rendered as an _outlined_ red button — visually **lighter** than the filled
primary export button beside it.

## Information architecture

| Before                                                               | After                                                                             |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| One main screen plus three full-screen overlays toggled by `display` | Six named destinations in a real `<nav>`: 概览 / 工作 / 荣誉 / 台账 / 报告 / 设置 |
| Eight icon-only header actions                                       | One primary action (**新增记录**); exports live in the view that owns them        |
| Honours = work cards with a gold border                              | Honours have their own view, form and vocabulary                                  |
| Settings a scroll of undifferentiated cards                          | Eight sections, destructive operations last and visually separated                |

Exports moved to where they belong: XLSX to 台账 (it exports what you are filtering), DOCX to 报告,
JSON backup to 设置 → 数据与备份.

## Colour

Colour now carries intent, and intent decides colour:

| Token group        | Reserved for                                              |
| ------------------ | --------------------------------------------------------- |
| `--brand-*` (red)  | identity and the single primary action                    |
| `--danger-*`       | destructive intent only, and visually distinct from brand |
| `--honor-*` (gold) | honours, and nothing else                                 |
| `--status-*`       | a fixed semantic set, always paired with text or an icon  |

Two contrast defects were found by automated testing and fixed:

- `--ink-400` was `#8b8580`: **3.64:1** on white, failing WCAG 1.4.3 AA. Now `#6f6a64`, which
  measures 5.35:1 on `--surface-card` and 4.82:1 on `--surface-sunken` — the two surfaces secondary
  text actually appears on.
- The honour button used `--honor-600` (`#a8853e`) with white text: **3.45:1**. Now `--honor-700`
  (`#8a6a27`) at 5.03:1. The lighter gold is still used for borders and chips, where it carries no
  text.

Calendar days from adjacent months were de-emphasised with `opacity: 0.55`, which pushed their
effective contrast below threshold. They are clickable and carry a date, so the opacity was removed
and they are distinguished by weight and ink instead.

## Surfaces

The legacy settings page nested a `.set-card` containing `.set-item` blocks, each with its own
border and background — four visible boxes around a single text field.

One level of elevation now. `Card` is the only card; anything inside uses `Panel` (flat, bordered)
or plain rows. Shadows are restrained; borders carry most of the separation.

## Forms

| Before                                                                                                 | After                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 20 controls in one scroll, including 6 honour fields merely `display:none`                             | Title, date and status always visible; deadlines, counterpart and filing in collapsible sections |
| `.form-row` stayed `display:flex` at every width — three controls squeezed to ~110px on a 360px screen | Single column below 40rem                                                                        |
| Placeholders as the only hint                                                                          | Real `<label for>`, plus `aria-describedby` hints                                                |
| Closing discarded silently                                                                             | A dirty form asks before discarding                                                              |
| `window.prompt()` for group creation and renames                                                       | Real form fields with validation                                                                 |

### Dates

The legacy form had the right idea — a 无/具体日期/文字说明 selector — but stored the choice in a
separate `xType` field that then disagreed with the value. `DateValueInput` makes the kind and the
value one object, so they cannot drift apart, and an incomplete range degrades to a single day
rather than producing a malformed value.

## Status and urgency

Every badge carries **a text label and an icon**, never colour alone (WCAG 1.4.1). The legacy
`.wc-status.done` and `.wc-status.undone` differed only in hue, and the deadline line had no word
for its `soon` state.

Urgency now names its cause: 「上报时限已逾期 3 天」 rather than an unattributed red badge. That is
possible because one function decides urgency and returns which of the two deadlines drove it.

## Dashboard

Six metrics, each chosen because it implies an action: 需要跟进 / 已逾期 / 今日到期 / 进行中 /
长期推进（未结束）/ 已完成.

Dropped: the bare total (「工作记录」), which never changes what anyone does that day.

The backup warning appears **only when acting on it is the right thing to do** — never on an empty
store. The legacy fix for that noise was to hard-hide the banner on every load (L3563), which
disabled the warning permanently.

## Destructive actions

Two confirmation strengths, because not all destruction is equal:

| Strength                                            | Used for                                                    |
| --------------------------------------------------- | ----------------------------------------------------------- |
| Standard: named consequence + confirm button        | deleting one record (recoverable), removing a category      |
| **Typed phrase** required before the button enables | replace-mode restore, emptying the trash, clearing all data |

The confirm button is never the initially focused control, so Enter cannot complete a destructive
action by reflex. Deletion is a **soft delete**: records go to a trash and can be restored.

## Responsive rules

Verified at 360 / 390 / 768 / 1024 / 1440 px, plus a 200%-zoom emulation.

- **The page body never scrolls horizontally.** Wide content scrolls inside its own container.
  Asserted at every width, on every route.
- Forms become single-column below 40rem.
- Filters use an auto-fit grid, so each control gets a full line at 360px and fills out
  progressively without a breakpoint per control.
- **The ledger is genuinely two presentations**, chosen by media query: a dense table from 60rem, a
  card list below it. The legacy version restyled `<td>` to `display:block` with
  `content: attr(data-label)` — visually a card, but the table roles remained, so a screen reader
  still announced "row 12, column 4" over what rendered as a paragraph. At narrow widths the table
  is now removed from the accessibility tree entirely.
- Dialogs are bottom sheets below 40rem, centred above it; content never overflows the viewport.
- Primary touch targets are ≥44px (WCAG 2.5.8). Radio and checkbox options are full-height rows,
  not bare 13px dots.
- `env(safe-area-inset-*)` respected on notched devices.

## Accessibility decisions

Target: WCAG 2.2 AA on realistically applicable criteria.

| Area               | Decision                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dialogs            | `role="dialog"` + `aria-modal` + `aria-labelledby`; focus moves in on open and returns to the trigger on close; Tab cycles within; Escape closes; background scroll locked. The legacy modals had none of this — a keyboard user tabbed straight through into the page behind. |
| Focus              | Visible `:focus-visible` ring on every interactive element. The legacy CSS set `outline: none` on all inputs and signalled focus only by border colour.                                                                                                                        |
| Calendar           | A real `<table role="grid">` with day-of-week headers; each day is a `<button>` with `aria-pressed` and an accessible name that includes the date, "今天", and the record counts. The legacy grid was `div`s with `onclick` — unreachable by keyboard.                         |
| Timeline controls  | Always present. The legacy edit/delete controls were `opacity: 0` until `:hover`, which hid them from keyboard and touch users entirely.                                                                                                                                       |
| Required fields    | Native `required` / `aria-required` plus a decorative asterisk explained by a form-level note. Putting 「（必填）」 inside the label would append it to every control's accessible name.                                                                                       |
| Hints              | `aria-describedby`, not nested in the label — a hint inside the label becomes part of the accessible name, which is verbose to hear.                                                                                                                                           |
| Icon-only controls | `aria-label` is required by the `Button` type; an icon-only button cannot compile without one. Asserted by a test that walks every button on the page.                                                                                                                         |
| Toasts             | Polite live region for confirmations, assertive for errors. **Never the only place information appears** — backup health, import results, storage diagnostics and validation failures are all also rendered in the page. Errors persist until dismissed.                       |
| Motion             | `prefers-reduced-motion` honoured globally, so a new animation cannot opt out by accident.                                                                                                                                                                                     |
| Navigation         | `aria-current="page"`, plus a border and a weight change — identifiable without the accent colour.                                                                                                                                                                             |
| Skip link          | First tab stop; moves focus to `<main>`.                                                                                                                                                                                                                                       |

### Verification, and its limits

`@axe-core/playwright` runs over nine rendered states (both dialogs, populated and empty dashboards,
work list with an expanded card, ledger, reports, settings, and a destructive confirmation) at WCAG
2.0/2.1/2.2 A and AA. **No rule is disabled.**

Automated tooling covers roughly a third of WCAG. The rest is covered by explicit behavioural tests
(focus trap, focus restoration, skip link, keyboard-only record creation, accessible names on every
button, 200% zoom) and by manual review recorded in `docs/qa-plan.md`.

**Known gap:** static JSX accessibility linting is absent. `eslint-plugin-jsx-a11y` has no release
compatible with ESLint 10 (its peer range stops at `^9`), and ESLint 9 is deprecated upstream.
Rather than force an unsupported peer, that layer is replaced by axe over rendered states — stronger
evidence, since it measures the real accessibility tree — plus the manual review. See
`docs/dependencies.md`.

## Print

The ledger and the report preview are the two things that get printed, so print targets them
explicitly rather than forcing the whole application onto paper. Chrome and Edge do not support CSS
paged-media margin boxes, so no page numbering is attempted — the DOCX report is the artefact for
anything needing formal pagination.

`thead` repeats on each page, but only for tables with body rows: a repeated header over an empty
page reads as a table whose contents vanished.
