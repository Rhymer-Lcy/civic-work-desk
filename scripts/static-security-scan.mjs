#!/usr/bin/env node
/**
 * Static source scan for the patterns this product forbids.
 *
 * ESLint already blocks most of these in `src/**`, but this scan is deliberately independent:
 * it reads the files as text, covers directories ESLint does not lint (`public/`, `index.html`,
 * `scripts/`), and it also checks the **built output**, which is where a dependency's behaviour
 * would show up rather than our own source.
 *
 * Its findings go into the review package verbatim (`review/STATIC_SECURITY_SCAN.txt`), so a
 * reviewer sees what was searched for, not only that "a scan ran".
 *
 * Exit code 1 on any finding.
 *
 * Usage: node scripts/static-security-scan.mjs [--json]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories never scanned: dependencies, generated output, confidential material. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '_private_reference',
  '_review_packages',
  'coverage',
  'playwright-report',
  'test-results',
  'dev-dist',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.html', '.css']);

/**
 * Each rule states what it forbids and why.
 *
 * `allow` marks files where a match is expected and legitimate. Every entry is a deliberate,
 * documented exception, never a way to quieten noise.
 *
 * `appliesToDist` separates two different questions:
 *   - "does OUR source use this primitive?" — a code-quality rule, source only. React's own
 *     reconciler necessarily contains `innerHTML` and `dangerouslySetInnerHTML`; finding them in
 *     a minified vendor chunk says nothing about this application.
 *   - "can the built artefact reach a third party?" — a privacy rule, and that one must hold over
 *     the whole bundle including every dependency.
 */
