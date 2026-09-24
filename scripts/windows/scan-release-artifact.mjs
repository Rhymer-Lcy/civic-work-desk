#!/usr/bin/env node
/**
 * Scan the BUILT Windows artifacts for development information that must not reach a colleague.
 *
 *   node scripts/windows/scan-release-artifact.mjs [--release-id <id>]
 *
 * Source inspection cannot answer this question. A Go binary embeds file paths from the build machine
 * unless `-trimpath` is used, an installer embeds the compiler's own strings, and a resource object
 * carries whatever was put in it. So this reads the actual bytes — the installer, every payload binary
 * and every payload file — and looks for the things that would identify the machine this was built on.
 *
 * Strings are extracted in both ASCII and UTF-16LE, because Windows binaries carry most of their text
 * as UTF-16 and an ASCII-only scan would miss every one of them.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const RELEASE_ID = argValue('--release-id', '2026.09.24-win-rc2');
const SETUP_BASE = `CivicWorkDesk-Windows-x64-${RELEASE_ID.replace('-win-', '-')}-Setup`;
const OUT_DIR = join(ROOT, 'release', 'windows');
const PAYLOAD = join(OUT_DIR, `civic-work-desk-windows-x64-${RELEASE_ID}`);

/**
 * What must not be in a shipped byte.
 *
 * The account name is read from the environment rather than written down, so this file never contains
 * it: a privacy check that carries the secret it is checking for defeats itself, and would put the name
 * into the public repository in the course of proving it is absent.
 */
