// End-to-end tests against the real HTTP server on an ephemeral port with an
// in-memory database. No mocks: if these pass, the server passes.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createApp } from '../server/main.mjs';
import { Run, RunState } from '../src/game/run.js';
import { TraceRecorder, quantiseIntent, encodeTrace, TICK_RATE } from '../src/game/trace.js';
import { UPGRADES } from '../src/game/economy.js';

let app;
let base;

before(async () => {
  app = createApp({
    dbFile: ':memory:',
    secret: 'test-secret-that-is-definitely-long-enough',
    host: '127.0.0.1',
    // keep the limiters generous so the suite does not trip them
    rate: {
      global: 100000, register: 10000, restore: 10000,
      runStart: 10000, runSubmit: 10000, mutate: 10000,
    },
  });
  const addr = await app.listen(0);
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => { await app.close(); });

/* ------------------------------------------------------------ client -- */

/** A browser-ish client: keeps the cookie jar and the CSRF token. */
class Client {
  constructor() { this.cookie = null; this.csrf = null; }

  async call(method, path, body, extraHeaders = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-bitrot-csrf'] = this.csrf;
    Object.assign(headers, extraHeaders);   // the caller always wins

    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    if (json?.csrf) this.csrf = json.csrf;
    return { status: res.status, body: json, headers: res.headers };
  }

  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b, h) { return this.call('POST', p, b ?? {}, h); }
}

/** A GET with the request line written by hand, so the path is sent verbatim. */
function rawGet(path) {
  const port = Number(new URL(base).port);
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let out = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => { out += d; if (out.length > 65536) sock.destroy(); });
    sock.on('close', () => resolve(out));
    sock.on('error', reject);
    sock.setTimeout(5000, () => { sock.destroy(); resolve(out || 'HTTP/1.1 000 timeout'); });
  });
}

