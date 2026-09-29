/**
 * Layout breakpoints that script has to agree with.
 *
 * CSS cannot import these values, so `tests/unit/breakpoints.test.ts` reads the stylesheets and fails
 * if a rule that must switch at the same width drifts from the value declared here.
 */

/**
 * The width, in rem, at which the application moves between its narrow and wide layouts: the
 * application bar stacks below it (`AppShell.module.css`), and the ledger shows its table at and
 * above it.
 */
export const WIDE_LAYOUT_REM = 60;

/**
 * The ledger renders its table when this matches and its card list otherwise.
 *
 * Until Phase 5 both were rendered and `LedgerPage.module.css` hid one with the same query; the
 * choice is now made here, once, and the unused presentation is not rendered at all.
 */
export const LEDGER_TABLE_QUERY = `(min-width: ${String(WIDE_LAYOUT_REM)}rem)`;
