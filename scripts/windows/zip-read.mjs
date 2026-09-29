/**
 * Minimal in-process ZIP reading for the Windows acceptance scripts: enough to open an OOXML export
 * (XLSX, DOCX) and look at one part, without shelling out.
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/**
 * Read one entry out of a ZIP (and therefore out of any OOXML file), in this process.
 *
 * Shelling out to PowerShell for this is what the first version did, and it was wrong in a way that took
 * a while to see: PowerShell writes its stdout in the console code page, so every Chinese character in
 * an extracted XML part was mangled before Node decoded the pipe as UTF-8. The assertion that the Word
 * report names its own period then failed against text that was perfectly correct on disk.
 *
 * Only the two cases these archives use are handled: stored and deflated. Anything else is reported
 * rather than guessed at.
 */
export function readZipEntry(zipPath, entryName) {
  const buf = readFileSync(zipPath);
  // The end-of-central-directory record is last, possibly followed by a comment, so scan backwards.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${zipPath} has no end-of-central-directory record`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('central directory entry is malformed');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (name === entryName) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50)
        throw new Error('local header is malformed');
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(
        `${entryName} uses compression method ${method}, which this reader does not handle`,
      );
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Every entry name in a ZIP, in central-directory order. */
export function zipEntryNames(zipPath) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n += 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
