import test from 'node:test';
import assert from 'node:assert/strict';
import {
  friendTraits, friendSprite, rollFriendId, startingIntegrity, isValidId,
  PORTRAIT, PERKS, RARITIES, STRAY_ID, rarityOrder,
  HEAD_KEYS, EAR_KEYS, EYE_KEYS, MOUTH_KEYS, ACC_KEYS, PATTERN_KEYS,
} from '../src/game/friends.js';
import { Rng } from '../src/core/rng.js';

const SAMPLE = ['7A31C4', 'E90B2F', '2C77D1', 'B45E08', '19FFA6', 'CD3021', '000001', 'FFFFFF'];

test('traits are a pure function of the id', () => {
  for (const id of SAMPLE) {
    const a = friendTraits(id);
    const b = friendTraits(id.toLowerCase());
    assert.deepEqual(a, b, `case-insensitive lookup differs for ${id}`);
  }
  assert.notDeepEqual(friendTraits('000001'), friendTraits('000002'));
});

test('every trait resolves to a real art part and a real perk', () => {
  for (let i = 0; i < 3000; i++) {
    const id = ((i + 1) * 7919 % 16777216).toString(16).toUpperCase().padStart(6, '0');
    if (id === STRAY_ID) continue;
    const t = friendTraits(id);
    assert.ok(t.name.length >= 4, `bad name for ${id}: ${t.name}`);
    assert.ok(RARITIES[t.rarity], `bad rarity for ${id}`);
    assert.ok(t.generation >= 1 && t.generation <= 5, `bad generation for ${id}: ${t.generation}`);
    assert.ok(PERKS.some((p) => p.id === t.perk.id), `bad perk for ${id}`);
    assert.ok(typeof t.perkText === 'string' && t.perkText.length > 3);
    // the sprite builder throws if a part key is missing
    const spr = friendSprite(id, 100);
    assert.equal(spr.w, PORTRAIT);
    assert.equal(spr.h, PORTRAIT);
  }
});

test('every id — including the stray — names art parts that exist', () => {
  const ids = [STRAY_ID, ...SAMPLE];
  for (let i = 1; i < 2000; i++) ids.push((i * 104729 % 16777216).toString(16).toUpperCase().padStart(6, '0'));
  for (const id of ids) {
    const t = friendTraits(id);
    assert.ok(HEAD_KEYS.includes(t.head), `${id}: bad head ${t.head}`);
    assert.ok(EAR_KEYS.includes(t.ears), `${id}: bad ears ${t.ears}`);
    assert.ok(EYE_KEYS.includes(t.eyes), `${id}: bad eyes ${t.eyes}`);
    assert.ok(MOUTH_KEYS.includes(t.mouth), `${id}: bad mouth ${t.mouth}`);
    assert.ok(ACC_KEYS.includes(t.accessory), `${id}: bad accessory ${t.accessory}`);
    assert.ok(PATTERN_KEYS.includes(t.pattern), `${id}: bad pattern ${t.pattern}`);
  }
});

test('the stray placeholder is inert', () => {
  const t = friendTraits(STRAY_ID);
  assert.equal(t.rarity, 'STRAY');
  assert.equal(t.perk, null);
  assert.equal(t.generation, 0);
  assert.equal(rarityOrder('STRAY'), -1);
  const spr = friendSprite(STRAY_ID, 100);
  assert.ok(spr.data.some((v) => v !== 0), 'the stray must still be drawn');
});

test('rarity distribution is plausible', () => {
  const counts = { COMMON: 0, RARE: 0, EPIC: 0, GENESIS: 0 };
  const N = 20000;
  const rng = new Rng(1234);
  for (let i = 0; i < N; i++) counts[friendTraits(rollFriendId(rng)).rarity]++;
  assert.ok(counts.COMMON / N > 0.5 && counts.COMMON / N < 0.72, `COMMON ${counts.COMMON / N}`);
  assert.ok(counts.RARE / N > 0.18 && counts.RARE / N < 0.34, `RARE ${counts.RARE / N}`);
  assert.ok(counts.EPIC / N > 0.05 && counts.EPIC / N < 0.15, `EPIC ${counts.EPIC / N}`);
  assert.ok(counts.GENESIS / N > 0.01 && counts.GENESIS / N < 0.05, `GENESIS ${counts.GENESIS / N}`);
});

