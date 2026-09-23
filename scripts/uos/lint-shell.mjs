#!/usr/bin/env node
/**
 * Static checks for the UOS deployment shell scripts and documents.
 *
 * ShellCheck would be the obvious tool and is not available here: the machine is behind a proxy that
 * returns 403 for the binary download, and Phase 3 may not add an Internet dependency to obtain a
 * linter. So this checks the rules that actually matter for *this* deployment — most of which
 * ShellCheck would not know about anyway, because they are invariants of the product rather than of
 * the language:
 *
 *   - the canonical origin appears exactly as `http://127.0.0.1:8765`, everywhere, with no
 *     `localhost`, no `0.0.0.0`, and no other port (§6, §18). A stray `localhost:8765` in a launcher
 *     is not a typo, it is a different IndexedDB namespace and therefore apparent data loss;
 *   - nothing requires `sudo` (§15);
 *   - no deletion by wildcard or by unquoted variable;
 *   - no process is killed by port number alone (§24);
 *   - POSIX `sh` scripts contain no bashisms, because the target's `/bin/sh` has not been observed;
 *   - every script declares a shebang and `set -eu`.
 *
 * Run: node scripts/uos/lint-shell.mjs
 *
 * **What it cannot catch.** The origin rules are textual, so they see `127.0.0.1:8765` written out
 * but not `"$HOST:$PORT"` — a script that assigned the wrong value to `PORT` would pass here. That
 * is deliberate rather than an oversight: statically resolving shell variables is a different kind
 * of tool, and the real defence against a wrong port is that the RC1 acceptance sheet asks the
 * tester to read the browser's address bar and confirm it character by character. Mutation-tested:
 * changing `HOST` to a wildcard bind in `start-test.sh` is caught; changing only `PORT` is not.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { commandOf } from './origin-scan.mjs';

const ROOT = process.cwd();
// Only the UOS deployment surface. `docs/security.md` legitimately discusses a different origin —
// the Playwright preview server — and scanning it here would be measuring the wrong subsystem.
//
// Every bundle directory is named explicitly rather than matched by prefix. That is not tidiness: it
// is the fix for a real coverage gap. `release/uos-rc1` does not contain `release/uos-rc1-1`, so when
// RC1.1 was cut, its twelve files silently fell outside the lint while the run kept reporting PASS —
// a check that had stopped looking at the thing it was supposed to guard. Adding a bundle here is now
// part of cutting one; the count printed at the end is the thing to watch.
const ROOTS = [
  'scripts/uos',
  'deploy/uos',
  'release/uos-rc1',
  'release/uos-rc1-1',
  'release/uos20',
];
const DOC_PATTERN = /^docs\/uos-[\w-]+\.md$/;
const CANONICAL = 'http://127.0.0.1:8765';

/**
 * Does this line *do* something, or does it *talk about* something?
 *
 * That distinction is the difference between a working check and a noisy one. Every document here
 * has to explain that `localhost:8765` is not the deployment URL, that binding all interfaces would
 * expose the application, and that sudo is not required — and a scanner that cannot tell a
 * prohibition from an instance flags exactly the sentences written to prevent the defect. (Same
 * family as an absence check whose needle is wrapped in its own source: it fails in the direction
 * that looks like success.)
 *
 * So: prose is checked only where it carries a command; code is checked with comments stripped.
 *
 * The decision itself lives in origin-scan.mjs (imported above), shared with the check that runs over
 * the delivered archive. Two scanners answering the same question differently is how the archive
 * check came to flag the README's own warning about localhost.
 */

const problems = [];
function fail(file, line, rule, detail) {
  problems.push({ file, line, rule, detail });
}

