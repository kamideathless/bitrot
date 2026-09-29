// Procedural Rare Friends.
//
// A Friend is fully described by a 6-hex-digit id. Every trait, its name, its
// rarity, its perk and its 16x16 portrait are pure functions of that id, so a
// Friend can be re-derived anywhere from the id alone (that is also how a real
// tokenId would map onto canonical artwork through FriendSDK).
//
// Art is authored as horizontal spans: [y, x, length]. Spans are far easier to
// proof-read than 16-character ASCII rows.

import { hashString, sub } from '../core/rng.js';

export const PORTRAIT = 16;

const HEADS = {
  round: [
    [3, 4, 8], [4, 3, 10], [5, 2, 12], [6, 2, 12], [7, 2, 12], [8, 2, 12],
    [9, 2, 12], [10, 2, 12], [11, 2, 12], [12, 3, 10], [13, 4, 8],
  ],
  box: [
    [3, 2, 12], [4, 2, 12], [5, 2, 12], [6, 2, 12], [7, 2, 12], [8, 2, 12],
    [9, 2, 12], [10, 2, 12], [11, 2, 12], [12, 2, 12], [13, 3, 10],
  ],
  drop: [
    [3, 5, 6], [4, 4, 8], [5, 3, 10], [6, 2, 12], [7, 2, 12], [8, 2, 12],
    [9, 2, 12], [10, 2, 12], [11, 2, 12], [12, 2, 12], [13, 3, 10],
  ],
  gem: [
    [3, 6, 4], [4, 4, 8], [5, 2, 12], [6, 1, 14], [7, 1, 14], [8, 1, 14],
    [9, 1, 14], [10, 2, 12], [11, 2, 12], [12, 3, 10], [13, 5, 6],
  ],
  tall: [
    [2, 4, 8], [3, 3, 10], [4, 3, 10], [5, 3, 10], [6, 3, 10], [7, 3, 10],
    [8, 3, 10], [9, 3, 10], [10, 3, 10], [11, 3, 10], [12, 3, 10], [13, 3, 10],
    [14, 4, 8],
  ],
};

const EARS = {
  none: [],
  cat: [[0, 4, 2], [0, 10, 2], [1, 3, 3], [1, 10, 3], [2, 2, 4], [2, 10, 4]],
  bunny: [[0, 4, 2], [0, 10, 2], [1, 4, 2], [1, 10, 2], [2, 4, 2], [2, 10, 2]],
  antenna: [[0, 6, 4], [1, 6, 4], [2, 7, 2]],
  horns: [[0, 1, 2], [0, 13, 2], [1, 2, 3], [1, 11, 3], [2, 3, 4], [2, 9, 4]],
  fin: [[0, 7, 2], [1, 6, 4], [2, 5, 6]],
};

const EYES = {
  beady: [[6, 4, 2], [6, 10, 2], [7, 4, 2], [7, 10, 2]],
  wide: [
    [6, 3, 4], [6, 9, 4],
    [7, 3, 1], [7, 6, 1], [7, 9, 1], [7, 12, 1],
    [8, 3, 4], [8, 9, 4],
  ],
  visor: [[6, 3, 10], [7, 3, 1], [7, 12, 1], [8, 3, 10]],
  cyclops: [[6, 5, 6], [7, 5, 1], [7, 10, 1], [8, 5, 1], [8, 7, 2], [8, 10, 1], [9, 5, 6]],
  cross: [
    [6, 3, 1], [6, 5, 1], [6, 10, 1], [6, 12, 1],
    [7, 4, 1], [7, 11, 1],
    [8, 3, 1], [8, 5, 1], [8, 10, 1], [8, 12, 1],
  ],
  sleepy: [[6, 3, 4], [6, 9, 4], [7, 4, 2], [7, 10, 2]],
  star: [[6, 4, 1], [6, 11, 1], [7, 3, 3], [7, 10, 3], [8, 4, 1], [8, 11, 1]],
  angry: [[6, 3, 2], [6, 11, 2], [7, 5, 2], [7, 9, 2], [8, 5, 2], [8, 9, 2]],
};

const MOUTHS = {
  smile: [[10, 4, 1], [10, 11, 1], [11, 5, 6]],
  line: [[11, 5, 6]],
  fang: [[10, 5, 6], [11, 6, 1], [11, 9, 1]],
  open: [[10, 5, 6], [11, 5, 1], [11, 10, 1], [12, 5, 6]],
  none: [],
  wave: [[10, 5, 1], [10, 7, 1], [10, 9, 1], [11, 4, 1], [11, 6, 1], [11, 8, 1], [11, 10, 1]],
};

