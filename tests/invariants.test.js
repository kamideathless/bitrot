// Adversarial play. Pilots here are not trying to score — they are trying to
// find a way to break the dive: a corner the rot cannot reach, an input that
// stalls the simulation, a loop that makes the player unkillable.
//
// Every frame is checked against the invariants the rest of the game assumes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Run, RunState, TUNING, FIELD_W, FIELD_H } from '../src/game/run.js';
import { derivedStats, UPGRADES } from '../src/game/economy.js';
import { defaultSave } from '../src/core/store.js';
import { COLS, ROWS, CELL, WALL, ROT, idx } from '../src/game/automaton.js';
import { isValidId } from '../src/game/friends.js';
import { quantiseIntent } from '../src/game/trace.js';

const STEP = 1 / 60;

function statsFor(level = 0) {
  const save = defaultSave();
  for (const def of UPGRADES) save.upgrades[def.id] = Math.min(level, def.costs.length);
  return derivedStats(save);
}

/** Throws the moment anything the game relies on stops being true. */
function checkInvariants(run, stats, where) {
  const finite = (v, name) => assert.ok(Number.isFinite(v), `${where}: ${name} is ${v}`);
  finite(run.x, 'x'); finite(run.y, 'y');
  finite(run.energy, 'energy'); finite(run.time, 'time');

  assert.ok(run.x >= CELL - 0.001 && run.x <= FIELD_W - CELL + 0.001, `${where}: x escaped (${run.x})`);
  assert.ok(run.y >= CELL - 0.001 && run.y <= FIELD_H - CELL + 0.001, `${where}: y escaped (${run.y})`);
  assert.ok(run.hp >= 0 && run.hp <= run.maxHp, `${where}: hp is ${run.hp}/${run.maxHp}`);
  assert.ok(run.energy >= -0.001 && run.energy <= stats.energyMax + 0.001,
    `${where}: energy is ${run.energy}/${stats.energyMax}`);
  assert.ok(run.sector >= 1 && run.sector < 200, `${where}: sector is ${run.sector}`);

  for (const k of Object.keys(run.counters)) {
    assert.ok(Number.isInteger(run.counters[k]) && run.counters[k] >= 0,
      `${where}: counter ${k} is ${run.counters[k]}`);
  }

  // pickups must never sit in a wall
  for (const sh of run.shards) {
    assert.notEqual(run.field.cells[idx(sh.cx, sh.cy)], WALL, `${where}: shard inside a wall`);
    assert.ok(sh.cx > 0 && sh.cx < COLS - 1 && sh.cy > 0 && sh.cy < ROWS - 1, `${where}: shard out of bounds`);
  }
  for (const thing of [run.capsule, run.defrag]) {
    if (!thing) continue;
    assert.notEqual(run.field.cells[idx(thing.cx, thing.cy)], WALL, `${where}: pickup inside a wall`);
  }
  for (const id of run.rescued) assert.ok(isValidId(id), `${where}: bogus rescued id ${id}`);
}

/** Play out a dive with a pilot, checking invariants on every single frame. */
function stress(pilot, { seed, stats, maxSeconds = 900, label = 'run' }) {
  const run = new Run({ stats, seed });
  const limit = Math.round(maxSeconds / STEP);
  let i = 0;
  while (run.state === RunState.PLAYING && i < limit) {
    run.update(STEP, quantiseIntent(pilot(run, i)));
    run.drainEvents();
    checkInvariants(run, stats, `${label} @${run.time.toFixed(1)}s`);
    i++;
  }
  return run;
}

/* ------------------------------------------------------------ pilots -- */

const idle = () => ({ ax: 0, ay: 0 });

/** Sit in a corner and purge on cooldown — the classic turtle. */
const corner = (corner) => (run) => {
  const tx = corner.x * FIELD_W, ty = corner.y * FIELD_H;
  const dx = tx - run.x, dy = ty - run.y;
  const d = Math.hypot(dx, dy) || 1;
  return { ax: d > 4 ? dx / d : 0, ay: d > 4 ? dy / d : 0, purge: true };
};

