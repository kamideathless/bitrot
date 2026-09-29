// Renders every screen headlessly and writes PNGs to docs/.
// The game's renderer is a plain Uint8Array, so no browser is needed.
//
//   node tools/shots.mjs
//
// Regenerate whenever the UI changes; the README links these files.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { renderScene, makeApp, fakeInput, demoSave, demoResult, W, H } from './headless.mjs';
import { createTitleScene } from '../src/scenes/title.js';
import { createHubScene } from '../src/scenes/hub.js';
import { createPlayScene } from '../src/scenes/play.js';
import { createResultsScene } from '../src/scenes/results.js';
import { createUpgradesScene } from '../src/scenes/upgrades.js';
import { createCollectionScene } from '../src/scenes/collection.js';
import { createHelpScene } from '../src/scenes/help.js';
import { createSettingsScene } from '../src/scenes/settings.js';

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'docs');
const SCALE = 2;
const INK_RGB = [0x0e, 0x0e, 0x10];
const PAPER_RGB = [0xe9, 0xe9, 0xe1];

/* ---------------------------- minimal PNG ---------------------------- */

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Scale2x, matching what the game does on screen when smoothing is on, so the
 * documentation shows what players actually see.
 */
function smooth2x(src, w, h) {
  const dw = w * 2;
  const out = new Uint8Array(dw * h * 2);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const up = y > 0 ? row - w : row;
    const down = y < h - 1 ? row + w : row;
    const o0 = (y * 2) * dw;
    const o1 = o0 + dw;
    for (let x = 0; x < w; x++) {
      const P = src[row + x];
      const A = src[up + x];
      const D = src[down + x];
      const C = x > 0 ? src[row + x - 1] : P;
      const B = x < w - 1 ? src[row + x + 1] : P;
      let p1 = P, p2 = P, p3 = P, p4 = P;
      if (C === A && C !== D && A !== B) p1 = A;
      if (A === B && A !== C && B !== D) p2 = B;
      if (D === C && D !== B && C !== A) p3 = C;
      if (B === D && B !== A && D !== C) p4 = D;
      const k = x * 2;
      out[o0 + k] = p1; out[o0 + k + 1] = p2;
      out[o1 + k] = p3; out[o1 + k + 1] = p4;
    }
  }
  return out;
}

/** 8-bit RGB PNG from a 1-bit framebuffer, upscaled by `scale`. */
function encodePng(buf, width, height, scale) {
  const w = width * scale;
  const h = height * scale;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter: none
    const sy = (y / scale) | 0;
    for (let x = 0; x < w; x++) {
      const sx = (x / scale) | 0;
      const rgb = buf[sy * width + sx] ? INK_RGB : PAPER_RGB;
      raw[p++] = rgb[0];
      raw[p++] = rgb[1];
      raw[p++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------- shots -------------------------------- */

function playInput(dir = { x: 0.9, y: 0.35 }) {
  return fakeInput({ keyAxis: () => dir, held: (a) => a === 'purge' });
}

const SHOTS = [
  ['01-title', () => renderScene(createTitleScene, { seconds: 4.6 })],
  ['02-hub', () => {
    const app = makeApp({ online: true });
    app.account = { id: 'demo', name: 'DIVER-7C1A' };
    return renderScene(createHubScene, { app, seconds: 0.5 });
  }],
  ['03-dive', () => renderScene(createPlayScene, {
    app: makeApp({ input: playInput() }), seconds: 26,
  })],
  ['04-dive-late', () => renderScene(createPlayScene, {
    app: makeApp({ input: playInput({ x: -0.8, y: -0.6 }) }), seconds: 62,
  })],
  ['05-report', () => {
    const app = makeApp();
    return renderScene(createResultsScene, { app, seconds: 1.2, params: { result: demoResult() } });
  }],
  ['06-friends', () => renderScene(createCollectionScene, { seconds: 0.5 })],
  ['07-upgrades', () => renderScene(createUpgradesScene, { seconds: 0.5 })],
  ['08-manual', () => renderScene(createHelpScene, { seconds: 0.4, params: {} })],
  ['09-economy', () => {
    let calls = 0;
    const input = fakeInput({ pressed: (a) => a === 'right' && calls++ < 4 });
    return renderScene(createHelpScene, { app: makeApp({ input }), seconds: 0.4 });
  }],
  ['10-settings', () => renderScene(createSettingsScene, { seconds: 0.4 })],
];

await mkdir(OUT, { recursive: true });
for (const [name, run] of SHOTS) {
  const { gfx } = run();
  const png = encodePng(smooth2x(gfx.buf, W, H), W * 2, H * 2, 1);
  await writeFile(join(OUT, `${name}.png`), png);
  console.log(`docs/${name}.png  ${(png.length / 1024).toFixed(1)} KB`);
}
console.log(`\n${SHOTS.length} screenshots written to docs/`);
