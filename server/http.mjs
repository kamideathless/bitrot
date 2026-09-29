// Request plumbing: security headers, body limits, rate limiting and a static
// file server that cannot be talked out of its root.

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep, relative, isAbsolute } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Paths that must never be reachable over HTTP, whatever the URL says. */
const FORBIDDEN_PREFIXES = ['data', 'server', '.git', 'node_modules'];

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeaders(cfg) {
  const h = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (cfg.secureCookies) {
    h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return h;
}

/* ------------------------------------------------------------ responses -- */

export function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const payload = body === null || body === undefined ? Buffer.alloc(0)
    : Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...headers, 'content-length': payload.length });
  res.end(payload);
}

export function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (code, msg, extra) => new HttpError(400, code, msg, extra);
export const unauthorised = (msg = 'sign in first') => new HttpError(401, 'unauthorised', msg);
export const forbidden = (code, msg) => new HttpError(403, code, msg);
export const tooMany = (retryAfter) => new HttpError(429, 'rate_limited', 'slow down', { retryAfter });

/* ----------------------------------------------------------------- body -- */

/** Read a JSON body with a hard byte ceiling. Never buffers past the limit. */
export async function readJson(req, limitBytes) {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new HttpError(413, 'body_too_large', `body must be under ${limitBytes} bytes`);
  }
  const type = String(req.headers['content-type'] || '');
  if (type && !type.startsWith('application/json')) {
    throw badRequest('bad_content_type', 'expected application/json');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      req.destroy();
      throw new HttpError(413, 'body_too_large', `body must be under ${limitBytes} bytes`);
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('bad_json', 'body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('bad_json', 'body must be a JSON object');
  }
  return parsed;
}

/* ----------------------------------------------------------- rate limit -- */

/**
 * Fixed-window counters. Deliberately simple, with a bounded map so that a
 * flood of distinct keys cannot itself become the denial of service.
 */
export class RateLimiter {
  constructor({ windowMs = 60_000, maxKeys = 20_000 } = {}) {
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /** @returns {{ok: true} | {ok: false, retryAfter: number}} */
  take(bucket, key, limit) {
    const now = Date.now();
    const id = `${bucket}\u0000${key}`;
    let entry = this.hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      if (this.hits.size >= this.maxKeys) this.evict(now);
      this.hits.set(id, entry);
    }
    entry.count++;
    if (entry.count > limit) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    }
    return { ok: true };
  }

  evict(now) {
    for (const [k, v] of this.hits) {
      if (v.resetAt <= now) this.hits.delete(k);
    }
    // still full: drop the oldest quarter rather than grow without bound
    if (this.hits.size >= this.maxKeys) {
      let drop = Math.ceil(this.maxKeys / 4);
      for (const k of this.hits.keys()) {
        this.hits.delete(k);
        if (--drop <= 0) break;
      }
    }
  }
}

/** Client address. Only trusts x-forwarded-for when explicitly configured. */
export function clientIp(req, cfg) {
  if (cfg.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length < 256) {
      const first = fwd.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

/* --------------------------------------------------------------- origin -- */

/**
 * Same-origin enforcement for state-changing requests. Combined with
 * SameSite=Strict cookies and a required CSRF header this closes CSRF from
 * three independent directions.
 */
export function originAllowed(req, cfg) {
  const origin = req.headers.origin;
  if (!origin) return true;                    // same-origin fetch, or a curl
  if (cfg.allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- static -- */

export async function serveStatic(req, res, cfg, urlPath, headers) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    throw badRequest('bad_path', 'undecodable path');
  }
  if (rel.includes('\0')) throw badRequest('bad_path', 'null byte in path');
  if (rel.endsWith('/')) rel += 'index.html';

  const target = normalize(join(cfg.root, rel));
  const rootWithSep = cfg.root.endsWith(sep) ? cfg.root : cfg.root + sep;
  if (target !== cfg.root.replace(/[\\/]$/, '') && !target.startsWith(rootWithSep)) {
    throw forbidden('outside_root', 'nope');
  }

  const relFromRoot = relative(cfg.root, target);
  if (!relFromRoot || isAbsolute(relFromRoot) || relFromRoot.startsWith('..')) {
    throw forbidden('outside_root', 'nope');
  }
  const first = relFromRoot.split(/[\\/]/)[0];
  if (FORBIDDEN_PREFIXES.includes(first) || (first.startsWith('.') && first !== '.well-known')) {
    throw new HttpError(404, 'not_found', 'not found');
  }

  const info = await stat(target).catch(() => null);
  if (!info || !info.isFile()) throw new HttpError(404, 'not_found', 'not found');

  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    send(res, 304, null, { ...headers, etag, 'cache-control': 'no-cache' });
    return;
  }
  const body = await readFile(target);
  send(res, 200, body, {
    ...headers,
    'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-cache',
    etag,
  });
}
