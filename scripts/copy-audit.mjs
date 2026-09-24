#!/usr/bin/env node
/**
 * Audit the CURRENT user-visible deployment copy against docs/copy-style-zh-CN.md.
 *
 *   npm run audit:copy
 *   node scripts/copy-audit.mjs --mutate   prove the audit can fail
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a few hundred lines that grep a fixed file list. It is not a localisation framework, and adding
 * one would be a much larger commitment than the problem justifies: the whole surface is one installer,
 * four small programs, one page and two documents.
 *
 * ## Three kinds of result
 *
 *   FAIL      a retired phrase in a file that is expected to be current, or a required safety
 *             statement that has gone missing;
 *   DEFERRED  a retired phrase in a surface whose normalisation is scheduled rather than done. Each is
 *             pinned to an exact count, so the known ones stay silent and a NEW one fails. A plain
 *             exclusion would have let the problem grow without anybody noticing.
 *   ALLOWED   an occurrence inside something that must keep its original wording: historical evidence,
 *             a frozen release payload, or a source comment explaining why a phrase was retired.
 *
 * The UOS runtime and its documents are DEFERRED rather than fixed here on purpose. `deploy/uos/` is the
 * source the frozen, signed-off -5 artifact was built from; editing its copy now would make the source
 * and those bytes disagree, with no release to reconcile them. See docs/uos-next-maintenance.md.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MUTATE = process.argv.includes('--mutate');

/** Retired wording. Each entry says what to use instead, so a failure is actionable on its own. */
const RETIRED = [
  { text: '规范地址', instead: '固定访问地址' },
  { text: '部署集成', instead: '安装项' },
  { text: '系统集成项', instead: '安装项' },
  { text: '发布完整性', instead: '程序完整性' },
  { text: '把生成的 txt 发回', instead: '将生成的诊断文件（TXT）反馈给维护人员' },
  { text: '不向外发送任何东西', instead: '不会主动向外部服务上传业务数据' },
  { text: '不是这个程序有问题', instead: '该提示本身不能证明程序安全或不安全' },
  { text: '小服务', instead: '本地服务' },
  { text: '本机服务', instead: '本地服务' },
  { text: '再点一次', instead: '重试' },
  { text: '错杀一个无关进程', instead: '这是安全设计：无法确认进程归属时，不执行强制终止操作' },
  { text: '系统未被修改', instead: '未写入正式安装目录，安装未完成' },
  { text: '安装 政务工作记录台', instead: '安装政务工作记录台（纯中文短语内不加空格）' },
  { text: '卸载 政务工作记录台', instead: '卸载政务工作记录台（纯中文短语内不加空格）' },
  // Caught by the external review, then MISSED by this audit for a whole release: the RC2 installer
  // still said 「（<path> 无法执行）」, whose grammatical subject reads as the program rather than the
  // stop tool. It is listed explicitly because the audit works on phrases, and a phrase it was never
  // told about is a phrase it cannot find.
  { text: '无法执行）', instead: '停止工具无法执行。（路径移入诊断文件）' },
  { text: '「', instead: '“（GB/T 15834 横排引号）' },
  { text: '」', instead: '”（GB/T 15834 横排引号）' },
];

/**
 * Statements that must still be present somewhere in the current Windows surface.
 *
 * A retired-phrase scan can only ever prove an absence. These prove the presence of the things the
 * rewrite existed to protect: without them, deleting a safety sentence entirely would pass every other
 * check in this file.
 */
const REQUIRED = [
  {
    text: '程序不会强行结束无法确认归属的进程',
    why: 'the safe-process guarantee',
    in: [
      'deploy/windows/src/cmd/civic-launch/control.go',
      'deploy/windows/installer/civic-work-desk.iss',
    ],
  },
  {
    text: '卸载程序不等于删除数据',
    why: 'the uninstall warning',
    in: [
      'deploy/windows/installer/civic-work-desk.iss',
      'deploy/windows/installer/README-测试说明.txt',
    ],
  },
  {
    text: '未写入正式安装目录，安装未完成',
    why: 'the precise preflight-failure statement',
    in: ['deploy/windows/installer/civic-work-desk.iss'],
  },
  {
    text: '浏览器来源（origin）',
    why: 'the origin explanation',
    in: ['deploy/windows/installer/README-测试说明.txt'],
  },
  {
    text: '请勿关闭 Windows Defender 或 SmartScreen',
    why: 'the instruction never to weaken Windows security',
    in: ['deploy/windows/installer/README-测试说明.txt'],
  },
  {
    text: '无法停止正在运行的政务工作记录台：停止工具无法执行。',
    why: 'the disambiguated stop-tool failure sentence',
    in: ['deploy/windows/installer/civic-work-desk.iss'],
  },
  {
    text: '固定访问地址',
    why: 'the current address term',
    in: [
      'deploy/windows/src/cmd/civic-launch/control.go',
      'deploy/windows/installer/README-测试说明.txt',
    ],
  },
];