const RULES = [
  {
    id: 'inline-event-handler',
    description: 'Inline HTML event attributes (onclick=, onchange=, ...)',
    reason:
      'The legacy prototype had 118 of these; they defeat CSP and interpolate data into code.',
    pattern:
      /\son(?:click|change|input|submit|load|error|keydown|keyup|focus|blur|mouseover)\s*=\s*["']/gi,
    scope: /\.(html|tsx?|jsx?)$/,
    allow: [],
    appliesToDist: false,
  },
  {
    id: 'eval',
    description: 'eval(...)',
    reason: 'Arbitrary code execution; blocked by CSP.',
    pattern: /(?<![.\w])eval\s*\(/g,
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [],
    appliesToDist: false,
  },
  {
    id: 'new-function',
    description: 'new Function(...)',
    reason: 'Equivalent to eval; blocked by CSP.',
    pattern: /new\s+Function\s*\(/g,
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [],
    appliesToDist: false,
  },
  {
    id: 'dangerously-set-inner-html',
    description: 'dangerouslySetInnerHTML',
    reason: 'Bypasses React escaping; the legacy stored-XSS vector.',
    pattern: /dangerouslySetInnerHTML/g,
    scope: /\.(tsx?|jsx?)$/,
    allow: [],
    appliesToDist: false,
  },
  {
    id: 'inner-html-assignment',
    description: '.innerHTML / .outerHTML assignment',
    reason: 'The legacy prototype built markup from template strings in 40 places.',
    pattern: /\.(inner|outer)HTML\s*=/g,
    scope: /\.(tsx?|jsx?|mjs|cjs)$/,
    allow: [],
    appliesToDist: false,
  },
  {
    id: 'document-write',
    description: 'document.write(',
    reason: 'Legacy print-window hack; blocked in modern browsers and unsafe.',
    pattern: /document\s*\.\s*write\s*\(/g,
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [],
    appliesToDist: false,
  },
  {
    id: 'remote-script-or-style',
    description: 'Remote <script src="http(s)://"> or <link href="http(s)://">',
    reason: 'No runtime dependency may be fetched from another origin.',
    pattern: /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//gi,
    scope: /\.(html|tsx?|jsx?)$/,
    allow: [],
    appliesToDist: true,
  },
  {
    id: 'known-telemetry-host',
    description: 'Analytics / CDN / font hostnames',
    reason: 'Zero third-party telemetry is a hard product requirement.',
    pattern:
      /\b(?:beacon\.cdn\.qq\.com|BeaconAction|google-analytics\.com|googletagmanager\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|sentry\.io|hotjar\.com|mixpanel\.com)\b/gi,
    scope: /\.(tsx?|jsx?|mjs|cjs|html|css|json)$/,
    // Three legitimate mentions: the docs recording the removal, and the E2E test that asserts the
    // strings are absent — a negative assertion has to contain its own needle.
    allow: [/^docs[/\\]/, /^_private_reference[/\\]/, /^tests[/\\]/],
    appliesToDist: true,
  },
  {
    id: 'absolute-local-path',
    description: 'Hard-coded absolute Windows or POSIX developer paths',
    reason: 'Source must be location-independent; only setup docs may name a path.',
    pattern:
      /(?:[A-Za-z]:[\\/](?:CivicWorkDesk|Users|新建文件夹)|\/home\/[a-z]+\/|\/Users\/[a-z]+\/)/g,
    scope: /\.(tsx?|jsx?|mjs|cjs|html|css|json|yml|yaml)$/,
    allow: [],
    appliesToDist: true,
  },
  {
    id: 'legacy-personal-data',
    description: 'Record ids from the legacy personal dataset',
    reason: 'Real names, numbers and record ids must never enter the repository.',
    /*
     * `imp_NNN` is the id scheme of the 178 embedded records in the legacy file. Finding one in
     * source or in the bundle means a real record has been copied in.
     *
     * The legacy localStorage key names (`gov_work_log_v2` and friends) are deliberately NOT part
     * of this pattern: they are key names, not data, and they appear in code comments and in
     * docs/legacy-audit.md precisely to document what was replaced. A rule that flagged them would
     * be pressure to delete the explanation rather than pressure to protect anything.
     */
    pattern: /\bimp_\d{3}\b/g,
    scope: /\.(tsx?|jsx?|mjs|cjs|html|css|json)$/,
    allow: [/^docs[/\\]/],
    appliesToDist: true,
  },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (SOURCE_EXTENSIONS.has(extname(entry))) out.push(full);
  }
  return out;
}

function scan(files) {
  const findings = [];
  for (const file of files) {
    const relativePath = relative(ROOT, file).replaceAll('\\', '/');
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // This file necessarily contains every pattern it searches for.
    if (relativePath === 'scripts/static-security-scan.mjs') continue;
    const inDist = relativePath.startsWith('dist/');
    for (const rule of RULES) {
      if (!rule.scope.test(file)) continue;
      if (inDist && rule.appliesToDist !== true) continue;
      if (rule.allow.some((allowed) => allowed.test(relativePath))) continue;
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        findings.push({
          rule: rule.id,
          file: relativePath,
          line,
          excerpt: match[0].slice(0, 80),
        });
      }
    }
  }
  return findings;
}

function main() {
  const asJson = process.argv.includes('--json');
  const targets = ['src', 'scripts', 'tests', 'public', 'index.html', 'dist'];
  const files = [];
  for (const target of targets) {
    const full = join(ROOT, target);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }

  const findings = scan(files);
  const distScanned = files.some((file) => relative(ROOT, file).startsWith('dist'));

  if (asJson) {
    console.log(JSON.stringify({ filesScanned: files.length, distScanned, findings }, null, 2));
  } else {
    console.log(`CivicWorkDesk static security scan`);
    console.log(`files scanned : ${String(files.length)}`);
    console.log(`dist included : ${distScanned ? 'yes' : 'no (run npm run build first)'}`);
    console.log(`rules applied : ${String(RULES.length)}`);
    for (const rule of RULES) {
      console.log(`  - ${rule.id}: ${rule.description}`);
    }
    console.log('');
    if (findings.length === 0) {
      console.log('RESULT: PASS — no forbidden pattern found.');
    } else {
      console.log(`RESULT: FAIL — ${String(findings.length)} finding(s):`);
      for (const finding of findings) {
        console.log(
          `  ${finding.rule}  ${finding.file}:${String(finding.line)}  ${finding.excerpt}`,
        );
      }
    }
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

main();
