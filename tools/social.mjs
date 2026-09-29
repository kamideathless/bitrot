// Social assets for announcing the game: a 16:9 card and an animated GIF of a
// Friend being rebuilt pixel by pixel.
//
//   node tools/social.mjs
//
// Both are drawn with the game's own renderer, so what you post is literally
// what the game draws - no mockups, no external image tools.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { Gfx, INK, PAPER } from '../src/core/gfx.js';
import { drawText, drawTextCentered, measure, FONT, MICRO } from '../src/core/font.js';
import { friendSprite, friendTraits, startingIntegrity, PORTRAIT } from '../src/game/friends.js';
import { restoreCost, RESTORE_STEP } from '../src/game/economy.js';

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'social');
const INK_RGB = [0x0e, 0x0e, 0x10];
const PAPER_RGB = [0xe9, 0xe9, 0xe1];

/* ------------------------------ PNG ---------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(buf, width, height, scale) {
  const w = width * scale, h = height * scale;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    const sy = (y / scale) | 0;
    for (let x = 0; x < w; x++) {
      const rgb = buf[sy * width + ((x / scale) | 0)] ? INK_RGB : PAPER_RGB;
      raw[p++] = rgb[0]; raw[p++] = rgb[1]; raw[p++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ GIF ---------------------------------- */

/** GIF-flavoured LZW: variable-width codes, MSB-last packing, 255-byte blocks. */
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();

  const bytes = [];
  let acc = 0, accBits = 0;
  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) { bytes.push(acc & 0xff); acc >>= 8; accBits -= 8; }
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    const assigned = next++;
    dict.set(key, assigned);
    if (assigned === (1 << codeSize) && codeSize < 12) codeSize++;
    if (next === 4096) {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (accBits > 0) bytes.push(acc & 0xff);

  // sub-blocks
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const slice = bytes.slice(i, i + 255);
    out.push(slice.length, ...slice);
  }
  out.push(0);
  return Buffer.from(out);
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }

/**
 * Animated GIF from 1-bit frames. Two colours, so the whole thing stays tiny
 * and every pixel survives - no palette quantisation to blur the dither.
 */
function encodeGif(frames, width, height, scale, delays) {
  const parts = [
    Buffer.from('GIF89a', 'ascii'),
    u16(width * scale), u16(height * scale),
    Buffer.from([0xf0, 0x00, 0x00]),                  // global table, 2 entries
    Buffer.from([...PAPER_RGB, ...INK_RGB]),
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01]), u16(0), Buffer.from([0x00]),   // loop forever
  ];

  frames.forEach((buf, i) => {
    const w = width * scale, h = height * scale;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = (y / scale) | 0;
      for (let x = 0; x < w; x++) px[y * w + x] = buf[sy * width + ((x / scale) | 0)] ? 1 : 0;
    }
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, 0x04]), u16(delays[i]), Buffer.from([0x00, 0x00]),
      Buffer.from([0x2c]), u16(0), u16(0), u16(w), u16(h), Buffer.from([0x00]),
      Buffer.from([2]), lzwEncode(px, 2),
    );
  });

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/* ----------------------------- drawing -------------------------------- */

/** The hero Friend. Fixed id so the assets are reproducible: this one reads
 *  clearly as a face at 16x16, which is what a rescue poster needs. */
const HERO = 'A11CE0';

function portrait(g, id, integrity, x, y, scale) {
  g.spriteScaled(friendSprite(id, integrity), x, y, scale);
}

