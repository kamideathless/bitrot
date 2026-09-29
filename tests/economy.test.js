import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSave } from '../src/core/store.js';
import {
  UPGRADES, UPGRADE_BY_ID, nextCost, maxLevel, upgradeBonus, buyUpgrade,
  derivedStats, activePerk, BASE_STATS, restoreCost, restoreTotalCost,
  burnRestore, RESTORE_STEP, runPayout, runScore, sectorMultiplier,
  duplicateSalvage, formatTime, formatRf,
} from '../src/game/economy.js';
import { friendTraits, startingIntegrity } from '../src/game/friends.js';

function saveWith(overrides = {}) {
  return { ...defaultSave(), ...overrides };
}

/** One example id for each of the four real rarities. */
function rarityExamples() {
  const want = ['COMMON', 'RARE', 'EPIC', 'GENESIS'];
  const found = {};
  for (let i = 1; i < 200000 && want.some((r) => !found[r]); i++) {
    const id = i.toString(16).toUpperCase().padStart(6, '0');
    const t = friendTraits(id);
    if (want.includes(t.rarity) && !found[t.rarity]) found[t.rarity] = id;
  }
  for (const r of want) assert.ok(found[r], `no ${r} friend found`);
  return found;
}

test('upgrade costs strictly increase per level', () => {
  for (const def of UPGRADES) {
    for (let i = 1; i < def.costs.length; i++) {
      assert.ok(def.costs[i] > def.costs[i - 1], `${def.id} level ${i} is not more expensive`);
    }
    assert.equal(def.values.length, def.costs.length, `${def.id} has mismatched values/costs`);
    assert.ok(BASE_STATS[def.stat] !== undefined, `${def.id} points at unknown stat ${def.stat}`);
  }
});

test('upgradeBonus accumulates and nextCost ends at max', () => {
  const def = UPGRADE_BY_ID.purge;
  assert.equal(upgradeBonus(def, 0), 0);
  assert.equal(upgradeBonus(def, 2), def.values[0] + def.values[1]);
  assert.equal(upgradeBonus(def, 99), def.values.reduce((a, b) => a + b, 0));
  assert.equal(nextCost(def, maxLevel(def)), null);
});

test('buying an upgrade moves RF and level, and fails when broke', () => {
  let save = saveWith({ rf: 45 });
  const res = buyUpgrade(save, 'purge');
  assert.ok(res.ok);
  assert.equal(res.spent, 45);
  assert.equal(res.save.rf, 0);
  assert.equal(res.save.upgrades.purge, 1);
  assert.equal(save.upgrades.purge, 0, 'the original save must not be mutated');

  const broke = buyUpgrade(res.save, 'purge');
  assert.equal(broke.ok, false);
  assert.equal(broke.reason, 'NOT ENOUGH RF');

  assert.equal(buyUpgrade(save, 'nope').ok, false);
});

test('a maxed upgrade cannot be bought again', () => {
  const def = UPGRADE_BY_ID.core;
  let save = saveWith({ rf: 99999, upgrades: { ...defaultSave().upgrades, core: maxLevel(def) } });
  const res = buyUpgrade(save, 'core');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'MAXED');
});

test('derivedStats folds upgrades into the base stats', () => {
  const base = derivedStats(defaultSave());
  assert.deepEqual(
    { hp: base.maxHp, purge: base.purgeRadius },
    { hp: BASE_STATS.maxHp, purge: BASE_STATS.purgeRadius },
  );
  const upgraded = derivedStats(saveWith({
    upgrades: { ...defaultSave().upgrades, purge: 2, core: 1 },
  }));
  assert.equal(upgraded.maxHp, BASE_STATS.maxHp + 1);
  assert.equal(upgraded.purgeRadius, BASE_STATS.purgeRadius + upgradeBonus(UPGRADE_BY_ID.purge, 2));
});

test('a perk only applies when the equipped Friend is fully restored', () => {
  // find an id whose perk is a multiplier so we can see the effect
  let id = null;
  for (let i = 0; i < 4096 && !id; i++) {
    const cand = i.toString(16).toUpperCase().padStart(6, '0');
    const t = friendTraits(cand);
    if (t.perk && t.perk.id === 'lightfoot') id = cand;
  }
  assert.ok(id, 'expected at least one LIGHTFOOT friend in the first 4096 ids');

  const partial = saveWith({ friends: [{ id, integrity: 90, rescuedAt: 0 }], equipped: id });
  assert.equal(activePerk(partial), null);
  assert.equal(derivedStats(partial).speed, BASE_STATS.speed);

  const full = saveWith({ friends: [{ id, integrity: 100, rescuedAt: 0 }], equipped: id });
  const perk = activePerk(full);
  assert.ok(perk);
  assert.ok(derivedStats(full).speed > BASE_STATS.speed);
});

