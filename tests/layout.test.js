// Catches text that has drifted: strings that collide with each other or run
// off the edge of the screen.
//
// Every scene is rendered headlessly with the text probe switched on, so the
// check covers whatever the layout actually produced rather than what it was
// supposed to produce.

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeApp, fakeInput, renderScene, demoResult, demoSave, W, H } from '../tools/headless.mjs';
import { Gfx } from '../src/core/gfx.js';
import { defaultSave } from '../src/core/store.js';
import { createTitleScene } from '../src/scenes/title.js';
import { createHubScene } from '../src/scenes/hub.js';
import { createPlayScene } from '../src/scenes/play.js';
import { createResultsScene } from '../src/scenes/results.js';
import { createUpgradesScene } from '../src/scenes/upgrades.js';
import { createCollectionScene } from '../src/scenes/collection.js';
import { createHelpScene } from '../src/scenes/help.js';
import { createSettingsScene } from '../src/scenes/settings.js';

/** Render once with the probes on and hand back what was drawn. */
function textOf(factory, { params = {}, app, seconds = 0.5 } = {}) {
  const trace = [];
  const panels = [];
  globalThis.__BITROT_TEXT_TRACE__ = trace;
  globalThis.__BITROT_PANEL_TRACE__ = panels;
  try {
    renderScene(factory, { app: app || makeApp(), params, seconds });
  } finally {
    globalThis.__BITROT_TEXT_TRACE__ = null;
    globalThis.__BITROT_PANEL_TRACE__ = null;
  }
  trace.panels = panels;
  return trace;
}

/**
 * Text that starts inside a panel but finishes outside it has outgrown its
 * frame — the most common way a layout drifts when copy or a font changes.
 */