// Accessories never touch the eye band (y6-y9) or mouth band (y10-y12).
const ACCESSORIES = {
  none: { body: [], ink: [] },
  halo: { body: [], ink: [[0, 4, 8], [1, 4, 1], [1, 11, 1]] },
  crown: {
    body: [[1, 2, 1], [1, 6, 1], [1, 9, 1], [1, 13, 1], [2, 2, 12]],
    ink: [[2, 4, 1], [2, 7, 2], [2, 11, 1]],
  },
  scarf: {
    body: [[14, 3, 10], [15, 4, 8]],
    ink: [[14, 4, 1], [14, 6, 1], [14, 8, 1], [14, 10, 1]],
  },
  headphones: {
    body: [
      [2, 4, 8], [3, 3, 1], [3, 12, 1],
      [5, 1, 2], [5, 13, 2], [6, 1, 2], [6, 13, 2],
      [7, 1, 2], [7, 13, 2], [8, 1, 2], [8, 13, 2],
    ],
    ink: [[6, 1, 2], [6, 13, 2]],
  },
  brow: { body: [], ink: [[4, 3, 10], [5, 3, 1], [5, 12, 1]] },
  collar: { body: [[13, 1, 14], [14, 2, 12]], ink: [[14, 4, 8]] },
};

// Markings, never full fills: the face has to stay readable at 16x16.
// A pattern gets (x, y, ctx) where ctx.rim marks the inner edge of the body.
const PATTERNS = {
  none: null,
  speck: (x, y) => ((x * 5 + y * 3) % 11) === 0,
  cap: (x, y) => y <= 5 && ((x + y) & 1) === 0,
  vstripe: (x, y) => y >= 10 && (x % 3 === 0),
  checker: (x, y) => y >= 12 && ((x + y) & 1) === 0,
  rim: (x, y, ctx) => !!ctx.rim[y * PORTRAIT + x],
};

export const HEAD_KEYS = Object.keys(HEADS);
export const EAR_KEYS = Object.keys(EARS);
export const EYE_KEYS = Object.keys(EYES);
export const MOUTH_KEYS = Object.keys(MOUTHS);
export const ACC_KEYS = Object.keys(ACCESSORIES);
export const PATTERN_KEYS = Object.keys(PATTERNS);

const SYL_A = ['VE', 'KO', 'MI', 'ZA', 'RU', 'TE', 'NO', 'BI', 'SA', 'GU', 'LU', 'PI', 'DRA', 'QUE', 'XO', 'FEN'];
const SYL_B = ['LIX', 'MOR', 'KAN', 'DAR', 'SHI', 'PUL', 'TEK', 'VOR', 'NIS', 'RAM', 'ZUL', 'BEK', 'TOS', 'WYN', 'QAI', 'FLO'];

export const RARITIES = {
  COMMON: { key: 'COMMON', tier: 0, mult: 0.6, restoreRate: 1.0, salvage: 10, weight: 1 },
  RARE: { key: 'RARE', tier: 1, mult: 0.9, restoreRate: 1.7, salvage: 20, weight: 1 },
  EPIC: { key: 'EPIC', tier: 2, mult: 1.2, restoreRate: 2.6, salvage: 40, weight: 1 },
  GENESIS: { key: 'GENESIS', tier: 3, mult: 1.6, restoreRate: 4.5, salvage: 85, weight: 1 },
};

export const PERKS = [
  { id: 'scrubber', name: 'SCRUBBER', stat: 'purgeRadius', kind: 'mul', base: 0.16, fmt: (v) => `PURGE RADIUS +${Math.round(v * 100)}%` },
  { id: 'flywheel', name: 'FLYWHEEL', stat: 'energyRegen', kind: 'mul', base: 0.28, fmt: (v) => `ENERGY REGEN +${Math.round(v * 100)}%` },
  { id: 'lightfoot', name: 'LIGHTFOOT', stat: 'speed', kind: 'mul', base: 0.10, fmt: (v) => `MOVE SPEED +${Math.round(v * 100)}%` },
  { id: 'scavenger', name: 'SCAVENGER', stat: 'shardValue', kind: 'mul', base: 0.35, fmt: (v) => `SHARD VALUE +${Math.round(v * 100)}%` },
  { id: 'afterimage', name: 'AFTERIMAGE', stat: 'dashCooldown', kind: 'mul', base: -0.26, fmt: (v) => `DASH COOLDOWN ${Math.round(v * 100)}%` },
  { id: 'plating', name: 'PLATING', stat: 'maxHp', kind: 'add', base: 1, fmt: (v) => `+${v} MAX INTEGRITY` },
  { id: 'lodestone', name: 'LODESTONE', stat: 'magnet', kind: 'mul', base: 0.9, fmt: (v) => `PICKUP RANGE +${Math.round(v * 100)}%` },
  { id: 'echo', name: 'ECHO', stat: 'scarGens', kind: 'mul', base: 0.5, fmt: (v) => `SCAR DURATION +${Math.round(v * 100)}%` },
];