test('restoreCost rises as a Friend approaches 100%', () => {
  const id = '7A31C4';
  const low = restoreCost({ id, integrity: 20 });
  const mid = restoreCost({ id, integrity: 50 });
  const high = restoreCost({ id, integrity: 90 });
  assert.ok(low < mid && mid < high, `expected rising costs, got ${low}/${mid}/${high}`);
  assert.equal(restoreCost({ id, integrity: 100 }), null);
});

test('rarer Friends cost more to restore', () => {
  const byRarity = rarityExamples();
  const cost = (id) => restoreCost({ id, integrity: 50 });
  assert.ok(cost(byRarity.COMMON) < cost(byRarity.RARE));
  assert.ok(cost(byRarity.RARE) < cost(byRarity.EPIC));
  assert.ok(cost(byRarity.EPIC) < cost(byRarity.GENESIS));
});

test('restoreTotalCost equals the sum of every step', () => {
  const id = '2C77D1';
  let f = { id, integrity: 33 };
  const total = restoreTotalCost(f);
  let sum = 0;
  let guard = 0;
  while (f.integrity < 100 && guard++ < 50) {
    sum += restoreCost(f);
    f = { id, integrity: Math.min(100, f.integrity + RESTORE_STEP) };
  }
  assert.equal(total, sum);
  assert.equal(f.integrity, 100);
});

test('burnRestore destroys exactly what it spends and reaches 100%', () => {
  const id = 'B45E08';
  let save = saveWith({ rf: 5000, friends: [{ id, integrity: startingIntegrity(id), rescuedAt: 0 }] });
  const startRf = save.rf;
  let burned = 0;
  let restored = false;
  let guard = 0;
  while (!restored && guard++ < 40) {
    const res = burnRestore(save, id);
    assert.ok(res.ok, res.reason);
    burned += res.spent;
    restored = res.restored;
    save = res.save;
  }
  assert.ok(restored);
  assert.equal(save.friends[0].integrity, 100);
  assert.equal(save.rfBurned, burned);
  assert.equal(save.rf, startRf - burned);
  assert.equal(burnRestore(save, id).ok, false);
  assert.equal(burnRestore(save, 'FFFFFF').reason, 'NOT OWNED');
});

test('burnRestore refuses when the wallet is short', () => {
  const id = '19FFA6';
  const save = saveWith({ rf: 0, friends: [{ id, integrity: 30, rescuedAt: 0 }] });
  const res = burnRestore(save, id);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'NOT ENOUGH RF');
});

test('payout and score grow with every input and never go negative', () => {
  const zero = { time: 0, sector: 1, shards: 0, rescues: 0, defrags: 0 };
  assert.equal(runPayout(zero), 0);
  assert.equal(runScore(zero), 0);
  assert.ok(runPayout({ ...zero, shards: 10 }) > 0);
  assert.ok(runPayout({ ...zero, rescues: 1 }) > runPayout({ ...zero, shards: 10 }));
  assert.ok(runPayout({ ...zero, shards: 10, sector: 3 }) > runPayout({ ...zero, shards: 10 }));
  assert.equal(runPayout({ ...zero, shards: -5, rescues: -2 }), 0);
  assert.ok(runPayout({ ...zero, shards: 10 }, 1.35) > runPayout({ ...zero, shards: 10 }, 1));
  assert.equal(sectorMultiplier(1), 1);
  assert.ok(sectorMultiplier(4) > sectorMultiplier(3));
});

test('duplicate salvage scales with rarity', () => {
  const ids = rarityExamples();
  assert.ok(duplicateSalvage(ids.COMMON) > 0);
  assert.ok(duplicateSalvage(ids.RARE) > duplicateSalvage(ids.COMMON));
  assert.ok(duplicateSalvage(ids.EPIC) > duplicateSalvage(ids.RARE));
  assert.ok(duplicateSalvage(ids.GENESIS) > duplicateSalvage(ids.EPIC));
});

test('formatters', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(75.9), '01:15');
  assert.equal(formatTime(-4), '00:00');
  assert.equal(formatRf(999), '999');
  assert.equal(formatRf(12500), '12.5K');
});