async function newPlayer(name = 'TESTER') {
  const c = new Client();
  const r = await c.post('/api/auth/register', { name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { client: c, ...r.body };
}

/**
 * Play a real dive locally the way the browser does, recording the trace.
 * Returns the trace plus the result the client *would* have shown.
 */
function playLocally(seed, stats, { pilot, maxSeconds = 420 } = {}) {
  const run = new Run({ stats, seed });
  const rec = new TraceRecorder();
  const step = 1 / TICK_RATE;
  const cap = Math.round(maxSeconds * TICK_RATE);
  let i = 0;
  // play it out properly: the server only scores dives that actually ended
  while (run.state === RunState.PLAYING && i < cap) {
    const raw = pilot ? pilot(run, i) : { ax: 0, ay: 0, purge: false, dash: false };
    const q = quantiseIntent(raw);
    rec.push(q.code);
    run.update(step, q);
    run.drainEvents();
    i++;
  }
  assert.equal(run.state, RunState.OVER, `the pilot survived past ${maxSeconds}s`);
  return { trace: rec.encode(), run, ticks: rec.ticks };
}

const chaser = (r, i) => {
  const t = r.capsule || r.shards[0];
  if (!t) return { ax: 0, ay: 0, purge: i % 40 === 0 };
  const dx = t.x - r.x, dy = t.y - r.y;
  const d = Math.hypot(dx, dy) || 1;
  return { ax: dx / d, ay: dy / d, purge: i % 30 === 0, dash: i % 200 === 0 };
};

/* ------------------------------------------------------------- basics -- */

test('health and security headers', async () => {
  const c = new Client();
  const r = await c.get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('an anonymous visitor gets a null account, not an error', async () => {
  const c = new Client();
  const r = await c.get('/api/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.account, null);
  assert.equal(r.body.save, null);
});

test('register issues a session cookie, a csrf token and one recovery key', async () => {
  const { client, account, recoveryKey, save, csrf } = await newPlayer('ZERO COOL');
  assert.equal(account.name, 'ZERO COOL');
  assert.match(recoveryKey, /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  assert.ok(csrf && csrf.length > 16);
  assert.equal(save.rf, 0);
  assert.match(client.cookie, /^bitrot_session=/);

  const me = await client.get('/api/me');
  assert.equal(me.body.account.id, account.id);
  // the recovery key is never handed out again
  assert.equal(me.body.recoveryKey, undefined);
});

test('the session cookie is HttpOnly, SameSite=Strict and path-scoped', async () => {
  const res = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
});

test('display names are sanitised, not trusted', async () => {
  const { account } = await newPlayer('<script>alert(1)</script>');
  assert.ok(!account.name.includes('<'), `got ${account.name}`);
  assert.match(account.name, /^DIVER-[0-9A-F]{4}$/);
});

/* ------------------------------------------------------------- replay -- */

test('a genuine dive is accepted and the server derives the numbers itself', async () => {
  const { client } = await newPlayer();
  const start = await client.post('/api/run/start');
  assert.equal(start.status, 200);
  assert.ok(Number.isInteger(start.body.seed));
  assert.ok(start.body.ticket.length > 10);

  const local = playLocally(start.body.seed, start.body.stats, { pilot: chaser });
  const submit = await client.post('/api/run/submit', {
    ticket: start.body.ticket, trace: local.trace,
  });
  assert.equal(submit.status, 200, JSON.stringify(submit.body));

  // the server's replay must match what the browser simulated, exactly
  const mine = local.run.result(start.body.shardValue);
  assert.equal(submit.body.result.score, mine.score);
  assert.equal(submit.body.result.shards, mine.shards);
  assert.equal(submit.body.result.rescues, mine.rescues);
  assert.deepEqual(submit.body.result.rescued, mine.rescued);
  assert.equal(submit.body.result.time.toFixed(4), mine.time.toFixed(4));

  assert.equal(submit.body.save.runs, 1);
  assert.equal(submit.body.save.rf, submit.body.payout);
});

test('a ticket can only be spent once', async () => {
  const { client } = await newPlayer();
  const start = await client.post('/api/run/start');
  const local = playLocally(start.body.seed, start.body.stats, { pilot: chaser });

  const first = await client.post('/api/run/submit', { ticket: start.body.ticket, trace: local.trace });
  assert.equal(first.status, 200);
  const second = await client.post('/api/run/submit', { ticket: start.body.ticket, trace: local.trace });
  assert.equal(second.status, 403);
  assert.equal(second.body.error, 'ticket_used');
});

test('a ticket belongs to the account that asked for it', async () => {
  const a = await newPlayer('AAA');
  const b = await newPlayer('BBB');
  const start = await a.client.post('/api/run/start');
  const local = playLocally(start.body.seed, start.body.stats, { pilot: chaser });

  const stolen = await b.client.post('/api/run/submit', { ticket: start.body.ticket, trace: local.trace });
  assert.equal(stolen.status, 404);
  assert.equal(stolen.body.error, 'no_ticket');
});

test('a trace played against a different seed does not produce a different score', async () => {
  const { client } = await newPlayer();
  const start = await client.post('/api/run/start');
  // play against a seed of our own choosing, then submit under the real ticket
  const local = playLocally(start.body.seed + 1, start.body.stats, { pilot: chaser });
  const mine = local.run.result(start.body.shardValue);

  const submit = await client.post('/api/run/submit', { ticket: start.body.ticket, trace: local.trace });
  // it either fails outright or scores whatever the *server's* seed produces —
  // what it must never do is hand back the score the client engineered
  if (submit.status === 200) {
    assert.notEqual(submit.body.result.score, mine.score);
  } else {
    assert.equal(submit.status, 400);
  }
});

test('a claimed score in the submission body is ignored', async () => {
  const { client } = await newPlayer();
  const start = await client.post('/api/run/start');
  const local = playLocally(start.body.seed, start.body.stats, { pilot: chaser });

  const submit = await client.post('/api/run/submit', {
    ticket: start.body.ticket,
    trace: local.trace,
    score: 999999999,
    rf: 999999999,
    result: { score: 999999999, rescues: 99 },
  });
  assert.equal(submit.status, 200);
  assert.ok(submit.body.result.score < 1e6, `score was ${submit.body.result.score}`);
  assert.ok(submit.body.save.rf < 1e6);
});

test('garbage traces are rejected, not simulated', async () => {
  const { client } = await newPlayer();
  for (const trace of ['', '!!!!', 'AAA', 'A'.repeat(300), '////']) {
    const start = await client.post('/api/run/start');
    const r = await client.post('/api/run/submit', { ticket: start.body.ticket, trace });
    assert.equal(r.status, 400, `trace ${JSON.stringify(trace)} gave ${r.status}`);
  }
});

test('a trace that never ends the run is refused', async () => {
  const { client } = await newPlayer();
  const start = await client.post('/api/run/start');
  // one tick of standing still: the dive is nowhere near over
  const trace = encodeTrace([quantiseIntent({ ax: 0, ay: 0 }).code, 60]);
  const r = await client.post('/api/run/submit', { ticket: start.body.ticket, trace });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'run_unfinished');
});

test('an over-long trace is refused before it is replayed', async () => {
  const { client } = await newPlayer();
  const start = await client.post('/api/run/start');
  const code = quantiseIntent({ ax: 0, ay: 0 }).code;
  const pairs = [];
  for (let i = 0; i < 40; i++) pairs.push(code, 0xffff);   // ~2.6M ticks
  const r = await client.post('/api/run/submit', { ticket: start.body.ticket, trace: encodeTrace(pairs) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_trace');
});

/* ------------------------------------------------------------ economy -- */

test('upgrades are paid for out of the stored balance, not a claimed one', async () => {
  const { client } = await newPlayer();
  const broke = await client.post('/api/economy/upgrade', { id: 'purge' });
  assert.equal(broke.status, 400);
  assert.equal(broke.body.message, 'NOT ENOUGH RF');

  // earn honestly
  let save = null;
  for (let i = 0; i < 6; i++) {
    const start = await client.post('/api/run/start');
    const local = playLocally(start.body.seed, start.body.stats, { pilot: chaser });
    const s = await client.post('/api/run/submit', { ticket: start.body.ticket, trace: local.trace });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    save = s.body.save;
    if (save.rf >= UPGRADES[0].costs[0]) break;
  }
  assert.ok(save.rf >= UPGRADES[0].costs[0], `only earned ${save.rf} RF`);

  const before = save.rf;
  const bought = await client.post('/api/economy/upgrade', { id: 'purge' });
  assert.equal(bought.status, 200);
  assert.equal(bought.body.save.upgrades.purge, 1);
  assert.equal(bought.body.save.rf, before - bought.body.spent);
});

test('unknown upgrade ids are rejected', async () => {
  const { client } = await newPlayer();
  const r = await client.post('/api/economy/upgrade', { id: '../../etc/passwd' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'unknown_upgrade');
});

test('you cannot equip or restore a Friend you do not own', async () => {
  const { client } = await newPlayer();
  const equip = await client.post('/api/economy/equip', { friendId: 'ABCDEF' });
  assert.equal(equip.status, 400);
  assert.equal(equip.body.message, 'NOT OWNED');

  const burn = await client.post('/api/economy/restore', { friendId: 'ABCDEF' });
  assert.equal(burn.status, 400);
  assert.equal(burn.body.message, 'NOT OWNED');

  const bad = await client.post('/api/economy/restore', { friendId: 'zzz' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_friend');
});

/* ---------------------------------------------------------------- authz -- */

test('every mutating endpoint needs a session', async () => {
  const anon = new Client();
  for (const path of [
    '/api/run/start', '/api/run/submit', '/api/economy/upgrade',
    '/api/economy/restore', '/api/economy/equip', '/api/account/name',
  ]) {
    const r = await anon.post(path, {});
    assert.equal(r.status, 401, `${path} returned ${r.status}`);
  }
});

test('a mutation without the CSRF header is refused even with a valid cookie', async () => {
  const { client } = await newPlayer();
  const res = await fetch(base + '/api/run/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie },
    body: '{}',
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'bad_csrf');
});

test('a wrong CSRF token is refused', async () => {
  const { client } = await newPlayer();
  const r = await client.post('/api/run/start', {}, { 'x-bitrot-csrf': 'not-the-token' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'bad_csrf');
});

test('a cross-origin write is refused', async () => {
  const { client } = await newPlayer();
  const r = await client.post('/api/run/start', {}, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'bad_origin');
});

test('a forged or expired session token is simply not a session', async () => {
  const c = new Client();
  c.cookie = 'bitrot_session=' + 'A'.repeat(43);
  c.csrf = 'whatever';
  const r = await c.post('/api/run/start');
  assert.equal(r.status, 401);
});

test('logout really invalidates the session', async () => {
  const { client } = await newPlayer();
  assert.equal((await client.post('/api/auth/logout')).status, 200);
  const after = await client.get('/api/me');
  assert.equal(after.body.account, null);
});

test('restore needs both the account id and the key, and rotates sessions', async () => {
  const { client, account, recoveryKey } = await newPlayer('RESTORER');
  const start = await client.post('/api/run/start');
  assert.equal(start.status, 200);

  const wrong = await new Client().post('/api/auth/restore', {
    accountId: account.id, recoveryKey: 'AAAAA-AAAAA-AAAAA-AAAAA',
  });
  assert.equal(wrong.status, 401);

  const missing = await new Client().post('/api/auth/restore', {
    accountId: 'nope', recoveryKey,
  });
  assert.equal(missing.status, 401);

  const fresh = new Client();
  const ok = await fresh.post('/api/auth/restore', { accountId: account.id, recoveryKey });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.id, account.id);

  // the old session was dropped when the new one was minted
  const stale = await client.get('/api/me');
  assert.equal(stale.body.account, null);
});

/* --------------------------------------------------------------- input -- */

test('oversized and malformed bodies are rejected', async () => {
  const { client } = await newPlayer();
  const huge = await fetch(base + '/api/economy/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie, 'x-bitrot-csrf': client.csrf },
    body: JSON.stringify({ id: 'x'.repeat(50_000) }),
  });
  assert.equal(huge.status, 413);

  const notJson = await fetch(base + '/api/economy/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie, 'x-bitrot-csrf': client.csrf },
    body: '{ nope',
  });
  assert.equal(notJson.status, 400);

  const arrayBody = await fetch(base + '/api/economy/upgrade', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: client.cookie, 'x-bitrot-csrf': client.csrf },
    body: '[1,2,3]',
  });
  assert.equal(arrayBody.status, 400);
});

test('wrong methods and unknown endpoints are distinguished', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/nope')).status, 404);
  assert.equal((await c.get('/api/auth/logout')).status, 405);
});

/* -------------------------------------------------------------- static -- */

test('static files are served and the data directory is not', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /BITROT/);

  assert.equal((await fetch(base + '/play.html')).status, 200);
  assert.equal((await fetch(base + '/src/game/run.js')).status, 200);

  for (const path of ['/data/bitrot.sqlite', '/server/config.mjs', '/server/db.mjs']) {
    const r = await fetch(base + path);
    assert.equal(r.status, 404, `${path} was reachable`);
  }
});

test('path traversal cannot escape the site root', async () => {
  // fetch() normalises "/../x" away before it ever reaches the socket, so these
  // have to go out as raw request lines to actually test the server.
  // Percent-encoded separators survive URL parsing, so these are the payloads
  // that would actually walk out of the root if the guard were missing.
  for (const path of [
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/..%2f..%2fpackage.json',
    '/..%5c..%5cpackage.json',
    '/%2e%2e%5c%2e%2e%5cpackage.json',
    '/src%2f..%2f..%2fpackage.json',
    '/%00/index.html',
    '/index.html%00.txt',
  ]) {
    const raw = await rawGet(path);
    assert.ok(/^HTTP\/1\.1 (400|403|404)/.test(raw),
      `${path} returned: ${raw.split('\r\n')[0]}`);
  }

  // Ordinary dot segments — including their %2e spellings — are collapsed by
  // URL parsing before the handler ever sees them, so they resolve *inside* the
  // root rather than escaping it. Assert that, rather than pretending they are
  // blocked: a file that does not exist under the root still 404s.
  for (const path of ['/../../../../../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
    assert.match(await rawGet(path), /^HTTP\/1\.1 404/, path);
  }
  for (const path of ['/../package.json', '/src/%2e%2e/%2e%2e/package.json']) {
    const raw = await rawGet(path);
    assert.match(raw, /^HTTP\/1\.1 200/, path);
    assert.match(raw, /"name": "bitrot"/, `${path} served something unexpected`);
  }
});

test('the source tree is public but the database and server code are not', async () => {
  // this project is open source; serving src/ is intentional
  assert.equal((await fetch(base + '/package.json')).status, 200);
  assert.equal((await fetch(base + '/src/core/gfx.js')).status, 200);
  // these are not
  for (const p of ['/server/auth.mjs', '/data/bitrot.sqlite', '/.git/config']) {
    assert.equal((await fetch(base + p)).status, 404, `${p} was reachable`);
  }
});

test('static serving refuses anything but GET', async () => {
  const r = await fetch(base + '/index.html', { method: 'POST' });
  assert.equal(r.status, 405);
});

/* --------------------------------------------------------- leaderboard -- */

test('the leaderboard only contains verified runs', async () => {
  const board = await new Client().get('/api/leaderboard');
  assert.equal(board.status, 200);
  assert.ok(Array.isArray(board.body.entries));
  for (const e of board.body.entries) {
    assert.ok(Number.isInteger(e.score) && e.score >= 0);
    assert.ok(typeof e.name === 'string' && e.name.length <= 18);
    assert.equal(e.you, false);          // anonymous caller is nobody
    assert.equal(e.publicId, undefined); // internal ids stay internal
  }
  // sorted descending
  const scores = board.body.entries.map((e) => e.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('rate limiting kicks in and says when to come back', async () => {
  const tight = createApp({
    dbFile: ':memory:',
    secret: 'another-test-secret-long-enough-to-pass',
    rate: { global: 3, register: 100, restore: 100, runStart: 100, runSubmit: 100, mutate: 100 },
  });
  const addr = await tight.listen(0);
  const url = `http://127.0.0.1:${addr.port}/api/health`;
  try {
    let limited = null;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(url);
      if (r.status === 429) { limited = r; break; }
    }
    assert.ok(limited, 'never hit the limit');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  } finally {
    await tight.close();
  }
});
