/**
 * Browser file download.
 *
 * Two legacy defects are fixed here.
 *
 * 1. **The object URL was revoked synchronously after `click()`.** `exportJSON()` and
 *    `exportExcel()` both did `a.click(); URL.revokeObjectURL(url);` on the same tick, which can
 *    abort the transfer before the browser has read the blob. `exportPeriodReport()` used a
 *    1-second timeout, so the same product had two different behaviours.
 * 2. **Success was asserted, not observed.** The legacy code showed "已导出 N 条" and wrote
 *    `gov_last_backup` unconditionally, even if nothing reached disk. Here `downloadBlob`
 *    reports what it actually did, and callers only record a successful backup on a resolved
 *    promise.
 *
 * What a browser permits us to observe is limited: there is no API that confirms the user kept
 * the file. `downloadBlob` therefore guarantees a narrower, honest claim — the blob was produced,
 * handed to the browser, and no error was raised while doing so. `docs/security.md` states that
 * limit, and the UI wording matches it ("已生成", not "已保存").
 */

const REVOKE_DELAY_MS = 30_000;

export interface DownloadResult {
  readonly filename: string;
  readonly byteLength: number;
}

export class DownloadError extends Error {
  override readonly name = 'DownloadError';
  constructor(filename: string, cause: unknown) {
    super(`could not hand "${filename}" to the browser`, { cause });
  }
}

export function downloadBlob(blob: Blob, filename: string): DownloadResult {
  let url: string | null = null;
  try {
    url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    // Appending before clicking is required by some browsers and harmless in the rest. `hidden`
    // rather than an inline `style.display` write: the UA stylesheet already hides it, a
    // programmatic `click()` still fires on a hidden element, and the element carries no `style`
    // attribute. (That is tidiness and `style-src-attr` hygiene, not what makes the strict CSP
    // possible — `style-src` does not govern CSSOM writes. See docs/security.md.)
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } catch (cause) {
    if (url) URL.revokeObjectURL(url);
    throw new DownloadError(filename, cause);
  }

  // Held long enough that a slow disk or a "Save as" dialog cannot lose the transfer, then
  // released so a long session does not accumulate blobs.
  const held = url;
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(held);
  }, REVOKE_DELAY_MS);

  return { filename, byteLength: blob.size };
}

export function jsonBlob(text: string): Blob {
  return new Blob([text], { type: 'application/json;charset=utf-8' });
}

/** The genuine OOXML spreadsheet media type. */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The genuine OOXML word-processing media type. */
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
