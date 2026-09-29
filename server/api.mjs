// The API. Every handler assumes the request is hostile.
//
// Rules the whole surface follows:
//   * the client sends intentions, never outcomes;
//   * the save in the database is the only save that counts;
//   * every mutation runs inside a transaction against the stored state;
//   * every input is checked against an explicit shape before it is used.

import { randomInt } from 'node:crypto';
import { defaultSave, normalizeSave } from '../src/core/store.js';
import {
  derivedStats, buyUpgrade, burnRestore, restoreCost, applyRunToSave,
  equipFriend, shardValueFor, UPGRADE_BY_ID,
} from '../src/game/economy.js';
import { isValidId } from '../src/game/friends.js';
import { replayRun, ReplayError } from './replay.mjs';
import {
  HttpError, badRequest, unauthorised, forbidden, sendJson, readJson, tooMany,
} from './http.mjs';
import {
  createSession, destroySession, newToken, newRecoveryKey, hashRecoveryKey,
  verifyRecoveryKey, normaliseRecoveryKey, sanitiseName, defaultName,
  cookieHeader, clearCookieHeader,
} from './auth.mjs';

/* ------------------------------------------------------------ helpers -- */

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

function loadSave(ctx) {
  const row = ctx.store.q.getSave.get(ctx.account.id);
  if (!row) return defaultSave();
  try {
    return normalizeSave(JSON.parse(row.state));
  } catch {
    // A save we cannot parse is a save we do not trust; start the player clean
    // rather than crashing the endpoint.
    return defaultSave();
  }
}

function writeSave(ctx, save) {
  ctx.store.q.updateSave.run(JSON.stringify(save), Date.now(), ctx.account.id);
}

function publicAccount(account) {
  return {
    id: account.public_id,
    name: account.display_name,
    createdAt: account.created_at,
  };
}

function standing(ctx) {
  const best = ctx.store.q.bestRunFor.get(ctx.account.id)?.score ?? 0;
  const rank = best > 0 ? ctx.store.q.rankOf.get(best)?.rank ?? null : null;
  return { bestScore: best, rank, players: ctx.store.q.runCount.get()?.n ?? 0 };
}

function requireAccount(ctx) {
  if (!ctx.account) throw unauthorised();
  return ctx.account;
}

/* --------------------------------------------------------------- auth -- */

async function register(ctx) {
  ctx.limit('register', ctx.ip, ctx.cfg.rate.register);
  const body = await readJson(ctx.req, ctx.cfg.limits.bodyBytes);
  const name = sanitiseName(body.name, defaultName());

  const recoveryKey = newRecoveryKey();
  const { hash, salt } = hashRecoveryKey(recoveryKey);
  const now = Date.now();
  const publicId = newToken(9);

  const session = ctx.store.tx(() => {
    const info = ctx.store.q.insertAccount.run(publicId, hash, salt, name, now, now);
    const accountId = Number(info.lastInsertRowid);
    ctx.store.q.insertSave.run(accountId, JSON.stringify(defaultSave()), now);
    return createSession(ctx.store, accountId, { sessionDays: ctx.cfg.limits.sessionDays });
  });

  ctx.setCookie(cookieHeader(session.token, {
    secureCookies: ctx.cfg.secureCookies,
    sessionDays: ctx.cfg.limits.sessionDays,
  }));

  // The only time the recovery key is ever transmitted.
  return {
    account: { id: publicId, name, createdAt: now },
    csrf: session.csrf,
    recoveryKey,
    save: defaultSave(),
    standing: { bestScore: 0, rank: null, players: 0 },
  };
}

async function restore(ctx) {
  ctx.limit('restore', ctx.ip, ctx.cfg.rate.restore);
  const body = await readJson(ctx.req, ctx.cfg.limits.bodyBytes);
  const publicId = str(body.accountId, 64);
  const key = normaliseRecoveryKey(body.recoveryKey);
  if (!publicId || key.length !== 20) throw badRequest('bad_credentials', 'account id and recovery key required');

  const account = ctx.store.q.accountByPublicId.get(publicId);
  // Always do the scrypt work, so a missing account and a wrong key cost the same.
  const ok = account
    ? verifyRecoveryKey(key, account.recovery_hash, account.recovery_salt)
    : verifyRecoveryKey(key, hashRecoveryKey('x').hash, 'deadbeef');

  if (!account || !ok || account.banned) {
    throw new HttpError(401, 'bad_credentials', 'that account id and key do not match');
  }

  // A restore is a fresh sign-in: drop every other session for the account.
  const session = ctx.store.tx(() => {
    ctx.store.q.deleteSessionsFor.run(account.id);
    ctx.store.q.touchAccount.run(Date.now(), account.id);
    return createSession(ctx.store, account.id, { sessionDays: ctx.cfg.limits.sessionDays });
  });
  ctx.setCookie(cookieHeader(session.token, {
    secureCookies: ctx.cfg.secureCookies,
    sessionDays: ctx.cfg.limits.sessionDays,
  }));

  ctx.account = account;
  return {
    account: publicAccount(account),
    csrf: session.csrf,
    save: loadSave(ctx),
    standing: standing(ctx),
  };
}

