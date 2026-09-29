import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/core/rng.js';
import {
  createField, step, purgeCircle, defrag, seed, neighbourCount, coverage,
  rotCount, cleanCells, distanceToRot, idx, COLS, ROWS, WALL, ROT, CLEAN,
  genInterval, CONFIG, clampP, PRESSURE_CAP,
} from '../src/game/automaton.js';

test('a fresh field is walled and otherwise clean', () => {
  const f = createField();
  assert.equal(f.cells.length, COLS * ROWS);
  for (let x = 0; x < COLS; x++) {
    assert.equal(f.cells[idx(x, 0)], WALL);
    assert.equal(f.cells[idx(x, ROWS - 1)], WALL);
  }
  for (let y = 0; y < ROWS; y++) {
    assert.equal(f.cells[idx(0, y)], WALL);
    assert.equal(f.cells[idx(COLS - 1, y)], WALL);
  }
  assert.equal(rotCount(f), 0);
  assert.equal(f.playable, (COLS - 2) * (ROWS - 2));
});

test('neighbourCount only counts rot, never walls', () => {
  const f = createField();
  assert.equal(neighbourCount(f.cells, 1, 1), 0, 'corner cell sees no wall neighbours');
  seed(f, 2, 2);
  seed(f, 2, 1);
  assert.equal(neighbourCount(f.cells, 1, 1), 2);
});

test('rot never disappears on its own', () => {
  const rng = new Rng(7);
  const f = createField();
  for (let i = 0; i < 6; i++) seed(f, 4 + rng.int(30), 4 + rng.int(14));
  let prev = rotCount(f);
  for (let g = 0; g < 200; g++) {
    step(f, 0.5, () => rng.next());
    const now = rotCount(f);
    assert.ok(now >= prev, `generation ${g}: rot shrank from ${prev} to ${now}`);
    prev = now;
  }
  assert.ok(prev > 6, 'rot should have grown at all');
});

test('a walled-in field never rots the border and coverage stays in range', () => {
  const rng = new Rng(11);
  const f = createField();
  seed(f, 20, 11);
  for (let g = 0; g < 600; g++) step(f, 1, () => rng.next());
  for (let x = 0; x < COLS; x++) {
    assert.equal(f.cells[idx(x, 0)], WALL);
    assert.equal(f.cells[idx(x, ROWS - 1)], WALL);
  }
  const c = coverage(f);
  assert.ok(c > 0 && c <= 1, `coverage out of range: ${c}`);
});

test('purgeCircle clears rot and leaves a scar that blocks rebirth', () => {
  const rng = new Rng(3);
  const f = createField();
  for (let y = 5; y < 16; y++) for (let x = 5; x < 30; x++) seed(f, x, y);
  const before = rotCount(f);
  const cleared = purgeCircle(f, 12, 10, 3, 20);
  assert.ok(cleared > 0);
  assert.equal(rotCount(f), before - cleared);
  assert.ok(f.scar[idx(12, 10)] > 0);

  // with a scar in place the centre cannot come back for a while
  for (let g = 0; g < 10; g++) step(f, 1, () => rng.next());
  assert.equal(f.cells[idx(12, 10)], CLEAN, 'scarred cell rotted before the scar expired');
});

test('scars expire and the ground becomes vulnerable again', () => {
  const rng = new Rng(5);
  const f = createField();
  for (let y = 4; y < 18; y++) for (let x = 4; x < 34; x++) seed(f, x, y);
  purgeCircle(f, 18, 11, 2, 3);
  let rotted = false;
  for (let g = 0; g < 400 && !rotted; g++) {
    step(f, 1.5, () => rng.next());
    rotted = f.cells[idx(18, 11)] === ROT;
  }
  assert.ok(rotted, 'cell never rotted again after a short scar');
});

test('purge never eats the wall ring', () => {
  const f = createField();
  purgeCircle(f, 0, 0, 8, 10);
  assert.equal(f.cells[idx(0, 0)], WALL);
  assert.equal(f.cells[idx(1, 0)], WALL);
});

test('defrag wipes everything and scars the board', () => {
  const rng = new Rng(9);
  const f = createField();
  for (let i = 0; i < 10; i++) seed(f, 3 + rng.int(33), 3 + rng.int(16));
  for (let g = 0; g < 60; g++) step(f, 1, () => rng.next());
  assert.ok(rotCount(f) > 0);
  const cleared = defrag(f, 6);
  assert.equal(rotCount(f), 0);
  assert.ok(cleared > 0);
  assert.ok(f.scar[idx(20, 11)] > 0);
});

test('generation interval shortens with pressure and is capped', () => {
  assert.ok(genInterval(0) > genInterval(1));
  assert.equal(genInterval(1), genInterval(5), 'gen interval should stop shrinking past pressure 1');
  assert.equal(clampP(99), PRESSURE_CAP);
  assert.equal(clampP(-5), 0);
});

test('birth chances rise monotonically with neighbour count', () => {
  for (let n = 1; n < 8; n++) {
    assert.ok(CONFIG.birth[n + 1] > CONFIG.birth[n], `birth[${n + 1}] should exceed birth[${n}]`);
  }
});

test('cleanCells and distanceToRot agree with the grid', () => {
  const f = createField();
  seed(f, 10, 10);
  const clean = cleanCells(f);
  assert.equal(clean.length, f.playable - 1);
  assert.ok(!clean.includes(idx(10, 10)));
  assert.equal(distanceToRot(f, 10, 10, 6), 6 + 1, 'the rot cell itself is not its own neighbour');
  assert.equal(distanceToRot(f, 11, 10, 6), 1);
  assert.equal(distanceToRot(f, 13, 10, 6), 3);
  assert.equal(distanceToRot(f, 30, 5, 4), 5, 'capped when nothing is near');
});

test('seed() refuses walls and cells that are already rotten', () => {
  const f = createField();
  assert.equal(seed(f, 0, 0), false);
  assert.equal(seed(f, 5, 5), true);
  assert.equal(seed(f, 5, 5), false);
  assert.equal(seed(f, -1, 5), false);
  assert.equal(seed(f, 999, 5), false);
});
