import test from 'node:test';
import assert from 'node:assert/strict';
import { Run, RunState, TUNING, FIELD_W, FIELD_H, PRESSURE } from '../src/game/run.js';
import { derivedStats } from '../src/game/economy.js';
import { defaultSave } from '../src/core/store.js';
import { CELL, COLS, ROWS, idx, ROT, rotCount } from '../src/game/automaton.js';
import { isValidId } from '../src/game/friends.js';

const STEP = 1 / 60;
const stats = () => derivedStats(defaultSave());

function drive(run, seconds, pilot) {
  const events = [];
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i++) {
    if (run.state !== RunState.PLAYING) break;
    run.update(STEP, pilot ? pilot(run, i) : { ax: 0, ay: 0 });
    events.push(...run.drainEvents());
  }
  return events;
}

test('a run starts in a breathable pocket', () => {
  const run = new Run({ stats: stats(), seed: 42 });
  const c = run.playerCell();
  assert.equal(run.field.cells[idx(c.x, c.y)], 0);
  assert.equal(run.hp, stats().maxHp);
  assert.equal(run.shards.length, TUNING.shardTarget);
  assert.ok(rotCount(run.field) >= TUNING.startSeeds - 1);
});

test('the player can never leave the arena', () => {
  const run = new Run({ stats: stats(), seed: 7 });
  drive(run, 30, (r, i) => ({
    ax: Math.sin(i * 0.07) > 0 ? 1 : -1,
    ay: Math.cos(i * 0.031) > 0 ? 1 : -1,
    purge: false, dash: i % 97 === 0,
  }));
  assert.ok(run.x >= CELL && run.x <= FIELD_W - CELL, `x out of bounds: ${run.x}`);
  assert.ok(run.y >= CELL && run.y <= FIELD_H - CELL, `y out of bounds: ${run.y}`);
});

test('standing still in the open eventually kills you', () => {
  const run = new Run({ stats: stats(), seed: 1234 });
  drive(run, 400, () => ({ ax: 0, ay: 0 }));
  assert.equal(run.state, RunState.OVER);
  assert.equal(run.hp, 0);
  assert.ok(run.time > 20, 'death came suspiciously fast');
  assert.ok(run.time < 400, 'the rot never reached an idle player');
});

test('purging costs energy, clears rot and respects the cooldown', () => {
  const s = stats();
  const run = new Run({ stats: s, seed: 88 });
  // let some rot build up first
  drive(run, 25, () => ({ ax: 0, ay: 0, purge: false }));
  run.energy = s.energyMax;
  run.purgeCd = 0;
  const before = run.energy;
  run.update(STEP, { ax: 0, ay: 0, purge: true });
  assert.ok(run.energy < before, 'purge did not spend energy');
  const purges = run.counters.purges;
  run.update(STEP, { ax: 0, ay: 0, purge: true });
  assert.equal(run.counters.purges, purges, 'cooldown did not block the second purge');
});

test('purge is refused when the cell is empty', () => {
  const run = new Run({ stats: stats(), seed: 5 });
  run.energy = 0;
  run.update(STEP, { ax: 0, ay: 0, purge: true });
  const events = run.drainEvents();
  assert.ok(events.some((e) => e.type === 'purgeFail'));
  assert.equal(run.counters.purges, 0);
});

test('purging buys you time (same seed, same position, only purging differs)', () => {
  const quiet = new Run({ stats: stats(), seed: 2024 });
  drive(quiet, 400, () => ({ ax: 0, ay: 0 }));

  const purger = new Run({ stats: stats(), seed: 2024 });
  drive(purger, 400, (r, i) => ({ ax: 0, ay: 0, purge: i % 40 === 0 }));

  assert.ok(purger.time > quiet.time * 1.2,
    `purger ${purger.time.toFixed(1)}s vs quiet ${quiet.time.toFixed(1)}s`);
  assert.ok(purger.counters.purges > 10);
});

test('a bigger purge radius keeps you alive longer than the base one', () => {
  const base = stats();
  const buffed = { ...base, purgeRadius: base.purgeRadius + 18, scarGens: base.scarGens + 10 };
  const pilot = (r, i) => ({ ax: 0, ay: 0, purge: i % 40 === 0 });

  const a = new Run({ stats: base, seed: 3131 });
  drive(a, 500, pilot);
  const b = new Run({ stats: buffed, seed: 3131 });
  drive(b, 500, pilot);
  assert.ok(b.time > a.time, `upgraded ${b.time.toFixed(1)}s should beat base ${a.time.toFixed(1)}s`);
});