function logout(ctx) {
  if (ctx.sessionToken) destroySession(ctx.store, ctx.sessionToken);
  ctx.setCookie(clearCookieHeader({ secureCookies: ctx.cfg.secureCookies }));
  return { ok: true };
}

function me(ctx) {
  if (!ctx.account) return { account: null, save: null, csrf: null };
  return {
    account: publicAccount(ctx.account),
    csrf: ctx.session.csrf,
    save: loadSave(ctx),
    standing: standing(ctx),
  };
}

async function rename(ctx) {
  requireAccount(ctx);
  ctx.limit('mutate', String(ctx.account.id), ctx.cfg.rate.mutate);
  const body = await readJson(ctx.req, ctx.cfg.limits.bodyBytes);
  const name = sanitiseName(body.name, null);
  if (!name) throw badRequest('bad_name', 'letters, digits, spaces, dot, dash and underscore; 18 max');
  ctx.store.q.renameAccount.run(name, ctx.account.id);
  return { account: { ...publicAccount(ctx.account), name } };
}

/* --------------------------------------------------------------- runs -- */

function runStart(ctx) {
  requireAccount(ctx);
  ctx.limit('run_start', String(ctx.account.id), ctx.cfg.rate.runStart);

  const save = loadSave(ctx);
  const stats = derivedStats(save);
  const shardValue = shardValueFor(save);
  const seed = randomInt(1, 2 ** 31 - 1);
  const id = newToken(18);
  const now = Date.now();

  ctx.store.q.insertTicket.run(
    id, ctx.account.id, seed, JSON.stringify(stats), shardValue,
    now, now + ctx.cfg.limits.runTicketMinutes * 60_000,
  );
  return { ticket: id, seed, stats, shardValue, expiresIn: ctx.cfg.limits.runTicketMinutes * 60 };
}

async function runSubmit(ctx) {
  requireAccount(ctx);
  ctx.limit('run_submit', String(ctx.account.id), ctx.cfg.rate.runSubmit);

  const body = await readJson(ctx.req, ctx.cfg.limits.submitBytes);
  const ticketId = str(body.ticket, 64);
  const trace = str(body.trace, ctx.cfg.limits.submitBytes);
  if (!ticketId || trace === null) throw badRequest('bad_submission', 'ticket and trace required');

  const ticket = ctx.store.q.getTicket.get(ticketId);
  if (!ticket || ticket.account_id !== ctx.account.id) {
    throw new HttpError(404, 'no_ticket', 'unknown dive');
  }
  if (ticket.consumed_at !== null) throw forbidden('ticket_used', 'that dive was already submitted');
  if (ticket.expires_at < Date.now()) throw forbidden('ticket_expired', 'that dive ticket has expired');

  // Claim the ticket first: a replay costs CPU, and claiming it up front means
  // two concurrent submissions of the same dive cannot both get through.
  const claimed = ctx.store.q.consumeTicket.run(Date.now(), ticketId);
  if (claimed.changes !== 1) throw forbidden('ticket_used', 'that dive was already submitted');

  let replay;
  try {
    replay = replayRun({
      seed: ticket.seed,
      stats: JSON.parse(ticket.stats),
      shardValue: ticket.shard_value,
    }, trace);
  } catch (err) {
    if (err instanceof ReplayError) throw badRequest(err.code, err.message);
    throw err;
  }

  const result = replay.result;
  const applied = ctx.store.tx(() => {
    const save = loadSave(ctx);
    const next = applyRunToSave(save, result);
    writeSave(ctx, next.save);
    ctx.store.q.insertRun.run(
      ticketId, ctx.account.id,
      Math.round(result.score), Math.round(next.payout), result.time,
      result.sector, result.shards, result.rescues, result.defrags,
      Date.now(),
    );
    return next;
  });

  return {
    // the server's own numbers, not the client's
    result: {
      time: result.time, sector: result.sector, shards: result.shards,
      rescues: result.rescues, defrags: result.defrags, purges: result.purges,
      hits: result.hits, lostShards: result.lostShards, lostCapsules: result.lostCapsules,
      coverage: result.coverage, rescued: result.rescued,
      rf: result.rf, score: result.score,
    },
    payout: applied.payout,
    fresh: applied.fresh.map((f) => f.id),
    dupes: applied.dupes,
    save: applied.save,
    standing: standing(ctx),
    verifiedIn: replay.ms,
  };
}

