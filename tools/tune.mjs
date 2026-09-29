// Balance harness.
//
//   node tools/tune.mjs [runs]
//
// Part 1 measures the raw automaton: how fast the arena fills with and without
// someone purging it.
// Part 2 plays whole runs with a scripted pilot at three gear levels, which is
// the number that actually matters — how long a dive lasts.

import { Rng } from '../src/core/rng.js';
import {
  createField, step, bitFlip, purgeCircle, coverage, seed, COLS, ROWS, CELL,
  genInterval, idx, ROT,
} from '../src/game/automaton.js';
import { Run, RunState, PRESSURE, FIELD_W, FIELD_H } from '../src/game/run.js';
import { derivedStats, BASE_STATS, UPGRADES, restoreTotalCost } from '../src/game/economy.js';
import { friendTraits, startingIntegrity } from '../src/game/friends.js';
import { defaultSave } from '../src/core/store.js';

const RUNS = Number(process.argv[2] || 24);
const STEP = 1 / 60;

/* ------------------------- part 1: the automaton ------------------------ */

function simulateField({ purge = false, purgeRadiusCells = 2.5, scarGens = 14, purgeEvery = 3.0, maxTime = 300 }) {
  const rng = new Rng((Math.random() * 1e9) | 0);
  const field = createField();
  for (let i = 0; i < 4; i++) seed(field, 4 + rng.int(COLS - 8), 3 + rng.int(ROWS - 6));
  let t = 0, acc = 0, nextPurge = purgeEvery, filled = null;
  const marks = {};

  while (t < maxTime) {
    t += STEP;
    const pressure = PRESSURE(t);
    acc += STEP;
    const gi = genInterval(pressure);
    while (acc >= gi) {
      acc -= gi;
      step(field, pressure, () => rng.next());
      bitFlip(field, pressure, () => rng.next());
    }
    if (purge && t >= nextPurge) {
      nextPurge = t + purgeEvery;
      let bestI = -1, best = -1;
      for (let k = 0; k < 40; k++) {
        const x = 2 + rng.int(COLS - 4);
        const y = 2 + rng.int(ROWS - 4);
        let c = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= COLS || yy >= ROWS) continue;
          if (field.cells[yy * COLS + xx] === ROT) c++;
        }
        if (c > best) { best = c; bestI = y * COLS + x; }
      }
      if (bestI >= 0) purgeCircle(field, (bestI % COLS) + 0.5, ((bestI / COLS) | 0) + 0.5, purgeRadiusCells, scarGens);
    }
    const cov = coverage(field) * 100;
    for (const m of [10, 25, 50, 70]) if (marks[m] === undefined && cov >= m) marks[m] = t;
    if (filled === null && cov > 86) { filled = t; break; }
  }
  return { marks, filled: filled ?? maxTime };
}

function reportField(label, opts) {
  const rows = Array.from({ length: RUNS }, () => simulateField(opts));
  const at = (m) => {
    const vals = rows.map((r) => r.marks[m]).filter((v) => v !== undefined);
    return vals.length ? (vals.reduce((a, b) => a + b) / vals.length).toFixed(1) : '  -  ';
  };
  const filled = (rows.reduce((s, r) => s + r.filled, 0) / rows.length).toFixed(1);
  console.log(
    label.padEnd(30),
    '10%:', String(at(10)).padStart(6),
    '25%:', String(at(25)).padStart(6),
    '50%:', String(at(50)).padStart(6),
    '70%:', String(at(70)).padStart(6),
    '86%:', filled.padStart(6),
  );
}

/* --------------------------- part 2: full runs -------------------------- */

/**
 * A scripted pilot: runs toward the most valuable reachable pickup, steers away
 * from rot, purges when the rot gets close and dashes to break out.
 */
function pilot(run) {
  const cellOf = (px, py) => ({ x: Math.floor(px / CELL), y: Math.floor(py / CELL) });
  const rotNear = (px, py, radius) => {
    const c = cellOf(px, py);
    let n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = c.x + dx, y = c.y + dy;
        if (x < 1 || y < 1 || x >= COLS - 1 || y >= ROWS - 1) { n += 0.5; continue; }
        if (run.field.cells[idx(x, y)] === ROT) n++;
      }
    }
    return n;
  };

  // pick a goal
  let goal = run.defrag || run.capsule;
  if (!goal && run.shards.length) {
    goal = run.shards.reduce((best, s) => {
      const d = Math.hypot(s.x - run.x, s.y - run.y);
      return !best || d < best.d ? { ...s, d } : best;
    }, null);
  }

  // candidate directions, scored by danger then by progress toward the goal
  let bestDir = { x: 0, y: 0 };
  let bestScore = -Infinity;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const probeX = Math.max(CELL, Math.min(FIELD_W - CELL, run.x + dx * 26));
    const probeY = Math.max(CELL, Math.min(FIELD_H - CELL, run.y + dy * 26));
    const danger = rotNear(probeX, probeY, 2);
    let score = -danger * 3;
    if (goal) {
      const gx = goal.x - run.x, gy = goal.y - run.y;
      const len = Math.hypot(gx, gy) || 1;
      score += (dx * gx + dy * gy) / len * 2.2;
    }
    if (score > bestScore) { bestScore = score; bestDir = { x: dx, y: dy }; }
  }

  const pressureHere = rotNear(run.x, run.y, 2);
  return {
    ax: bestDir.x,
    ay: bestDir.y,
    purge: pressureHere >= 4 && run.energy >= run.purgeCost,
    dash: pressureHere >= 9 && run.dashCd <= 0,
  };
}

