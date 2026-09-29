// Shared 1-bit UI furniture: panels, bars, menus, Friend cards.

import { INK, PAPER, W, H } from '../core/gfx.js';
import { FONT, MICRO, drawText, drawTextCentered, drawTextRight, measure, wrapText, ICON } from '../core/font.js';
import { friendSprite, friendTraits } from '../game/friends.js';

/** Framed panel with an optional inverted title bar. */
export function panel(g, x, y, w, h, opts = {}) {
  const { title = null, fill = PAPER, shadow = true } = opts;

  // Layout probe: tests use this to catch content that has outgrown its frame.
  const trace = globalThis.__BITROT_PANEL_TRACE__;
  if (trace) trace.push({ x, y, w, h, title });

  if (shadow) {
    g.dither(x + 2, y + h, w, 2, 6, INK, 1);
    g.dither(x + w, y + 2, 2, h, 6, INK, 1);
  }
  g.rect(x, y, w, h, fill);
  g.frame(x, y, w, h, INK);
  if (title !== null) {
    g.rect(x + 1, y + 1, w - 2, 11, INK);
    drawText(g, title, x + 4, y + 3, { v: PAPER });
  }
  return { x: x + 2, y: y + (title !== null ? 15 : 3), w: w - 4, h: h - (title !== null ? 18 : 6) };
}

/** Horizontal meter. `frac` 0..1. `v` is the foreground colour. */
export function bar(g, x, y, w, h, frac, opts = {}) {
  const { style = 'solid', ticks = 0, v = INK } = opts;
  const bg = v ? PAPER : INK;
  g.rect(x, y, w, h, bg);
  g.frame(x, y, w, h, v);
  const iw = w - 4;
  const fw = Math.round(Math.max(0, Math.min(1, frac)) * iw);
  if (fw > 0) {
    if (style === 'dither') g.dither(x + 2, y + 2, fw, h - 4, 8, v);
    else g.rect(x + 2, y + 2, fw, h - 4, v);
  }
  if (ticks > 1) {
    for (let i = 1; i < ticks; i++) {
      const tx = x + 2 + Math.round((iw * i) / ticks);
      for (let yy = y + 2; yy < y + h - 2; yy += 2) g.px(tx, yy, g.get(tx, yy) ? PAPER : INK);
    }
  }
}

/** A row of little squares — used for upgrade levels. */
export function pips(g, x, y, count, filled, size = 4, gap = 2, v = INK) {
  for (let i = 0; i < count; i++) {
    const px = x + i * (size + gap);
    if (i < filled) g.rect(px, y, size, size, v);
    else { g.frame(px, y, size, size, v); }
  }
  return count * (size + gap) - gap;
}

/** Decorative dithered backdrop with slow diagonal drift. */
export function backdrop(g, t, level = 3) {
  g.clear(PAPER);
  const phase = Math.floor(t * 4) & 3;
  g.dither(0, 0, W, H, level, INK, phase);
}

/** Title bar used at the top of every non-play screen. */
export function header(g, title, right = null) {
  g.rect(0, 0, W, 14, INK);
  drawText(g, title, 6, 4, { v: PAPER });
  if (right) drawTextRight(g, right, W - 6, 4, { v: PAPER });
  g.dither(0, 14, W, 2, 8, INK, 0);
}

export function footer(g, text, right = null) {
  g.rect(0, H - 13, W, 13, INK);
  drawText(g, text, 6, H - 10, { v: PAPER, font: FONT });
  if (right) drawTextRight(g, right, W - 6, H - 10, { v: PAPER });
}

/**
 * Draw a Friend portrait with a frame whose style encodes rarity.
 * Returns the outer size.
 */
export function friendCard(g, id, integrity, x, y, scale = 1, opts = {}) {
  const { frame = true, selected = false, t = 0, showRarity = false } = opts;
  const traits = friendTraits(id);
  const spr = friendSprite(id, integrity);
  const size = 16 * scale;
  const pad = frame ? 2 : 0;

  if (frame) {
    g.rect(x, y, size + pad * 2, size + pad * 2, PAPER);
    const tier = traits.rarityTier;
    if (tier >= 3) {
      // GENESIS: double frame with animated corners
      g.frame(x, y, size + pad * 2, size + pad * 2, INK);
      g.dashFrame(x + 1, y + 1, size + pad * 2 - 2, size + pad * 2 - 2, INK, 4, Math.floor(t * 8));
    } else if (tier === 2) {
      g.frame(x, y, size + pad * 2, size + pad * 2, INK);
      g.rect(x, y, 2, 2, INK); g.rect(x + size + pad * 2 - 2, y, 2, 2, INK);
      g.rect(x, y + size + pad * 2 - 2, 2, 2, INK); g.rect(x + size + pad * 2 - 2, y + size + pad * 2 - 2, 2, 2, INK);
    } else if (tier === 1) {
      g.frame(x, y, size + pad * 2, size + pad * 2, INK);
    } else {
      g.dashFrame(x, y, size + pad * 2, size + pad * 2, INK, 2, 0);
    }
  }
  g.spriteScaled(spr, x + pad, y + pad, scale, { phase: Math.floor(t * 6) & 3, corruptLevel: 5 });

  if (selected) {
    g.dashFrame(x - 2, y - 2, size + pad * 2 + 4, size + pad * 2 + 4, INK, 4, Math.floor(t * 12));
  }
  if (showRarity && traits.rarityTier >= 0) {
    drawText(g, traits.rarity[0], x + size + pad * 2 - 4, y + size + pad * 2 - 6, { font: MICRO });
  }
  return size + pad * 2;
}

