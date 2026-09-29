// The (simulated) $RAREFRIENDS economy: upgrades, restoration burns, payouts.
// Everything here is pure so it can be unit-tested without a browser.

import { friendTraits, startingIntegrity } from './friends.js';

export const BASE_STATS = {
  maxHp: 3,
  energyMax: 100,
  energyRegen: 11,      // per second
  purgeRadius: 30,      // logical px
  purgeCost: 40,        // energy
  scarGens: 14,         // automaton generations a purged cell stays immune
  speed: 82,            // px / second
  magnet: 13,           // px
  dashCooldown: 1.1,    // seconds
  shardValue: 1,        // RF
};

export const UPGRADES = [
  {
    id: 'purge', name: 'PURGE COIL', stat: 'purgeRadius',
    blurb: 'WIDER STATIC PURGE BLAST.',
    costs: [45, 110, 230, 420],
    values: [6, 6, 6, 6], kind: 'add', unit: 'PX',
  },
  {
    id: 'energy', name: 'CELL BANK', stat: 'energyMax',
    blurb: 'MORE STORED PURGE ENERGY.',
    costs: [40, 95, 200, 380],
    values: [15, 15, 15, 15], kind: 'add', unit: '',
  },
  {
    id: 'scar', name: 'SCAR ETCH', stat: 'scarGens',
    blurb: 'PURGED GROUND STAYS CLEAN LONGER.',
    costs: [55, 130, 260],
    values: [5, 5, 6], kind: 'add', unit: 'GEN',
  },
  {
    id: 'core', name: 'CORE PLATE', stat: 'maxHp',
    blurb: 'ONE MORE HIT BEFORE YOU DROP.',
    costs: [150, 420],
    values: [1, 1], kind: 'add', unit: '',
  },
  {
    id: 'boots', name: 'DRIFT BOOTS', stat: 'speed',
    blurb: 'FASTER MOVEMENT.',
    costs: [60, 145, 300],
    values: [7, 7, 7], kind: 'add', unit: 'PX/S',
  },
  {
    id: 'magnet', name: 'LODE COIL', stat: 'magnet',
    blurb: 'SHARDS GET PULLED IN FROM FURTHER.',
    costs: [50, 120, 250],
    values: [7, 8, 9], kind: 'add', unit: 'PX',
  },
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

export function maxLevel(def) { return def.costs.length; }

/** Cost of the next level, or null if maxed. */
export function nextCost(def, level) {
  if (level >= def.costs.length) return null;
  return def.costs[level];
}

/** Total stat bonus contributed by `level` purchased levels. */
export function upgradeBonus(def, level) {
  let total = 0;
  for (let i = 0; i < Math.min(level, def.values.length); i++) total += def.values[i];
  return total;
}

/**
 * Resolve the stat block for a run: base + upgrades + equipped-Friend perk.
 * A Friend's perk only counts once the Friend is fully RESTORED (integrity 100)
 * — that is the whole point of burning RF.
 */
export function derivedStats(save) {
  const stats = { ...BASE_STATS };

  for (const def of UPGRADES) {
    const lvl = (save.upgrades && save.upgrades[def.id]) || 0;
    if (!lvl) continue;
    stats[def.stat] += upgradeBonus(def, lvl);
  }

  const perk = activePerk(save);
  if (perk) {
    if (perk.kind === 'add') stats[perk.stat] += perk.value;
    else stats[perk.stat] = stats[perk.stat] * (1 + perk.value);
  }

  stats.maxHp = Math.max(1, Math.round(stats.maxHp));
  stats.energyMax = Math.round(stats.energyMax);
  stats.dashCooldown = Math.max(0.35, stats.dashCooldown);
  return stats;
}

/** The perk currently in effect, or null. */
export function activePerk(save) {
  const f = equippedFriend(save);
  if (!f || f.integrity < 100) return null;
  const t = friendTraits(f.id);
  if (!t.perk) return null;
  return { id: t.perk.id, name: t.perk.name, stat: t.perk.stat, kind: t.perk.kind, value: t.perkValue, text: t.perkText };
}

export function equippedFriend(save) {
  if (!save || !save.equipped) return null;
  return save.friends.find((f) => f.id === save.equipped) || null;
}

/* ----------------------------------------------------------------------- */
/* Restoration (the burn sink)                                             */
/* ----------------------------------------------------------------------- */

export const RESTORE_STEP = 10;        // integrity points bought at a time
export const RESTORE_BASE_COST = 17;   // RF per step for a COMMON Friend

/**
 * RF cost to push a Friend from its current integrity up by one step.
 * Cost climbs as the Friend approaches 100 — the last pixels are the dearest.
 */
export function restoreCost(friend) {
  if (!friend || friend.integrity >= 100) return null;
  const t = friendTraits(friend.id);
  const remaining = 100 - friend.integrity;
  const step = Math.min(RESTORE_STEP, remaining);
  const progress = friend.integrity / 100;               // 0..1
  const curve = 1 + progress * 2.4;                      // 1x -> 3.4x
  const raw = RESTORE_BASE_COST * t.restoreRate * curve * (step / RESTORE_STEP);
  return Math.max(1, Math.round(raw));
}

/** Total RF still needed to take a Friend all the way to 100%. */
export function restoreTotalCost(friend) {
  if (!friend) return 0;
  let sim = { id: friend.id, integrity: friend.integrity };
  let total = 0;
  let guard = 0;
  while (sim.integrity < 100 && guard++ < 64) {
    total += restoreCost(sim);
    sim = { id: sim.id, integrity: Math.min(100, sim.integrity + RESTORE_STEP) };
  }
  return total;
}

/**
 * Apply one restoration burn. Returns { ok, save, spent, restored } — `save`
 * is a new object, the caller decides whether to commit it.
 */
export function burnRestore(save, friendId) {
  const idx = save.friends.findIndex((f) => f.id === friendId);
  if (idx < 0) return { ok: false, reason: 'NOT OWNED' };
  const friend = save.friends[idx];
  if (friend.integrity >= 100) return { ok: false, reason: 'ALREADY RESTORED' };
  const cost = restoreCost(friend);
  if (save.rf < cost) return { ok: false, reason: 'NOT ENOUGH RF' };

  const friends = save.friends.slice();
  const nextIntegrity = Math.min(100, friend.integrity + RESTORE_STEP);
  friends[idx] = { ...friend, integrity: nextIntegrity };

  return {
    ok: true,
    spent: cost,
    restored: nextIntegrity >= 100,
    save: {
      ...save,
      rf: save.rf - cost,
      rfBurned: save.rfBurned + cost,
      friends,
    },
  };
}

/** Apply an upgrade purchase. Returns { ok, save, spent }. */
export function buyUpgrade(save, upgradeId) {
  const def = UPGRADE_BY_ID[upgradeId];
  if (!def) return { ok: false, reason: 'UNKNOWN' };
  const level = save.upgrades[upgradeId] || 0;
  const cost = nextCost(def, level);
  if (cost === null) return { ok: false, reason: 'MAXED' };
  if (save.rf < cost) return { ok: false, reason: 'NOT ENOUGH RF' };
  return {
    ok: true,
    spent: cost,
    save: {
      ...save,
      rf: save.rf - cost,
      upgrades: { ...save.upgrades, [upgradeId]: level + 1 },
    },
  };
}

/* ----------------------------------------------------------------------- */
/* Run payout                                                              */
/* ----------------------------------------------------------------------- */

export const PAYOUT = {
  perShard: 1,
  perRescue: 24,
  perDefrag: 12,
  perSector: 6,
};

/**
 * Sector multiplier applied to the whole payout. Deliberately shallow: a long
 * dive should pay more than a short one, but not so much more that the deep
 * end trivialises the restoration sink.
 */
export function sectorMultiplier(sector) {
  return 1 + 0.09 * Math.max(0, sector - 1);
}

/**
 * RF earned by a run. `stats.shardValue` folds in the SCAVENGER perk.
 */
export function runPayout(result, shardValue = 1) {
  const shards = Math.max(0, Math.floor(result.shards || 0));
  const rescues = Math.max(0, Math.floor(result.rescues || 0));
  const defrags = Math.max(0, Math.floor(result.defrags || 0));
  const sector = Math.max(1, Math.floor(result.sector || 1));
  const raw =
    shards * PAYOUT.perShard * shardValue +
    rescues * PAYOUT.perRescue +
    defrags * PAYOUT.perDefrag +
    (sector - 1) * PAYOUT.perSector;
  return Math.max(0, Math.round(raw * sectorMultiplier(sector)));
}

/** Score is the leaderboard number; RF is the wallet number. */
export function runScore(result) {
  const t = Math.max(0, result.time || 0);
  return Math.round(
    t * 12 +
    (result.shards || 0) * 30 +
    (result.rescues || 0) * 450 +
    (result.defrags || 0) * 180 +
    (Math.max(1, result.sector || 1) - 1) * 250,
  );
}

/** Duplicate Friends are salvaged into RF instead of being added again. */
export function duplicateSalvage(id) {
  return friendTraits(id).salvage;
}

/**
 * Fold a finished dive into a save: pay out RF, file the rescued Friends,
 * salvage duplicates and update the records. Pure — returns a new save.
 *
 * Both the browser and the server call this, and the server calls it with a
 * result it re-simulated itself, so the two can never disagree about what a
 * run was worth.
 */
export function applyRunToSave(save, result, now = Date.now()) {
  const fresh = [];
  const dupes = [];
  const friends = save.friends.slice();
  let salvage = 0;

  for (const id of result.rescued || []) {
    if (friends.some((f) => f.id === id)) {
      const amount = duplicateSalvage(id);
      salvage += amount;
      dupes.push({ id, salvage: amount });
    } else {
      friends.push({ id, integrity: startingIntegrity(id), rescuedAt: now });
      fresh.push({ id });
    }
  }

  const payout = Math.max(0, Math.round(result.rf || 0)) + salvage;
  const best = { ...save.best };
  const newBest = (result.score || 0) > best.score;
  if (newBest) best.score = result.score;
  if (result.time > best.time) best.time = result.time;
  if (result.sector > best.sector) best.sector = result.sector;
  if (result.rescues > best.rescues) best.rescues = result.rescues;

  const next = {
    ...save,
    rf: save.rf + payout,
    rfEarned: save.rfEarned + payout,
    runs: save.runs + 1,
    friends,
    best,
    totals: {
      ...save.totals,
      shards: save.totals.shards + (result.shards || 0),
      rescues: save.totals.rescues + (result.rescues || 0),
      defrags: save.totals.defrags + (result.defrags || 0),
      purges: save.totals.purges + (result.purges || 0),
      duplicates: save.totals.duplicates + dupes.length,
      time: save.totals.time + (result.time || 0),
    },
  };
  if (!next.equipped && friends.length) next.equipped = friends[0].id;

  return { save: next, fresh, dupes, salvage, payout, newBest };
}

/** Equip a Friend the account actually owns. */
export function equipFriend(save, friendId) {
  if (!save.friends.some((f) => f.id === friendId)) {
    return { ok: false, reason: 'NOT OWNED' };
  }
  return { ok: true, save: { ...save, equipped: friendId } };
}

/** The shard multiplier a run should be paid at, given the equipped perk. */
export function shardValueFor(save) {
  const perk = activePerk(save);
  return perk && perk.id === 'scavenger' ? 1 + perk.value : 1;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatRf(n) {
  const v = Math.round(n);
  if (v < 10000) return String(v);
  return `${(v / 1000).toFixed(1)}K`;
}