export const STRAY_ID = '000000';

/** Is this a legal Friend id? */
export function isValidId(id) {
  return typeof id === 'string' && /^[0-9A-F]{6}$/.test(id);
}

function rarityFor(h) {
  const r = sub(h, 1);
  if (r < 0.025) return RARITIES.GENESIS;
  if (r < 0.12) return RARITIES.EPIC;
  if (r < 0.38) return RARITIES.RARE;
  return RARITIES.COMMON;
}

const traitCache = new Map();

/** Derive every trait of a Friend from its id. Pure + memoised. */
export function friendTraits(id) {
  const key = String(id).toUpperCase();
  const cached = traitCache.get(key);
  if (cached) return cached;

  const h = hashString('BITROT/FRIEND/' + key);
  const stray = key === STRAY_ID;
  const rarity = stray ? { key: 'STRAY', tier: -1, mult: 0, restoreRate: 1, salvage: 0 } : rarityFor(h);

  const pick = (arr, k) => arr[Math.floor(sub(h, k) * arr.length) % arr.length];

  // Higher tiers unlock the flashier silhouettes.
  const earPool = rarity.tier >= 2 ? EAR_KEYS : EAR_KEYS.slice(0, 5);
  const accPool = rarity.tier >= 1 ? ACC_KEYS : ACC_KEYS.slice(0, 4);

  const traits = {
    id: key,
    stray,
    head: stray ? 'box' : pick(HEAD_KEYS, 2),
    ears: stray ? 'none' : pick(earPool, 3),
    eyes: stray ? 'beady' : pick(EYE_KEYS, 4),
    mouth: stray ? 'line' : pick(MOUTH_KEYS, 5),
    accessory: stray ? 'none' : pick(accPool, 6),
    pattern: stray ? 'none' : pick(PATTERN_KEYS, 7),
    rarity: rarity.key,
    rarityTier: rarity.tier,
    rarityMult: rarity.mult,
    restoreRate: rarity.restoreRate,
    salvage: rarity.salvage,
    generation: stray ? 0 : Math.min(5, 1 + rarity.tier + Math.floor(sub(h, 8) * 2)),
    name: stray ? 'STRAY' : pick(SYL_A, 9) + pick(SYL_B, 10),
    serial: stray ? '000' : String(Math.floor(sub(h, 11) * 900) + 100),
    perk: null,
    perkValue: 0,
    perkText: '—',
  };

  if (!stray) {
    const perk = PERKS[Math.floor(sub(h, 12) * PERKS.length) % PERKS.length];
    let value = perk.base * (perk.kind === 'add' ? 1 : rarity.mult);
    if (perk.kind === 'add') value = rarity.tier >= 2 ? perk.base + 1 : perk.base;
    value = perk.kind === 'mul' ? Math.round(value * 100) / 100 : Math.round(value);
    traits.perk = perk;
    traits.perkValue = value;
    traits.perkText = perk.fmt(perk.id === 'afterimage' ? value : value);
  }

  traits.label = stray ? 'STRAY GEN-0' : `${traits.name}-${traits.serial}`;
  traitCache.set(key, traits);
  return traits;
}

function paintSpans(mask, spans, value = 1) {
  if (!spans) return;
  for (const [y, x, len] of spans) {
    if (y < 0 || y >= PORTRAIT) continue;
    for (let i = 0; i < len; i++) {
      const xx = x + i;
      if (xx < 0 || xx >= PORTRAIT) continue;
      mask[y * PORTRAIT + xx] = value;
    }
  }
}

