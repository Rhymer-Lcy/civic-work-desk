#!/usr/bin/env node
/**
 * Generate the PWA icon set as real PNG files, with no image dependency.
 *
 * The legacy prototype produced its only icon as an inline `data:image/svg+xml` URI inside a
 * runtime-generated manifest, declared `purpose: "any maskable"` with no safe-zone padding. A
 * maskable icon is cropped to a circle by Android, so the glyph was clipped; and several install
 * paths require a raster icon.
 *
 * This writes a minimal, valid, non-interlaced 8-bit RGB PNG by hand (IHDR/IDAT/IEND with zlib
 * stored blocks via zlib.deflateSync). Shapes are drawn into a pixel buffer, so the output is
 * deterministic and reproducible without ImageMagick, sharp, or a headless browser.
 *
 * Run: node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'public', 'icons');

/** Brand colours, kept in step with src/styles/tokens.css. */
const BRAND = [0x8c, 0x1d, 0x1d];
const INK_INVERSE = [0xff, 0xff, 0xff];
const GOLD = [0xa8, 0x85, 0x3e];

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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgb) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw the mark: a rounded-square brand field, a white "document" block, and a gold bar standing
 * for the honour ledger. `safeInset` is the fraction of the canvas kept clear at the edges so a
 * maskable crop cannot clip the glyph (the spec's safe zone is the centre 80%).
 */
function drawMark(size, { safeInset }) {
  const rgb = Buffer.alloc(size * size * 3);
  const inset = Math.round(size * safeInset);
  const inner = size - inset * 2;

  const put = (x, y, colour) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 3;
    rgb[offset] = colour[0];
    rgb[offset + 1] = colour[1];
    rgb[offset + 2] = colour[2];
  };

  // Background: the brand field fills the whole canvas so a maskable crop never shows a seam.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) put(x, y, BRAND);
  }

  // A rounded-square darker plate inside the safe zone gives the mark a defined edge when the
  // icon is shown un-cropped.
  const inRoundedRect = (x, y, left, top, w, h, r) => {
    if (x < left || y < top || x >= left + w || y >= top + h) return false;
    const fromLeft = x - left;
    const fromRight = left + w - 1 - x;
    const fromTop = y - top;
    const fromBottom = top + h - 1 - y;
    // Outside every corner square: the point is in one of the straight bands.
    if (Math.min(fromLeft, fromRight) >= r || Math.min(fromTop, fromBottom) >= r) return true;
    // In a corner square: pick the centre of *that* corner's arc, not whichever edge was nearer
    // overall — comparing the combined minimum would collapse all four corners onto the top-left.
    const cx = fromLeft < r ? left + r : left + w - 1 - r;
    const cy = fromTop < r ? top + r : top + h - 1 - r;
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // Document block: white, centred, portrait aspect.
  const docW = Math.round(inner * 0.52);
  const docH = Math.round(inner * 0.64);
  const docX = Math.round((size - docW) / 2);
  const docY = Math.round((size - docH) / 2) - Math.round(inner * 0.04);
  const docR = Math.max(2, Math.round(docW * 0.1));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inRoundedRect(x, y, docX, docY, docW, docH, docR)) put(x, y, INK_INVERSE);
    }
  }

  // Three text rules on the document, in brand red.
  const ruleH = Math.max(1, Math.round(docH * 0.055));
  const ruleGap = Math.round(docH * 0.145);
  const ruleX = docX + Math.round(docW * 0.18);
  for (let i = 0; i < 3; i += 1) {
    const ruleW = i === 2 ? Math.round(docW * 0.36) : Math.round(docW * 0.64);
    const ruleY = docY + Math.round(docH * 0.26) + i * ruleGap;
    for (let y = ruleY; y < ruleY + ruleH; y += 1) {
      for (let x = ruleX; x < ruleX + ruleW; x += 1) put(x, y, BRAND);
    }
  }

  // Gold bar along the document's foot: the honour ledger.
  const barH = Math.max(2, Math.round(docH * 0.085));
  const barY = docY + docH - Math.round(docH * 0.2);
  const barX = docX + Math.round(docW * 0.18);
  const barW = Math.round(docW * 0.64);
  const barR = Math.max(1, Math.round(barH / 2));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (inRoundedRect(x, y, barX, barY, barW, barH, barR)) put(x, y, GOLD);
    }
  }

  return rgb;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="CivicWorkDesk">
  <rect width="512" height="512" rx="96" fill="#8c1d1d"/>
  <rect x="163" y="128" width="186" height="230" rx="18" fill="#ffffff"/>
  <g fill="#8c1d1d">
    <rect x="196" y="176" width="120" height="13" rx="6"/>
    <rect x="196" y="209" width="120" height="13" rx="6"/>
    <rect x="196" y="242" width="68" height="13" rx="6"/>
  </g>
  <rect x="196" y="309" width="120" height="20" rx="10" fill="#a8853e"/>
</svg>
`;

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const targets = [
    // `any` icons keep a small inset so the mark is not flush to the edge.
    { name: 'icon-192.png', size: 192, safeInset: 0.06 },
    { name: 'icon-512.png', size: 512, safeInset: 0.06 },
    // Maskable icons keep the mark inside the centre 80% so a circular crop cannot clip it.
    { name: 'icon-maskable-192.png', size: 192, safeInset: 0.14 },
    { name: 'icon-maskable-512.png', size: 512, safeInset: 0.14 },
    { name: 'apple-touch-icon.png', size: 180, safeInset: 0.06 },
  ];

  for (const target of targets) {
    const rgb = drawMark(target.size, { safeInset: target.safeInset });
    const png = encodePng(target.size, target.size, rgb);
    writeFileSync(join(OUT_DIR, target.name), png);
    console.log(`wrote ${target.name} (${target.size}x${target.size}, ${png.length} bytes)`);
  }

  writeFileSync(join(OUT_DIR, 'icon.svg'), SVG, 'utf8');
  console.log('wrote icon.svg');
}

main();
