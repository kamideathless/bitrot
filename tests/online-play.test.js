// The client glue, end to end: the play scene asks a real server for a seed,
// records the dive, submits it, and adopts the save the server hands back.
//
// This is the piece the pure-server tests cannot reach — that play.js actually
// wires the ticket, the recorder and the submission together correctly.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/main.mjs';
import { makeApp, fakeInput } from '../tools/headless.mjs';
import { defaultSave } from '../src/core/store.js';
import { createPlayScene } from '../src/scenes/play.js';
import { createResultsScene } from '../src/scenes/results.js';

let server;
let base;

before(async () => {
  server = createApp({
    dbFile: ':memory:',
    secret: 'online-play-test-secret-long-enough-ok',
    rate: { global: 100000, register: 1000, restore: 1000, runStart: 1000, runSubmit: 1000, mutate: 1000 },
  });
  const addr = await server.listen(0);
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => { await server.close(); });

/** A cookie-aware stand-in for src/net/client.js (Node's fetch has no jar). */
class TestApi {
  constructor() { this.cookie = null; this.csrf = null; this.standing = null; }

  async call(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && method !== 'GET') headers['x-bitrot-csrf'] = this.csrf;
    const res = await fetch(base + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = await res.json().catch(() => null);
    if (data?.csrf) this.csrf = data.csrf;
    if (!res.ok) {
      const err = new Error(data?.message || res.statusText);
      err.code = data?.error || 'http_' + res.status;
      throw err;
    }
    return data;
  }

  register() { return this.call('POST', '/api/auth/register', {}); }
  startRun() { return this.call('POST', '/api/run/start', {}); }
  submitRun(ticket, trace) { return this.call('POST', '/api/run/submit', { ticket, trace }); }
  buyUpgrade(id) { return this.call('POST', '/api/economy/upgrade', { id }); }
}

/** Steer toward the nearest pickup, which is what a player roughly does. */
function pilotInput(run) {
  if (!run) return { x: 0, y: 0 };
  const target = run.capsule || run.shards[0];
  if (!target) return { x: 0, y: 0 };
  const dx = target.x - run.x, dy = target.y - run.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

/**
 * Drive the play scene the way main.js does, letting real promises settle.
 * Returns the app once the scene has asked to move on.
 */
async function drivePlayScene(app, { maxSeconds = 420 } = {}) {
  const scene = createPlayScene(app);
  scene.enter();
  const step = 1 / 60;
  let i = 0;
  const limit = Math.round(maxSeconds * 60);

  while (app.sceneRequests.length === 0 && i < limit) {
    // let the ticket request / submission resolve between frames
    if (i % 30 === 0) await Promise.resolve().then(() => new Promise((r) => setTimeout(r, 0)));
    const run = scene.debug?.().run;
    const dir = pilotInput(run);
    app.input.keyAxis = () => dir;
    app.input.held = (a) => a === 'purge' && i % 30 === 0;
    scene.update(step);
    app.input.endFrame();
    i++;
  }
  // the submission is in flight when the scene stops stepping; wait it out
  for (let k = 0; k < 400 && app.sceneRequests.length === 0; k++) {
    await new Promise((r) => setTimeout(r, 10));
    scene.update(step);
  }
  return { scene, ticks: i };
}

test('an online dive is issued, recorded, submitted and adopted', async () => {
  const api = new TestApi();
  const reg = await api.register();

  const app = makeApp({ save: defaultSave(), input: fakeInput(), api, online: true });
  app.save = reg.save;

  const { scene } = await drivePlayScene(app);

  assert.equal(app.sceneRequests.length, 1, 'the scene never moved on');
  const req = app.sceneRequests[0];
  assert.equal(req.name, 'results');
  assert.ok(req.params.server, 'the report was not given a server verdict');
  assert.equal(req.params.rejected, undefined);

  // the save on the app is now the server's save
  assert.equal(app.save.runs, 1);
  assert.equal(app.save.rf, req.params.server.payout);

  // and the server agrees when asked again
  const me = await api.call('GET', '/api/me');
  assert.equal(me.save.runs, 1);
  assert.equal(me.save.rf, app.save.rf);
  assert.equal(me.save.friends.length, app.save.friends.length);

  // the result the report will draw is the server's, not a local guess
  const local = scene.debug().run.result(1);
  assert.equal(req.params.result.score, local.score);
});

test('the report does not double-credit a server-verified run', async () => {
  const api = new TestApi();
  const reg = await api.register();
  const app = makeApp({ save: reg.save, input: fakeInput(), api, online: true });

  await drivePlayScene(app);
  const req = app.sceneRequests[0];
  const rfAfterSubmit = app.save.rf;
  const runsAfterSubmit = app.save.runs;

  // building the report must not touch the balance again
  createResultsScene(app, req.params);
  assert.equal(app.save.rf, rfAfterSubmit);
  assert.equal(app.save.runs, runsAfterSubmit);

  const me = await api.call('GET', '/api/me');
  assert.equal(me.save.rf, rfAfterSubmit, 'client and server disagree about the balance');
});

test('an offline dive is scored locally and never submitted', async () => {
  const app = makeApp({ save: defaultSave(), input: fakeInput(), api: null, online: false });
  await drivePlayScene(app);

  const req = app.sceneRequests[0];
  assert.equal(req.name, 'results');
  assert.equal(req.params.server, undefined);
  assert.equal(req.params.local, true);
  assert.equal(app.save.runs, 0, 'the sandbox must not credit the run before the report');

  // the report applies it to the local sandbox copy
  createResultsScene(app, req.params);
  assert.equal(app.save.runs, 1);
});

test('a dive played while the server is unreachable falls back to the sandbox', async () => {
  const brokenApi = {
    startRun() { const e = new Error('boom'); e.code = 'offline'; return Promise.reject(e); },
    submitRun() { const e = new Error('boom'); e.code = 'offline'; return Promise.reject(e); },
  };
  const app = makeApp({ save: defaultSave(), input: fakeInput(), api: brokenApi, online: true });
  await drivePlayScene(app);

  assert.equal(app.sceneRequests.length, 1);
  const req = app.sceneRequests[0];
  assert.equal(req.name, 'results');
  assert.equal(req.params.server, undefined);
  assert.equal(app.online, false, 'the app should have noticed it went offline');
});

test('the economy facade spends through the server when online', async () => {
  const api = new TestApi();
  const reg = await api.register();
  const app = makeApp({ save: reg.save, input: fakeInput(), api, online: true });

  // earn enough for the cheapest upgrade
  for (let i = 0; i < 8 && app.save.rf < 40; i++) {
    app.sceneRequests.length = 0;
    await drivePlayScene(app);
  }
  assert.ok(app.save.rf >= 40, `only earned ${app.save.rf} RF`);

  const before = app.save.rf;
  const res = await app.economy.buyUpgrade('energy');
  assert.equal(res.ok, true, res.reason);
  assert.equal(app.save.rf, before - res.spent);
  assert.equal(app.save.upgrades.energy, 1);

  const me = await api.call('GET', '/api/me');
  assert.equal(me.save.upgrades.energy, 1);
  assert.equal(me.save.rf, app.save.rf);
});
