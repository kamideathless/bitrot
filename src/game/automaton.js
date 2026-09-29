// The rot field: a probabilistic growth automaton on a 40x23 grid.
//
// A clean cell becomes rotten with a probability that rises steeply with the
// number of rotten neighbours, so blobs stay round-ish and concavities close
// fast, while open ground is only threatened slowly. Rot never dies on its
// own — the only thing that removes it is the player. That single asymmetry is
// what turns the arena into something you have to garden.
//
// The module is pure data + functions: no canvas, no DOM, fully unit-testable.

export const CLEAN = 0;
export const ROT = 1;
export const WALL = 2;

export const COLS = 40;
export const ROWS = 23;
export const CELL = 12;

export const CONFIG = {
  // birth chance per generation, indexed by rotten-neighbour count 0..8
  birth: [0, 0.005, 0.009, 0.017, 0.034, 0.078, 0.175, 0.38, 0.78],
  // pressure scales the whole table: 0 -> calm, 1 -> late-run
  pressureLo: 0.5,
  pressureHi: 2.6,
  // spontaneous bit flips (new seeds) per generation
  flipLo: 0.006,
  flipHi: 0.055,
  // generation length in seconds
  genLo: 0.22,
  genHi: 0.12,
};

export function lerp(a, b, t) { return a + (b - a) * t; }

export const PRESSURE_CAP = 2.6;

export function genInterval(pressure) {
  return lerp(CONFIG.genLo, CONFIG.genHi, Math.min(1, clampP(pressure)));
}

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Pressure may overshoot 1 in very long runs; it is capped, not clamped. */
export function clampP(v) { return v < 0 ? 0 : v > PRESSURE_CAP ? PRESSURE_CAP : v; }

export function idx(x, y) { return y * COLS + x; }

export function inBounds(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; }

export function createField() {
  const cells = new Uint8Array(COLS * ROWS);
  const age = new Uint8Array(COLS * ROWS);
  const scar = new Uint8Array(COLS * ROWS);
  for (let x = 0; x < COLS; x++) {
    cells[idx(x, 0)] = WALL;
    cells[idx(x, ROWS - 1)] = WALL;
  }
  for (let y = 0; y < ROWS; y++) {
    cells[idx(0, y)] = WALL;
    cells[idx(COLS - 1, y)] = WALL;
  }
  return { cells, age, scar, gen: 0, playable: countPlayable(cells) };
}

function countPlayable(cells) {
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] !== WALL) n++;
  return n;
}

export function neighbourCount(cells, x, y) {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= ROWS) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const xx = x + dx;
      if (xx < 0 || xx >= COLS) continue;
      if (cells[yy * COLS + xx] === ROT) n++;
    }
  }
  return n;
}

/** Force a cell to rot (ignores scars). Returns true if it changed. */
export function seed(field, x, y) {
  if (!inBounds(x, y)) return false;
  const i = idx(x, y);
  if (field.cells[i] !== CLEAN) return false;
  field.cells[i] = ROT;
  field.age[i] = 0;
  field.scar[i] = 0;
  return true;
}

/**
 * Advance the field by one generation.
 * `pressure` is 0..1. `rand` is a () => [0,1) function.
 * Returns the number of newly rotten cells.
 */
export function step(field, pressure, rand) {
  const p = clampP(pressure);
  const mult = lerp(CONFIG.pressureLo, CONFIG.pressureHi, p);
  const { cells, age, scar } = field;
  const next = cells.slice();
  let born = 0;

  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      const i = y * COLS + x;
      const c = cells[i];
      if (c === WALL) continue;
      if (c === ROT) {
        if (age[i] < 255) age[i]++;
        continue;
      }
      if (scar[i] > 0) { scar[i]--; continue; }
      const n = neighbourCount(cells, x, y);
      if (n === 0) continue;
      const chance = Math.min(0.97, CONFIG.birth[n] * mult);
      if (rand() < chance) {
        next[i] = ROT;
        age[i] = 0;
        born++;
      }
    }
  }

  field.cells.set(next);
  field.gen++;
  return born;
}

/** Spontaneous corruption: sprinkle new seeds in open ground. */
export function bitFlip(field, pressure, rand, avoid = null, avoidR = 3) {
  const rate = lerp(CONFIG.flipLo, CONFIG.flipHi, clampP(pressure));
  if (rand() >= rate) return false;
  for (let tries = 0; tries < 24; tries++) {
    const x = 1 + Math.floor(rand() * (COLS - 2));
    const y = 1 + Math.floor(rand() * (ROWS - 2));
    const i = idx(x, y);
    if (field.cells[i] !== CLEAN || field.scar[i] > 0) continue;
    if (avoid) {
      const dx = x - avoid.x, dy = y - avoid.y;
      if (dx * dx + dy * dy < avoidR * avoidR) continue;
    }
    field.cells[i] = ROT;
    field.age[i] = 0;
    return true;
  }
  return false;
}

/**
 * Clear rot inside a circle (cell coordinates, radius in cells) and scar it.
 * Returns the number of cells cleared.
 */
export function purgeCircle(field, cx, cy, radius, scarGens) {
  const r2 = radius * radius;
  let cleared = 0;
  const x0 = Math.max(1, Math.floor(cx - radius));
  const x1 = Math.min(COLS - 2, Math.ceil(cx + radius));
  const y0 = Math.max(1, Math.floor(cy - radius));
  const y1 = Math.min(ROWS - 2, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = y * COLS + x;
      if (field.cells[i] === WALL) continue;
      if (field.cells[i] === ROT) { cleared++; field.cells[i] = CLEAN; }
      field.age[i] = 0;
      field.scar[i] = Math.max(field.scar[i], scarGens);
    }
  }
  return cleared;
}

/** Full defrag: wipe every rotten cell. Returns how many were removed. */
export function defrag(field, scarGens = 6) {
  let cleared = 0;
  for (let i = 0; i < field.cells.length; i++) {
    if (field.cells[i] === ROT) { field.cells[i] = CLEAN; cleared++; }
    if (field.cells[i] === CLEAN) {
      field.age[i] = 0;
      field.scar[i] = Math.max(field.scar[i], scarGens);
    }
  }
  return cleared;
}

export function rotCount(field) {
  let n = 0;
  for (let i = 0; i < field.cells.length; i++) if (field.cells[i] === ROT) n++;
  return n;
}

export function coverage(field) {
  return rotCount(field) / field.playable;
}

export function isRot(field, x, y) {
  if (!inBounds(x, y)) return true;
  return field.cells[idx(x, y)] === ROT;
}

export function isBlocked(field, x, y) {
  if (!inBounds(x, y)) return true;
  const c = field.cells[idx(x, y)];
  return c === WALL;
}

/** Collect every clean, unoccupied cell — used for spawning pickups. */
export function cleanCells(field, out = []) {
  out.length = 0;
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (field.cells[y * COLS + x] === CLEAN) out.push(y * COLS + x);
    }
  }
  return out;
}

/**
 * Distance (in cells) from (x,y) to the nearest rot, capped at `cap`.
 * Used to place pickups somewhere that is actually survivable, and to place
 * DEFRAG canisters somewhere that very much is not.
 */
export function distanceToRot(field, x, y, cap = 6) {
  for (let r = 1; r <= cap; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = x + dx, yy = y + dy;
        if (!inBounds(xx, yy)) continue;
        if (field.cells[idx(xx, yy)] === ROT) return r;
      }
    }
  }
  return cap + 1;
}
