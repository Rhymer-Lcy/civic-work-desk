#!/usr/bin/env node
/**
 * Generate the Windows multi-resolution icon from the application's own artwork.
 *
 *   node scripts/windows/generate-ico.mjs [--check]
 *
 * ## Why the shapes are redrawn rather than converted
 *
 * The canonical artwork is `public/icons/icon.svg`, and the PWA raster set is produced from the same
 * shapes by `scripts/generate-icons.mjs` — by hand, with no image dependency, so the output is
 * deterministic. This follows that decision rather than reversing it: converting the SVG would need a
 * rasteriser (ImageMagick, sharp, a headless browser), which is a build dependency this repository has
 * deliberately avoided, and the result would vary with the rasteriser's anti-aliasing.
 *
 * So the same three primitives the SVG uses — a rounded rectangle, a plain rectangle, a rounded bar —
 * are drawn into a pixel buffer at each Windows shell size. The icon a user sees is therefore the same
 * mark as the PWA icon, not a lookalike.
 *
 * ## Why both BMP and PNG entries
 *
 * An .ico is a directory of independent images. Windows Vista and later read PNG-compressed entries,
 * but several shell code paths — and some third-party file dialogs still in use on managed desktops —
 * only understand the BMP/DIB form. So every size up to 64 is written as a 32-bit BGRA DIB, and 256 is
 * written as PNG because a 256×256 DIB would add ~256 KiB for no benefit.
 *
 * `--check` regenerates in memory and compares against the committed file, failing if they differ. That
 * is what stops the committed icon from becoming a stale companion of this generator.
 */

import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'deploy', 'windows', 'installer', 'civic-work-desk.ico');
const CHECK = process.argv.includes('--check');

/* Brand colours, in step with public/icons/icon.svg and src/styles/tokens.css. */
const BRAND = [0x8c, 0x1d, 0x1d];
const PAPER = [0xff, 0xff, 0xff];
const GOLD = [0xa8, 0x85, 0x3e];

/* The sizes Windows actually asks for: 16 (tree views, title bars), 20 and 24 (some DPI scalings),
 * 32 (default shell), 40 and 48 (large icons), 64 (extra large), 256 (jumbo and the file dialog). */
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];

/** The SVG's geometry, in its own 512-unit viewBox, so every size is one scale factor away. */
const GEOMETRY = {
  viewBox: 512,
  plate: { x: 0, y: 0, w: 512, h: 512, r: 96, fill: BRAND },
  card: { x: 163, y: 128, w: 186, h: 230, r: 18, fill: PAPER },
  lines: [
    { x: 196, y: 176, w: 120, h: 13, r: 6, fill: BRAND },
    { x: 196, y: 209, w: 120, h: 13, r: 6, fill: BRAND },
    { x: 196, y: 242, w: 68, h: 13, r: 6, fill: BRAND },
  ],
  seal: { x: 196, y: 309, w: 120, h: 20, r: 10, fill: GOLD },
};

/**
 * Coverage of one pixel by a rounded rectangle, sampled on a 4x4 grid.
 *
 * Supersampling rather than a coverage formula: at 16x16 the rounded corners are a couple of pixels
 * across, and a hard in/out test makes the plate look chipped. Sixteen samples is enough to read as a
 * smooth corner at every size here and stays exactly reproducible.
 */
function coverage(px, py, rect, scale) {
  const x = rect.x * scale;
  const y = rect.y * scale;
  const w = rect.w * scale;
  const h = rect.h * scale;
  const r = Math.min(rect.r * scale, w / 2, h / 2);
  let inside = 0;
  const step = 0.25;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const cx = px + step * (sx + 0.5);
      const cy = py + step * (sy + 0.5);
      if (cx < x || cx > x + w || cy < y || cy > y + h) continue;
      // Inside the straight body, or inside a corner circle.
      const dx = cx < x + r ? x + r - cx : cx > x + w - r ? cx - (x + w - r) : 0;
      const dy = cy < y + r ? y + r - cy : cy > y + h - r ? cy - (y + h - r) : 0;
      if (dx === 0 || dy === 0 || dx * dx + dy * dy <= r * r) inside += 1;
    }
  }
  return inside / 16;
}

