// Talks to the BITROT server.
//
// The rule the client follows: when it is online, the server's save is the only
// save. The browser copy is a cache of it, never a source of truth, and nothing
// is ever merged. Offline, the game runs as a clearly-labelled local sandbox
// whose progress is not submitted — which is what keeps a dupe bug from ever
// being possible in the first place.

const CSRF_HEADER = 'x-bitrot-csrf';
const ACCOUNT_KEY = 'bitrot.account.v1';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export class Api {
  constructor(base = '') {
    this.base = base;
    this.csrf = null;
    this.account = null;
    this.standing = null;
    this.online = false;
    this.lastError = null;
  }

  async request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf && method !== 'GET') headers[CSRF_HEADER] = this.csrf;

    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      this.online = false;
      throw new ApiError(0, 'offline', err.message);
    }

    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const e = new ApiError(res.status, data?.error || 'http_' + res.status, data?.message || res.statusText);
      this.lastError = e;
      throw e;
    }
    if (data && typeof data.csrf === 'string') this.csrf = data.csrf;
    return data ?? {};
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body ?? {}); }

  /**
   * Find out who we are. Creates an anonymous account on first visit.
   * Returns { online, account, save } — `save` is null when offline.
   */
  async connect() {
    try {
      let me = await this.get('/api/me');
      if (!me.account) me = await this.post('/api/auth/register', {});
      this.online = true;
      this.account = me.account;
      this.standing = me.standing || null;
      if (me.recoveryKey) {
        rememberAccount({ id: me.account.id, recoveryKey: me.recoveryKey, name: me.account.name });
      }
      return { online: true, account: me.account, save: me.save, recoveryKey: me.recoveryKey || null };
    } catch (err) {
      this.online = false;
      this.lastError = err;
      return { online: false, account: null, save: null, reason: err.code };
    }
  }

  async restore(accountId, recoveryKey) {
    const out = await this.post('/api/auth/restore', { accountId, recoveryKey });
    this.online = true;
    this.account = out.account;
    this.standing = out.standing || null;
    rememberAccount({ id: out.account.id, recoveryKey, name: out.account.name });
    return out;
  }

  startRun() { return this.post('/api/run/start'); }
  submitRun(ticket, trace) { return this.post('/api/run/submit', { ticket, trace }); }
  buyUpgrade(id) { return this.post('/api/economy/upgrade', { id }); }
  burnRestore(friendId, toFull) { return this.post('/api/economy/restore', { friendId, toFull: !!toFull }); }
  equip(friendId) { return this.post('/api/economy/equip', { friendId }); }
  leaderboard() { return this.get('/api/leaderboard'); }
  rename(name) { return this.post('/api/account/name', { name }); }
}

/* ------------------------------------------------------------------ */

/**
 * The recovery key is kept locally so a returning player is not asked to type
 * it. It is a convenience cache, not an auth token: the session cookie is what
 * authenticates, and the server never accepts this value from anywhere else.
 */
export function rememberAccount(record) {
  try {
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(record));
  } catch { /* private mode, no big deal */ }
}

export function recallAccount() {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.recoveryKey !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function forgetAccount() {
  try { localStorage.removeItem(ACCOUNT_KEY); } catch { /* ignore */ }
}
