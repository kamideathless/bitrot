// Deterministic hashing + PRNG. Everything in BITROT that must be reproducible
// (Friend traits, arena seeds, automaton bit-flips) goes through here.

/** FNV-1a style string hash -> uint32 */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // final avalanche so neighbouring ids diverge hard
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Cheap 3-int spatial hash -> float in [0,1). Used by the automaton. */
export function hash3(x, y, z) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** mulberry32 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) {
    this.seed = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    this._next = mulberry32(this.seed);
  }
  next() { return this._next(); }
  int(n) { return Math.floor(this._next() * n); }
  range(a, b) { return a + this._next() * (b - a); }
  intRange(a, b) { return a + Math.floor(this._next() * (b - a + 1)); }
  chance(p) { return this._next() < p; }
  pick(arr) { return arr[Math.floor(this._next() * arr.length)]; }
  /** Weighted pick. weights is an array of numbers matching arr. */
  weighted(arr, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this._next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r < 0) return arr[i];
    }
    return arr[arr.length - 1];
  }
  hex(n) {
    let s = '';
    const D = '0123456789ABCDEF';
    for (let i = 0; i < n; i++) s += D[this.int(16)];
    return s;
  }
}

/** Deterministic per-key sub-random from a base hash, in [0,1). */
export function sub(hash, key) {
  let h = (hash ^ Math.imul(key + 1, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
