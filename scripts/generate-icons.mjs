#!/usr/bin/env node
/**
 * Generates simple purple square PNG icons for the browser extension.
 * Run once: node scripts/generate-icons.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { deflateSync } from 'zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICONS_DIR = path.join(__dirname, '..', 'browser-extension', 'icons');

await fs.mkdir(ICONS_DIR, { recursive: true });

// Minimal valid PNG generator (solid colored square)
function createPNG(size, r, g, b) {
  const width = size, height = size;

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data (filter byte 0 + RGB pixels per row)
  const rawRows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter none
    for (let x = 0; x < width; x++) {
      // Slight gradient effect
      const factor = 1 - (x + y) / (width + height) * 0.3;
      row[1 + x * 3 + 0] = Math.round(r * factor);
      row[1 + x * 3 + 1] = Math.round(g * factor);
      row[1 + x * 3 + 2] = Math.round(b * factor);
    }
    rawRows.push(row);
  }
  const rawData = Buffer.concat(rawRows);

  // Compress with zlib
  const compressed = deflateSync(rawData);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([typeB, data]);
    const crc = crc32(crcBuf);
    const crcB = Buffer.alloc(4);
    crcB.writeUInt32BE(crc >>> 0);
    return Buffer.concat([len, typeB, data, crcB]);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC32 implementation
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  const table = makeCRCTable();
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF);
}

function makeCRCTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

// Purple: #7c3aed → rgb(124, 58, 237)
const sizes = [16, 32, 48, 128];
for (const size of sizes) {
  const png = createPNG(size, 124, 58, 237);
  await fs.writeFile(path.join(ICONS_DIR, `icon${size}.png`), png);
  console.log(`✓ icon${size}.png`);
}

console.log('Icons generated in browser-extension/icons/');
