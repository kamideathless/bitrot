// Headless render smoke test: build every scene, run it, draw it, and check it
// produced a sane picture. This is what catches a typo in a layout call or a
// missing import in a screen nobody clicked through recently.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApp, fakeInput, renderScene, demoSave, demoResult, W, H } from '../tools/headless.mjs';
import { defaultSave } from '../src/core/store.js';
import { createTitleScene } from '../src/scenes/title.js';
import { createHubScene } from '../src/scenes/hub.js';
import { createPlayScene } from '../src/scenes/play.js';
import { createResultsScene } from '../src/scenes/results.js';
import { createUpgradesScene } from '../src/scenes/upgrades.js';
import { createCollectionScene } from '../src/scenes/collection.js';
import { createHelpScene } from '../src/scenes/help.js';
import { createSettingsScene } from '../src/scenes/settings.js';

const RESULT = demoResult();

const SCENES = [
  ['title', createTitleScene, {}],
  ['hub', createHubScene, {}],
  ['play', createPlayScene, {}],
  ['results', createResultsScene, { result: RESULT }],
  ['upgrades', createUpgradesScene, {}],
  ['collection', createCollectionScene, {}],
  ['help', createHelpScene, {}],
  ['help-intro', createHelpScene, { intro: true }],
  ['settings', createSettingsScene, {}],
];

function inkRatio(gfx) {
  let n = 0;
  for (let i = 0; i < gfx.buf.length; i++) n += gfx.buf[i];
  return n / gfx.buf.length;
}

for (const [name, factory, params] of SCENES) {
  test(`${name} renders without throwing and draws something`, () => {
    const { gfx } = renderScene(factory, { params, seconds: 1.5 });
    const ratio = inkRatio(gfx);
    assert.ok(ratio > 0.02, `${name} drew almost nothing (ink ${(ratio * 100).toFixed(1)}%)`);
    assert.ok(ratio < 0.97, `${name} is almost solid black (ink ${(ratio * 100).toFixed(1)}%)`);
    for (const v of gfx.buf) assert.ok(v === 0 || v === 1, `${name} wrote a non 1-bit value`);
  });
}

test('every scene also renders from a brand new save', () => {
  for (const [name, factory, params] of SCENES) {
    const app = makeApp({ save: defaultSave() });
    assert.doesNotThrow(() => renderScene(factory, { app, params, seconds: 0.6 }), `${name} failed on an empty save`);
  }
});

test('every scene renders with reduced motion on', () => {
  for (const [name, factory, params] of SCENES) {
    const app = makeApp({ reduced: true });
    assert.doesNotThrow(() => renderScene(factory, { app, params, seconds: 0.6 }), `${name} failed with reduced motion`);
  }
});

test('every scene renders on a touch device', () => {
  for (const [name, factory, params] of SCENES) {
    const app = makeApp({ input: fakeInput({ hasTouch: true }) });
    assert.doesNotThrow(() => renderScene(factory, { app, params, seconds: 0.6 }), `${name} failed in touch mode`);
  }
});

test('a long dive keeps rendering after the player dies', () => {
  const app = makeApp({ input: fakeInput({ keyAxis: () => ({ x: 0, y: 0 }) }) });
  const { gfx } = renderScene(createPlayScene, { app, seconds: 220 });
  assert.ok(inkRatio(gfx) > 0.05);
  // the scene should have asked to move on to the report
  assert.ok(app.sceneRequests.some((r) => r.name === 'results'), 'never handed off to the report screen');
});

test('the report commits the run to the save exactly once', () => {
  const app = makeApp({ save: defaultSave() });
  renderScene(createResultsScene, { app, params: { result: RESULT }, seconds: 1 });
  assert.equal(app.save.runs, 1);
  assert.equal(app.save.friends.length, 3);
  assert.equal(app.save.rf, RESULT.rf);
  assert.equal(app.save.rfEarned, RESULT.rf);
  assert.equal(app.save.best.score, RESULT.score);
  assert.equal(app.save.equipped, app.save.friends[0].id);
});

test('duplicate rescues are salvaged instead of duplicated', () => {
  const save = defaultSave();
  save.friends.push({ id: '7A31C4', integrity: 40, rescuedAt: 0 });
  save.equipped = '7A31C4';
  const app = makeApp({ save });
  renderScene(createResultsScene, {
    app,
    params: { result: { ...RESULT, rescued: ['7A31C4', '7A31C4'], rescues: 2 } },
    seconds: 0.6,
  });
  assert.equal(app.save.friends.length, 1, 'a duplicate must not be added again');
  assert.equal(app.save.friends[0].integrity, 40, 'a duplicate must not reset integrity');
  assert.ok(app.save.rf > RESULT.rf, 'duplicates should pay salvage RF');
  assert.equal(app.save.totals.duplicates, 2);
});

test('the collection screen survives an empty archive', () => {
  const app = makeApp({ save: defaultSave() });
  const { gfx } = renderScene(createCollectionScene, { app, seconds: 0.5 });
  assert.ok(inkRatio(gfx) > 0.02);
});

test('screens are exactly 480x320', () => {
  const { gfx } = renderScene(createHubScene, { seconds: 0.2 });
  assert.equal(gfx.buf.length, W * H);
  assert.equal(W, 480);
  assert.equal(H, 320);
});
