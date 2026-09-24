#!/usr/bin/env node
/**
 * Build the Phase-4 Stage-A tester bundle: the Windows probe and its Chinese instructions, and
 * nothing else.
 *
 *   node scripts/windows/build-probe-bundle.mjs [release-id]
 *
 * ## Why a script rather than a hand-made ZIP
 *
 * The handoff quotes an exact SHA-256 so the tester can check what they received. A hand-made archive
 * cannot be rebuilt to the same bytes, so the quoted digest would become unverifiable the moment
 * anyone regenerated it. This writes entries in a fixed order with a fixed timestamp, so two runs over
 * unchanged inputs produce a byte-identical archive and the digest keeps meaning something.
 *
 * ## What goes in
 *
 * Two files. No source tree, no Node, no npm, no application, no UOS material, no installer. A tester
 * running Stage A needs to answer questions about their machine; anything else in the bundle is
 * something they could run by mistake.
 */

import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'release');

/** Exactly the two files a Stage-A tester needs. */
const MEMBERS = [
  { name: 'probe-windows.ps1', source: 'deploy/windows/probe/probe-windows.ps1' },
  { name: 'README-PROBE.md', source: 'deploy/windows/probe/README-PROBE.md' },
];

/* A fixed DOS timestamp (2026-01-01 00:00:00). Real mtimes would make every rebuild a different
 * archive, which is the property this script exists to avoid. */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12);
    central.writeUInt16LE(FIXED_DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38); // external attrs: plain file
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, end]);
}

const releaseId = process.argv[2] ?? '2026.09.24-1';
if (!/^[\w.-]+$/.test(releaseId)) {
  console.error(`error: illegal release id: ${releaseId}`);
  process.exit(2);
}

const entries = [];
for (const member of MEMBERS) {
  const full = join(ROOT, member.source);
  if (!existsSync(full)) {
    console.error(`error: missing ${member.source}`);
    process.exit(2);
  }
  entries.push({ name: member.name, data: readFileSync(full) });
}

/* The probe must be pure ASCII: Windows PowerShell 5.1 reads a BOM-less .ps1 in the machine's ANSI
 * code page, so a non-ASCII byte in the source is corrupted before the script ever runs — which is
 * exactly how the first probe run produced a mojibake report. Checked here so a future edit cannot
 * reintroduce it silently. */
const probe = entries.find((e) => e.name === 'probe-windows.ps1');
const nonAscii = [...probe.data].filter((b) => b > 127).length;
if (nonAscii > 0) {
  console.error(`error: probe-windows.ps1 contains ${String(nonAscii)} non-ASCII byte(s).`);
  console.error(
    'PowerShell 5.1 would corrupt them. Keep the probe ASCII-only, or add a UTF-8 BOM.',
  );
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
const zipName = `civic-work-desk-windows-probe-${releaseId}.zip`;
const zipPath = join(OUT_DIR, zipName);
const zip = buildZip(entries);
writeFileSync(zipPath, zip);

const digest = createHash('sha256').update(zip).digest('hex');
writeFileSync(`${zipPath}.sha256`, `${digest}  ${zipName}\n`, 'utf8');

console.log('Phase-4 Stage-A tester bundle');
console.log('');
console.log(`  archive : ${zipPath}`);
console.log(`  bytes   : ${String(zip.length)}`);
console.log(`  sha256  : ${digest}`);
console.log(`  sidecar : ${zipPath}.sha256`);
console.log('');
console.log('  contents:');
for (const entry of entries) {
  console.log(
    `    ${entry.name.padEnd(22)} ${String(entry.data.length).padStart(7)} bytes  ` +
      `sha256 ${createHash('sha256').update(entry.data).digest('hex').slice(0, 16)}...`,
  );
}
console.log('');
console.log('  Deterministic: rebuilding from unchanged inputs reproduces these exact bytes.');