/** Mash every button every frame. */
const masher = (run, i) => ({
  ax: Math.sin(i * 1.7), ay: Math.cos(i * 2.3), purge: true, dash: true,
});

/** Try to live inside dash invulnerability. */
const dashLoop = (run, i) => ({ ax: 1, ay: Math.sin(i * 0.1), purge: false, dash: true });

/** Inputs a hostile client might send rather than a person. */
const hostile = (run, i) => ({
  ax: [0, 1, -1, 1e9, -1e9, NaN, undefined][i % 7],
  ay: [0, -1, 1, NaN, 1e9, null, 0][i % 7],
  purge: i % 3 === 0,
  dash: i % 5 === 0,
});

/* -------------------------------------------------------------- tests -- */

test('idling in the open is always fatal, at every gear level', () => {
  for (const level of [0, 2, 4]) {
    const stats = statsFor(level);
    for (const seed of [1, 4242, 90210]) {
      const run = stress(idle, { seed, stats, label: `idle lv${level} seed${seed}` });
      assert.equal(run.state, RunState.OVER,
        `lv${level} seed${seed}: still alive after ${run.time.toFixed(0)}s of standing still`);
    }
  }
});

test('camping a corner and purging does not make you immortal', () => {
  const corners = [
    { x: 0.04, y: 0.05 }, { x: 0.96, y: 0.05 },
    { x: 0.04, y: 0.95 }, { x: 0.96, y: 0.95 },
    { x: 0.5, y: 0.5 },
  ];
  const stats = statsFor(4);            // fully geared, the best case for a camper
  for (const c of corners) {
    const run = stress(corner(c), { seed: 777, stats, maxSeconds: 900, label: `corner ${c.x},${c.y}` });
    assert.equal(run.state, RunState.OVER,
      `camping ${c.x},${c.y} survived past 900s (reached ${run.time.toFixed(0)}s)`);
  }
});

test('mashing every button does not break or immortalise the dive', () => {
  const stats = statsFor(4);
  for (const seed of [5, 555, 55555]) {
    const run = stress(masher, { seed, stats, label: `masher seed${seed}` });
    assert.equal(run.state, RunState.OVER, `masher seed${seed} never died`);
    assert.ok(run.counters.purges > 0);
  }
});

test('dash invulnerability cannot be chained into immortality', () => {
  const stats = statsFor(4);
  const run = stress(dashLoop, { seed: 31337, stats, label: 'dash loop' });
  assert.equal(run.state, RunState.OVER, `dash looping survived ${run.time.toFixed(0)}s`);
  // i-frames must have gaps: dash lasts 0.16s on a cooldown of at least 0.35s
  assert.ok(stats.dashCooldown > TUNING.dashSeconds + 0.1,
    'the dash cooldown is short enough to cover its own invulnerability');
});

test('hostile, non-finite inputs cannot move the player or stall the sim', () => {
  const stats = statsFor(2);
  const run = stress(hostile, { seed: 8080, stats, label: 'hostile' });
  assert.equal(run.state, RunState.OVER);
  assert.ok(run.time > 1, 'the run ended instantly');
});

test('the arena wall is never breached, whatever happens', () => {
  const stats = statsFor(4);
  const run = stress(masher, { seed: 4040, stats, maxSeconds: 400, label: 'wall check' });
  for (let x = 0; x < COLS; x++) {
    assert.equal(run.field.cells[idx(x, 0)], WALL, `top wall breached at ${x}`);
    assert.equal(run.field.cells[idx(x, ROWS - 1)], WALL, `bottom wall breached at ${x}`);
  }
  for (let y = 0; y < ROWS; y++) {
    assert.equal(run.field.cells[idx(0, y)], WALL, `left wall breached at ${y}`);
    assert.equal(run.field.cells[idx(COLS - 1, y)], WALL, `right wall breached at ${y}`);
  }
});