function blend(dst, src, alpha) {
  for (let i = 0; i < 3; i += 1) dst[i] = Math.round(dst[i] * (1 - alpha) + src[i] * alpha);
}

/**
 * Pixel-exact geometry for the sizes where scaling the 512-unit artwork stops working.
 *
 * The document lines are 13 units tall in a 512-unit box: 0.41 px at 16 and 0.51 px at 20. Scaled, they
 * land as a uniform pink smear across the card — confirmed by rendering a contact sheet and looking at
 * it, which is the only way this shows up. Below 24 the mark is therefore redrawn on the pixel grid
 * with whole-pixel strokes, and at 16 with two lines instead of three, because three 1-px lines plus
 * their gaps do not fit in a card that is 11 px tall.
 *
 * These are the same five elements in the same arrangement, not a different logo.
 */
const SMALL = {
  16: {
    plate: { x: 0, y: 0, w: 16, h: 16, r: 3, fill: BRAND },
    card: { x: 4, y: 3, w: 8, h: 11, r: 1, fill: PAPER },
    lines: [
      { x: 6, y: 5, w: 4, h: 1, r: 0, fill: BRAND },
      { x: 6, y: 7, w: 4, h: 1, r: 0, fill: BRAND },
    ],
    seal: { x: 6, y: 11, w: 4, h: 1, r: 0, fill: GOLD },
  },
  20: {
    plate: { x: 0, y: 0, w: 20, h: 20, r: 4, fill: BRAND },
    card: { x: 5, y: 4, w: 10, h: 13, r: 1, fill: PAPER },
    lines: [
      { x: 7, y: 6, w: 6, h: 1, r: 0, fill: BRAND },
      { x: 7, y: 8, w: 6, h: 1, r: 0, fill: BRAND },
      { x: 7, y: 10, w: 4, h: 1, r: 0, fill: BRAND },
    ],
    seal: { x: 7, y: 14, w: 6, h: 1, r: 0, fill: GOLD },
  },
  24: {
    plate: { x: 0, y: 0, w: 24, h: 24, r: 5, fill: BRAND },
    card: { x: 7, y: 5, w: 10, h: 14, r: 1, fill: PAPER },
    lines: [
      { x: 9, y: 8, w: 6, h: 1, r: 0, fill: BRAND },
      { x: 9, y: 10, w: 6, h: 1, r: 0, fill: BRAND },
      { x: 9, y: 12, w: 4, h: 1, r: 0, fill: BRAND },
    ],
    seal: { x: 9, y: 16, w: 6, h: 1, r: 0, fill: GOLD },
  },
};

/**
 * Sizes whose scaled strokes are close to one pixel and benefit from landing ON the grid.
 *
 * At 32 the 13-unit line scales to 0.81 px and at 40 to 1.02 px: rendered smoothly they are a grey
 * half-tone rather than a line. Rounding each rectangle to whole pixels, with a one-pixel floor, keeps
 * the same proportions while making every stroke solid. Above this the strokes are thick enough that
 * anti-aliasing is what looks right, so the scaled path is used unchanged.
 */
const SNAP_SIZES = new Set([32, 40]);

function snapRect(rect, scale) {
  const x = Math.round(rect.x * scale);
  const y = Math.round(rect.y * scale);
  return {
    x,
    y,
    w: Math.max(1, Math.round((rect.x + rect.w) * scale) - x),
    h: Math.max(1, Math.round((rect.y + rect.h) * scale) - y),
    r: Math.round(rect.r * scale),
    fill: rect.fill,
  };
}

