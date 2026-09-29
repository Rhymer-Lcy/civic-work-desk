import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEDGER_TABLE_QUERY, WIDE_LAYOUT_REM } from '@/styles/breakpoints';

/**
 * The script-side breakpoints must agree with the stylesheets, which cannot import them.
 *
 * The ledger chooses between its table and its card list in script, at the width where the
 * application bar stacks in CSS. If either moved alone, the page would show a desktop table under a
 * phone-shaped bar (or the reverse) across a band of widths, and nothing else would notice.
 */

function css(path: string): string {
  // Comments carry the history of the old rules; only live CSS counts.
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

const SHELL = css('src/components/layout/AppShell.module.css');
const LEDGER = css('src/features/ledger/LedgerPage.module.css');

/** Every `selector { body }` block whose selector names the class, at any nesting depth. */
function blocksFor(source: string, className: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`[^{}]*\\.${className}\\b[^{}]*\\{([^{}]*)\\}`, 'g');
  for (const match of source.matchAll(pattern)) blocks.push(match[1] ?? '');
  return blocks;
}

describe('layout breakpoints', () => {
  it('the ledger switches presentation at the width where the application bar stacks', () => {
    expect(LEDGER_TABLE_QUERY).toBe(`(min-width: ${String(WIDE_LAYOUT_REM)}rem)`);
    const stacking = [...SHELL.matchAll(/@media \(max-width: ([\d.]+)rem\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(stacking).toEqual([WIDE_LAYOUT_REM]);
  });

  it('the ledger stylesheet no longer switches presentations itself', () => {
    // The old rule rendered both presentations and hid one; the choice now lives in script only.
    expect(LEDGER).not.toMatch(
      new RegExp(`\\(\\s*m(in|ax)-width:\\s*${String(WIDE_LAYOUT_REM)}rem`),
    );
    const wrapBlocks = blocksFor(LEDGER, 'tableWrap');
    const cardBlocks = blocksFor(LEDGER, 'cards');
    expect(wrapBlocks.length).toBeGreaterThan(0);
    expect(cardBlocks.length).toBeGreaterThan(0);
    for (const body of [...wrapBlocks, ...cardBlocks]) {
      expect(body).not.toMatch(/display\s*:\s*none/);
    }
  });
});
