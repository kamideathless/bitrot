// A tiny software 1-bit framebuffer.
//
// Everything is drawn into a Uint8Array of 0 (PAPER) / 1 (INK) at a fixed
// 480x320 logical resolution, then blitted to the canvas with integer scaling.
// Keeping the renderer strictly 1-bit is what makes the game look like a real
// pixel display instead of "a canvas with a pixel font on it": shading only
// exists as ordered dithering, and effects like the purge shockwave are just
// XOR inversions of the buffer.

export const W = 480;
export const H = 320;
export const PAPER = 0;
export const INK = 1;

// 4x4 ordered (Bayer) matrix, values 0..15.
const BAYER = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

export class Gfx {
  /**
   * The game always uses the default 480x320. The size is configurable so the
   * same renderer can back the landing page's decorative surfaces.
   */
  constructor(width = W, height = H) {
    this.W = width | 0;
    this.H = height | 0;
    this.buf = new Uint8Array(this.W * this.H);
    // clip rect
    this.cx0 = 0; this.cy0 = 0; this.cx1 = this.W; this.cy1 = this.H;
  }

  clip(x, y, w, h) {
    this.cx0 = Math.max(0, x | 0);
    this.cy0 = Math.max(0, y | 0);
    this.cx1 = Math.min(this.W, (x | 0) + (w | 0));
    this.cy1 = Math.min(this.H, (y | 0) + (h | 0));
  }

  noClip() {
    this.cx0 = 0; this.cy0 = 0; this.cx1 = this.W; this.cy1 = this.H;
  }

  clear(v = PAPER) { this.buf.fill(v); }

  px(x, y, v) {
    x |= 0; y |= 0;
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return;
    this.buf[y * this.W + x] = v;
  }

