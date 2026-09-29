// The renderer is pure CPU work on a Uint8Array, so it can be tested headless.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Gfx, makeSprite, W, H, INK, PAPER } from '../src/core/gfx.js';
import { FONT, MICRO, drawText, drawTextCentered, measure, wrapText, ICON } from '../src/core/font.js';
import { drawField } from '../src/ui/field.js';
import { createField, seed, COLS, ROWS, CELL } from '../src/game/automaton.js';

const countInk = (g) => g.buf.reduce((n, v) => n + v, 0);

test('the framebuffer is the advertised size and starts blank', () => {
  const g = new Gfx();
  assert.equal(g.buf.length, W * H);
  assert.equal(countInk(g), 0);
});

test('drawing never writes outside the buffer', () => {
  const g = new Gfx();
  assert.doesNotThrow(() => {
    g.rect(-500, -500, 2000, 2000, INK);
    g.px(-1, -1, INK);
    g.px(W + 10, H + 10, INK);
    g.disc(-40, -40, 80, INK);
    g.ringInvert(W + 50, H + 50, 90, 4);
    g.line(-100, -100, W + 100, H + 100, INK);
    g.dither(-20, -20, W + 80, H + 80, 8, INK);
  });
  assert.equal(g.buf.length, W * H);
});

test('clip rect is honoured', () => {
  const g = new Gfx();
  g.clip(10, 10, 20, 20);
  g.rect(0, 0, W, H, INK);
  g.noClip();
  assert.equal(countInk(g), 400);
  assert.equal(g.get(9, 9), PAPER);
  assert.equal(g.get(10, 10), INK);
  assert.equal(g.get(29, 29), INK);
  assert.equal(g.get(30, 30), PAPER);
});

test('dither levels are monotonic', () => {
  let prev = -1;
  for (let level = 0; level <= 16; level++) {
    const g = new Gfx();
    g.dither(0, 0, 64, 64, level, INK);
    const n = countInk(g);
    assert.ok(n >= prev, `level ${level} drew fewer pixels than ${level - 1}`);
    prev = n;
  }
  const solid = new Gfx();
  solid.dither(0, 0, 64, 64, 16, INK);
  assert.equal(countInk(solid), 64 * 64);
});

test('invertRect is its own inverse', () => {
  const g = new Gfx();
  g.rect(20, 20, 50, 50, INK);
  const before = g.buf.slice();
  g.invertRect(10, 10, 80, 80);
  assert.notDeepEqual(g.buf, before);
  g.invertRect(10, 10, 80, 80);
  assert.deepEqual(g.buf, before);
});

test('makeSprite rejects ragged art', () => {
  assert.throws(() => makeSprite(['##', '###']));
  const s = makeSprite(['#o.', 'x#o']);
  assert.deepEqual([...s.data], [1, 2, 0, 3, 1, 2]);
});

test('every font glyph is well formed', () => {
  for (const [ch, data] of FONT.glyphs) {
    assert.equal(data.length, FONT.w * FONT.h, `glyph ${JSON.stringify(ch)} is the wrong size`);
  }
  for (const [ch, data] of MICRO.glyphs) {
    assert.equal(data.length, MICRO.w * MICRO.h, `micro glyph ${JSON.stringify(ch)} is the wrong size`);
  }
  // the characters the UI actually leans on must exist in the main font
  const required = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;!?-+=/()[]<>%\'"#_|@&*';
  for (const ch of required) {
    assert.ok(FONT.glyphs.has(ch), `main font is missing "${ch}"`);
  }
  for (const key of Object.keys(ICON)) {
    assert.ok(FONT.glyphs.has(ICON[key]), `icon ${key} has no 5x7 glyph`);
    assert.ok(MICRO.glyphs.has(ICON[key]), `icon ${key} has no 3x5 glyph`);
  }
});

test('text draws ink and measures consistently', () => {
  const g = new Gfx();
  drawText(g, 'BITROT', 4, 4);
  assert.ok(countInk(g) > 40);
  assert.equal(measure('AB'), 11);          // 5 + 1 + 5
  assert.equal(measure('AB', { scale: 2 }), 22);
  assert.equal(measure(''), 0);
  const g2 = new Gfx();
  drawTextCentered(g2, 'HI', 0, W, 10);
  assert.ok(countInk(g2) > 0);
});

