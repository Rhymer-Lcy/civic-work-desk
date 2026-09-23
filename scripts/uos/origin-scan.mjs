/**
 * Shared rule: does this line *use* an origin, or does it *talk about* one?
 *
 * Both the static check over the working tree (lint-shell.mjs) and the check over the delivered
 * archive (archive-tests.mjs) have to answer that question, and they have to answer it the same way.
 * They did not, at first: the archive check scanned raw text and flagged the README table row that
 * exists precisely to tell the operator `http://localhost:8765/` is the WRONG origin. A scan that
 * cannot tell a prohibition from an instance flags exactly the sentences written to prevent the
 * defect — and, worse, invites someone to delete the warning to make the check pass.
 *
 * So the decision lives here once. Two consumers, one rule; if the rule is wrong it is wrong in one
 * place.
 */

/**
 * Commands that could actually contact or bind an origin. A Markdown line is only inspected when it
 * starts with one of these, optionally behind a shell prompt.
 */
export const COMMAND_START =
  /^\s*(?:\$\s*)?(sh|bash|sudo|python3?|curl|wget|xdg-open|xdg-settings|xdg-mime|busybox|ss|netstat|cd|cp|mv|rm|kill|pkill|killall|exec|nohup|ln|tar|sha256sum)\b/;

/** A Markdown line that is a command, or the empty string if it is prose. */
export function commandOf(line) {
  return COMMAND_START.test(line) ? line : '';
}

/** Shell/conf/desktop source minus its comment, so naming a construct is not using it. */
export function strippedShellLine(line) {
  return line.replace(/(^|\s)#.*$/, '$1');
}

/**
 * How a given filename should be read. `raw` is for generated data files with no comment syntax and
 * no prose, where every occurrence is real.
 */
export function scanKindFor(name) {
  if (/\.(sh|conf|desktop)$/.test(name)) return 'shell';
  if (/\.md$/.test(name)) return 'markdown';
  return 'raw';
}

/**
 * Origin defects in one file's text. Returns `{ line, rule, detail }` for each hit.
 *
 * The rules are the product invariants, not language rules: the canonical origin is
 * http://127.0.0.1:8765, and a different scheme, host or port is a different IndexedDB namespace,
 * which presents to the user as data loss rather than as a misconfiguration.
 */
export function wrongOriginHits(text, kind) {
  const hits = [];
  text.split('\n').forEach((rawLine, index) => {
    if (rawLine.includes('lint-shell:allow')) return;

    let line;
    if (kind === 'shell') line = strippedShellLine(rawLine);
    else if (kind === 'markdown') line = commandOf(rawLine);
    else line = rawLine;

    const number = index + 1;
    if (/\blocalhost\s*:\s*8765/.test(line)) {
      hits.push({ line: number, rule: 'origin', detail: 'localhost:8765 is a different origin' });
    }
    if (/0\.0\.0\.0/.test(line)) {
      hits.push({ line: number, rule: 'bind', detail: '0.0.0.0 would expose the app to the LAN' });
    }
    const portHit = /127\.0\.0\.1:(\d{2,5})/.exec(line);
    if (portHit && portHit[1] !== '8765') {
      hits.push({ line: number, rule: 'origin', detail: `port ${portHit[1]} is not canonical` });
    }
    if (/https:\/\/127\.0\.0\.1/.test(line)) {
      hits.push({
        line: number,
        rule: 'origin',
        detail: 'the canonical origin is http, not https',
      });
    }
  });
  return hits;
}
