// Runtime configuration. Everything comes from the environment; there are no
// secrets in the repository and no usable default for one.

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(v);
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function secret() {
  const raw = process.env.BITROT_SECRET;
  if (raw && raw.length >= 32) return raw;
  if (raw) {
    throw new Error('BITROT_SECRET must be at least 32 characters');
  }
  // Never ship a hardcoded key. Without one, sessions simply do not survive a
  // restart — noisy, but safe.
  const generated = randomBytes(32).toString('base64url');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BITROT_SECRET is required when NODE_ENV=production');
  }
  console.warn(
    '[bitrot] BITROT_SECRET is not set — generated an ephemeral one.\n' +
    '         Sessions will be invalidated on restart. Set it for anything real.',
  );
  return generated;
}

export function loadConfig(overrides = {}) {
  const cfg = {
    root: ROOT,
    port: int('PORT', 4173, { min: 1, max: 65535 }),
    host: process.env.HOST || '127.0.0.1',
    dataDir: process.env.BITROT_DATA || join(ROOT, 'data'),
    dbFile: null,                       // filled below; ':memory:' in tests
    secret: null,
    secureCookies: bool('BITROT_SECURE_COOKIES', false),
    trustProxy: bool('BITROT_TRUST_PROXY', false),

    // origins allowed to make state-changing calls; same-origin always is
    allowedOrigins: (process.env.BITROT_ORIGINS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),

    limits: {
      bodyBytes: int('BITROT_MAX_BODY', 8 * 1024, { min: 512, max: 1 << 20 }),
      // worst-case trace is ~8/3 bytes per tick at the 600s cap, plus JSON overhead
      submitBytes: int('BITROT_MAX_SUBMIT', 320 * 1024, { min: 1024, max: 4 << 20 }),
      sessionDays: int('BITROT_SESSION_DAYS', 30, { min: 1, max: 365 }),
      runTicketMinutes: int('BITROT_TICKET_MINUTES', 20, { min: 1, max: 180 }),
      nameLength: 18,
      leaderboard: 50,
    },

    rate: {
      // requests per minute, per client ip
      global: int('BITROT_RATE_GLOBAL', 240, { min: 10, max: 100000 }),
      // account-scoped, per minute
      register: int('BITROT_RATE_REGISTER', 5, { min: 1, max: 1000 }),
      restore: int('BITROT_RATE_RESTORE', 10, { min: 1, max: 1000 }),
      runStart: int('BITROT_RATE_RUN_START', 30, { min: 1, max: 1000 }),
      runSubmit: int('BITROT_RATE_RUN_SUBMIT', 20, { min: 1, max: 1000 }),
      mutate: int('BITROT_RATE_MUTATE', 90, { min: 1, max: 10000 }),
    },
    ...overrides,
  };

  if (!cfg.dbFile) cfg.dbFile = join(cfg.dataDir, 'bitrot.sqlite');
  if (!cfg.secret) cfg.secret = overrides.secret || secret();
  return cfg;
}