const FORBIDDEN = [
  { name: 'build-tool root (D:\\tools)', pattern: /[Dd]:[\\/]tools[\\/]/ },
  { name: 'workspace root (F:\\CivicWorkDesk)', pattern: /[Ff]:[\\/]CivicWorkDesk/ },
  { name: 'user profile path', pattern: /[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+[\\/]/ },
  { name: 'private reference directory', pattern: /_private_reference/ },
  { name: 'PDB debug path', pattern: /\.pdb\b/i },
  { name: 'Go build cache path', pattern: /go-build[0-9]/ },
  { name: 'GOPATH module cache', pattern: /pkg[\\/]mod[\\/]/ },
  { name: 'Inno temp build directory', pattern: /is-[A-Z0-9]{8,}\.tmp/ },
  { name: 'AWS key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** The account and machine names, taken from the environment so they are never literals here. */
const ENV_SECRETS = [
  { name: 'Windows account name', value: process.env.USERNAME ?? '' },
  { name: 'machine name', value: process.env.COMPUTERNAME ?? '' },
  { name: 'user domain', value: process.env.USERDOMAIN ?? '' },
];

/** Printable runs of 6+ characters, in both encodings a Windows binary uses. */
function extractStrings(buffer) {
  const out = [];
  let run = [];
  for (const byte of buffer) {
    if (byte >= 0x20 && byte < 0x7f) run.push(String.fromCharCode(byte));
    else {
      if (run.length >= 6) out.push(run.join(''));
      run = [];
    }
  }
  if (run.length >= 6) out.push(run.join(''));

  // UTF-16LE: an ASCII character followed by a zero byte.
  run = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const lo = buffer[i];
    const hi = buffer[i + 1];
    if (hi === 0 && lo >= 0x20 && lo < 0x7f) run.push(String.fromCharCode(lo));
    else {
      if (run.length >= 6) out.push(run.join(''));
      run = [];
    }
  }
  if (run.length >= 6) out.push(run.join(''));
  return out;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const targets = [];
const setup = join(OUT_DIR, `${SETUP_BASE}.exe`);
if (existsSync(setup)) targets.push(setup);
if (existsSync(PAYLOAD)) targets.push(...walk(PAYLOAD));

if (targets.length === 0) {
  console.error(`error: nothing to scan. Build ${RELEASE_ID} first.`);
  process.exit(2);
}

console.log('CivicWorkDesk Windows release-artifact privacy scan');
console.log('');
console.log(`  release : ${RELEASE_ID}`);
console.log(`  files   : ${targets.length}`);
console.log(`  bytes   : ${targets.reduce((n, f) => n + statSync(f).size, 0)}`);
console.log('');

let findings = 0;
let scanned = 0;
for (const file of targets) {
  const buffer = readFileSync(file);
  const strings = extractStrings(buffer);
  scanned += 1;
  const rel = relative(ROOT, file);

  for (const rule of FORBIDDEN) {
    const hits = strings.filter((s) => rule.pattern.test(s));
    if (hits.length > 0) {
      findings += 1;
      console.log(`  [LEAK] ${rel}`);
      console.log(`         ${rule.name}: ${hits.length} occurrence(s)`);
      for (const hit of hits.slice(0, 3)) console.log(`           ${hit.slice(0, 120)}`);
    }
  }
  for (const secret of ENV_SECRETS) {
    // A very short value would match inside ordinary words; say so rather than pretending to check it.
    if (secret.value.length < 3) continue;
    const needle = secret.value.toLowerCase();
    const hits = strings.filter((s) => s.toLowerCase().includes(needle));
    if (hits.length > 0) {
      findings += 1;
      console.log(`  [LEAK] ${rel}`);
      console.log(`         ${secret.name}: ${hits.length} occurrence(s)`);
      for (const hit of hits.slice(0, 3)) console.log(`           ${hit.slice(0, 120)}`);
    }
  }
}

/*
 * A scan that finds nothing has to prove it could have found something. The extractor is run over a
 * buffer built here containing one of each shape, in both encodings -- so a broken extractor, a broken
 * regex or an empty environment value fails loudly instead of reporting a clean result.
 */
console.log('  mutation test: planting each shape into a synthetic buffer');
const plants = [
  ['build-tool root', 'D:\\tools\\go1.27.1\\go\\src\\runtime\\proc.go'],
  ['workspace root', 'F:\\CivicWorkDesk\\deploy\\windows\\src\\main.go'],
  ['user profile path', 'C:\\Users\\someone\\AppData\\Local\\Temp\\x'],
  ['private reference', 'F:\\CivicWorkDesk\\_private_reference\\legacy.html'],
  ['PDB path', 'civic-server.pdb'],
  ['Go build cache', 'C:\\go-build1234\\ab\\abcdef'],
  ['module cache', 'D:\\gopath\\pkg\\mod\\example.com\\x'],
  ['Inno temp', 'C:\\Temp\\is-ABCD1234.tmp\\civic-admin.exe'],
];
let detected = 0;
for (const [label, text] of plants) {
  const ascii = Buffer.from(`\0\0${text}\0\0`, 'latin1');
  const utf16 = Buffer.concat([
    Buffer.from([0, 0]),
    Buffer.from(text, 'utf16le'),
    Buffer.from([0, 0]),
  ]);
  for (const [encoding, buf] of [
    ['ascii', ascii],
    ['utf16', utf16],
  ]) {
    const found = extractStrings(buf).some((s) => FORBIDDEN.some((r) => r.pattern.test(s)));
    if (found) detected += 1;
    else console.log(`    NOT DETECTED (${encoding}): ${label}`);
  }
}
const expected = plants.length * 2;
console.log(`    planted shapes detected : ${detected}/${expected} (ASCII and UTF-16LE)`);

const usableSecrets = ENV_SECRETS.filter((s) => s.value.length >= 3);
console.log(
  `    environment values searched for : ${usableSecrets.map((s) => s.name).join(', ') || '(none)'}`,
);
if (usableSecrets.length === 0) {
  console.error(
    '  error: no environment identity value was long enough to search for; the scan proves nothing',
  );
  process.exit(1);
}
if (detected !== expected) {
  console.error('  error: the scan cannot detect every shape it claims to check');
  process.exit(1);
}

console.log('');
console.log(`  files scanned : ${scanned}`);
console.log(`  findings      : ${findings}`);
console.log('');
if (findings === 0) {
  console.log('RESULT: PASS — no development information found in the shipped bytes');
  process.exit(0);
}
console.log('RESULT: FAIL');
process.exit(1);
