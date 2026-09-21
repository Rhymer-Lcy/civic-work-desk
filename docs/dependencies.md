# Dependencies

Every version is pinned exactly. No `^`, `~`, `latest` or `*` appears in `package.json`;
`.npmrc` sets `save-exact=true`, `package-lock.json` is committed, and CI installs with `npm ci`.
No dependency is fetched from a CDN at runtime — everything is bundled.

## Runtime

| Package        | Version | License    | Purpose                       | Why not build it                                                                                                                                                                                                                                            |
| -------------- | ------- | ---------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react`        | 19.3.0  | MIT        | UI runtime                    | —                                                                                                                                                                                                                                                           |
| `react-dom`    | 19.3.0  | MIT        | DOM renderer                  | —                                                                                                                                                                                                                                                           |
| `dexie`        | 4.4.6   | Apache-2.0 | IndexedDB wrapper             | Raw IndexedDB is an event-based API with no promise support, no schema versioning helper and error-prone transaction scoping. The transactional guarantees this product depends on (see `data-model.md`) are exactly what a hand-rolled wrapper gets wrong. |
| `zod`          | 4.6.5   | MIT        | Runtime schema validation     | Guards the two untrusted boundaries: a user-supplied backup file, and every read from IndexedDB. Hand-written validators for ~20 fields across a discriminated union drift from the types; Zod's inferred types cannot.                                     |
| `date-fns`     | 4.4.0   | MIT        | Date-only calendar arithmetic | Only `differenceInCalendarDays` and `isValid` are used. That one function is the reason DST boundaries do not miscount: a 23-hour local day is still one calendar day, which a millisecond subtraction gets wrong. Tree-shakes to 0.76 KB.                  |
| `lucide-react` | 1.47.0  | ISC        | Icons                         | Bundled locally as SVG components — no icon font, no remote request. Tree-shakes to the ~25 icons actually used (19 KB raw / 7 KB gzip).                                                                                                                    |
| `exceljs`      | 4.4.0   | MIT        | Genuine `.xlsx`               | OOXML is a ZIP of a dozen interrelated XML parts with a shared-strings table and a style registry. Hand-writing it is how the legacy prototype ended up emitting SpreadsheetML 2003 named `.xls`. **Lazy-loaded.**                                          |
| `docx`         | 9.7.1   | MIT        | Genuine `.docx`               | Same reasoning. The legacy "Word" export was an HTML string with a `.doc` extension and malformed table markup. **Lazy-loaded.**                                                                                                                            |

## Development

| Package                            | Version | Purpose                                                                 |
| ---------------------------------- | ------- | ----------------------------------------------------------------------- |
| `typescript`                       | 6.0.3   | Type checking, strict mode                                              |
| `vite`                             | 8.1.5   | Build and dev server                                                    |
| `@vitejs/plugin-react`             | 6.1.1   | React fast refresh + JSX                                                |
| `vite-plugin-pwa`                  | 1.3.0   | Service worker generation                                               |
| `workbox-build` / `workbox-window` | 7.4.1   | Peer requirements of the above; worker runtime                          |
| `vitest`                           | 5.0.1   | Unit and integration runner                                             |
| `@vitest/coverage-v8`              | 5.0.1   | Coverage                                                                |
| `jsdom`                            | 30.1.0  | DOM for unit tests                                                      |
| `fake-indexeddb`                   | 6.2.5   | In-memory IndexedDB so integration tests exercise real Dexie code paths |
| `@testing-library/react`           | 16.3.3  | Component testing                                                       |
| `@testing-library/dom`             | 10.4.2  | Peer of the above                                                       |
| `@testing-library/user-event`      | 14.6.7  | Realistic interaction simulation                                        |
| `@testing-library/jest-dom`        | 7.0.1   | DOM matchers                                                            |
| `@playwright/test`                 | 1.63.0  | E2E                                                                     |
| `@axe-core/playwright`             | 4.13.0  | Accessibility assertions                                                |
| `eslint`                           | 10.11.0 | Linting                                                                 |
| `@eslint/js`                       | 10.0.1  | Base rules                                                              |
| `typescript-eslint`                | 8.70.0  | TS rules, type-aware                                                    |
| `eslint-plugin-react-hooks`        | 7.1.1   | Hook rules                                                              |
| `eslint-plugin-react-refresh`      | 0.5.7   | Fast-refresh safety                                                     |
| `globals`                          | 17.12.0 | Environment globals                                                     |
| `prettier`                         | 3.9.8   | Formatting                                                              |
| `@types/*`                         | matched | Type definitions                                                        |

## Deliberate omissions

| Not used                                 | Why                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A router (`react-router`, `wouter`)      | Six flat routes and no nesting. `src/app/router.ts` is 60 lines, hash-based (so the build works from any sub-path without a rewrite rule) and directly testable.                                                                             |
| A state library (Redux, Zustand, Jotai)  | One React context holding one snapshot, refreshed after each write. For a few hundred records this is both simpler and less bug-prone than cache invalidation.                                                                               |
| A UI framework (MUI, Ant Design, shadcn) | Would add 100–300 KB to deliver components this product barely uses, and would dictate a visual language at odds with the restrained public-sector character. Native controls give better mobile behaviour than most framework substitutes.  |
| Tailwind                                 | The spec asked for a demonstrated architectural benefit. With ~20 components and a token system already required for the design language, CSS modules give scoping, a real cascade for print styles, and no build-time class-name inference. |
| A date picker component                  | `<input type="date">` is better: native keyboard handling, native locale formatting, native mobile pickers, zero bytes.                                                                                                                      |
| A charting library                       | The report shows counts; a table communicates them better than a chart would.                                                                                                                                                                |
| An i18n runtime                          | Single-locale product. Adding one would be scaffolding for a requirement that does not exist.                                                                                                                                                |
| `zustand`/`immer`                        | No deeply nested mutable state to manage.                                                                                                                                                                                                    |

## Notable decisions

### `eslint-plugin-jsx-a11y` is absent — an accepted gap

There is no release compatible with ESLint 10: its peer range stops at `^9`, and every 6.x version
declares the same. ESLint 9 is deprecated upstream ("this version is no longer supported").

The options were a deprecated linter, a force-installed broken peer, or no static JSX a11y rules.
**Chosen: supported ESLint 10, no jsx-a11y**, with compensating controls:

- `@axe-core/playwright` over nine rendered states at WCAG 2.0/2.1/2.2 A and AA, with no rule
  disabled — this measures the real accessibility tree, which is stronger evidence than static JSX
  heuristics;
- explicit behavioural tests for focus trapping, focus restoration, the skip link, keyboard-only
  record creation, accessible names on every button, and 200% zoom;
- a typed API that makes the most common violation impossible to write: `Button` with
  `iconOnly: true` requires `aria-label`, so it cannot compile without one;
- documented manual review in `docs/qa-plan.md`.

**What is genuinely lost:** static detection of patterns axe cannot see at runtime, e.g. a
`role` typo on a component never rendered by a scanned state. This should be revisited when
jsx-a11y supports ESLint 10.

### ExcelJS carries an accepted moderate advisory

`exceljs@4.4.0 → uuid@8.3.2`, GHSA-w5hq-g745-h8pq (moderate). The advisory affects `uuid.v3`/`v5`/
`v6` when a `buf` argument is supplied. ExcelJS imports only `v4` and calls it with no arguments:

```
node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:1
  const {v4: uuidv4} = require('uuid');
```

**Not reachable.** npm's suggested remediation is `exceljs@3.4.0` — an older major — which is not a
fix. Accepted, below the `high` CI gate, recorded in `docs/security.md`, and to be re-checked when
ExcelJS updates its `uuid` dependency.

### Lazy loading

ExcelJS (256 KB gzip) and `docx` (103 KB gzip) are larger than everything else combined. Both are
loaded with a dynamic `import()` at the call site, and their _types_ with `import type` — which
`verbatimModuleSyntax` erases — so the code is fully typed and the initial bundle is unaffected.

Initial JavaScript: **≈178.6 KB gzip** against a 250 KiB budget.

## Adding a dependency

1. Can the standard library or ~50 lines of our own code do it? Prefer that.
2. Does it pull a transitive tree? Check `npm ls <name>` before committing.
3. Does it make a network request at runtime? Then it cannot be used, at all.
4. Add it to this file with purpose, classification, license and any maintenance concern.
5. Pin the exact version, commit the lockfile, and confirm `npm run verify` still passes.