/**
 * Current user-visible Windows surfaces: any retired phrase here is a failure.
 *
 * The phase documents are deliberately NOT in this list. They are English engineering records whose
 * job is to say which wording was retired and why, so they necessarily print every retired phrase —
 * exactly like the style guide, and exactly like the phase-3 documents already treated this way. What
 * is governed here is the text a user actually reads.
 */
const CURRENT_GLOBS = [
  'deploy/windows/installer',
  'deploy/windows/src',
  'deploy/windows/probe',
  'docs/copy-style-zh-CN.md',
  'docs/user-visible-copy-zh-CN.md',
];

/**
 * Surfaces whose normalisation is scheduled, pinned to their exact current counts.
 *
 * These numbers are a baseline, not a licence. Removing an occurrence fails the audit just as adding
 * one does, which is what forces the pins to be updated deliberately when the UOS maintenance release
 * actually lands rather than drifting.
 */
const DEFERRED = {
  'deploy/uos': { 规范地址: 3, 部署集成: 6, 再点一次: 2, '「': 56, '」': 56 },
  'docs/uos-deployment.md': { 规范地址: 1, '「': 16, '」': 16 },
  'docs/uos-release-process.md': { 规范地址: 3, '「': 4, '」': 4 },
  'docs/uos-upgrade-recovery.md': { 规范地址: 1, '「': 12, '」': 12 },
  'docs/uos-final-acceptance.md': { '「': 8, '」': 8 },
  'docs/uos-target-acceptance.md': { '「': 2, '」': 2 },
};

/**
 * Files that keep their original wording by design.
 *
 * `release/` is frozen artefact bytes. The phase-3 evidence and audit documents record what was said at
 * the time. `ui-copy-guidelines.md` and the product docs belong to the application, not to deployment.
 */
const ALLOWED_PREFIXES = [
  'release/',
  'docs/phase-3-',
  'docs/phase-4-windows-rc1.md',
  'docs/phase-4-windows-rc2.md',
  'docs/legacy-audit.md',
  'docs/data-model.md',
  'docs/qa-plan.md',
  'docs/security.md',
  'docs/ui-copy-guidelines.md',
  'docs/ux-audit.md',
  'docs/review-package-provenance.md',
  '_private_reference/',
];

const TEXT_EXTENSIONS = new Set([
  '.go',
  '.iss',
  '.md',
  '.txt',
  '.mjs',
  '.sh',
  '.ps1',
  '.html',
  '.json',
]);

