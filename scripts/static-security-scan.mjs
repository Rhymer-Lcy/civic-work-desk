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
  /*
   * Phase 5. The reference prototype a friend maintains loads Tencent Beacon and reports page views
   * and referrers. Its design is a reference for this product and its code is not, so the three ways
   * that kind of code reaches the network are forbidden outright, in source and in the bundle.
   */
  {
    id: 'beacon-api',
    description: 'navigator.sendBeacon(...)',
    reason: 'The browser API analytics libraries use to report on page unload.',
    pattern: /\bsendBeacon\s*\(/g,
    samples: ['navigator.sendBeacon(url, body)'],
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [/^docs[/\\]/, /^tests[/\\]/],
    appliesToDist: true,
  },
  {
    id: 'cn-analytics-host',
    description: 'Tencent, Baidu and other Chinese analytics or reporting hosts',
    reason: 'Zero third-party telemetry; the reference prototype reported to beacon.cdn.qq.com.',
    pattern:
      /(?:\b[a-z0-9-]+\.)*qq\.com\b|\bhm\.baidu\.com\b|\bcnzz\.com\b|\bumeng\.com\b|\b51\.la\b|\bgrowingio\b|\bsensorsdata\b/gi,
    samples: ['https://beacon.cdn.qq.com/sdk/beacon.js', 'https://hm.baidu.com/hm.js?x'],
    scope: /\.(tsx?|jsx?|mjs|cjs|html|css|json)$/,
    allow: [/^docs[/\\]/, /^_private_reference[/\\]/, /^tests[/\\]/],
    appliesToDist: true,
  },
  {
    id: 'dynamic-remote-load',
    description:
      'A remote URL assigned to .src, fetched, opened, or a tracking pixel (new Image())',
    reason: 'How a loader injects a remote SDK at run time without any <script> tag in the HTML.',
    pattern:
      /\.src\s*=\s*["'`]https?:\/\/|(?:\bfetch|\.open)\(\s*["'`](?:GET["'`]\s*,\s*["'`])?https?:\/\/|\bnew\s+Image\s*\(\s*\)/g,
    samples: [
      "script.src = 'https://beacon.cdn.qq.com/sdk/4.5.9/beacon_web.min.js'",
      "fetch('https://example.invalid/report')",
      "xhr.open('GET', 'https://example.invalid/report')",
      'const pixel = new Image()',
    ],
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [/^docs[/\\]/, /^tests[/\\]/],
    appliesToDist: true,
  },
  {
    id: 'window-client-enumeration',
    description:
      'Service-worker window enumeration (clients.matchAll) outside the reviewed protocol',
    reason:
      'Phase 5.1: one reviewed file may enumerate the windows of the origin, and it reduces each to a ' +
      'URL-free classification before replying. Any other enumeration could disclose what is open.',
    pattern: /\bclients\s*\.\s*matchAll\s*\(/g,
    samples: ["self.clients.matchAll({ type: 'window' })", 'clients .matchAll()'],
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [
      /^public[/\\]sw-client-awareness\.js$/,
      /^dist[/\\]sw-client-awareness\.js$/,
      /^docs[/\\]/,
      /^tests[/\\]/,
    ],
    appliesToDist: true,
  },
  {
    id: 'runtime-endpoint-caller',
    description:
      'A caller of the deployment endpoint /api/civic/runtime outside its reviewed module',
    reason:
      'Phase 5.1: one module asks the endpoint which interface generation is expected, with a ' +
      'body-less GET and no credentials. A second caller could send what that module never sends.',
    pattern: /\/api\/civic\/runtime\b/g,
    samples: ["fetch('/api/civic/runtime')", 'const url = "/api/civic/runtime";'],
    scope: /\.(tsx?|jsx?|mjs|cjs|html)$/,
    allow: [
      /^src[/\\]app[/\\]pwa[/\\]runtime-generation\.ts$/,
      // The module above, bundled: it lives in the entry chunk.
      /^dist[/\\]assets[/\\]index-[A-Za-z0-9_-]+\.js$/,
      /^docs[/\\]/,
      /^tests[/\\]/,
    ],
    appliesToDist: true,
  },
];

/**
 * Every rule that declares `samples` must match each of them, or the scan refuses to run.
 *
 * A rule whose pattern cannot fire reports PASS forever; that is how an absence check quietly stops
 * checking. The samples are planted positives, verified on every run before anything is scanned.
 */
function selfTest() {
  const broken = [];
  for (const rule of RULES) {
    for (const sample of rule.samples ?? []) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(sample)) broken.push(`${rule.id}: ${sample}`);
    }
    rule.pattern.lastIndex = 0;
  }
  return broken;
}

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
  const broken = selfTest();
  if (broken.length > 0) {
    console.error('SELF-TEST FAILED — these rules do not match their own samples:');
    for (const line of broken) console.error(`  ${line}`);
    process.exit(2);
  }
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
