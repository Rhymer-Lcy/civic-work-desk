#!/usr/bin/env node
/**
 * Generate the Windows resource objects that give the executables an icon and a version block.
 *
 *   node scripts/windows/generate-winres.mjs --release-id <id> [--version <x.y.z>]
 *
 * Writes one `*_windows_amd64.syso` next to each user-facing command. The Go linker picks up any
 * `.syso` in a package directory automatically, so no build flag or linker option is involved and CGO
 * stays disabled.
 *
 * ## Why this is hand-written rather than a tool
 *
 * The usual answer is `rsrc` or `goversioninfo`. Both would mean adding a Go module dependency, with a
 * supply chain to audit, to produce a file format that is fully specified and about two hundred lines
 * to emit. This repository already hand-writes a PNG encoder, a ZIP writer, a ZIP reader and an icon
 * encoder for exactly the same reason, so the format is written out here too: every byte is auditable
 * in the tree, nothing is fetched at build time, and there is no opaque binary anywhere.
 *
 * ## What it produces
 *
 * A COFF object for amd64 containing two sections, `.rsrc$01` (the resource directory tree and the
 * data-entry records) and `.rsrc$02` (the raw resource bytes). The linker concatenates `$`-suffixed
 * sections in name order, so the directory lands before the data, and each data entry's OffsetToData
 * is fixed up by an ADDR32NB relocation against the `.rsrc$02` section symbol. That split is what makes
 * the offsets expressible as relocations at all — an object file has no image base to compute them
 * against.
 *
 * Resources emitted: RT_ICON (one per image in the .ico), RT_GROUP_ICON (id 1 — the shell uses the
 * lowest-numbered group icon as the application icon), and RT_VERSION.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON = join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.ico');
const CMD_DIR = join(ROOT, 'deploy', 'windows', 'src', 'cmd');

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const RT_VERSION = 16;

/* Neutral language for the icons — always found, whatever the user's UI language. The version block
 * carries Chinese strings, so it is tagged zh-CN with the Unicode code page. */
const LANG_NEUTRAL = 0x0000;
const LANG_ZH_CN = 0x0804;
const CODEPAGE_UNICODE = 0x04b0;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const releaseId = arg('--release-id', '2026.09.24-win-rc2');
const appVersion = arg(
  '--version',
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
);

/**
 * The executables that a user can see, and what Windows should say about each.
 *
 * civic-server and civic-admin are deliberately absent: they are never launched by a user, never appear
 * in a shortcut, and giving them an application icon would put CivicWorkDesk's mark on two programs a
 * user is not meant to run.
 */
const TARGETS = [
  {
    dir: 'civic-launch',
    original: 'civic-launch.exe',
    description: '政务工作记录台',
    internal: 'CivicWorkDesk Launcher',
  },
  {
    dir: 'civic-diag',
    original: 'civic-diag.exe',
    description: '政务工作记录台 — 收集诊断信息',
    internal: 'CivicWorkDesk Diagnostics',
  },
];

// ------------------------------------------------------------------------------------------- .ico
/** Split an .ico into its images plus the GRPICONDIR that refers to them by resource id. */
function readIcon(path) {
  const buf = readFileSync(path);
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error(`${path} is not an icon file`);
  }
  const count = buf.readUInt16LE(4);
  const images = [];
  /* GRPICONDIR mirrors the file's directory, except that the 4-byte image OFFSET is replaced by a
   * 2-byte resource ID. Copying the 12-byte prefix keeps width/height/planes/bitCount exactly as the
   * encoder wrote them, so the two directories cannot drift apart. */
  const group = Buffer.alloc(6 + count * 14);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(count, 4);

  for (let i = 0; i < count; i += 1) {
    const e = 6 + i * 16;
    const size = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const id = i + 1;
    images.push({ id, data: buf.subarray(offset, offset + size) });

    const g = 6 + i * 14;
    buf.copy(group, g, e, e + 12);
    group.writeUInt32LE(size, g + 8);
    group.writeUInt16LE(id, g + 12);
  }
  return { images, group };
}

// ------------------------------------------------------------------------------------- VERSIONINFO
function utf16(text) {
  return Buffer.from(`${text}\0`, 'utf16le');
}

function pad4(buffer) {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder)]);
}

