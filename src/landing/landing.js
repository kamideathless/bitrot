// The landing page is drawn with the game's own renderer: the same 1-bit
// framebuffer, the same 5x7 bitmap font, the same rot automaton and the same
// procedural Friends. Nothing here is a mock-up of the game — it is the game's
// modules running in a page.

import { Gfx, blitToCanvas, INK, PAPER } from '../core/gfx.js';
import { FONT, drawText, measure } from '../core/font.js';
import { hashString, sub, Rng } from '../core/rng.js';
import {
  createField, step, bitFlip, purgeCircle, defrag, seed, genInterval,
  COLS, ROWS, CELL, ROT, CLEAN,
} from '../game/automaton.js';
import { friendSprite, friendTraits, rollFriendId } from '../game/friends.js';
import { restoreCost, RESTORE_STEP } from '../game/economy.js';

const PAPER_HEX = '#e9e9e1';
const INK_HEX = '#0e0e10';

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- text -- */

/**
 * Text in the game's bitmap font, with the game's corruption model applied so
 * a heading can be "restored" as it scrolls into view.
 */
class PixelText {
  constructor(canvas, text, { scale = 4, pad = 2, ink = PAPER_HEX } = {}) {
    this.canvas = canvas;
    this.ink = ink;
    const w = measure(text, { scale }) + pad * 2;
    const h = FONT.h * scale + pad * 2;
    this.gfx = new Gfx(w, h);
    this.full = new Gfx(w, h);
    drawText(this.full, text, pad, pad, { scale, v: INK });

    // stable reveal order, exactly like friendSprite's restoration
    const hb = hashString('BITROT/TEXT/' + text);
    this.lit = [];
    for (let i = 0; i < this.full.buf.length; i++) if (this.full.buf[i]) this.lit.push(i);
    this.lit.sort((a, b) => sub(hb, a) - sub(hb, b));
    this.progress = 0;
    this.render(reduced ? 1 : 0);
  }

  render(progress) {
    this.progress = progress;
    const buf = this.gfx.buf;
    buf.fill(0);
    const n = Math.round(this.lit.length * Math.max(0, Math.min(1, progress)));
    for (let k = 0; k < n; k++) buf[this.lit[k]] = 1;
    blitToCanvas(this.gfx, this.canvas, null, this.ink);
  }

  /** Animate from corrupt to whole. */
  restore(duration = 820, delay = 0) {
    if (reduced) { this.render(1); return; }
    const start = performance.now() + delay;
    const tick = (now) => {
      const p = (now - start) / duration;
      this.render(p <= 0 ? 0 : p >= 1 ? 1 : 1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** A brief flicker of decay, for signs of life. */
  glitch(depth = 0.16, duration = 150) {
    if (reduced) return;
    const start = performance.now();
    const tick = (now) => {
      const p = (now - start) / duration;
      if (p >= 1) { this.render(1); return; }
      this.render(1 - depth * Math.sin(p * Math.PI));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function mountPixelText(el) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pixel';
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);
  return new PixelText(canvas, el.dataset.text, {
    scale: Number(el.dataset.scale || 4),
    ink: el.dataset.ink || PAPER_HEX,
  });
}

/* ----------------------------------------------------------- rot field -- */

const AGE_LEVELS = [5, 7, 9, 11, 13, 14, 15, 16];
const levelForAge = (age) =>
  AGE_LEVELS[age < 2 ? 0 : age < 4 ? 1 : age < 6 ? 2 : age < 9 ? 3 : age < 13 ? 4 : age < 18 ? 5 : age < 26 ? 6 : 7];

/** Rot only — no wall ring, so the texture can run edge to edge. */
function drawRot(g, field, phase, oy = 0) {
  const { cells, age } = field;
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      if (cells[i] !== ROT) continue;
      g.dither(x * CELL, oy + y * CELL, CELL, CELL, levelForAge(age[i]), INK, phase);
    }
  }
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      const i = y * COLS + x;
      if (cells[i] !== ROT) continue;
      const px = x * CELL, py = oy + y * CELL;
      if (cells[i - COLS] === CLEAN) g.rect(px, py, CELL, 1, INK);
      if (cells[i + COLS] === CLEAN) g.rect(px, py + CELL - 1, CELL, 1, INK);
      if (cells[i - 1] === CLEAN) g.rect(px, py, 1, CELL, INK);
      if (cells[i + 1] === CLEAN) g.rect(px + CELL - 1, py, 1, CELL, INK);
    }
  }
}

/**
 * A self-running arena. `mode` 'ambient' just grows and wipes; 'demo' also
 * fires purges so the scar mechanic is visible.
 */
