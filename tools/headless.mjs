// A DOM-free stand-in for the App object, so every scene can be constructed,
// updated and drawn in Node. Used by tools/shots.mjs and tests/scenes.test.js.
//
// This works because the renderer is a plain Uint8Array and the scenes only
// ever touch `app` through a small, explicit surface.

import { Gfx, W, H } from '../src/core/gfx.js';
import { defaultSave } from '../src/core/store.js';
import { startingIntegrity } from '../src/game/friends.js';
import { runPayout, runScore } from '../src/game/economy.js';
import { createEconomy } from '../src/net/economy.js';

/** A believable run result, with RF and score computed by the real economy. */
export function demoResult(overrides = {}) {
  const r = {
    time: 118.3, sector: 3, shards: 41, rescues: 3, defrags: 2, purges: 37,
    hits: 4, lostShards: 6, lostCapsules: 1, coverage: 0.62,
    rescued: ['A11C03', '77BB21', '7A31C4'],
    ...overrides,
  };
  r.rf = runPayout(r);
  r.score = runScore(r);
  return r;
}

export function fakeInput(overrides = {}) {
  return {
    hasTouch: false,
    pointer: { x: -1, y: -1, down: false, pressed: false, released: false, inside: false },
    pressedKeys: new Set(),
    down: new Set(),
    downEvents: [],
    pressed: () => false,
    held: () => false,
    keyPressed: () => false,
    keyAxis: () => ({ x: 0, y: 0 }),
    activePointers: () => [],
    endFrame() {},
    ...overrides,
  };
}

export function fakeAudio() {
  const calls = [];
  return {
    calls,
    ready: false,
    muted: true,
    init() {},
    setMuted() {},
    sfx(n) { calls.push(n); },
    playTrack(n) { calls.push('track:' + n); },
    stopTrack() {},
    setTempoScale() {},
  };
}

/** A save with a few Friends, some RF and a couple of upgrades. */
export function demoSave() {
  const save = defaultSave();
  save.rf = 486;
  save.rfEarned = 1240;
  save.rfBurned = 754;
  save.runs = 11;
  save.seenIntro = true;
  save.best = { score: 8420, time: 132.4, sector: 3, rescues: 4 };
  save.upgrades = { purge: 2, energy: 1, scar: 1, core: 1, boots: 1, magnet: 0 };
  const ids = ['7A31C4', 'E90B2F', '2C77D1', 'B45E08', '19FFA6', 'CD3021', '4F80AA', '9B12E7'];
  save.friends = ids.map((id, i) => ({
    id,
    integrity: i === 0 ? 100 : Math.min(100, startingIntegrity(id) + i * 9),
    rescuedAt: i,
  }));
  save.equipped = ids[0];
  save.totals = { shards: 412, rescues: 14, defrags: 6, purges: 233, duplicates: 3, time: 1180 };
  return save;
}

export function makeApp({
  save = demoSave(), input = fakeInput(), reduced = false, api = null, online = false,
} = {}) {
  const app = {
    api,
    online,
    netStatus: online ? 'online' : 'offline',
    account: null,
    adoptServerSave(next) {
      if (!next) return;
      const settings = app.save.settings;
      app.save = next;
      app.save.settings = settings;
    },
    gfx: new Gfx(),
    input,
    audio: fakeAudio(),
    save,
    reduced,
    t: 0,
    sceneName: null,
    sceneRequests: [],
    screen: { scale: 1, setInverted() {}, resize() {} },
    setScene(name, params) { app.sceneRequests.push({ name, params }); },
    persist() {},
    resetSave() { app.save = defaultSave(); },
    applySettings() {},
    say() {},
    shake() {},
    flash() {},
    toggleMute() { return false; },
  };
  app.economy = createEconomy(app);
  return app;
}

/** Build a scene, run it for `seconds`, draw it and hand back the buffer. */
export function renderScene(factory, { app = makeApp(), params = {}, seconds = 0.5 } = {}) {
  const scene = factory(app, params);
  if (scene.enter) scene.enter();
  const step = 1 / 60;
  for (let t = 0; t < seconds; t += step) {
    if (scene.update) scene.update(step);
    app.input.endFrame();
  }
  app.gfx.clear();
  app.gfx.noClip();
  if (scene.draw) scene.draw(app.gfx);
  app.gfx.noClip();
  return { scene, app, gfx: app.gfx };
}

export { W, H };
