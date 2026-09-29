// Input trace codec — shared by the client (which records) and the server
// (which replays).
//
// The whole anti-cheat design rests on one property: `Run` is deterministic.
// Given the same seed, the same stat block and the same sequence of intents it
// produces exactly the same result, every time, on any machine. So the client
// never reports a score — it reports what buttons were pressed, and the server
// replays the dive itself.
//
// For that to hold, the *live* game must feed the simulation the same quantised
// values that get recorded. `quantiseIntent` is therefore called on the hot
// path in play.js, not just here.

export const TRACE_VERSION = 1;

/** Ticks per second the simulation runs at. Must match main.js's STEP. */
export const TICK_RATE = 60;

/** Hard ceiling on a submitted run: 10 minutes. Bounds server replay cost. */
export const MAX_TICKS = TICK_RATE * 600;

/** Axis values are stored as integers -8..8, so a tick fits in two bytes. */
const AXIS_STEPS = 8;

/**
 * Snap an analogue intent onto the wire grid. Feeding the result back into the
 * simulation is what makes a replay bit-exact.
 */
export function quantiseIntent(intent) {
  const qx = clampAxis(Math.round((intent.ax || 0) * AXIS_STEPS));
  const qy = clampAxis(Math.round((intent.ay || 0) * AXIS_STEPS));
  return {
    ax: qx / AXIS_STEPS,
    ay: qy / AXIS_STEPS,
    purge: !!intent.purge,
    dash: !!intent.dash,
    code: packTick(qx, qy, !!intent.purge, !!intent.dash),
  };
}

function clampAxis(v) {
  return v < -AXIS_STEPS ? -AXIS_STEPS : v > AXIS_STEPS ? AXIS_STEPS : v | 0;
}

/** (-8..8, -8..8, bool, bool) -> 0..1023 */
export function packTick(qx, qy, purge, dash) {
  return ((qx + AXIS_STEPS) & 31) | (((qy + AXIS_STEPS) & 31) << 5) | (purge ? 1 << 10 : 0) | (dash ? 1 << 11 : 0);
}

/** 0..4095 -> intent usable by Run.update */
export function unpackTick(code) {
  const qx = (code & 31) - AXIS_STEPS;
  const qy = ((code >> 5) & 31) - AXIS_STEPS;
  return {
    ax: qx / AXIS_STEPS,
    ay: qy / AXIS_STEPS,
    purge: (code & (1 << 10)) !== 0,
    dash: (code & (1 << 11)) !== 0,
  };
}

/**
 * Records one code per tick and run-length encodes it. Real play holds the same
 * input for many frames, so a three minute dive compresses to a few hundred
 * pairs rather than 10 800 entries.
 */
export class TraceRecorder {
  constructor() {
    this.runs = [];      // [code, count, code, count, ...]
    this.ticks = 0;
    this.overflowed = false;
  }

  push(code) {
    if (this.ticks >= MAX_TICKS) { this.overflowed = true; return; }
    this.ticks++;
    const n = this.runs.length;
    if (n && this.runs[n - 2] === code && this.runs[n - 1] < 0xffff) {
      this.runs[n - 1]++;
    } else {
      this.runs.push(code, 1);
    }
  }

  encode() {
    return encodeTrace(this.runs);
  }
}

/**
 * Pairs -> base64url. Two bytes for the code, two for the count, big-endian.
 * A plain, boring format: no compression tricks the server has to trust.
 */
export function encodeTrace(pairs) {
  if (pairs.length % 2 !== 0) throw new Error('trace: odd pair list');
  const bytes = new Uint8Array(pairs.length * 2);
  for (let i = 0, o = 0; i < pairs.length; i += 2) {
    const code = pairs[i] & 0xffff;
    const count = pairs[i + 1] & 0xffff;
    if (count === 0) throw new Error('trace: zero-length run');
    bytes[o++] = code >> 8; bytes[o++] = code & 0xff;
    bytes[o++] = count >> 8; bytes[o++] = count & 0xff;
  }
  return bytesToBase64Url(bytes);
}

/**
 * base64url -> { pairs, ticks }. Throws on anything malformed; the caller is
 * expected to treat a throw as "reject this submission".
 */
export function decodeTrace(text, { maxTicks = MAX_TICKS } = {}) {
  if (typeof text !== 'string') throw new Error('trace: not a string');
  // Worst case is input that changes every single tick: one 4-byte pair per
  // tick, and base64 spends 4 characters per 3 bytes — so 16/3 characters per
  // tick. Anything past that cannot be a valid trace of `maxTicks` ticks.
  if (text.length > Math.ceil((16 / 3) * maxTicks) + 64) throw new Error('trace: too long');
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('trace: bad characters');
  const bytes = base64UrlToBytes(text);
  if (bytes.length % 4 !== 0) throw new Error('trace: truncated');

  const pairs = [];
  let ticks = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    const count = (bytes[i + 2] << 8) | bytes[i + 3];
    if (count === 0) throw new Error('trace: zero-length run');
    if (code > 0xfff) throw new Error('trace: bad tick code');
    ticks += count;
    if (ticks > maxTicks) throw new Error('trace: too many ticks');
    pairs.push(code, count);
  }
  return { pairs, ticks };
}

/** Walk a decoded trace tick by tick. */
export function* iterateTrace(pairs) {
  for (let i = 0; i < pairs.length; i += 2) {
    const intent = unpackTick(pairs[i]);
    for (let k = 0; k < pairs[i + 1]; k++) yield intent;
  }
}

/* ------------------------------------------------------------------ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function bytesToBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64[b2 & 63];
  }
  return out;
}

const B64_INDEX = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();

function base64UrlToBytes(text) {
  const n = text.length;
  const full = n >> 2;
  const rem = n & 3;
  if (rem === 1) throw new Error('trace: bad base64 length');
  const out = new Uint8Array(full * 3 + (rem ? rem - 1 : 0));
  let o = 0;
  const val = (i) => {
    const c = text.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c] : -1;
    if (v < 0) throw new Error('trace: bad base64');
    return v;
  };
  for (let i = 0; i + 3 < n; i += 4) {
    const v = (val(i) << 18) | (val(i + 1) << 12) | (val(i + 2) << 6) | val(i + 3);
    out[o++] = (v >> 16) & 255; out[o++] = (v >> 8) & 255; out[o++] = v & 255;
  }
  if (rem === 2) {
    const v = (val(n - 2) << 18) | (val(n - 1) << 12);
    out[o++] = (v >> 16) & 255;
  } else if (rem === 3) {
    const v = (val(n - 3) << 18) | (val(n - 2) << 12) | (val(n - 1) << 6);
    out[o++] = (v >> 16) & 255; out[o++] = (v >> 8) & 255;
  }
  return out;
}