function spills(trace) {
  const out = [];
  for (const t of trace) {
    for (const p of trace.panels || []) {
      const startsInside = t.x >= p.x && t.x < p.x + p.w && t.y >= p.y && t.y < p.y + p.h;
      if (!startsInside) continue;
      if (t.x + t.w > p.x + p.w - 1 || t.y + t.h > p.y + p.h - 1) {
        out.push(`"${t.text}" @${t.x},${t.y} spills out of ${p.title || 'panel'} ${p.x},${p.y} ${p.w}x${p.h}`);
      }
      break;
    }
  }
  return out;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Two strings drawn on top of each other is the signature of drifted text.
 * A few overlaps are legitimate (floating popups over the HUD), so callers can
 * exempt them by substring.
 */
function collisions(trace, allow = []) {
  const keep = trace.filter((t) => !allow.some((a) => t.text.includes(a)));
  const hits = [];
  for (let i = 0; i < keep.length; i++) {
    for (let j = i + 1; j < keep.length; j++) {
      if (overlaps(keep[i], keep[j])) {
        hits.push(`"${keep[i].text}" @${keep[i].x},${keep[i].y} x "${keep[j].text}" @${keep[j].x},${keep[j].y}`);
      }
    }
  }
  return hits;
}

/** Strings that are *meant* to run past the edge, like the title marquee. */
const SCROLLERS = ['ARCHIVE INTEGRITY FALLING'];

function offscreen(trace) {
  return trace
    .filter((t) => !SCROLLERS.some((m) => t.text.includes(m)))
    .filter((t) => t.x < 0 || t.y < 0 || t.x + t.w > W || t.y + t.h > H)
    .map((t) => `"${t.text}" @${t.x},${t.y} ${t.w}x${t.h}`);
}

const SCREENS = [
  ['title', createTitleScene, {}],
  ['hub', createHubScene, {}],
  ['results', createResultsScene, { result: demoResult() }],
  ['upgrades', createUpgradesScene, {}],
  ['collection', createCollectionScene, {}],
  ['settings', createSettingsScene, {}],
];

for (const [name, factory, params] of SCREENS) {
  test(`${name}: no text collides or leaves the screen`, () => {
    const trace = textOf(factory, { params });
    assert.ok(trace.length > 0, `${name} drew no text at all`);
    assert.deepEqual(offscreen(trace), [], `${name} draws text off screen`);
    assert.deepEqual(collisions(trace), [], `${name} draws text on top of text`);
    assert.deepEqual(spills(trace), [], `${name} draws text outside its panel`);
  });
}

test('every manual page keeps its text apart', () => {
  for (let page = 0; page < 6; page++) {
    let pressed = 0;
    const input = fakeInput({ pressed: (a) => a === 'right' && pressed++ < page });
    const trace = textOf(createHelpScene, { app: makeApp({ input }), seconds: 0.35 });
    assert.deepEqual(offscreen(trace), [], `manual page ${page + 1} draws off screen`);
    assert.deepEqual(collisions(trace), [], `manual page ${page + 1} draws text on text`);
    assert.deepEqual(spills(trace), [], `manual page ${page + 1} overflows a panel`);
  }
});

test('the dive HUD stays clear of itself', () => {
  const app = makeApp({ input: fakeInput({ keyAxis: () => ({ x: 0.6, y: 0.2 }) }) });
  // popups deliberately float over the field, so they are exempt
  const trace = textOf(createPlayScene, { app, seconds: 14 });
  assert.deepEqual(offscreen(trace), [], 'the HUD draws off screen');
  assert.deepEqual(
    collisions(trace, ['+', 'LOST', 'NO CHARGE', 'DEFRAG', 'FRIEND', 'CAPSULE', 'SECTOR']),
    [], 'the HUD draws text on text',
  );
});

test('screens hold up on a brand new save too', () => {
  for (const [name, factory, params] of SCREENS) {
    const app = makeApp({ save: defaultSave() });
    const trace = textOf(factory, { app, params });
    assert.deepEqual(offscreen(trace), [], `${name} (empty save) draws off screen`);
    assert.deepEqual(collisions(trace), [], `${name} (empty save) draws text on text`);
  }
});

test('long values do not push text off the edge', () => {
  // a very rich account: five-figure balances, a full archive, maxed upgrades
  const save = demoSave();
  save.rf = 987654;
  save.rfEarned = 1234567;
  save.rfBurned = 999999;
  save.runs = 99999;
  save.best = { score: 9999999, time: 5999, sector: 99, rescues: 999 };
  save.totals = { shards: 99999, rescues: 9999, defrags: 9999, purges: 99999, duplicates: 999, time: 999999 };
  for (const k of Object.keys(save.upgrades)) save.upgrades[k] = 4;

  for (const [name, factory, params] of SCREENS) {
    const app = makeApp({ save: JSON.parse(JSON.stringify(save)) });
    const trace = textOf(factory, { app, params });
    assert.deepEqual(offscreen(trace), [], `${name} (huge numbers) draws off screen`);
  }
});

test('the purge meter is divided into one segment per purge', () => {
  // The cell is a pool, not a single charge, and players read a plain bar as
  // "fill me up before you can fire". The dividers are what say otherwise, so
  // they have to actually be on screen.
  const app = makeApp({ input: fakeInput() });
  const gfx = new Gfx();
  const scene = createPlayScene(app);
  scene.enter();
  for (let i = 0; i < 180; i++) { scene.update(1 / 60); app.input.endFrame(); }
  scene.draw(gfx);

  const run = scene.debug().run;
  const stats = scene.debug().stats;
  const expected = Math.max(0, Math.ceil(stats.energyMax / run.purgeCost) - 1);

  // count vertical ink runs inside the meter interior
  let dividers = 0;
  for (let x = 9; x < 115; x++) {
    const here = gfx.get(x, 35) === 1 && gfx.get(x, 36) === 1;
    const prev = gfx.get(x - 1, 35) === 1;
    if (here && !prev) dividers++;
  }
  assert.equal(dividers, expected,
    `meter shows ${dividers} dividers for ${stats.energyMax}/${run.purgeCost} charges`);
  assert.ok(expected > 0, 'the cell should hold more than one purge');
});
