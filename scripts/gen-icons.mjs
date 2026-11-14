#!/usr/bin/env node
/**
 * Deterministic icon generator.
 *
 * The extension needs 16/48/128 px PNG icons and an SVG logo. Committing binary
 * art with no source is how a repository ends up with icons nobody can change:
 * the next person has to redraw them in a tool the project does not have.
 *
 * So the mark is code. This script rasterises it with a hand-rolled PNG encoder
 * (zlib + CRC, no dependencies) and writes the SVG from the same geometry.
 * Running it twice produces byte-identical files, and `--check` proves the
 * committed icons still match the generator — `scripts/verify.sh` runs that.
 *
 * Usage:
 *   node scripts/gen-icons.mjs           write src/assets/*
 *   node scripts/gen-icons.mjs --check   fail if the files on disk differ
 */

import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/assets');
const SIZES = [16, 48, 128];

/* ---------------------------------------------------------------- geometry */

/**
 * The mark: a funnel that narrows into a single warm lead.
 *
 * All coordinates are in unit space (0..1) with y growing downwards, so one
 * description serves every size. Small icons thicken the stem and the dot,
 * because geometry that reads at 128 px disappears at 16 px.
 */
const BADGE_RADIUS = 0.22;

const MARK = {
  topY: 0.245, // where the wide mouth starts
  neckY: 0.505, // where the mouth ends and the stem starts
  stemEndY: 0.655, // where the stem ends
  mouthHalfWidth: 0.305, // half width at topY
  neckHalfWidth: 0.115, // half width at neckY
  dotY: 0.775, // centre of the lead that came out
  dotRadius: 0.075,
};

/** Palette. Same hues as the dashboard design tokens. */
const GRADIENT_TOP_LEFT = [31, 58, 102]; // --c-primary-dim
const GRADIENT_BOTTOM_RIGHT = [79, 140, 255]; // --c-primary
const MARK_COLOR = [255, 255, 255];
const DOT_COLOR = [53, 211, 154]; // --c-success

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

/** Signed distance to an axis-aligned rounded rectangle centred on the origin. */
function sdRoundRect(x, y, halfWidth, halfHeight, radius) {
  const dx = Math.abs(x) - halfWidth + radius;
  const dy = Math.abs(y) - halfHeight + radius;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - radius;
}

/**
 * Is this point inside the white funnel (mouth + stem)?
 * `widen` thickens the narrow parts for small icons.
 */
function insideFunnel(u, v, widen) {
  const x = Math.abs(u - 0.5);
  if (v >= MARK.topY && v <= MARK.neckY) {
    const t = (v - MARK.topY) / (MARK.neckY - MARK.topY);
    const halfWidth = lerp(MARK.mouthHalfWidth, MARK.neckHalfWidth + widen, t);
    return x <= halfWidth;
  }
  if (v > MARK.neckY && v <= MARK.stemEndY) {
    return x <= MARK.neckHalfWidth + widen;
  }
  return false;
}

function insideDot(u, v, widen) {
  return Math.hypot(u - 0.5, v - MARK.dotY) <= MARK.dotRadius + widen;
}

/* ------------------------------------------------------------------- raster */

const SUPERSAMPLE = 4;

/**
 * Render one icon as RGBA bytes.
 *
 * Every output pixel averages SUPERSAMPLE^2 point samples. That is what gives
 * the rounded corners and the slanted funnel edges a clean edge without any
 * antialiasing library, and it is why the output is reproducible: there is no
 * floating-point accumulation order that varies between runs.
 */
