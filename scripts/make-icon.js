'use strict';
/**
 * ============================================================================
 *  OmniDownloader — scripts/make-icon.js
 * ----------------------------------------------------------------------------
 *  Generates the application artwork used by the OS and the installer:
 *
 *      build/icon.png   256×256 (fallback / web use)
 *      build/icon.ico   16, 24, 32, 48, 64, 128, 256 px — Windows + NSIS
 *
 *  The PNG encoder and the ICO wrapper are implemented here from scratch so
 *  the project keeps its "no build tooling, no image dependencies" promise:
 *  this script only uses Node's built-in `zlib`.
 *
 *  Artwork = the app's accent gradient (see `--accent` / `--accent-2` in
 *  src/renderer/style.css) with a white download arrow, rendered with 6×6
 *  supersampling for clean anti-aliased edges.
 *
 *  Usage:  npm run icon      (or: node scripts/make-icon.js)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 6; // samples per axis, per pixel

/** Must mirror `--accent` / `--accent-2` in style.css. */
const TOP = [0x4c, 0xc2, 0xff];
const BOTTOM = [0x7b, 0x8c, 0xff];

/* -------------------------------------------------------------------------- */
/* PNG encoding (spec: ISO/IEC 15948, filter type 0 = "None")                 */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba RGBA pixels, row-major, no padding. @returns {Buffer} */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None (simplest, and our data compresses well)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------------------- */
/* Artwork                                                                    */
/* -------------------------------------------------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle centred in the unit square. */
function sdRoundRect(x, y, half, radius) {
  const qx = Math.abs(x - 0.5) - (half - radius);
  const qy = Math.abs(y - 0.5) - (half - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Classic even-odd ray cast. @param {Array<[number,number]>} poly */
function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Chevron of the download arrow (pointing down). */
const CHEVRON = [
  [0.28, 0.44],
  [0.50, 0.68],
  [0.72, 0.44],
  [0.63, 0.44],
  [0.50, 0.575],
  [0.37, 0.44]
];

/** @returns {[number,number,number,number]} straight (non-premultiplied) RGBA 0..1 */
function sample(x, y) {
  if (sdRoundRect(x, y, 0.45, 0.24) > 0) return [0, 0, 0, 0];

  // Accent gradient, darkening slightly towards the bottom for depth.
  const t = clamp01((y - 0.05) / 0.9);
  const shade = 1 - 0.1 * t * t;
  const r = (lerp(TOP[0], BOTTOM[0], t) / 255) * shade;
  const g = (lerp(TOP[1], BOTTOM[1], t) / 255) * shade;
  const b = (lerp(TOP[2], BOTTOM[2], t) / 255) * shade;

  const inShaft = x >= 0.44 && x <= 0.56 && y >= 0.22 && y <= 0.52;
  if (inShaft || inPolygon(x, y, CHEVRON)) return [1, 1, 1, 1];
  return [r, g, b, 1];
}

/** Renders one square icon at `size` px using supersampled coverage. */
function renderIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const perAxis = SUPERSAMPLE;
  const samples = perAxis * perAxis;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let aSum = 0;

      for (let sy = 0; sy < perAxis; sy += 1) {
        for (let sx = 0; sx < perAxis; sx += 1) {
          const x = (px + (sx + 0.5) / perAxis) / size;
          const y = (py + (sy + 0.5) / perAxis) / size;
          const [r, g, b, a] = sample(x, y);
          aSum += a;
          rSum += r * a; // premultiplied accumulation → correct edges
          gSum += g * a;
          bSum += b * a;
        }
      }

      const alpha = aSum / samples;
      const o = (py * size + px) * 4;
      rgba[o] = aSum > 0 ? Math.round(rSum / aSum) : 0;
      rgba[o + 1] = aSum > 0 ? Math.round(gSum / aSum) : 0;
      rgba[o + 2] = aSum > 0 ? Math.round(bSum / aSum) : 0;
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* -------------------------------------------------------------------------- */
/* ICO container (PNG-compressed entries — supported since Windows Vista)     */
/* -------------------------------------------------------------------------- */

/** @param {Array<{size:number, data:Buffer}>} images */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // width (0 means 256)
    entry[1] = size >= 256 ? 0 : size; // height
    entry[2] = 0; // palette colours
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4);  // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/* -------------------------------------------------------------------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const images = SIZES.map((size) => {
    const started = Date.now();
    const png = encodePng(size, size, renderIcon(size));
    console.log(`  ${String(size).padStart(3)}px → ${png.length.toString().padStart(6)} bytes (${Date.now() - started}ms)`);
    return { size, data: png };
  });

  const largest = images[images.length - 1];
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), largest.data);
  const ico = encodeIco(images);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);

  console.log(`\n  ${path.join(OUT_DIR, 'icon.png')} (${largest.size}×${largest.size})`);
  console.log(`  ${path.join(OUT_DIR, 'icon.ico')} (${SIZES.join(', ')} px, ${ico.length} bytes)`);
}

main();