test('no cell in the arena is permanently safe from the rot', () => {
  // Over a long dive with nobody purging, every playable cell should be
  // reachable by the rot at some point. A cell that never rots is a dead spot
  // a player could park on forever.
  const stats = statsFor(0);
  const run = new Run({ stats, seed: 12345 });
  const everRotted = new Uint8Array(COLS * ROWS);
  run.hp = 9999;                                   // observe the board, not the player
  run.maxHp = 9999;
  for (let i = 0; i < Math.round(600 / STEP); i++) {
    run.update(STEP, { ax: 0, ay: 0 });
    run.drainEvents();
    for (let k = 0; k < run.field.cells.length; k++) {
      if (run.field.cells[k] === ROT) everRotted[k] = 1;
    }
  }
  const missed = [];
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (!everRotted[idx(x, y)]) missed.push(`${x},${y}`);
    }
  }
  // the spawn pocket is scarred at the start, so allow a small number
  assert.ok(missed.length < 12,
    `${missed.length} cells never rotted in 600s: ${missed.slice(0, 12).join(' ')}`);
});

test('a dive always terminates inside the submittable window', () => {
  // if a dive could run past the trace ceiling, client and server would
  // disagree about the result
  const stats = statsFor(4);
  for (const seed of [11, 22, 33, 44]) {
    const run = stress(corner({ x: 0.5, y: 0.5 }), { seed, stats, maxSeconds: 900, label: `cap seed${seed}` });
    assert.equal(run.state, RunState.OVER);
    assert.ok(run.time < 600,
      `seed ${seed} lasted ${run.time.toFixed(0)}s, past the 600s trace ceiling`);
  }
});

test('rescues can never push integrity above the maximum', () => {
  const stats = statsFor(4);
  const run = new Run({ stats, seed: 606 });
  for (let i = 0; i < Math.round(200 / STEP) && run.state === RunState.PLAYING; i++) {
    // chase capsules specifically, to bank as many heals as possible
    const target = run.capsule || run.shards[0];
    let intent = { ax: 0, ay: 0, purge: i % 40 === 0 };
    if (target) {
      const dx = target.x - run.x, dy = target.y - run.y;
      const d = Math.hypot(dx, dy) || 1;
      intent = { ax: dx / d, ay: dy / d, purge: i % 25 === 0 };
    }
    run.update(STEP, quantiseIntent(intent));
    run.drainEvents();
    assert.ok(run.hp <= run.maxHp, `hp ${run.hp} exceeded max ${run.maxHp}`);
  }
});

test('the same inputs always produce the same dive, however chaotic', () => {
  const stats = statsFor(3);
  const a = stress(masher, { seed: 999, stats, maxSeconds: 200, label: 'determinism a' });
  const b = stress(masher, { seed: 999, stats, maxSeconds: 200, label: 'determinism b' });
  assert.equal(a.time.toFixed(6), b.time.toFixed(6));
  assert.deepEqual(a.counters, b.counters);
  assert.deepEqual(a.rescued, b.rescued);
  assert.equal(a.x.toFixed(6), b.x.toFixed(6));
});

test('a dive that reaches the trace ceiling ends there, so client and server agree', async () => {
  const { TraceRecorder, MAX_TICKS } = await import('../src/game/trace.js');
  const rec = new TraceRecorder();
  const run = new Run({ stats: statsFor(4), seed: 4141 });
  run.hp = 99999;                      // an unkillable player, to reach the cap
  run.maxHp = 99999;

  let ended = false;
  for (let i = 0; i < MAX_TICKS + 600; i++) {
    if (run.state !== RunState.PLAYING) break;
    const q = quantiseIntent({ ax: 0, ay: 0 });
    rec.push(q.code);
    run.update(STEP, q);
    run.drainEvents();
    if (rec.overflowed) { ended = run.end('trace_full'); break; }
  }
  assert.ok(rec.ticks <= MAX_TICKS, 'the recorder went past its ceiling');
  assert.equal(run.state, RunState.OVER, 'the dive kept going past the recordable window');
  assert.ok(ended, 'the dive was not ended by the recorder filling up');
});