  get(x, y) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return PAPER;
    return this.buf[y * this.W + x];
  }

  invertPx(x, y) {
    x |= 0; y |= 0;
    if (x < this.cx0 || y < this.cy0 || x >= this.cx1 || y >= this.cy1) return;
    const i = y * this.W + x;
    this.buf[i] = this.buf[i] ? 0 : 1;
  }

  rect(x, y, w, h, v = INK) {
    let x0 = Math.max(this.cx0, x | 0);
    let y0 = Math.max(this.cy0, y | 0);
    let x1 = Math.min(this.cx1, (x | 0) + (w | 0));
    let y1 = Math.min(this.cy1, (y | 0) + (h | 0));
    for (let yy = y0; yy < y1; yy++) {
      this.buf.fill(v, yy * this.W + x0, yy * this.W + x1);
    }
  }

  invertRect(x, y, w, h) {
    const x0 = Math.max(this.cx0, x | 0);
    const y0 = Math.max(this.cy0, y | 0);
    const x1 = Math.min(this.cx1, (x | 0) + (w | 0));
    const y1 = Math.min(this.cy1, (y | 0) + (h | 0));
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.W;
      for (let xx = x0; xx < x1; xx++) {
        this.buf[row + xx] = this.buf[row + xx] ? 0 : 1;
      }
    }
  }

  /** Outlined rectangle, 1px. */
  frame(x, y, w, h, v = INK) {
    this.rect(x, y, w, 1, v);
    this.rect(x, y + h - 1, w, 1, v);
    this.rect(x, y, 1, h, v);
    this.rect(x + w - 1, y, 1, h, v);
  }

  /**
   * Ordered-dither fill. level 0..16 (0 = nothing, 16 = solid).
   * `phase` shifts the pattern so overlapping surfaces don't align.
   */
  dither(x, y, w, h, level, v = INK, phase = 0) {
    if (level <= 0) return;
    if (level >= 16) { this.rect(x, y, w, h, v); return; }
    const x0 = Math.max(this.cx0, x | 0);
    const y0 = Math.max(this.cy0, y | 0);
    const x1 = Math.min(this.cx1, (x | 0) + (w | 0));
    const y1 = Math.min(this.cy1, (y | 0) + (h | 0));
    for (let yy = y0; yy < y1; yy++) {
      const row = yy * this.W;
      const by = ((yy + phase) & 3) << 2;
      for (let xx = x0; xx < x1; xx++) {
        if (BAYER[by + ((xx + phase) & 3)] < level) this.buf[row + xx] = v;
      }
    }
  }

  hline(x0, x1, y, v = INK) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    this.rect(x0, y, x1 - x0 + 1, 1, v);
  }

  vline(x, y0, y1, v = INK) {
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    this.rect(x, y0, 1, y1 - y0 + 1, v);
  }

  line(x0, y0, x1, y1, v = INK) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, v);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Dashed 1px rectangle outline — used for selections. */
  dashFrame(x, y, w, h, v = INK, period = 4, offset = 0) {
    const on = (i) => (((i + offset) % period) < (period >> 1));
    for (let i = 0; i < w; i++) {
      if (on(i)) { this.px(x + i, y, v); this.px(x + i, y + h - 1, v); }
    }
    for (let i = 0; i < h; i++) {
      if (on(i)) { this.px(x, y + i, v); this.px(x + w - 1, y + i, v); }
    }
  }

  disc(cx, cy, r, v = INK) {
    const r2 = r * r;
    const x0 = Math.max(this.cx0, Math.floor(cx - r));
    const x1 = Math.min(this.cx1, Math.ceil(cx + r) + 1);
    const y0 = Math.max(this.cy0, Math.floor(cy - r));
    const y1 = Math.min(this.cy1, Math.ceil(cy + r) + 1);
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) this.buf[y * this.W + x] = v;
      }
    }
  }

  discDither(cx, cy, r, level, v = INK, phase = 0) {
    if (level <= 0) return;
    const r2 = r * r;
    const x0 = Math.max(this.cx0, Math.floor(cx - r));
    const x1 = Math.min(this.cx1, Math.ceil(cx + r) + 1);
    const y0 = Math.max(this.cy0, Math.floor(cy - r));
    const y1 = Math.min(this.cy1, Math.ceil(cy + r) + 1);
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      const by = ((y + phase) & 3) << 2;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy > r2) continue;
        if (BAYER[by + ((x + phase) & 3)] < level) this.buf[y * this.W + x] = v;
      }
    }
  }

  /** Annulus, inverted (great 1-bit shockwave). */
  ringInvert(cx, cy, r, thickness = 1) {
    const rOut = r + thickness * 0.5;
    const rIn = Math.max(0, r - thickness * 0.5);
    const ro2 = rOut * rOut, ri2 = rIn * rIn;
    const x0 = Math.max(this.cx0, Math.floor(cx - rOut));
    const x1 = Math.min(this.cx1, Math.ceil(cx + rOut) + 1);
    const y0 = Math.max(this.cy0, Math.floor(cy - rOut));
    const y1 = Math.min(this.cy1, Math.ceil(cy + rOut) + 1);
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      const row = y * this.W;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro2 && d2 >= ri2) this.buf[row + x] = this.buf[row + x] ? 0 : 1;
      }
    }
  }

  ring(cx, cy, r, v = INK, thickness = 1) {
    const rOut = r + thickness * 0.5;
    const rIn = Math.max(0, r - thickness * 0.5);
    const ro2 = rOut * rOut, ri2 = rIn * rIn;
    const x0 = Math.max(this.cx0, Math.floor(cx - rOut));
    const x1 = Math.min(this.cx1, Math.ceil(cx + rOut) + 1);
    const y0 = Math.max(this.cy0, Math.floor(cy - rOut));
    const y1 = Math.min(this.cy1, Math.ceil(cy + rOut) + 1);
    for (let y = y0; y < y1; y++) {
      const dy = y + 0.5 - cy;
      const row = y * this.W;
      for (let x = x0; x < x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 <= ro2 && d2 >= ri2) this.buf[row + x] = v;
      }
    }
  }

  /**
   * Blit a sprite. `spr` is { w, h, data: Uint8Array } where
   * 0 = transparent, 1 = ink, 2 = paper, 3 = invert-what-is-there,
   * 4 = "corrupt" (sparse dithered ink, used for missing Friend pixels).
   */
  sprite(spr, x, y, opts = {}) {
    const { flipX = false, invert = false, phase = 0, corruptLevel = 5 } = opts;
    x |= 0; y |= 0;
    const { w, h, data } = spr;
    for (let sy = 0; sy < h; sy++) {
      const py = y + sy;
      if (py < this.cy0 || py >= this.cy1) continue;
      const row = py * this.W;
      const by = ((py + phase) & 3) << 2;
      for (let sx = 0; sx < w; sx++) {
        const v = data[sy * w + (flipX ? w - 1 - sx : sx)];
        if (v === 0) continue;
        const px = x + sx;
        if (px < this.cx0 || px >= this.cx1) continue;
        if (v === 3) { this.buf[row + px] = this.buf[row + px] ? 0 : 1; continue; }
        if (v === 4) {
          if (BAYER[by + ((px + phase) & 3)] < corruptLevel) this.buf[row + px] = invert ? PAPER : INK;
          continue;
        }
        let c = v === 1 ? INK : PAPER;
        if (invert) c = c ? 0 : 1;
        this.buf[row + px] = c;
      }
    }
  }

  /** Blit a sprite scaled by an integer factor. */
  spriteScaled(spr, x, y, scale, opts = {}) {
    if (scale === 1) return this.sprite(spr, x, y, opts);
    const { invert = false, phase = 0, corruptLevel = 5 } = opts;
    const { w, h, data } = spr;
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const v = data[sy * w + sx];
        if (v === 0) continue;
        if (v === 3) { this.invertRect(x + sx * scale, y + sy * scale, scale, scale); continue; }
        if (v === 4) {
          this.dither(x + sx * scale, y + sy * scale, scale, scale, corruptLevel, invert ? PAPER : INK, phase);
          continue;
        }
        let c = v === 1 ? INK : PAPER;
        if (invert) c = c ? 0 : 1;
        this.rect(x + sx * scale, y + sy * scale, scale, scale, c);
      }
    }
  }
}