/** 16:9 card: the restoration ladder, which explains the game without words. */
function card() {
  const g = new Gfx(480, 270);
  g.clear(INK);

  drawTextCentered(g, 'BITROT', 0, 480, 26, { v: PAPER, scale: 5 });
  drawTextCentered(g, 'THE ARCHIVE IS DECAYING', 0, 480, 70, { v: PAPER, font: MICRO, scale: 2 });

  // the ladder
  const steps = [0, 20, 40, 60, 80, 100];
  const SC = 4, size = PORTRAIT * SC, gap = 14;
  const total = steps.length * size + (steps.length - 1) * gap;
  let x = Math.round((480 - total) / 2);
  const y = 110;
  for (const pct of steps) {
    g.rect(x - 3, y - 3, size + 6, size + 6, PAPER);
    portrait(g, HERO, pct, x, y, SC);
    drawTextCentered(g, `${pct}%`, x, size, y + size + 10, { v: PAPER, font: MICRO, scale: 1 });
    if (x + size + gap < 480) {
      drawText(g, '>', x + size + 3, y + size / 2 - 3, { v: PAPER, scale: 1 });
    }
    x += size + gap;
  }

  drawTextCentered(g, 'RESCUE CORRUPTED FRIENDS. BURN RF TO REBUILD THE PIXELS THE ROT ATE.',
    0, 480, 208, { v: PAPER, font: MICRO, scale: 1 });
  drawTextCentered(g, 'KAMIDEATHLESS.GITHUB.IO/BITROT', 0, 480, 232, { v: PAPER, scale: 2 });
  drawTextCentered(g, 'MADE FOR THE RARE FRIENDS VIBEATHON  .  SIMULATED ECONOMY  .  NO WALLET',
    0, 480, 254, { v: PAPER, font: MICRO, scale: 1 });

  return g;
}

/** One Friend rebuilding itself, 0 to 100, with the RF meter ticking up. */
function restoreFrames() {
  const t = friendTraits(HERO);
  const W2 = 200, H2 = 200;
  const frames = [], delays = [];
  const SC = 7, size = PORTRAIT * SC;
  const px = Math.round((W2 - size) / 2);

  // Start where the game actually delivers a rescued Friend, not at 0, and
  // walk the same +10 steps a player buys - so the RF total on screen is one
  // someone could really pay for this exact Friend.
  const stops = [startingIntegrity(HERO)];
  while (stops[stops.length - 1] < 100) {
    stops.push(Math.min(100, stops[stops.length - 1] + RESTORE_STEP));
  }

  let burned = 0;
  for (let step = 0; step < stops.length; step++) {
    const pct = stops[step];
    if (step > 0) burned += restoreCost({ id: HERO, integrity: stops[step - 1] });

    const g = new Gfx(W2, H2);
    g.clear(INK);
    drawTextCentered(g, t.name, 0, W2, 12, { v: PAPER, scale: 2 });

    g.rect(px - 3, 34 - 3, size + 6, size + 6, PAPER);
    portrait(g, HERO, pct, px, 34, SC);

    // integrity meter
    const bx = 24, bw = W2 - 48, by = 158;
    g.frame(bx, by, bw, 9, PAPER);
    const fill = Math.round(((bw - 4) * pct) / 100);
    if (fill > 0) g.rect(bx + 2, by + 2, fill, 5, PAPER);
    drawText(g, 'INTEGRITY', bx, by + 14, { v: PAPER, font: MICRO });
    const right = `${pct}%`;
    drawText(g, right, bx + bw - measure(right, { font: MICRO }), by + 14, { v: PAPER, font: MICRO });
    drawTextCentered(g, `${burned} RF BURNED`, 0, W2, by + 26, { v: PAPER, font: MICRO });

    frames.push(g.buf);
    delays.push(step === stops.length - 1 ? 180 : 24);   // centiseconds; hold on the finished Friend
  }
  return { frames, delays, w: W2, h: H2 };
}

/* ------------------------------- main --------------------------------- */

await mkdir(OUT, { recursive: true });

const c = card();
await writeFile(join(OUT, 'card.png'), encodePng(c.buf, 480, 270, 3));
console.log('social/card.png        1440x810');

const r = restoreFrames();
await writeFile(join(OUT, 'restore.gif'), encodeGif(r.frames, r.w, r.h, 3, r.delays));
console.log(`social/restore.gif    ${r.w * 3}x${r.h * 3}, ${r.frames.length} frames`);