test('shards, capsules and defrag canisters all appear within a long run', () => {
  // a well-equipped pilot, so the run certainly lasts past the first defrag
  const tough = { ...stats(), maxHp: 12, energyMax: 300, energyRegen: 40, purgeRadius: 54 };
  const run = new Run({ stats: tough, seed: 31337 });
  const events = drive(run, 120, (r, i) => {
    // chase whatever is closest
    const target = r.capsule || r.defrag || r.shards[0];
    if (!target) return { ax: 0, ay: 0, purge: true };
    const dx = target.x - r.x, dy = target.y - r.y;
    const d = Math.hypot(dx, dy) || 1;
    return { ax: dx / d, ay: dy / d, purge: true, dash: i % 150 === 0 };
  });
  assert.ok(run.time > TUNING.defragFirst, `run only lasted ${run.time.toFixed(1)}s`);
  const kinds = new Set(events.map((e) => e.type));
  assert.ok(kinds.has('shard'), 'never picked up a shard');
  assert.ok(kinds.has('capsuleSpawn'), 'no capsule ever spawned');
  assert.ok(kinds.has('defragSpawn'), 'no defrag canister ever spawned');
  assert.ok(run.counters.shards > 5, `only ${run.counters.shards} shards in 120s`);
});

test('rescued ids are valid and land in the result', () => {
  const run = new Run({ stats: stats(), seed: 777 });
  drive(run, 150, (r, i) => {
    const target = r.capsule || r.shards[0];
    if (!target) return { ax: 0, ay: 0, purge: i % 40 === 0 };
    const dx = target.x - r.x, dy = target.y - r.y;
    const d = Math.hypot(dx, dy) || 1;
    return { ax: dx / d, ay: dy / d, purge: i % 22 === 0, dash: i % 120 === 0 };
  });
  const res = run.result();
  assert.equal(res.rescued.length, res.rescues);
  for (const id of res.rescued) assert.ok(isValidId(id), `bad rescued id ${id}`);
  assert.ok(res.rescues > 0, 'a capsule-chasing pilot should rescue at least one friend in 150s');
  assert.ok(res.rf >= 0 && res.score >= 0);
  assert.ok(res.coverage >= 0 && res.coverage <= 1);
});

test('taking damage grants invulnerability and carves a pocket', () => {
  const run = new Run({ stats: stats(), seed: 4242 });
  // bury the player deliberately
  const c = run.playerCell();
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = c.x + dx, y = c.y + dy;
      if (x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1) run.field.cells[idx(x, y)] = ROT;
    }
  }
  const hp = run.hp;
  run.update(STEP, { ax: 0, ay: 0 });
  assert.equal(run.hp, hp - 1);
  assert.ok(run.iframe > 0);
  assert.equal(run.field.cells[idx(c.x, c.y)], 0, 'damage should clear the cell you are standing in');
  // no second hit while invulnerable
  run.update(STEP, { ax: 0, ay: 0 });
  assert.equal(run.hp, hp - 1);
});

test('sectors tick over and make purging more expensive', () => {
  const run = new Run({ stats: { ...stats(), maxHp: 9 }, seed: 909 });
  const costAtSector1 = run.purgeCost;
  assert.equal(costAtSector1, stats().purgeCost);
  const events = drive(run, TUNING.sectorSeconds + 1, (r, i) => ({
    ax: Math.sin(i * 0.05), ay: Math.cos(i * 0.05), purge: i % 20 === 0,
  }));
  assert.ok(events.some((e) => e.type === 'sector'));
  assert.ok(run.sector >= 2);
  assert.ok(run.purgeCost > costAtSector1, 'purge should cost more in a deeper sector');
});

test('a cornered player cannot farm shards on the spot', () => {
  const run = new Run({ stats: stats(), seed: 606 });
  // bury everything except a small pocket around the player
  const pc = run.playerCell();
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (Math.hypot(x - pc.x, y - pc.y) > 3) run.field.cells[idx(x, y)] = ROT;
    }
  }
  run.shards.length = 0;
  run.shardCd = 0;
  drive(run, 8, () => ({ ax: 0, ay: 0 }));
  for (const s of run.shards) {
    const d = Math.hypot(s.cx - pc.x, s.cy - pc.y);
    assert.ok(d >= TUNING.shardMinDist - 0.001, `shard spawned ${d.toFixed(1)} cells away`);
  }
});

test('capsules still appear when the arena is almost gone', () => {
  const run = new Run({ stats: { ...stats(), maxHp: 99 }, seed: 707 });
  const pc = run.playerCell();
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x < COLS - 1; x++) {
      if (Math.hypot(x - pc.x, y - pc.y) > 2) run.field.cells[idx(x, y)] = ROT;
    }
  }
  run.capsule = null;
  run.nextCapsule = run.time + 0.1;
  drive(run, 12, () => ({ ax: 0, ay: 0 }));
  assert.ok(run.capsule || run.counters.rescues > 0 || run.counters.lostCapsules > 0,
    'a capsule should have appeared even with nowhere clean to put it');
});

