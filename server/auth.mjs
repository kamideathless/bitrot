// Accounts and sessions.
//
// There are no passwords and no email addresses: an account is a random id plus
// a one-time recovery key that the player keeps if they want to play on a second
// device. Nothing personal is stored, so there is nothing personal to leak.

import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const COOKIE_NAME = 'bitrot_session';

/* --------------------------------------------------------------- keys -- */

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Recovery keys are shown as 4 groups of 5 for people to write down. */
export function newRecoveryKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1
  const raw = randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += alphabet[raw[i] % alphabet.length];
  }
  return out;
}

export function normaliseRecoveryKey(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryKey(key, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(normaliseRecoveryKey(key), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return { hash: derived.toString('hex'), salt };
}

export function verifyRecoveryKey(key, hash, salt) {
  let derived;
  try {
    derived = hashRecoveryKey(key, salt).hash;
  } catch {
    return false;
  }
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ accounts -- */

const NAME_OK = /^[A-Za-z0-9 _.\-]{1,18}$/;

export function sanitiseName(raw, fallback) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!NAME_OK.test(name)) return fallback;
  return name;
}

export function defaultName() {
  return 'DIVER-' + randomBytes(2).toString('hex').toUpperCase();
}

/* ------------------------------------------------------------ sessions -- */

export function createSession(store, accountId, { sessionDays }) {
  const token = newToken(32);
  const csrf = newToken(24);
  const now = Date.now();
  store.q.insertSession.run(
    hashToken(token), accountId, csrf, now, now + sessionDays * 86400_000,
  );
  return { token, csrf };
}

/** Returns { account, session } or null. Expired rows are removed on sight. */
export function resolveSession(store, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const hash = hashToken(token);
  const session = store.q.sessionByHash.get(hash);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    store.q.deleteSession.run(hash);
    return null;
  }
  const account = store.q.accountById.get(session.account_id);
  if (!account || account.banned) return null;
  return { account, session, tokenHash: hash };
}

export function destroySession(store, token) {
  if (typeof token !== 'string') return;
  store.q.deleteSession.run(hashToken(token));
}

/** Constant-time compare for CSRF tokens. */
export function csrfMatches(expected, given) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function cookieHeader(token, { secureCookies, sessionDays }) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${sessionDays * 86400}`,
  ];
  if (secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookieHeader({ secureCookies }) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secureCookies) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