/* ------------------------------------------------------------ economy -- */

async function upgrade(ctx) {
  requireAccount(ctx);
  ctx.limit('mutate', String(ctx.account.id), ctx.cfg.rate.mutate);
  const body = await readJson(ctx.req, ctx.cfg.limits.bodyBytes);
  const id = str(body.id, 32);
  if (!id || !UPGRADE_BY_ID[id]) throw badRequest('unknown_upgrade', 'no such upgrade');

  const out = ctx.store.tx(() => {
    const save = loadSave(ctx);
    const res = buyUpgrade(save, id);
    if (!res.ok) throw badRequest('refused', res.reason);
    writeSave(ctx, res.save);
    return res;
  });
  return { save: out.save, spent: out.spent };
}

async function restoreFriend(ctx) {
  requireAccount(ctx);
  ctx.limit('mutate', String(ctx.account.id), ctx.cfg.rate.mutate);
  const body = await readJson(ctx.req, ctx.cfg.limits.bodyBytes);
  const friendId = str(body.friendId, 8);
  if (!friendId || !isValidId(friendId)) throw badRequest('bad_friend', 'not a Friend id');
  const toFull = body.toFull === true;

  const out = ctx.store.tx(() => {
    let save = loadSave(ctx);
    let spent = 0;
    let restored = false;
    let steps = 0;
    for (;;) {
      const res = burnRestore(save, friendId);
      if (!res.ok) {
        if (spent === 0) throw badRequest('refused', res.reason);
        break;
      }
      save = res.save;
      spent += res.spent;
      restored = res.restored;
      // 10 points per step, so ten steps is the whole bar; the guard is belt
      // and braces against a future change to RESTORE_STEP.
      if (!toFull || restored || ++steps > 32) break;
    }
    writeSave(ctx, save);
    return { save, spent, restored };
  });
  return out;
}

async function equip(ctx) {
  requireAccount(ctx);
  ctx.limit('mutate', String(ctx.account.id), ctx.cfg.rate.mutate);
  const body = await readJson(ctx.req, ctx.cfg.limits.bodyBytes);
  const friendId = str(body.friendId, 8);
  if (!friendId || !isValidId(friendId)) throw badRequest('bad_friend', 'not a Friend id');

  const out = ctx.store.tx(() => {
    const save = loadSave(ctx);
    const res = equipFriend(save, friendId);
    if (!res.ok) throw badRequest('refused', res.reason);
    writeSave(ctx, res.save);
    return res;
  });
  return { save: out.save };
}

/* -------------------------------------------------------- leaderboard -- */

function leaderboard(ctx) {
  const rows = ctx.store.q.topRuns.all(ctx.cfg.limits.leaderboard);
  return {
    entries: rows.map((r, i) => ({
      rank: i + 1,
      name: r.display_name,
      score: r.score,
      seconds: r.seconds,
      sector: r.sector,
      rescues: r.rescues,
      at: r.verified_at,
      you: ctx.account ? r.public_id === ctx.account.public_id : false,
    })),
    standing: ctx.account ? standing(ctx) : null,
  };
}

/* --------------------------------------------------------------- table -- */

/** method + path -> { handler, auth, mutating } */
export const ROUTES = {
  'GET /api/me': { handler: me },
  'GET /api/leaderboard': { handler: leaderboard },
  'GET /api/health': { handler: () => ({ ok: true }) },

  'POST /api/auth/register': { handler: register, mutating: true },
  'POST /api/auth/restore': { handler: restore, mutating: true },
  'POST /api/auth/logout': { handler: logout, mutating: true },
  'POST /api/account/name': { handler: rename, mutating: true, auth: true },

  'POST /api/run/start': { handler: runStart, mutating: true, auth: true },
  'POST /api/run/submit': { handler: runSubmit, mutating: true, auth: true },

  'POST /api/economy/upgrade': { handler: upgrade, mutating: true, auth: true },
  'POST /api/economy/restore': { handler: restoreFriend, mutating: true, auth: true },
  'POST /api/economy/equip': { handler: equip, mutating: true, auth: true },
};

export { sendJson };