class RotSurface {
  /**
   * `tiles` stacks that many independent arenas vertically, which gives the
   * hero a taller source so `object-fit: cover` crops sideways instead of
   * slicing a thin band out of the middle.
   */
  constructor(canvas, {
    seedValue = 1, pressure = 0.7, mode = 'ambient', tiles = 1,
    paper = PAPER_HEX, ink = INK_HEX,
  } = {}) {
    this.canvas = canvas;
    this.paper = paper;
    this.ink = ink;
    this.rng = new Rng(seedValue);
    this.pressure = pressure;
    this.mode = mode;
    this.gfx = new Gfx(COLS * CELL, ROWS * CELL * tiles);
    this.fields = Array.from({ length: tiles }, () => createField());
    this.acc = 0;
    this.t = 0;
    this.flash = 0;
    this.nextPurge = 1.4;
    this.waves = [];
    this.stats = { cleared: 0, purges: 0 };
    for (const f of this.fields) this.reseed(f, 6);
    this.warm(mode === 'ambient' ? 110 : 26);
    this.draw();
  }

  reseed(field, n) {
    for (let i = 0; i < n; i++) seed(field, 2 + this.rng.int(COLS - 4), 2 + this.rng.int(ROWS - 4));
  }

  warm(generations) {
    for (let i = 0; i < generations; i++) {
      for (const f of this.fields) {
        step(f, this.pressure, () => this.rng.next());
        bitFlip(f, this.pressure, () => this.rng.next());
      }
    }
  }

  coverage(field = this.fields[0]) {
    let n = 0;
    for (let i = 0; i < field.cells.length; i++) if (field.cells[i] === ROT) n++;
    return n / field.playable;
  }

  /** The cell with the most rot around it — where a player would aim. */
  densest(field) {
    let best = null;
    let bestScore = -1;
    for (let k = 0; k < 60; k++) {
      const x = 3 + this.rng.int(COLS - 6);
      const y = 3 + this.rng.int(ROWS - 6);
      let c = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
          if (field.cells[yy * COLS + xx] === ROT) c++;
        }
      }
      if (c > bestScore) { bestScore = c; best = { x, y }; }
    }
    return bestScore > 3 ? best : null;
  }

  update(dt) {
    this.t += dt;
    this.acc += dt;
    const gi = genInterval(this.pressure);
    let guard = 0;
    while (this.acc >= gi && guard++ < 4) {
      this.acc -= gi;
      for (const f of this.fields) {
        step(f, this.pressure, () => this.rng.next());
        bitFlip(f, this.pressure, () => this.rng.next());
      }
    }

    if (this.mode === 'demo' && this.t >= this.nextPurge) {
      this.nextPurge = this.t + 1.5;
      const field = this.fields[0];
      const spot = this.densest(field);
      if (spot) {
        this.stats.purges++;
        this.stats.cleared += purgeCircle(field, spot.x + 0.5, spot.y + 0.5, 3.2, 26);
        this.waves.push({ x: (spot.x + 0.5) * CELL, y: (spot.y + 0.5) * CELL, t: 0 });
      }
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      this.waves[i].t += dt;
      if (this.waves[i].t > 0.42) this.waves.splice(i, 1);
    }

    for (const f of this.fields) {
      if (this.mode === 'demo') {
        // the demo shows the whole cycle, wipe included
        if (this.coverage(f) > 0.6) {
          defrag(f, 4);
          this.reseed(f, 3);
          this.flash = 0.16;
        }
      } else if (this.coverage(f) > 0.6) {
        // the hero must never go empty, so it is thinned rather than wiped:
        // a few big purges keep it churning around a third covered
        for (let i = 0; i < 3; i++) {
          purgeCircle(f, 2 + this.rng.next() * (COLS - 4), 2 + this.rng.next() * (ROWS - 4), 6.5, 10);
        }
        this.reseed(f, 2);
      }
    }
    if (this.flash > 0) this.flash -= dt;
  }

  draw() {
    const g = this.gfx;
    g.clear(PAPER);
    const phase = reduced ? 0 : Math.floor(this.t * 5) & 3;
    this.fields.forEach((f, i) => drawRot(g, f, phase, i * ROWS * CELL));
    for (const w of this.waves) {
      g.ringInvert(w.x, w.y, 4 + (w.t / 0.42) * 52, 2);
    }
    if (this.flash > 0) g.invertRect(0, 0, g.W, g.H);
    blitToCanvas(g, this.canvas, this.paper, this.ink);
  }
}