function snapGeometry(size) {
  const scale = size / GEOMETRY.viewBox;
  return {
    plate: {
      ...GEOMETRY.plate,
      x: 0,
      y: 0,
      w: size,
      h: size,
      r: Math.round(GEOMETRY.plate.r * scale),
    },
    card: snapRect(GEOMETRY.card, scale),
    lines: GEOMETRY.lines.map((line) => snapRect(line, scale)),
    seal: snapRect(GEOMETRY.seal, scale),
  };
}

/** Render one size to straight RGBA, top row first. */
function render(size) {
  const pixelExact = SMALL[size] ?? (SNAP_SIZES.has(size) ? snapGeometry(size) : null);
  const geometry = pixelExact ?? GEOMETRY;
  const scale = pixelExact ? 1 : size / GEOMETRY.viewBox;
  const rgba = Buffer.alloc(size * size * 4);
  const shapes = [geometry.card, ...geometry.lines, geometry.seal];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const plate = coverage(x, y, geometry.plate, scale);
      if (plate <= 0) continue;
      const colour = [...geometry.plate.fill];
      for (const shape of shapes) {
        const a = coverage(x, y, shape, scale);
        if (a > 0) blend(colour, shape.fill, a);
      }
      const o = (y * size + x) * 4;
      rgba[o] = colour[0];
      rgba[o + 1] = colour[1];
      rgba[o + 2] = colour[2];
      rgba[o + 3] = Math.round(plate * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------------------------- PNG
function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** 8-bit RGBA PNG, one filter byte per scanline, deflated at a fixed level for determinism. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------- DIB
/**
 * 32-bit BGRA bottom-up DIB, as an icon entry expects.
 *
 * Two things here are icon-specific rather than bitmap-specific, and both are silent if wrong: the
 * BITMAPINFOHEADER height is DOUBLE the image height (the format reserves room for an AND mask even
 * when the alpha channel makes it redundant), and the rows run bottom-up. Getting either wrong yields
 * an icon that renders upside down or half-height instead of failing.
 */
function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x += 1) {
      const s = srcRow + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }
  // The AND mask is still read by some code paths even for a 32-bit icon. One bit per pixel, rows
  // padded to 4 bytes, all zero: "every pixel is part of the image", with the alpha channel doing the
  // real work.
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  return Buffer.concat([header, pixels, mask]);
}

// ---------------------------------------------------------------------------------------------- ICO
export function buildIco() {
  const images = SIZES.map((size) => {
    const rgba = render(size);
    return {
      size,
      // 0 in the directory means 256; the field is one byte.
      dirWidth: size >= 256 ? 0 : size,
      data: size >= 256 ? encodePng(size, rgba) : encodeDib(size, rgba),
      png: size >= 256,
    };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.dirWidth;
    entry[1] = image.dirWidth;
    entry[2] = 0; // palette entries: none, this is a true-colour image
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.data.length;
  }

  return {
    bytes: Buffer.concat([header, ...entries, ...images.map((i) => i.data)]),
    images,
  };
}

const { bytes, images } = buildIco();

if (CHECK) {
  if (!existsSync(OUT)) {
    console.error(`error: ${OUT} does not exist; run this script without --check`);
    process.exit(1);
  }
  const committed = readFileSync(OUT);
  if (!committed.equals(bytes)) {
    console.error('error: the committed icon does not match what this generator produces.');
    console.error(`       committed ${committed.length} bytes, generated ${bytes.length} bytes`);
    console.error('       Regenerate it: node scripts/windows/generate-ico.mjs');
    process.exit(1);
  }
  console.log(`icon check: ${OUT} matches the generator (${bytes.length} bytes)`);
  process.exit(0);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, bytes);
console.log('CivicWorkDesk Windows icon');
console.log('');
console.log(`  file  : ${OUT}`);
console.log(`  bytes : ${bytes.length}`);
console.log(`  images: ${images.length}`);
for (const image of images) {
  console.log(
    `    ${String(image.size).padStart(3)}x${String(image.size).padEnd(3)} ` +
      `${image.png ? 'PNG' : 'DIB'}  ${String(image.data.length).padStart(7)} bytes`,
  );
}