function playRun(stats, seedValue) {
  const run = new Run({ stats, seed: seedValue });
  let guard = 0;
  while (run.state === RunState.PLAYING && guard++ < 60 * 1200) {
    run.update(STEP, pilot(run));
    run.drainEvents();
  }
  return run.result();
}

function saveWithLevels(levels) {
  const save = defaultSave();
  for (const def of UPGRADES) save.upgrades[def.id] = Math.min(levels, def.costs.length);
  return save;
}

const perRunOut = {};
function reportRuns(label, stats) {
  const results = [];
  for (let i = 0; i < RUNS; i++) results.push(playRun(stats, 1000 + i * 37));
  const avg = (fn) => results.reduce((s, r) => s + fn(r), 0) / results.length;
  const sorted = results.map((r) => r.time).sort((a, b) => a - b);
  console.log(
    label.padEnd(30),
    'time', avg((r) => r.time).toFixed(1).padStart(6),
    ' med', sorted[Math.floor(sorted.length / 2)].toFixed(1).padStart(6),
    ' max', sorted[sorted.length - 1].toFixed(1).padStart(6),
    ' shards', avg((r) => r.shards).toFixed(1).padStart(5),
    ' friends', avg((r) => r.rescues).toFixed(2).padStart(5),
    ' defrag', avg((r) => r.defrags).toFixed(2).padStart(5),
    ' RF', avg((r) => r.rf).toFixed(0).padStart(5),
    ' score', avg((r) => r.score).toFixed(0).padStart(6),
  );
  const rf = avg((r) => r.rf);
  if (label.includes('no upgrades')) perRunOut.early = rf;
  else if (label.includes('lv2')) perRunOut.mid = rf;
  else perRunOut.late = rf;
  return perRunOut;
}

console.log(`\n--- arena fill, seconds to reach coverage (${RUNS} runs) ---\n`);
reportField('no player', { purge: false });
reportField('purge r2.5 / 3.0s', { purge: true, purgeRadiusCells: 2.5, purgeEvery: 3.0 });
reportField('purge r4.0 / 2.2s (maxed)', { purge: true, purgeRadiusCells: 4.0, scarGens: 30, purgeEvery: 2.2 });

console.log(`\n--- scripted pilot, full runs (${RUNS} runs) ---\n`);
reportRuns('no upgrades', derivedStats(defaultSave()));
reportRuns('all upgrades lv2', derivedStats(saveWithLevels(2)));
const perRun = reportRuns('fully upgraded', derivedStats(saveWithLevels(9)));

/* --------------------- part 3: how long things take --------------------- */

console.log(`
--- what a restoration costs, in runs ---
`);
const examples = {};
for (let i = 1; i < 200000 && Object.keys(examples).length < 4; i++) {
  const id = i.toString(16).toUpperCase().padStart(6, '0');
  const t = friendTraits(id);
  if (!examples[t.rarity]) examples[t.rarity] = id;
}
const earn = { early: perRun.early, mid: perRun.mid, late: perRun.late };
console.log('RF per run:  early', earn.early.toFixed(0), ' mid', earn.mid.toFixed(0), ' late', earn.late.toFixed(0));
for (const r of ['COMMON', 'RARE', 'EPIC', 'GENESIS']) {
  const id = examples[r];
  const total = restoreTotalCost({ id, integrity: startingIntegrity(id) });
  console.log(
    r.padEnd(8), 'restore', String(total).padStart(5), 'RF',
    ' = ', (total / earn.early).toFixed(1).padStart(5), 'early runs',
    ' / ', (total / earn.late).toFixed(1).padStart(5), 'late runs',
  );
}
const gear = UPGRADES.reduce((n, d) => n + d.costs.reduce((a, b) => a + b, 0), 0);
console.log('ALL GEAR restore', String(gear).padStart(5), 'RF',
  ' = ', (gear / earn.early).toFixed(1).padStart(5), 'early runs',
  ' / ', (gear / earn.late).toFixed(1).padStart(5), 'late runs');
console.log('');
