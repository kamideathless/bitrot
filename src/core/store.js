// Save-game persistence. Pure helpers live in game/economy.js; this module only
// deals with shape, defaults, migration and localStorage access.

export const SAVE_KEY = 'bitrot.save.v1';
export const SAVE_VERSION = 1;

export function defaultSave() {
  return {
    v: SAVE_VERSION,
    rf: 0,
    rfEarned: 0,
    rfBurned: 0,
    runs: 0,
    best: { score: 0, time: 0, sector: 1, rescues: 0 },
    upgrades: { energy: 0, purge: 0, scar: 0, core: 0, boots: 0, magnet: 0 },
    friends: [],        // [{ id, integrity, rescuedAt }]
    equipped: null,
    seenIntro: false,
    totals: { shards: 0, rescues: 0, defrags: 0, purges: 0, duplicates: 0, time: 0 },
    settings: { mute: false, reduced: false, crt: true, invert: false, smooth: true },
  };
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** Merge a loaded save over the defaults, dropping anything malformed. */
export function normalizeSave(raw) {
  const base = defaultSave();
  if (!isPlainObject(raw)) return base;

  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const clampInt = (v, lo, hi, d = 0) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));

  base.rf = Math.max(0, Math.round(num(raw.rf)));
  base.rfEarned = Math.max(0, Math.round(num(raw.rfEarned)));
  base.rfBurned = Math.max(0, Math.round(num(raw.rfBurned)));
  base.runs = Math.max(0, Math.round(num(raw.runs)));
  base.seenIntro = !!raw.seenIntro;

  if (isPlainObject(raw.best)) {
    base.best.score = Math.max(0, Math.round(num(raw.best.score)));
    base.best.time = Math.max(0, num(raw.best.time));
    base.best.sector = Math.max(1, Math.round(num(raw.best.sector, 1)));
    base.best.rescues = Math.max(0, Math.round(num(raw.best.rescues)));
  }

  if (isPlainObject(raw.upgrades)) {
    for (const k of Object.keys(base.upgrades)) {
      base.upgrades[k] = clampInt(raw.upgrades[k], 0, 8, 0);
    }
  }

  if (Array.isArray(raw.friends)) {
    const seen = new Set();
    for (const f of raw.friends) {
      if (!isPlainObject(f)) continue;
      const id = typeof f.id === 'string' ? f.id.toUpperCase().slice(0, 12) : null;
      if (!id || !/^[0-9A-F]{6}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      base.friends.push({
        id,
        integrity: clampInt(f.integrity, 0, 100, 25),
        rescuedAt: Math.max(0, Math.round(num(f.rescuedAt))),
      });
    }
  }

  if (typeof raw.equipped === 'string' && base.friends.some((f) => f.id === raw.equipped)) {
    base.equipped = raw.equipped;
  }

  if (isPlainObject(raw.totals)) {
    for (const k of Object.keys(base.totals)) {
      base.totals[k] = Math.max(0, num(raw.totals[k]));
    }
  }

  if (isPlainObject(raw.settings)) {
    base.settings.mute = !!raw.settings.mute;
    base.settings.reduced = !!raw.settings.reduced;
    base.settings.crt = raw.settings.crt !== false;
    base.settings.invert = !!raw.settings.invert;
    base.settings.smooth = raw.settings.smooth !== false;
  }

  return base;
}

export function loadSave(storage = safeStorage()) {
  if (!storage) return defaultSave();
  try {
    const raw = storage.getItem(SAVE_KEY);
    if (!raw) return defaultSave();
    return normalizeSave(JSON.parse(raw));
  } catch (err) {
    console.warn('BITROT: corrupt save, starting fresh.', err);
    return defaultSave();
  }
}

export function writeSave(save, storage = safeStorage()) {
  if (!storage) return false;
  try {
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch (err) {
    console.warn('BITROT: could not persist save.', err);
    return false;
  }
}

export function clearSave(storage = safeStorage()) {
  if (!storage) return;
  try { storage.removeItem(SAVE_KEY); } catch { /* ignore */ }
}

function safeStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__bitrot_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