/* -------------------------------------------------------- friend faces -- */

function drawFriend(canvas, id, integrity, scale, { paper = PAPER_HEX, ink = INK_HEX, phase = 0 } = {}) {
  const g = canvas.__gfx && canvas.__gfx.W === 16 * scale ? canvas.__gfx : (canvas.__gfx = new Gfx(16 * scale, 16 * scale));
  g.clear(PAPER);
  g.spriteScaled(friendSprite(id, integrity), 0, 0, scale, { phase });
  blitToCanvas(g, canvas, paper, ink);
}

/* -------------------------------------------------------------- reveal -- */

function setupReveal() {
  const items = [...document.querySelectorAll('[data-reveal]')];
  if (reduced || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('shown'));
    document.querySelectorAll('[data-text]').forEach((el) => { if (el.__pt) el.__pt.render(1); });
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('shown');
      if (e.target.__pt) e.target.__pt.restore(820, 120);
      e.target.querySelectorAll?.('[data-text]').forEach((h, i) => {
        if (h.__pt) h.__pt.restore(820, 120 + i * 90);
      });
      io.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 });
  items.forEach((el) => io.observe(el));
}

/**
 * Run a canvas only while it is actually on screen and the tab is visible.
 * The loop is cancelled rather than idling, so a page left open in a
 * background tab costs nothing.
 */
function whileVisible(el, onFrame) {
  let inView = false;
  let running = false;
  let raf = 0;
  let last = 0;

  const loop = (now) => {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.2) dt = 0.2;
    try {
      onFrame(dt);
    } catch (err) {
      // a decorative surface must never take the page down with it
      console.error('BITROT landing: animation stopped', err);
      running = false;
      return;
    }
    raf = requestAnimationFrame(loop);
  };
  const start = () => {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  };
  const sync = () => { (inView && !document.hidden) ? start() : stop(); };

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); }, { threshold: 0.05 }).observe(el);
  } else {
    inView = true;
    sync();
  }
  document.addEventListener('visibilitychange', sync);
}

/* ----------------------------------------------------------------- go --- */