test('the rot seeds itself near the player over time', () => {
  const run = new Run({ stats: { ...stats(), maxHp: 99 }, seed: 808 });
  const events = drive(run, TUNING.huntFirst + 2, () => ({ ax: 0, ay: 0 }));
  assert.ok(events.some((e) => e.type === 'hunt'), 'no hunt seeding happened');
});

test('pressure only rises', () => {
  let prev = -1;
  for (let t = 0; t <= 300; t += 5) {
    const p = PRESSURE(t);
    assert.ok(p > prev);
    prev = p;
  }
});

test('the same seed replays identically', () => {
  const pilot = (r, i) => ({ ax: Math.sin(i * 0.03), ay: Math.cos(i * 0.02), purge: i % 33 === 0 });
  const a = new Run({ stats: stats(), seed: 555 });
  const b = new Run({ stats: stats(), seed: 555 });
  drive(a, 60, pilot);
  drive(b, 60, pilot);
  assert.equal(a.time.toFixed(4), b.time.toFixed(4));
  assert.equal(a.counters.shards, b.counters.shards);
  assert.equal(rotCount(a.field), rotCount(b.field));
  assert.deepEqual(a.rescued, b.rescued);
});

test('one press clears along the path the player covers while the effect lasts', () => {
  const s = stats();
  const run = new Run({ stats: s, seed: 4242 });
  drive(run, 20, () => ({ ax: 0, ay: 0 }));   // let the arena grow

  run.energy = s.energyMax;
  const startX = run.x;
  const cy = Math.floor(run.y / CELL);
  const activeAt = [];

  // press once, then keep moving with the key still down
  for (let i = 0; i < Math.round(1.0 / STEP) && run.state === RunState.PLAYING; i++) {
    run.update(STEP, { ax: 1, ay: 0, purge: true });
    run.drainEvents();
    if (run.purgeActive) activeAt.push(run.x);
  }

  assert.equal(run.counters.purges, 1, 'holding fired more than one purge');
  assert.ok(activeAt.length > 8, 'the purge finished in a single frame');

  // the effect window must have travelled with the player, not stayed put
  const span = Math.max(...activeAt) - Math.min(...activeAt);
  assert.ok(span > 15, `the purge only covered ${span.toFixed(1)}px of travel`);

  // and every cell it passed over is clear — this is the reported bug
  for (let x = Math.min(...activeAt); x <= Math.max(...activeAt); x += CELL / 2) {
    const cx = Math.floor(x / CELL);
    assert.equal(run.field.cells[idx(cx, cy)], 0,
      `cell ${cx},${cy} under the purge path was left rotten`);
  }
});

test('holding the key does nothing after the first press', () => {
  const s = stats();
  const run = new Run({ stats: s, seed: 606 });
  run.energy = s.energyMax;

  run.update(STEP, { ax: 0, ay: 0, purge: true });
  run.drainEvents();
  const afterPress = run.energy;
  assert.equal(run.counters.purges, 1);

  // three seconds of holding: no extra charge, no extra purge, no nagging
  let fails = 0;
  for (let i = 0; i < Math.round(3 / STEP); i++) {
    run.update(STEP, { ax: 1, ay: 0, purge: true });
    for (const e of run.drainEvents()) if (e.type === 'purgeFail') fails++;
  }
  assert.equal(run.counters.purges, 1, 'holding kept firing purges');
  assert.equal(fails, 0, 'holding produced refusal cues');
  assert.ok(run.energy > afterPress, 'the cell did not recharge while held');
});

test('a purge with an empty cell is refused exactly once per press', () => {
  const run = new Run({ stats: stats(), seed: 71 });
  run.energy = 0;

  let fails = 0;
  for (let i = 0; i < 120; i++) {
    run.update(STEP, { ax: 0, ay: 0, purge: true });   // held down the whole time
    for (const e of run.drainEvents()) if (e.type === 'purgeFail') fails++;
  }
  assert.equal(fails, 1, `the refusal cue fired ${fails} times while held`);
  assert.equal(run.counters.purges, 0);
});

test('releasing and pressing again costs a fresh charge', () => {
  const s = stats();
  const run = new Run({ stats: s, seed: 909 });
  run.energy = s.energyMax;

  run.update(STEP, { ax: 0, ay: 0, purge: true });
  const afterFirst = run.energy;
  assert.ok(afterFirst <= s.energyMax - s.purgeCost + 0.001, 'the first press did not cost a charge');
  assert.equal(run.counters.purges, 1);

  // release, wait out the rate limit, press again
  for (let i = 0; i < Math.round(TUNING.purgeCooldown / STEP) + 2; i++) {
    run.update(STEP, { ax: 0, ay: 0, purge: false });
  }
  const beforeSecond = run.energy;          // the cell trickles back while we wait
  run.update(STEP, { ax: 0, ay: 0, purge: true });
  assert.equal(run.counters.purges, 2);
  const spent = beforeSecond - run.energy;
  assert.ok(spent > s.purgeCost * 0.9, `the second press only cost ${spent.toFixed(1)}`);
});