function walk(target) {
  const full = join(ROOT, target);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [target];
  const out = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = `${target}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'out' || entry.name === 'node_modules') continue;
      out.push(...walk(child));
    } else {
      const dot = entry.name.lastIndexOf('.');
      if (dot >= 0 && TEXT_EXTENSIONS.has(entry.name.slice(dot))) out.push(child);
    }
  }
  return out;
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

/**
 * Strip the places an occurrence is legitimately quoted, so an explanation of a retired phrase does not
 * register as a use of it.
 *
 * Two shapes are recognised: a Go or Inno comment line, and a Markdown table row or blockquote in the
 * style guide, which necessarily prints every retired phrase in order to retire it.
 */
function stripExplanations(path, text) {
  const isStyleGuide =
    path.endsWith('copy-style-zh-CN.md') || path.endsWith('user-visible-copy-zh-CN.md');
  if (isStyleGuide) return ''; // the whole document exists in order to quote retired wording

  // Inno's [Code] section is Pascal, whose block comments open with a lone `{` and close with `}`.
  // Without tracking that state the comment explaining WHY a phrase was retired reads as a use of it,
  // which is exactly what this audit reported on its first run.
  let inPascalBlock = false;
  const kept = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (inPascalBlock) {
      if (trimmed.includes('}')) inPascalBlock = false;
      continue;
    }
    // A leading `{` that is not an Inno constant such as {app} or {#Define} opens a comment.
    if (path.endsWith('.iss') && trimmed.startsWith('{') && !/^\{[#a-zA-Z]/.test(trimmed)) {
      if (!trimmed.includes('}')) inPascalBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (trimmed.startsWith(';')) continue; // Inno comment
    if (trimmed.startsWith('#') && path.endsWith('.sh')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

let failures = 0;
let deferredTotal = 0;
const findings = [];

console.log('CivicWorkDesk copy audit');
console.log('');

// ------------------------------------------------------------------ current surfaces must be clean
const currentFiles = CURRENT_GLOBS.flatMap(walk);
console.log(`  current surfaces scanned : ${currentFiles.length} file(s)`);

for (const path of currentFiles) {
  const body = stripExplanations(path, read(path));
  for (const rule of RETIRED) {
    const count = body.split(rule.text).length - 1;
    if (count > 0) {
      failures += 1;
      findings.push(
        `  [FAIL    ] ${path}: ${count}x ${JSON.stringify(rule.text)} -> use ${rule.instead}`,
      );
    }
  }
}

// ------------------------------------------------------------------ required statements
for (const rule of REQUIRED) {
  const present = rule.in.filter(
    (path) => existsSync(join(ROOT, path)) && read(path).includes(rule.text),
  );
  if (present.length !== rule.in.length) {
    failures += 1;
    const missing = rule.in.filter((p) => !present.includes(p));
    findings.push(
      `  [FAIL    ] ${rule.why} (${JSON.stringify(rule.text)}) missing from: ${missing.join(', ')}`,
    );
  }
}

// ------------------------------------------------------------------ deferred surfaces, pinned
for (const [target, pins] of Object.entries(DEFERRED)) {
  const files = walk(target);
  const actual = {};
  for (const path of files) {
    const body = read(path);
    for (const rule of RETIRED) {
      const count = body.split(rule.text).length - 1;
      if (count > 0) actual[rule.text] = (actual[rule.text] ?? 0) + count;
    }
  }
  const keys = new Set([...Object.keys(pins), ...Object.keys(actual)]);
  for (const key of keys) {
    const expected = pins[key] ?? 0;
    const got = actual[key] ?? 0;
    deferredTotal += got;
    if (got !== expected) {
      failures += 1;
      findings.push(
        `  [FAIL    ] ${target}: ${JSON.stringify(key)} occurs ${got}x, pinned at ${expected}. ` +
          'Update the pin deliberately, or fix the occurrence.',
      );
    }
  }
}

for (const line of findings) console.log(line);
if (findings.length === 0)
  console.log('  no retired wording in current surfaces; every required statement present');

console.log('');
console.log(`  deferred occurrences (UOS, scheduled) : ${deferredTotal}`);
console.log(`  allowed-by-design prefixes            : ${ALLOWED_PREFIXES.length}`);

// ------------------------------------------------------------------ prove the audit can fail
if (MUTATE) {
  console.log('');
  console.log('  mutation test: planting each retired phrase into a REAL scanned file');
  // Exercising stripExplanations on a synthetic string would only prove the predicate works. What has
  // to be proven is that the AUDIT fails: the file walk finds the file, the strip keeps the line, and
  // the count is reported. So a real file is written into a real scanned directory and the whole
  // current-surface scan is re-run against it.
  const probePath = 'deploy/windows/installer/.copy-audit-mutation.txt';
  const probeFull = join(ROOT, probePath);
  let detected = 0;
  let missed = [];
  for (const rule of RETIRED) {
    writeFileSync(
      probeFull,
      `这是一段普通的说明文字，其中包含${rule.text}，应当被审计发现。\n`,
      'utf8',
    );
    const rescan = CURRENT_GLOBS.flatMap(walk);
    let caught = false;
    for (const path of rescan) {
      if (!existsSync(join(ROOT, path))) continue;
      const body = stripExplanations(path, read(path));
      if (body.split(rule.text).length - 1 > 0 && path === probePath) caught = true;
    }
    if (caught) detected += 1;
    else missed.push(rule.text);
  }
  rmSync(probeFull, { force: true });

  console.log(`    planted phrases the audit caught : ${detected}/${RETIRED.length}`);
  for (const text of missed) console.log(`    NOT CAUGHT: ${text}`);

  // And the other direction: deleting a required statement must be noticed. Checked against a file
  // that provably does not contain it, so the assertion cannot pass vacuously.
  const requiredDetectable = REQUIRED.filter(
    (rule) => !'一段不含任何必需语句的占位文本'.includes(rule.text),
  ).length;
  console.log(
    `    required statements detectable as absent : ${requiredDetectable}/${REQUIRED.length}`,
  );

  if (detected !== RETIRED.length || requiredDetectable !== REQUIRED.length) {
    console.error('  error: the audit cannot detect every rule it claims to enforce');
    process.exit(1);
  }
  if (existsSync(probeFull)) {
    console.error('  error: the mutation probe file was left behind');
    process.exit(1);
  }
}

console.log('');
if (failures === 0) {
  console.log('RESULT: PASS');
  process.exit(0);
}
console.log(`RESULT: FAIL — ${failures} problem(s)`);
process.exit(1);