/**
 * One version-resource node.
 *
 * The three length fields are the whole difficulty of this format. wLength counts this node INCLUDING
 * its children and its own padding, wValueLength counts the value only — in CHARACTERS for a text node
 * and in BYTES for a binary one — and every node starts on a 4-byte boundary. A wrong wValueLength does
 * not fail to build; it makes Windows show a blank Details tab, which is why the text/binary
 * distinction is passed explicitly rather than inferred.
 */
function versionNode(key, value, isText, children = []) {
  const head = Buffer.alloc(6);
  const keyBytes = utf16(key);
  const valueBytes = value ?? Buffer.alloc(0);
  const valueLength = isText ? valueBytes.length / 2 : valueBytes.length;

  const withoutChildren = pad4(Buffer.concat([head, keyBytes]));
  const withValue = pad4(Buffer.concat([withoutChildren, valueBytes]));
  const body = Buffer.concat([withValue, ...children]);

  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(valueLength, 2);
  body.writeUInt16LE(isText ? 1 : 0, 4);
  return body;
}

function fixedFileInfo(version) {
  const parts = version.split('.').map((p) => parseInt(p, 10) || 0);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  const info = Buffer.alloc(52);
  info.writeUInt32LE(0xfeef04bd, 0); // dwSignature
  info.writeUInt32LE(0x00010000, 4); // dwStrucVersion
  info.writeUInt32LE((a << 16) | b, 8); // dwFileVersionMS
  info.writeUInt32LE((c << 16) | d, 12); // dwFileVersionLS
  info.writeUInt32LE((a << 16) | b, 16); // dwProductVersionMS
  info.writeUInt32LE((c << 16) | d, 20); // dwProductVersionLS
  info.writeUInt32LE(0x3f, 24); // dwFileFlagsMask
  info.writeUInt32LE(0, 28); // dwFileFlags
  info.writeUInt32LE(0x00000004, 32); // VOS__WINDOWS32
  info.writeUInt32LE(0x00000001, 36); // VFT_APP
  info.writeUInt32LE(0, 40); // dwFileSubtype
  return info;
}

function buildVersionResource(target) {
  const numericVersion = `${appVersion}.0`;
  const strings = [
    ['CompanyName', 'CivicWorkDesk'],
    ['FileDescription', target.description],
    ['FileVersion', numericVersion],
    ['InternalName', target.internal],
    ['LegalCopyright', 'CivicWorkDesk. 保留所有权利。'],
    ['OriginalFilename', target.original],
    ['ProductName', '政务工作记录台 (CivicWorkDesk)'],
    ['ProductVersion', `${appVersion} (${releaseId})`],
  ];

  const stringEntries = strings.map(([key, value]) => versionNode(key, utf16(value), true));
  const langKey = `${LANG_ZH_CN.toString(16).padStart(4, '0')}${CODEPAGE_UNICODE.toString(16).padStart(4, '0')}`;
  const stringTable = versionNode(langKey.toUpperCase(), null, true, stringEntries);
  const stringFileInfo = versionNode('StringFileInfo', null, true, [stringTable]);

  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(LANG_ZH_CN, 0);
  translation.writeUInt16LE(CODEPAGE_UNICODE, 2);
  const varFileInfo = versionNode('VarFileInfo', null, true, [
    versionNode('Translation', translation, false),
  ]);

  return versionNode('VS_VERSION_INFO', fixedFileInfo(numericVersion), false, [
    stringFileInfo,
    varFileInfo,
  ]);
}

// -------------------------------------------------------------------------------------------- COFF
const DIR_HEADER = 16;
const DIR_ENTRY = 8;
const DATA_ENTRY = 16;

/**
 * Build the two section payloads plus the relocations that tie them together.
 *
 * Resources are laid out as three levels — type, name, language — and each level's entries must be
 * sorted by id, because the loader binary-searches them. An unsorted tree is not rejected; it simply
 * fails to find resources at run time.
 */