test('lowercase is folded to uppercase and unknown glyphs fall back', () => {
  const a = new Gfx(); drawText(a, 'abc', 2, 2);
  const b = new Gfx(); drawText(b, 'ABC', 2, 2);
  assert.deepEqual(a.buf, b.buf);
  const c = new Gfx();
  assert.doesNotThrow(() => drawText(c, 'ЖЖ—é', 2, 2));
});

test('wrapText respects the width', () => {
  const lines = wrapText('THE ARCHIVE IS DECAYING AND EVERY FRIEND INSIDE IS AT RISK', 100, {});
  assert.ok(lines.length > 1);
  for (const line of lines) {
    assert.ok(measure(line) <= 100 || line.split(' ').length === 1, `line too wide: ${line}`);
  }
  assert.deepEqual(wrapText('', 100, {}), []);
});

test('the field renderer covers the whole playfield and marks walls', () => {
  const g = new Gfx();
  const f = createField();
  seed(f, 10, 10);
  drawField(g, f, 0, 0);
  // wall ring is solid ink (minus the 1px paper highlight on its inner edge)
  assert.equal(g.get(2, 2), INK);
  assert.equal(g.get(COLS * CELL - 3, ROWS * CELL - 3), INK);
  // seeded cell drew something
  let ink = 0;
  for (let y = 10 * CELL; y < 11 * CELL; y++) {
    for (let x = 10 * CELL; x < 11 * CELL; x++) if (g.get(x, y)) ink++;
  }
  assert.ok(ink > 20, 'a fresh rot cell should be visible');
});

test('sprite pixel kinds behave', () => {
  const g = new Gfx();
  g.rect(0, 0, 4, 1, INK);
  g.sprite(makeSprite(['.o#x']), 0, 0);
  assert.equal(g.get(0, 0), INK);    // transparent leaves the ink underneath
  assert.equal(g.get(1, 0), PAPER);  // 'o' paints paper
  assert.equal(g.get(2, 0), INK);    // '#' paints ink
  assert.equal(g.get(3, 0), PAPER);  // 'x' inverts the ink underneath
});

test('spriteScaled matches sprite at scale 1 and grows predictably', () => {
  const spr = makeSprite(['#o', 'o#']);
  const a = new Gfx(); a.sprite(spr, 5, 5);
  const b = new Gfx(); b.spriteScaled(spr, 5, 5, 1);
  assert.deepEqual(a.buf, b.buf);
  const c = new Gfx(); c.spriteScaled(spr, 0, 0, 4);
  assert.equal(c.get(0, 0), INK);
  assert.equal(c.get(3, 3), INK);
  assert.equal(c.get(4, 0), PAPER);
});

test('a Gfx can be built at a custom size and stays in bounds', () => {
  const g = new Gfx(97, 41);
  assert.equal(g.buf.length, 97 * 41);
  assert.equal(g.W, 97);
  assert.equal(g.H, 41);
  assert.doesNotThrow(() => {
    g.rect(-20, -20, 500, 500, INK);
    g.dither(0, 0, 97, 41, 8, PAPER);
    g.disc(96, 40, 30, INK);
    g.ringInvert(0, 0, 25, 3);
  });
  assert.equal(g.buf.length, 97 * 41);
  // a full-bleed fill really does cover every pixel of the custom surface
  const solid = new Gfx(13, 7);
  solid.rect(0, 0, 13, 7, INK);
  assert.equal(solid.buf.reduce((n, v) => n + v, 0), 13 * 7);
  // and the last pixel is addressable
  solid.clear();
  solid.px(12, 6, INK);
  assert.equal(solid.get(12, 6), INK);
  assert.equal(solid.buf[6 * 13 + 12], INK);
});

test('text lands at the same offsets on a custom-size surface', () => {
  const big = new Gfx();
  const small = new Gfx(120, 20);
  drawText(big, 'BITROT', 3, 4);
  drawText(small, 'BITROT', 3, 4);
  let same = true;
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 120; x++) {
      if (big.get(x, y) !== small.get(x, y)) { same = false; break; }
    }
  }
  assert.ok(same, 'the same call produced different pixels on a different surface size');
});