/** Python source with docstrings and comments removed, so naming a construct is not using it. */
function pythonCode(text) {
  const fence = '"'.repeat(3);
  const withoutDocstrings = text
    .split(fence)
    .filter((_, index) => index % 2 === 0)
    .join(' ');
  return withoutDocstrings.replace(/^\s*#.*$/gm, '');
}

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (/\.(sh|md|desktop|json|py|conf)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...ROOTS.flatMap((dir) => collect(join(ROOT, dir))),
  ...collect(join(ROOT, 'docs')).filter((file) =>
    DOC_PATTERN.test(relative(ROOT, file).replaceAll('\\', '/')),
  ),
];

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const isShell = rel.endsWith('.sh');
  const isPython = rel.endsWith('.py');

  // Python docstrings are not comments, so stripping `#` is not enough: the server's own docstring
  // states which binds it refuses, and that sentence must not read as a bind.
  let inDocstring = false;

  lines.forEach((rawLine, index) => {
    const number = index + 1;

    let source = rawLine;
    if (isPython) {
      const fences = (rawLine.match(/"""/g) ?? []).length;
      const startedInside = inDocstring;
      if (fences % 2 === 1) inDocstring = !inDocstring;
      if (startedInside || inDocstring || fences > 0) source = '';
    }

    // In a script, the line minus its comment. In prose, only a line that starts with a command.
    const line = isShell || isPython ? source.replace(/(^|\s)#.*$/, '$1') : commandOf(rawLine);
    const exempt = rawLine.includes('lint-shell:allow');

    /* ---- canonical origin ---- */
    if (!exempt && /\blocalhost\s*:\s*8765/.test(line)) {
      fail(rel, number, 'origin', 'localhost:8765 is a different origin from 127.0.0.1:8765');
    }
    if (!exempt && /0\.0\.0\.0/.test(line)) {
      fail(rel, number, 'bind', '0.0.0.0 would expose the application to the LAN');
    }
    const portHit = /127\.0\.0\.1:(\d{2,5})/.exec(line);
    if (!exempt && portHit && portHit[1] !== '8765') {
      fail(rel, number, 'origin', `port ${portHit[1]} is not the canonical 8765`);
    }
    if (!exempt && /https:\/\/127\.0\.0\.1/.test(line)) {
      fail(rel, number, 'origin', 'the canonical origin is http, not https');
    }

    /* ---- operational safety ---- */
    if (!exempt && /(^|\s)sudo\s/.test(line)) {
      fail(rel, number, 'sudo', 'Phase 3 must not require sudo');
    }
    if (!exempt && /\brm\s+(-[a-zA-Z]+\s+)*[^|&;]*\*/.test(line)) {
      fail(rel, number, 'rm-glob', 'deletion by wildcard');
    }
    if (!exempt && /\brm\s+(-[a-zA-Z]+\s+)*\$[A-Za-z_{]/.test(line)) {
      fail(rel, number, 'rm-var', 'deletion of an unquoted variable path');
    }
    // Word boundaries on the discovery tools, not bare substrings. `ss\s` without them matches the
    // "ss " inside "process holding the port" — which is how this rule first fired on a test's own
    // description string. A needle short enough to hide inside an English word will.
    if (
      !exempt &&
      /\b(kill|pkill|killall)\b/.test(line) &&
      /\bfuser\b|\blsof\b|\bss\b|\bnetstat\b/.test(line)
    ) {
      fail(rel, number, 'kill-by-port', 'never kill a process discovered only by port');
    }

    /* ---- POSIX shell ---- */
    if (isShell && !exempt) {
      // `[[` is a bashism; `[[:space:]]` is a POSIX character class and appears in every sed
      // expression here. The colon is what separates them, so the test excludes it rather than
      // whitelisting the scripts that parse JSON with sed.
      if (/\[\[(?!:)/.test(line)) fail(rel, number, 'bashism', '[[ is not POSIX');
      if (/\bfunction\s+\w+\s*\(/.test(line)) fail(rel, number, 'bashism', 'function keyword');
      if (/\w+=\(/.test(line)) fail(rel, number, 'bashism', 'array assignment');
      // Only `source` in command position. The bare word also occurs in prose that these scripts
      // print ("if one source file is not UTF-8"), and a shell string is not stripped the way a
      // comment is, so position is the only thing that distinguishes the builtin from the noun.
      if (/(?:^|[;&|]\s*)\s*source\s/.test(line)) fail(rel, number, 'bashism', 'source; use .');
      if (/&>/.test(line)) fail(rel, number, 'bashism', '&> redirection');
      if (/\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\]/.test(line))
        fail(rel, number, 'bashism', 'array expansion');
    }
  });

  if (isShell) {
    if (!/^#!\/bin\/sh\b/.test(text) && !/^#!\/usr\/bin\/env sh\b/.test(text)) {
      fail(rel, 1, 'shebang', 'expected #!/bin/sh — bash has not been observed on the target');
    }
    if (!/\nset -eu\b/.test(text)) {
      fail(rel, 1, 'set-eu', 'missing `set -eu`');
    }
  }

  if (isPython) {
    // The target runs Python 3.7.3. These are the constructs most likely to be reached for. Checked
    // against the code with docstrings removed: this server's own docstring lists what it avoids.
    const code = pythonCode(text);
    if (/:=/.test(code)) fail(rel, 1, 'py37', 'walrus operator requires Python 3.8');
    if (/f["'][^"']*\{[^}]*=\}/.test(code))
      fail(rel, 1, 'py37', 'f-string = specifier requires 3.8');
    if (/functools\.cached_property/.test(code))
      fail(rel, 1, 'py37', 'cached_property requires 3.8');
    if (
      /^\s*import\s+(?!abc|argparse|base64|contextlib|errno|functools|hashlib|html|http|io|json|mimetypes|os|posixpath|re|shutil|signal|socket|socketserver|sys|threading|time|traceback|urllib)/m.test(
        code,
      )
    ) {
      fail(rel, 1, 'py-stdlib', 'only the Python standard library is permitted');
    }
  }
}

/* ---- acceptance-document ordering ----
 *
 * The main evidence collector gathers exactly what uninstall deletes: the installed program files, the
 * desktop entry, the runtime state and the deployment logs. So an acceptance manual that tells the
 * tester to uninstall first produces a file full of "not installed" and throws away the strongest
 * automated evidence of the installed form — silently, because the collector still exits 0.
 *
 * That is an ordering property of a document, which no per-line rule can see. It is asserted here so
 * a later edit cannot reorder the sections unnoticed. Mutation-tested by swapping the two sections.
 */
const ORDERING = [
  {
    file: 'deploy/uos/acceptance/FINAL_ACCEPTANCE.md',
    earlier: { pattern: /scripts\/collect-results\.sh/, name: 'collect-results.sh' },
    later: { pattern: /civic-work-desk-uninstall/, name: 'the uninstall command' },
  },
  {
    file: 'deploy/uos/acceptance/RESULT_TEMPLATE.md',
    earlier: { pattern: /^## \d+\. 收集证据/m, name: 'the evidence-collection section' },
    later: { pattern: /^## \d+\. 卸载/m, name: 'the uninstall section' },
  },
];

for (const rule of ORDERING) {
  const full = join(ROOT, rule.file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch {
    fail(rule.file, 0, 'ordering', 'file missing, so its ordering cannot be checked');
    continue;
  }
  const earlierAt = text.search(rule.earlier.pattern);
  const laterAt = text.search(rule.later.pattern);
  if (earlierAt < 0) {
    fail(rule.file, 0, 'ordering', `${rule.earlier.name} is not mentioned at all`);
    continue;
  }
  if (laterAt < 0) {
    fail(rule.file, 0, 'ordering', `${rule.later.name} is not mentioned at all`);
    continue;
  }
  if (earlierAt > laterAt) {
    const line = text.slice(0, earlierAt).split('\n').length;
    fail(
      rule.file,
      line,
      'ordering',
      `${rule.earlier.name} must come BEFORE ${rule.later.name} — uninstall deletes what the ` +
        'collector gathers, so collecting afterwards yields a "not installed" report',
    );
  }
}

/* The canonical origin must appear somewhere, or the check above is vacuous. */
const mentions = files.filter((file) => readFileSync(file, 'utf8').includes(CANONICAL)).length;
if (mentions === 0) {
  fail('(all)', 0, 'origin', `no file mentions the canonical origin ${CANONICAL}`);
}

console.log(
  `UOS shell/doc static check — ${String(files.length)} files, canonical origin ${CANONICAL}`,
);
console.log(`files referencing the canonical origin: ${String(mentions)}`);
if (problems.length === 0) {
  console.log('RESULT: PASS — no forbidden pattern found.');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${String(problems.length)} problem(s):`);
for (const problem of problems) {
  console.log(`  ${problem.file}:${String(problem.line)}  [${problem.rule}] ${problem.detail}`);
}
process.exit(1);
