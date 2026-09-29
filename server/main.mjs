// BITROT server: static hosting plus the verified-play API.
//
//   node server/main.mjs            # http://127.0.0.1:4173
//   PORT=8080 BITROT_SECRET=... node server/main.mjs
//
// `createApp` is exported so the tests can drive the real thing on an ephemeral
// port against an in-memory database.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { ROUTES } from './api.mjs';
import {
  securityHeaders, serveStatic, sendJson, send, HttpError, RateLimiter,
  clientIp, originAllowed, tooMany, forbidden, unauthorised,
} from './http.mjs';
import { parseCookies, resolveSession, COOKIE_NAME, csrfMatches } from './auth.mjs';

const CSRF_HEADER = 'x-bitrot-csrf';

export function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const store = openDatabase(cfg.dbFile);
  const limiter = new RateLimiter();
  const baseHeaders = securityHeaders(cfg);

  const sweep = setInterval(() => store.sweep(), 10 * 60_000);
  sweep.unref?.();

  const server = createServer(async (req, res) => {
    const headers = { ...baseHeaders };
    let cookieToSet = null;

    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const path = url.pathname;
      const method = req.method || 'GET';

      // one coarse limit in front of everything
      const global = limiter.take('ip', clientIp(req, cfg), cfg.rate.global);
      if (!global.ok) throw tooMany(global.retryAfter);

      if (!path.startsWith('/api/')) {
        if (method !== 'GET' && method !== 'HEAD') {
          throw new HttpError(405, 'method_not_allowed', 'GET only');
        }
        await serveStatic(req, res, cfg, path, headers);
        return;
      }

      const route = ROUTES[`${method} ${path}`];
      if (!route) {
        // distinguish "wrong verb" from "no such endpoint" for a nicer client
        const otherVerb = Object.keys(ROUTES).some((k) => k.endsWith(` ${path}`));
        throw new HttpError(otherVerb ? 405 : 404, otherVerb ? 'method_not_allowed' : 'not_found', 'no such endpoint');
      }

      if (route.mutating && !originAllowed(req, cfg)) {
        throw forbidden('bad_origin', 'cross-origin writes are not allowed');
      }

      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies[COOKIE_NAME];
      const resolved = sessionToken ? resolveSession(store, sessionToken) : null;

      // CSRF: a cross-site page can make the browser send the cookie, but it
      // cannot read the token to echo it back in a custom header.
      if (route.mutating && resolved && !isSessionlessAuth(path)) {
        if (!csrfMatches(resolved.session.csrf, req.headers[CSRF_HEADER])) {
          throw forbidden('bad_csrf', 'missing or wrong CSRF token');
        }
      }
      if (route.auth && !resolved) throw unauthorised();

      const ctx = {
        req, res, cfg, store,
        ip: clientIp(req, cfg),
        account: resolved?.account || null,
        session: resolved?.session || null,
        sessionToken,
        setCookie(value) { cookieToSet = value; },
        limit(bucket, key, max) {
          const hit = limiter.take(bucket, key, max);
          if (!hit.ok) throw tooMany(hit.retryAfter);
        },
      };

      const payload = await route.handler(ctx);
      if (cookieToSet) headers['set-cookie'] = cookieToSet;
      sendJson(res, 200, payload ?? { ok: true }, headers);
    } catch (err) {
      handleError(res, err, headers, cookieToSet);
    }
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 10_000;

  return {
    cfg,
    store,
    server,
    listen(port = cfg.port, host = cfg.host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      clearInterval(sweep);
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

/** Register and restore create the session, so they have no CSRF token yet. */
function isSessionlessAuth(path) {
  return path === '/api/auth/register' || path === '/api/auth/restore';
}

function handleError(res, err, headers, cookieToSet) {
  if (res.writableEnded) return;
  if (cookieToSet) headers['set-cookie'] = cookieToSet;

  if (err instanceof HttpError) {
    if (err.extra?.retryAfter) headers['retry-after'] = String(err.extra.retryAfter);
    sendJson(res, err.status, { error: err.code, message: err.message }, headers);
    return;
  }
  // Anything unexpected: log it server-side, tell the client nothing.
  console.error('[bitrot] unhandled error', err);
  sendJson(res, 500, { error: 'internal', message: 'something broke' }, headers);
}

/* --------------------------------------------------------------- boot -- */

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  const app = createApp();
  const addr = await app.listen();
  const shown = typeof addr === 'string' ? addr : `http://${app.cfg.host}:${addr.port}/`;
  console.log(`BITROT server listening on ${shown}`);
  console.log(`  data:    ${app.cfg.dbFile}`);
  console.log(`  cookies: ${app.cfg.secureCookies ? 'Secure' : 'not Secure (set BITROT_SECURE_COOKIES=1 behind TLS)'}`);

  const bye = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