function dilate(mask) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < PORTRAIT; y++) {
    for (let x = 0; x < PORTRAIT; x++) {
      if (!mask[y * PORTRAIT + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx && dy) continue; // 4-neighbourhood keeps outlines thin
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= PORTRAIT || ny >= PORTRAIT) continue;
          out[ny * PORTRAIT + nx] = 1;
        }
      }
    }
  }
  return out;
}

const spriteCache = new Map();

/**
 * Build the 16x16 portrait sprite.
 * Values: 0 transparent, 1 ink, 2 paper, 4 corrupt (dithered).
 * `integrity` 0..100 controls how much of the Friend has been eaten by rot.
 */
export function friendSprite(id, integrity = 100) {
  const key = `${String(id).toUpperCase()}:${Math.round(integrity)}`;
  const cached = spriteCache.get(key);
  if (cached) return cached;

  const t = friendTraits(id);
  const N = PORTRAIT * PORTRAIT;

  const body = new Uint8Array(N);
  paintSpans(body, HEADS[t.head]);
  paintSpans(body, EARS[t.ears]);
  paintSpans(body, ACCESSORIES[t.accessory].body);

  const outline = dilate(body);
  for (let i = 0; i < N; i++) if (body[i]) outline[i] = 0;

  // features: eyes + mouth clipped to the body, accessory ink free-standing
  const feat = new Uint8Array(N);
  const clipped = new Uint8Array(N);
  paintSpans(clipped, EYES[t.eyes]);
  paintSpans(clipped, MOUTHS[t.mouth]);
  for (let i = 0; i < N; i++) if (clipped[i] && body[i]) feat[i] = 1;
  paintSpans(feat, ACCESSORIES[t.accessory].ink);

  const halo = dilate(feat);
  for (let i = 0; i < N; i++) if (feat[i]) halo[i] = 0;

  // inner edge of the silhouette, for the "rim" marking
  const rim = new Uint8Array(N);
  for (let y = 0; y < PORTRAIT; y++) {
    for (let x = 0; x < PORTRAIT; x++) {
      const i = y * PORTRAIT + x;
      if (!body[i]) continue;
      const open = (nx, ny) =>
        nx < 0 || ny < 0 || nx >= PORTRAIT || ny >= PORTRAIT || !body[ny * PORTRAIT + nx];
      if (open(x - 1, y) || open(x + 1, y) || open(x, y - 1) || open(x, y + 1)) rim[i] = 1;
    }
  }

  const data = new Uint8Array(N);
  const pat = PATTERNS[t.pattern];
  const ctx = { body, rim };
  for (let y = 0; y < PORTRAIT; y++) {
    for (let x = 0; x < PORTRAIT; x++) {
      const i = y * PORTRAIT + x;
      if (body[i]) {
        data[i] = pat && pat(x, y, ctx) ? 1 : 2;
      } else if (outline[i]) {
        data[i] = 1;
      }
    }
  }
  // paper halo only inside the silhouette, so we never bleach the background
  for (let i = 0; i < N; i++) if (halo[i] && body[i]) data[i] = 2;
  for (let i = 0; i < N; i++) if (feat[i]) data[i] = 1;

  // corruption: hide a deterministic, stable fraction of the drawn pixels
  const pct = Math.max(0, Math.min(100, integrity));
  if (pct < 100) {
    const hb = hashString('BITROT/ROT/' + t.id);
    const drawn = [];
    for (let i = 0; i < N; i++) if (data[i]) drawn.push(i);
    drawn.sort((a, b) => sub(hb, a) - sub(hb, b));
    const hideCount = Math.round(drawn.length * (1 - pct / 100));
    for (let k = drawn.length - hideCount; k < drawn.length; k++) data[drawn[k]] = 4;
  }

  const spr = { w: PORTRAIT, h: PORTRAIT, data };
  if (spriteCache.size > 512) spriteCache.clear();
  spriteCache.set(key, spr);
  return spr;
}

/** Roll a brand new Friend id from a Rng instance. */
export function rollFriendId(rng) {
  let id = rng.hex(6);
  if (id === STRAY_ID) id = 'A' + id.slice(1);
  return id;
}

/** Starting integrity of a freshly rescued Friend: 22%–48%, id-stable. */
export function startingIntegrity(id) {
  const h = hashString('BITROT/START/' + String(id).toUpperCase());
  return 22 + Math.floor(sub(h, 3) * 27);
}

export function rarityOrder(key) {
  return { COMMON: 0, RARE: 1, EPIC: 2, GENESIS: 3, STRAY: -1 }[key] ?? 0;
}