/** Build a sprite object from string rows. '#'=ink, '.'/' '=transparent, 'o'=paper, 'x'=invert */
export function makeSprite(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    if (r.length !== w) throw new Error(`makeSprite: row ${y} has length ${r.length}, expected ${w}`);
    for (let x = 0; x < w; x++) {
      const ch = r[x];
      data[y * w + x] = ch === '#' ? 1 : ch === 'o' ? 2 : ch === 'x' ? 3 : 0;
    }
  }
  return { w, h, data };
}

/**
 * Screen presenter: owns the canvas, integer scaling and the palette swap.
 */
export class Screen {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.off = document.createElement('canvas');
    this.off.width = W;
    this.off.height = H;
    this.offCtx = this.off.getContext('2d', { alpha: false });
    this.image = this.offCtx.createImageData(W, H);
    this.data32 = new Uint32Array(this.image.data.buffer);
    this.scale = 1;
    this.inverted = false;
    this.smoothing = true;
    this._smoothBuf = null;
    // little-endian ABGR
    this.palette = new Uint32Array(2);
    this.setPalette('#e9e9e1', '#0e0e10');
  }

  setPalette(paperHex, inkHex) {
    this.palette[0] = hexToABGR(paperHex);
    this.palette[1] = hexToABGR(inkHex);
  }

  setInverted(on) {
    this.inverted = !!on;
    if (this.inverted) this.setPalette('#0e0e10', '#e9e9e1');
    else this.setPalette('#e9e9e1', '#0e0e10');
  }

  /**
   * Pick the backing-store size and the CSS size.
   *
   * The backing store is always an integer multiple of 480x320 in *device*
   * pixels, so the software renderer stays cheap and the blit stays crisp.
   * The CSS size normally matches it exactly (perfectly square pixels), but
   * when that would leave a lot of the screen empty — the usual case on a
   * phone, where one device-pixel scale is the most that fits — the canvas is
   * stretched to fill instead. Losing exact pixel squareness is the right
   * trade at phone pixel densities; having a postage-stamp game is not.
   */
  resize(availW, availH) {
    const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    const s = Math.max(1, Math.floor(Math.min((availW * dpr) / W, (availH * dpr) / H)));

    if (s !== this.scale || this.canvas.width !== W * s) {
      this.scale = s;
      this.canvas.width = W * s;
      this.canvas.height = H * s;
      this.ctx.imageSmoothingEnabled = false;
    }

    let cssW = (W * s) / dpr;
    let cssH = (H * s) / dpr;
    this.stretched = false;
    if (cssW < availW * 0.8 && cssH < availH * 0.98) {
      const k = Math.min(availW / cssW, availH / cssH);
      cssW *= k;
      cssH *= k;
      // The display size is already decoupled from the backing store here — the
      // usual case on a phone. Render at 2x anyway so text gets the smoothing
      // pass; the browser scales the result to fit.
      this.stretched = true;
      if (this.scale < 2) {
        this.scale = 2;
        this.canvas.width = W * 2;
        this.canvas.height = H * 2;
      }
    }
    const wPx = `${Math.round(cssW)}px`;
    const hPx = `${Math.round(cssH)}px`;
    if (this.canvas.style.width !== wPx) this.canvas.style.width = wPx;
    if (this.canvas.style.height !== hPx) this.canvas.style.height = hPx;
  }

  setSmoothing(on) { this.smoothing = !!on; }

  /**
   * Scale2x / EPX: doubles the buffer while rounding off single-pixel corners
   * and diagonals. The result still reads as pixel art, just at a finer grain —
   * which matters because at 480x320 a 5x7 glyph blown up three times is very
   * blocky indeed.
   */
  _smooth(src) {
    const w = W, h = H, dw = w * 2;
    let out = this._smoothBuf;
    if (!out) out = this._smoothBuf = new Uint8Array(dw * h * 2);

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

  present(gfx, shakeX = 0, shakeY = 0) {
    // smoothing needs room to double, so it only applies from scale 2 up
    const smooth = this.smoothing && this.scale >= 2;
    const buf = smooth ? this._smooth(gfx.buf) : gfx.buf;
    const bw = smooth ? W * 2 : W;
    const bh = smooth ? H * 2 : H;

    if (this.off.width !== bw || this.off.height !== bh) {
      this.off.width = bw;
      this.off.height = bh;
      this.image = this.offCtx.createImageData(bw, bh);
      this.data32 = new Uint32Array(this.image.data.buffer);
    }

    const out = this.data32;
    const pal = this.palette;
    for (let i = 0; i < buf.length; i++) out[i] = pal[buf[i]];
    this.offCtx.putImageData(this.image, 0, 0);

    const ctx = this.ctx;
    // A stretched canvas lands on a fractional device ratio, where nearest
    // neighbour produces uneven pixel widths; let the browser filter instead.
    ctx.imageSmoothingEnabled = this.stretched === true && smooth;
    const s = this.scale;
    const ox = Math.round(shakeX) * s;
    const oy = Math.round(shakeY) * s;
    if (ox !== 0 || oy !== 0) {
      ctx.fillStyle = this.inverted ? '#e9e9e1' : '#0e0e10';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    ctx.drawImage(this.off, ox, oy, this.canvas.width, this.canvas.height);
  }
}

/**
 * Paint a Gfx 1:1 into a canvas of the same size. Either colour may be null,
 * which renders as transparent — used by the landing page so pixel text and
 * decorative surfaces can sit on top of a CSS background.
 */
export function blitToCanvas(gfx, canvas, paperHex = null, inkHex = '#0e0e10') {
  if (canvas.width !== gfx.W || canvas.height !== gfx.H) {
    canvas.width = gfx.W;
    canvas.height = gfx.H;
  }
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(gfx.W, gfx.H);
  const out = new Uint32Array(image.data.buffer);
  const pal = [
    paperHex === null ? 0 : hexToABGR(paperHex),
    inkHex === null ? 0 : hexToABGR(inkHex),
  ];
  const buf = gfx.buf;
  for (let i = 0; i < buf.length; i++) out[i] = pal[buf[i]];
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function hexToABGR(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return (255 << 24) | (b << 16) | (g << 8) | r;
}

export { BAYER };