/** Keyboard + pointer menu. Rects are registered during draw. */
export class Menu {
  constructor(items = [], opts = {}) {
    this.items = items;
    this.index = 0;
    this.columns = opts.columns || 1;
    this.wrap = opts.wrap !== false;
    this.hitRects = [];
    this._nextRects = [];
    this.hover = -1;
    this.changed = false;
  }

  setItems(items, keepIndex = true) {
    this.items = items;
    if (!keepIndex) this.index = 0;
    this.index = Math.max(0, Math.min(this.index, Math.max(0, items.length - 1)));
  }

  get current() { return this.items[this.index] || null; }

  moveBy(delta) {
    const n = this.items.length;
    if (!n) return false;
    let i = this.index;
    for (let k = 0; k < n; k++) {
      i += delta;
      if (i < 0) { if (!this.wrap) { i = 0; break; } i = n - 1; }
      if (i >= n) { if (!this.wrap) { i = n - 1; break; } i = 0; }
      if (!this.items[i] || !this.items[i].skip) break;
    }
    const changed = i !== this.index;
    this.index = i;
    return changed;
  }

  /**
   * Handle input. Returns 'select' | 'back' | 'move' | null.
   * Must be called before draw() each frame.
   */
  handle(input, audio) {
    let action = null;
    const cols = this.columns;
    let moved = false;

    if (input.pressed('up')) moved = this.moveBy(-cols) || moved;
    if (input.pressed('down')) moved = this.moveBy(cols) || moved;
    if (cols > 1) {
      if (input.pressed('left')) moved = this.moveBy(-1) || moved;
      if (input.pressed('right')) moved = this.moveBy(1) || moved;
    } else {
      if (input.pressed('left')) moved = this.moveBy(-1) || moved;
      if (input.pressed('right')) moved = this.moveBy(1) || moved;
    }
    if (moved) { action = 'move'; audio && audio.sfx('move'); }

    // pointer
    this.hover = -1;
    const px = input.pointer.x, py = input.pointer.y;
    for (const r of this.hitRects) {
      if (px >= r.x && py >= r.y && px < r.x + r.w && py < r.y + r.h) {
        this.hover = r.i;
        break;
      }
    }
    if (this.hover >= 0 && this.hover !== this.index && !this.items[this.hover]?.skip) {
      this.index = this.hover;
      if (action === null) action = 'move';
    }
    if (input.pointer.pressed && this.hover >= 0) {
      this.index = this.hover;
      action = 'select';
    }

    if (input.pressed('confirm')) action = 'select';
    if (input.pressed('cancel')) action = 'back';
    return action;
  }

  beginDraw() { this._nextRects = []; }
  rect(i, x, y, w, h) { this._nextRects.push({ i, x, y, w, h }); }
  endDraw() { this.hitRects = this._nextRects; }
}

/** Standard vertical list rendering used by hub / settings / pause. */
export function drawList(g, menu, x, y, w, rowH, t, opts = {}) {
  const { gap = 2, rightOf = null, disabledOf = null } = opts;
  menu.beginDraw();
  for (let i = 0; i < menu.items.length; i++) {
    const item = menu.items[i];
    const ry = y + i * (rowH + gap);
    const active = i === menu.index;
    const disabled = disabledOf ? disabledOf(item, i) : !!item.disabled;
    menu.rect(i, x, ry, w, rowH);
    if (active) {
      g.rect(x, ry, w, rowH, INK);
      drawText(g, ICON.cursor, x + 3, ry + (rowH - 7) / 2, { v: PAPER });
      drawText(g, item.label, x + 12, ry + (rowH - 7) / 2, { v: PAPER });
      const r = rightOf ? rightOf(item, i) : item.right;
      if (r) drawTextRight(g, r, x + w - 4, ry + (rowH - 7) / 2, { v: PAPER });
    } else {
      g.rect(x, ry, w, rowH, PAPER);
      g.frame(x, ry, w, rowH, INK);
      if (disabled) g.dither(x + 1, ry + 1, w - 2, rowH - 2, 5, INK, 1);
      drawText(g, item.label, x + 12, ry + (rowH - 7) / 2, { v: INK });
      const r = rightOf ? rightOf(item, i) : item.right;
      if (r) drawTextRight(g, r, x + w - 4, ry + (rowH - 7) / 2, { v: INK });
    }
  }
  menu.endDraw();
  return menu.items.length * (rowH + gap);
}

/** Multi-line paragraph helper. Returns the y after the last line. */
export function paragraph(g, text, x, y, maxWidth, opts = {}) {
  const { lineGap = 3, font = FONT, scale = 1, v = INK } = opts;
  const lines = wrapText(text, maxWidth, { font, scale });
  let cy = y;
  for (const line of lines) {
    drawText(g, line, x, cy, { font, scale, v });
    cy += font.h * scale + lineGap;
  }
  return cy;
}

/** Floating score popups. */
export class Popups {
  constructor() { this.items = []; }
  add(text, x, y, opts = {}) {
    this.items.push({ text, x, y, t: 0, life: opts.life || 0.9, vy: opts.vy ?? -18, scale: opts.scale || 1 });
  }
  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.t += dt;
      p.y += p.vy * dt;
      if (p.t >= p.life) this.items.splice(i, 1);
    }
  }
  draw(g) {
    for (const p of this.items) {
      const k = p.t / p.life;
      if (k > 0.55 && (Math.floor(p.t * 20) & 1)) continue;
      const tw = measure(p.text, { scale: p.scale });
      // keep the whole popup on screen, even when it spawns against a wall
      const x = Math.max(3, Math.min(W - tw - 3, Math.round(p.x - tw / 2)));
      drawText(g, p.text, x, Math.round(p.y), { scale: p.scale, v: INK, outline: true });
    }
  }
  clear() { this.items.length = 0; }
}

export { INK, PAPER };