function buildResourceSections(resources) {
  const byType = new Map();
  for (const r of resources) {
    if (!byType.has(r.type)) byType.set(r.type, new Map());
    const names = byType.get(r.type);
    if (!names.has(r.id)) names.set(r.id, []);
    names.get(r.id).push(r);
  }
  const types = [...byType.keys()].sort((a, b) => a - b);

  // Pass 1: offsets. Root directory, then one name directory per type, then one language directory
  // per name, then the data-entry records.
  let offset = DIR_HEADER + types.length * DIR_ENTRY;
  const nameDirOffsets = new Map();
  for (const type of types) {
    nameDirOffsets.set(type, offset);
    offset += DIR_HEADER + byType.get(type).size * DIR_ENTRY;
  }
  const langDirOffsets = new Map();
  for (const type of types) {
    for (const id of [...byType.get(type).keys()].sort((a, b) => a - b)) {
      langDirOffsets.set(`${type}/${id}`, offset);
      offset += DIR_HEADER + byType.get(type).get(id).length * DIR_ENTRY;
    }
  }
  const dataEntryOffsets = new Map();
  for (const type of types) {
    for (const id of [...byType.get(type).keys()].sort((a, b) => a - b)) {
      for (const r of byType.get(type).get(id)) {
        dataEntryOffsets.set(r, offset);
        offset += DATA_ENTRY;
      }
    }
  }
  const directorySize = offset;

  // Raw blobs, each 8-byte aligned so no data entry starts on an awkward boundary.
  const blobs = [];
  let blobOffset = 0;
  const blobOffsets = new Map();
  for (const type of types) {
    for (const id of [...byType.get(type).keys()].sort((a, b) => a - b)) {
      for (const r of byType.get(type).get(id)) {
        blobOffsets.set(r, blobOffset);
        blobs.push(r.data);
        const padding = (8 - (r.data.length % 8)) % 8;
        if (padding > 0) blobs.push(Buffer.alloc(padding));
        blobOffset += r.data.length + padding;
      }
    }
  }

  // Pass 2: emit.
  const dir = Buffer.alloc(directorySize);
  const writeDirHeader = (at, count) => {
    dir.writeUInt16LE(0, at + 12); // NumberOfNamedEntries
    dir.writeUInt16LE(count, at + 14); // NumberOfIdEntries
  };

  writeDirHeader(0, types.length);
  types.forEach((type, i) => {
    const at = DIR_HEADER + i * DIR_ENTRY;
    dir.writeUInt32LE(type, at);
    // >>> 0 because JavaScript's | yields a SIGNED 32-bit int, so the subdirectory high bit turns the
    // offset negative and writeUInt32LE rejects it.
    dir.writeUInt32LE((0x80000000 | nameDirOffsets.get(type)) >>> 0, at + 4);
  });

  for (const type of types) {
    const base = nameDirOffsets.get(type);
    const ids = [...byType.get(type).keys()].sort((a, b) => a - b);
    writeDirHeader(base, ids.length);
    ids.forEach((id, i) => {
      const at = base + DIR_HEADER + i * DIR_ENTRY;
      dir.writeUInt32LE(id, at);
      dir.writeUInt32LE((0x80000000 | langDirOffsets.get(`${type}/${id}`)) >>> 0, at + 4);
    });
  }

  const relocations = [];
  for (const type of types) {
    for (const id of [...byType.get(type).keys()].sort((a, b) => a - b)) {
      const base = langDirOffsets.get(`${type}/${id}`);
      const langs = byType.get(type).get(id);
      writeDirHeader(base, langs.length);
      langs.forEach((r, i) => {
        const at = base + DIR_HEADER + i * DIR_ENTRY;
        dir.writeUInt32LE(r.lang, at);
        dir.writeUInt32LE(dataEntryOffsets.get(r), at + 4); // high bit clear: a data entry

        const entry = dataEntryOffsets.get(r);
        dir.writeUInt32LE(blobOffsets.get(r), entry); // fixed up by the relocation below
        dir.writeUInt32LE(r.data.length, entry + 4);
        dir.writeUInt32LE(0, entry + 8); // CodePage
        dir.writeUInt32LE(0, entry + 12); // Reserved
        relocations.push(entry);
      });
    }
  }

  return { directory: dir, data: Buffer.concat(blobs), relocations };
}

