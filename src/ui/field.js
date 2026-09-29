// Renders the rot field. Age drives dither density, so young rot looks like
// thin static and old rot like solid black — the arena visibly ages.

import { INK, PAPER } from '../core/gfx.js';
import { COLS, ROWS, CELL, ROT, WALL, CLEAN } from '../game/automaton.js';

const AGE_LEVELS = [5, 7, 9, 11, 13, 14, 15, 16];

function levelForAge(age) {
  const i = age < 2 ? 0 : age < 4 ? 1 : age < 6 ? 2 : age < 9 ? 3 : age < 13 ? 4 : age < 18 ? 5 : age < 26 ? 6 : 7;
  return AGE_LEVELS[i];
}

/**
 * @param {Gfx} g
 * @param {object} field
 * @param {number} ox,oy  top-left of the playfield in logical pixels
 * @param {object} opts   { phase, showScars }
 */
export function drawField(g, field, ox, oy, opts = {}) {
  const { phase = 0, showScars = true } = opts;
  const { cells, age, scar } = field;

  for (let y = 0; y < ROWS; y++) {
    const py = oy + y * CELL;
    for (let x = 0; x < COLS; x++) {
      const i = y * COLS + x;
      const c = cells[i];
      const px = ox + x * CELL;
      if (c === WALL) {
        g.rect(px, py, CELL, CELL, INK);
        continue;
      }
      if (c === ROT) {
        g.dither(px, py, CELL, CELL, levelForAge(age[i]), INK, phase);
        continue;
      }
      if (showScars && scar[i] > 0) {
        g.dither(px + 4, py + 4, 4, 4, 2, INK, 2);
      }
    }
  }

  // crisp edges: any rot cell facing clean ground gets a hard 1px border
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      const i = y * COLS + x;
      if (cells[i] !== ROT) continue;
      const px = ox + x * CELL;
      const py = oy + y * CELL;
      if (cells[i - COLS] === CLEAN) g.rect(px, py, CELL, 1, INK);
      if (cells[i + COLS] === CLEAN) g.rect(px, py + CELL - 1, CELL, 1, INK);
      if (cells[i - 1] === CLEAN) g.rect(px, py, 1, CELL, INK);
      if (cells[i + 1] === CLEAN) g.rect(px + CELL - 1, py, 1, CELL, INK);
    }
  }

  // inner highlight on the wall ring so the arena reads as a container
  g.frame(ox + CELL - 1, oy + CELL - 1, (COLS - 2) * CELL + 2, (ROWS - 2) * CELL + 2, PAPER);
}