function render(size) {
  const px = new Uint8Array(size * size * 4);
  // Below 32 px the stem and the dot need extra weight or they vanish.
  const widen = size <= 24 ? 0.03 : size <= 40 ? 0.012 : 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const u = (x + (sx + 0.5) / SUPERSAMPLE) / size;
          const v = (y + (sy + 0.5) / SUPERSAMPLE) / size;

          // Badge coverage: 1 well inside, 0 well outside, smooth on the edge.
          const d = sdRoundRect(u - 0.5, v - 0.5, 0.5, 0.5, BADGE_RADIUS);
          const coverage = Math.min(1, Math.max(0, 0.5 - d * size));
          if (coverage <= 0) continue;

          const color = insideDot(u, v, widen)
            ? DOT_COLOR
            : insideFunnel(u, v, widen)
              ? MARK_COLOR
              : mixColor(GRADIENT_TOP_LEFT, GRADIENT_BOTTOM_RIGHT, (u + v) / 2);

          r += color[0] * coverage;
          g += color[1] * coverage;
          b += color[2] * coverage;
          alpha += coverage;
        }
      }

      const n = SUPERSAMPLE * SUPERSAMPLE;
      const i = (y * size + x) * 4;
      // Straight (non-premultiplied) alpha: divide colour by the same coverage.
      px[i] = alpha > 0 ? Math.round(r / alpha) : 0;
      px[i + 1] = alpha > 0 ? Math.round(g / alpha) : 0;
      px[i + 2] = alpha > 0 ? Math.round(b / alpha) : 0;
      px[i + 3] = Math.round((alpha / n) * 255);
    }
  }
  return px;
}

/* -------------------------------------------------------------- png encoder */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Encode 8-bit RGBA pixels as a PNG. Filter type 0 on every row. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- svg export */

function hex(rgb) {
  return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The same mark as vector art, for the dashboard header and the README.
 * Coordinates are the unit geometry above scaled into a 48x48 viewBox.
 */
function logoSvg() {
  const s = 48;
  const p = (n) => (n * s).toFixed(2).replace(/\.00$/, '');
  const r = BADGE_RADIUS * s;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" role="img" aria-label="IG Outreach CRM">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hex(GRADIENT_TOP_LEFT)}" />
      <stop offset="1" stop-color="${hex(GRADIENT_BOTTOM_RIGHT)}" />
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${s}" height="${s}" rx="${r}" ry="${r}" fill="url(#bg)" />
  <path d="M${p(0.5 - MARK.mouthHalfWidth)} ${p(MARK.topY)} H${p(0.5 + MARK.mouthHalfWidth)} L${p(0.5 + MARK.neckHalfWidth)} ${p(MARK.neckY)} H${p(0.5 - MARK.neckHalfWidth)} Z" fill="${hex(MARK_COLOR)}" />
  <rect x="${p(0.5 - MARK.neckHalfWidth)}" y="${p(MARK.neckY)}" width="${p(MARK.neckHalfWidth * 2)}" height="${p(MARK.stemEndY - MARK.neckY)}" fill="${hex(MARK_COLOR)}" />
  <circle cx="${p(0.5)}" cy="${p(MARK.dotY)}" r="${p(MARK.dotRadius)}" fill="${hex(DOT_COLOR)}" />
</svg>
`;
}

/* --------------------------------------------------------------------- main */

const check = process.argv.includes('--check');
const files = new Map();

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  files.set(path.join(OUT, `icon${size}.png`), encodePng(size, render(size)));
}
files.set(path.join(OUT, 'logo.svg'), Buffer.from(logoSvg(), 'utf8'));

let failed = false;
for (const [file, data] of files) {
  const rel = path.relative(ROOT, file);
  if (check) {
    const onDisk = existsSync(file) ? readFileSync(file) : null;
    if (!onDisk) {
      console.error(`MISSING ${rel} — run: node scripts/gen-icons.mjs`);
      failed = true;
    } else if (!onDisk.equals(data)) {
      console.error(`STALE   ${rel} — committed icon does not match the generator`);
      failed = true;
    } else {
      console.log(`ok      ${rel} (${data.length} bytes, matches generator)`);
    }
  } else {
    writeFileSync(file, data);
    console.log(`wrote   ${rel} (${data.length} bytes)`);
  }
}

if (failed) process.exit(1);