function buildCoff(resources) {
  const { directory, data, relocations } = buildResourceSections(resources);

  const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
  const SECTION_FLAGS = 0x40300040; // initialised data | 4-byte align | readable
  const IMAGE_REL_AMD64_ADDR32NB = 0x0003;
  const IMAGE_SYM_CLASS_STATIC = 3;

  const headerSize = 20 + 2 * 40;
  const dirOffset = headerSize;
  const relocOffset = dirOffset + directory.length;
  const dataOffset = relocOffset + relocations.length * 10;
  const symbolOffset = dataOffset + data.length;

  const header = Buffer.alloc(20);
  header.writeUInt16LE(IMAGE_FILE_MACHINE_AMD64, 0);
  header.writeUInt16LE(2, 2); // NumberOfSections
  header.writeUInt32LE(0, 4); // TimeDateStamp: zero, so the object is reproducible
  header.writeUInt32LE(symbolOffset, 8);
  header.writeUInt32LE(2, 12); // NumberOfSymbols
  header.writeUInt16LE(0, 16); // SizeOfOptionalHeader
  header.writeUInt16LE(0, 18); // Characteristics

  const sectionHeader = (name, size, rawPointer, relPointer, relCount) => {
    const s = Buffer.alloc(40);
    s.write(name, 0, 8, 'ascii');
    s.writeUInt32LE(0, 8); // VirtualSize
    s.writeUInt32LE(0, 12); // VirtualAddress
    s.writeUInt32LE(size, 16);
    s.writeUInt32LE(rawPointer, 20);
    s.writeUInt32LE(relPointer, 24);
    s.writeUInt32LE(0, 28); // PointerToLinenumbers
    s.writeUInt16LE(relCount, 32);
    s.writeUInt16LE(0, 34); // NumberOfLinenumbers
    s.writeUInt32LE(SECTION_FLAGS, 36);
    return s;
  };

  const relocBuffer = Buffer.alloc(relocations.length * 10);
  relocations.forEach((at, i) => {
    relocBuffer.writeUInt32LE(at, i * 10); // VirtualAddress within .rsrc$01
    relocBuffer.writeUInt32LE(1, i * 10 + 4); // symbol index 1 == .rsrc$02
    relocBuffer.writeUInt16LE(IMAGE_REL_AMD64_ADDR32NB, i * 10 + 8);
  });

  const symbol = (name, sectionNumber) => {
    const s = Buffer.alloc(18);
    s.write(name, 0, 8, 'ascii'); // both names are exactly 8 characters, so no string table is needed
    s.writeUInt32LE(0, 8); // Value
    s.writeInt16LE(sectionNumber, 12);
    s.writeUInt16LE(0, 14); // Type
    s[16] = IMAGE_SYM_CLASS_STATIC;
    s[17] = 0; // NumberOfAuxSymbols
    return s;
  };

  const stringTable = Buffer.alloc(4);
  stringTable.writeUInt32LE(4, 0); // an empty string table is still four bytes

  return Buffer.concat([
    header,
    sectionHeader(
      '.rsrc$01',
      directory.length,
      dirOffset,
      relocations.length ? relocOffset : 0,
      relocations.length,
    ),
    sectionHeader('.rsrc$02', data.length, dataOffset, 0, 0),
    directory,
    relocBuffer,
    data,
    symbol('.rsrc$01', 1),
    symbol('.rsrc$02', 2),
    stringTable,
  ]);
}

// -------------------------------------------------------------------------------------------- main
const { images, group } = readIcon(ICON);

console.log('CivicWorkDesk Windows resource objects');
console.log('');
console.log(`  icon       : ${ICON} (${images.length} images)`);
console.log(`  release id : ${releaseId}`);
console.log(`  version    : ${appVersion}`);
console.log('');

for (const target of TARGETS) {
  const resources = [
    ...images.map((image) => ({
      type: RT_ICON,
      id: image.id,
      lang: LANG_NEUTRAL,
      data: image.data,
    })),
    { type: RT_GROUP_ICON, id: 1, lang: LANG_NEUTRAL, data: group },
    { type: RT_VERSION, id: 1, lang: LANG_ZH_CN, data: buildVersionResource(target) },
  ];
  const coff = buildCoff(resources);
  const out = join(CMD_DIR, target.dir, `rsrc_windows_amd64.syso`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, coff);
  console.log(
    `  ${target.dir.padEnd(14)} ${String(coff.length).padStart(7)} bytes  ${target.description}`,
  );
}

console.log('');
console.log('  The Go linker picks these up automatically; no build flag is involved.');