test('sprites only contain legal pixel values and have a visible body', () => {
  for (const id of SAMPLE) {
    const spr = friendSprite(id, 100);
    let ink = 0, paper = 0;
    for (const v of spr.data) {
      assert.ok(v === 0 || v === 1 || v === 2 || v === 4, `illegal pixel value ${v}`);
      if (v === 1) ink++;
      if (v === 2) paper++;
    }
    assert.ok(ink > 20, `${id} has almost no outline`);
    assert.ok(paper > 30, `${id} has almost no body`);
  }
});

test('restoration reveals pixels in a stable order', () => {
  const id = '7A31C4';
  const full = friendSprite(id, 100);
  let previousCorrupt = Infinity;
  let previousVisible = null;
  for (let integrity = 0; integrity <= 100; integrity += 10) {
    const spr = friendSprite(id, integrity);
    const corrupt = [...spr.data].filter((v) => v === 4).length;
    assert.ok(corrupt <= previousCorrupt, `corruption grew when integrity rose to ${integrity}`);
    previousCorrupt = corrupt;

    const visible = new Set();
    for (let i = 0; i < spr.data.length; i++) if (spr.data[i] !== 0 && spr.data[i] !== 4) visible.add(i);
    if (previousVisible) {
      for (const i of previousVisible) {
        assert.ok(visible.has(i), `pixel ${i} was visible at a lower integrity and then vanished`);
      }
    }
    previousVisible = visible;

    // a corrupted sprite keeps the same silhouette slots as the full one
    for (let i = 0; i < spr.data.length; i++) {
      if (spr.data[i] !== 0) assert.notEqual(full.data[i], 0, `pixel ${i} appeared outside the silhouette`);
    }
  }
  assert.equal(previousCorrupt, 0, 'a 100% Friend must have no corrupt pixels');
});

test('a 0% Friend is entirely corrupt but still occupies its silhouette', () => {
  const spr = friendSprite('E90B2F', 0);
  assert.ok([...spr.data].every((v) => v === 0 || v === 4));
  assert.ok([...spr.data].filter((v) => v === 4).length > 50);
});

test('rolled ids are valid and never the stray', () => {
  const rng = new Rng(99);
  for (let i = 0; i < 5000; i++) {
    const id = rollFriendId(rng);
    assert.ok(isValidId(id), `invalid id ${id}`);
    assert.notEqual(id, STRAY_ID);
  }
  assert.equal(isValidId('zzzz'), false);
  assert.equal(isValidId(null), false);
  assert.equal(isValidId('7A31C'), false);
});

test('starting integrity is stable and in range', () => {
  for (const id of SAMPLE) {
    const a = startingIntegrity(id);
    assert.equal(a, startingIntegrity(id));
    assert.ok(a >= 22 && a <= 48, `${id} starts at ${a}`);
  }
});

test('perk values scale with rarity', () => {
  const byRarity = {};
  for (let i = 0; i < 40000 && Object.keys(byRarity).length < 4; i++) {
    const id = i.toString(16).toUpperCase().padStart(6, '0');
    const t = friendTraits(id);
    if (t.perk && t.perk.id === 'scavenger' && !byRarity[t.rarity]) byRarity[t.rarity] = t.perkValue;
  }
  const tiers = ['COMMON', 'RARE', 'EPIC', 'GENESIS'].filter((k) => byRarity[k] !== undefined);
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(byRarity[tiers[i]] > byRarity[tiers[i - 1]],
      `${tiers[i]} scavenger (${byRarity[tiers[i]]}) should beat ${tiers[i - 1]} (${byRarity[tiers[i - 1]]})`);
  }
});