function boot() {
  /* headings + wordmark ------------------------------------------------- */
  // Anything a reveal observer will animate starts corrupt; everything else
  // (the nav mark) has to be drawn whole right away.
  document.querySelectorAll('[data-text]').forEach((el) => {
    el.__pt = mountPixelText(el);
    if (!el.closest('[data-reveal]') && el.id !== 'wordmark') el.__pt.render(1);
  });

  const wordmark = document.getElementById('wordmark');
  if (wordmark?.__pt) {
    wordmark.__pt.restore(1100, 220);
    if (!reduced) {
      setInterval(() => { if (!document.hidden) wordmark.__pt.glitch(0.2, 180); }, 5200);
    }
  }

  /* hero backdrop -------------------------------------------------------- */
  const heroCanvas = document.getElementById('hero-field');
  if (heroCanvas) {
    const hero = new RotSurface(heroCanvas, {
      seedValue: 20260930, pressure: 0.78, mode: 'ambient', tiles: 2,
    });
    hero.draw();
    requestAnimationFrame(() => heroCanvas.classList.add('ready'));
    if (!reduced) {
      whileVisible(heroCanvas, (dt) => { hero.update(dt); hero.draw(); });
    }
  }

  /* card A: the automaton ------------------------------------------------ */
  const arena = document.getElementById('demo-arena');
  if (arena) {
    const surface = new RotSurface(arena, { seedValue: 7, pressure: 0.85, mode: 'demo' });
    const covEl = document.getElementById('demo-coverage');
    const purgeEl = document.getElementById('demo-purges');
    surface.draw();
    if (!reduced) {
      whileVisible(arena, (dt) => {
        surface.update(dt);
        surface.draw();
        if (covEl) covEl.textContent = `${Math.round(surface.coverage() * 100)}%`;
        if (purgeEl) purgeEl.textContent = String(surface.stats.purges);
      });
    } else if (covEl) {
      covEl.textContent = `${Math.round(surface.coverage() * 100)}%`;
    }
  }

  /* card B: burning restores pixels -------------------------------------- */
  const burnCanvas = document.getElementById('demo-burn');
  if (burnCanvas) {
    const id = 'A7C21F';
    const integrityEl = document.getElementById('demo-integrity');
    const burnedEl = document.getElementById('demo-burned');
    let integrity = 20;
    let burned = 0;
    let timer = 0;
    const paint = () => {
      drawFriend(burnCanvas, id, integrity, 9, { phase: Math.floor(performance.now() / 140) & 3 });
      if (integrityEl) integrityEl.textContent = `${integrity}%`;
      if (burnedEl) burnedEl.textContent = `${burned} RF`;
    };
    paint();
    if (!reduced) {
      whileVisible(burnCanvas, (dt) => {
        timer += dt;
        const beat = integrity >= 100 ? 1.9 : 0.5;
        if (timer >= beat) {
          timer = 0;
          if (integrity >= 100) { integrity = 20; burned = 0; }
          else {
            burned += restoreCost({ id, integrity }) || 0;
            integrity = Math.min(100, integrity + RESTORE_STEP);
          }
        }
        paint();
      });
    }
  }

  /* the marquee ---------------------------------------------------------- */
  const track = document.getElementById('marquee-track');
  if (track) {
    const rng = new Rng(8675309);
    const ids = [];
    for (let i = 0; i < 22; i++) ids.push(rollFriendId(rng));
    const make = (id) => {
      const c = document.createElement('canvas');
      c.className = 'pixel';
      const t = friendTraits(id);
      c.title = `${t.label} · ${t.rarity} · GEN-${t.generation}`;
      drawFriend(c, id, 100, 4, { paper: INK_HEX, ink: PAPER_HEX });
      return c;
    };
    // two copies so the -50% slide loops seamlessly
    for (const id of ids) track.appendChild(make(id));
    for (const id of ids) track.appendChild(make(id));
  }

  /* roll a Friend -------------------------------------------------------- */
  const rollCanvas = document.getElementById('roll-portrait');
  if (rollCanvas) {
    const rng = new Rng((Math.random() * 1e9) | 0);
    const nameEl = document.getElementById('roll-name');
    const rarityEl = document.getElementById('roll-rarity');
    const fields = {
      id: document.getElementById('t-id'),
      gen: document.getElementById('t-gen'),
      form: document.getElementById('t-form'),
      optics: document.getElementById('t-optics'),
      gear: document.getElementById('t-gear'),
      perk: document.getElementById('t-perk'),
    };
    let current = null;
    let morph = 0;

    const show = (id) => {
      current = id;
      const t = friendTraits(id);
      nameEl.textContent = t.label;
      rarityEl.textContent = t.rarity;
      fields.id.textContent = t.id;
      fields.gen.textContent = `GEN-${t.generation}`;
      fields.form.textContent = `${t.head} / ${t.ears}`;
      fields.optics.textContent = `${t.eyes} / ${t.mouth}`;
      fields.gear.textContent = `${t.accessory} / ${t.pattern}`;
      fields.perk.textContent = t.perkText;
      drawFriend(rollCanvas, id, 100, 11);
    };

    const roll = () => {
      const id = rollFriendId(rng);
      if (reduced) { show(id); return; }
      // materialise the new Friend out of static
      morph = 0;
      const start = performance.now();
      const run = (now) => {
        const p = Math.min(1, (now - start) / 560);
        drawFriend(rollCanvas, id, Math.round(8 + p * 92), 11, { phase: Math.floor(now / 90) & 3 });
        if (p < 1) requestAnimationFrame(run);
        else show(id);
      };
      // fill in the text immediately so the labels do not lag the picture
      show(id);
      requestAnimationFrame(run);
    };

    document.getElementById('roll-btn')?.addEventListener('click', roll);
    show(rollFriendId(rng));
  }

  /* counters ------------------------------------------------------------- */
  const counters = [...document.querySelectorAll('[data-count]')];
  if (counters.length) {
    if (reduced || !('IntersectionObserver' in window)) {
      counters.forEach((el) => { el.textContent = el.dataset.count; });
    } else {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target;
          io.unobserve(el);
          const target = Number(el.dataset.count);
          const suffix = el.dataset.suffix || '';
          const start = performance.now();
          const run = (now) => {
            const p = Math.min(1, (now - start) / 900);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = Math.round(target * eased) + suffix;
            if (p < 1) requestAnimationFrame(run);
          };
          requestAnimationFrame(run);
        }
      }, { threshold: 0.5 });
      counters.forEach((el) => { el.textContent = '0' + (el.dataset.suffix || ''); io.observe(el); });
    }
  }

  /* nav ------------------------------------------------------------------ */
  const nav = document.getElementById('nav');
  const barEl = document.getElementById('scrollbar');
  const onScroll = () => {
    const y = window.scrollY;
    nav?.classList.toggle('lifted', y > 40);
    if (barEl) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      barEl.style.width = `${max > 0 ? Math.min(100, (y / max) * 100) : 0}%`;
    }
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  setupReveal();
  document.body.classList.add('booted');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
