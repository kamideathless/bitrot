// BITROT — boot, scene router and main loop.

import { Gfx, Screen, W, H, INK } from './core/gfx.js';
import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { loadSave, writeSave, defaultSave, clearSave, normalizeSave } from './core/store.js';
import { Api } from './net/client.js';
import { createEconomy } from './net/economy.js';

import { createTitleScene } from './scenes/title.js';
import { createHubScene } from './scenes/hub.js';
import { createPlayScene } from './scenes/play.js';
import { createResultsScene } from './scenes/results.js';
import { createUpgradesScene } from './scenes/upgrades.js';
import { createCollectionScene } from './scenes/collection.js';
import { createHelpScene } from './scenes/help.js';
import { createSettingsScene } from './scenes/settings.js';

const canvas = document.getElementById('screen');
const crt = document.getElementById('crt');
const live = document.getElementById('live');

const SCENES = {
  title: createTitleScene,
  hub: createHubScene,
  play: createPlayScene,
  results: createResultsScene,
  upgrades: createUpgradesScene,
  collection: createCollectionScene,
  help: createHelpScene,
  settings: createSettingsScene,
};

class App {
  constructor() {
    this.gfx = new Gfx();
    this.screen = new Screen(canvas);
    this.input = new Input(canvas);
    this.audio = new Audio();
    this.save = loadSave();

    this.t = 0;
    this.scene = null;
    this.sceneName = null;
    this.pendingScene = null;
    this.transition = 0;
    this.transitionMax = 0.2;
    this._shake = 0;
    this._shakeT = 0;
    this._flash = 0;
    this._lastSaid = '';
    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsFrames = 0;

    // Online, the server owns the save and this copy is only a cache of it.
    // Offline, the game is a local sandbox and nothing is submitted. There is
    // deliberately no merge between the two.
    this.api = new Api();
    this.economy = createEconomy(this);
    this.online = false;
    this.account = null;
    this.netStatus = 'connecting';
    this.connect();

    this.input.onFirstGesture(() => {
      this.audio.init();
      this.audio.setMuted(this.save.settings.mute);
    });

    this.applySettings();
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.scene && this.scene.onHide) this.scene.onHide();
    });
    this.resize();
  }

  /**
   * Adopt the server's save wholesale. Local settings are kept because they are
   * a device preference, not part of the economy.
   */
  adoptServerSave(serverSave) {
    if (!serverSave) return;
    const settings = this.save.settings;
    this.save = normalizeSave(serverSave);
    this.save.settings = settings;
    this.applySettings();
  }

  async connect() {
    const out = await this.api.connect();
    this.online = out.online;
    this.account = out.account;
    this.netStatus = out.online ? 'online' : 'offline';
    if (out.online) {
      this.adoptServerSave(out.save);
      this.say(`Archive online as ${out.account.name}.`);
    } else {
      this.say('Offline: playing a local sandbox. Progress is not submitted.');
    }
    return out;
  }

  applySettings() {
    const s = this.save.settings;
    this.screen.setInverted(s.invert);
    this.screen.setSmoothing(s.smooth);
    if (crt) crt.classList.toggle('on', !!s.crt);
    this.audio.setMuted(s.mute);
    this.reduced = !!s.reduced || prefersReducedMotion();
  }

  resize() {
    const pad = 16;
    const availW = Math.max(160, window.innerWidth - pad);
    const availH = Math.max(120, window.innerHeight - (window.innerHeight > 620 ? 96 : 16));
    this.screen.resize(availW, availH);
  }

  persist() { writeSave(this.save); }

  resetSave() {
    clearSave();
    this.save = defaultSave();
    this.applySettings();
  }

  say(text) {
    if (!live || text === this._lastSaid) return;
    this._lastSaid = text;
    live.textContent = text;
  }

  setScene(name, params = {}) {
    if (!SCENES[name]) throw new Error('unknown scene: ' + name);
    this.pendingScene = { name, params };
  }

  _commitScene() {
    const { name, params } = this.pendingScene;
    this.pendingScene = null;
    if (this.scene && this.scene.leave) this.scene.leave();
    this.sceneName = name;
    this.scene = SCENES[name](this, params);
    if (this.scene.enter) this.scene.enter();
    this.transition = this.transitionMax;
  }

  shake(amount) {
    if (this.reduced) return;
    this._shake = Math.max(this._shake, amount);
  }

  flash(seconds = 0.06) {
    if (this.reduced) { this._flash = Math.max(this._flash, Math.min(seconds, 0.03)); return; }
    this._flash = Math.max(this._flash, seconds);
  }

  toggleMute() {
    this.save.settings.mute = !this.save.settings.mute;
    this.audio.setMuted(this.save.settings.mute);
    this.persist();
    this.say(this.save.settings.mute ? 'Sound muted' : 'Sound on');
    return this.save.settings.mute;
  }

  update(dt) {
    this.t += dt;
    if (this.pendingScene) this._commitScene();

    if (this.input.pressed('mute')) this.toggleMute();

    if (this.transition > 0) this.transition = Math.max(0, this.transition - dt);
    if (this._shake > 0) {
      this._shake = Math.max(0, this._shake - dt * 26);
      this._shakeT += dt;
    }
    if (this._flash > 0) this._flash = Math.max(0, this._flash - dt);

    if (this.scene && this.scene.update) this.scene.update(dt);
  }

  draw() {
    const g = this.gfx;
    if (this.scene && this.scene.draw) this.scene.draw(g);
    else g.clear();

    if (this._flash > 0) g.invertRect(0, 0, W, H);

    if (this.transition > 0) {
      const k = this.transition / this.transitionMax;   // 1 -> 0
      g.dither(0, 0, W, H, Math.ceil(k * 16), INK, 0);
    }

    let sx = 0, sy = 0;
    if (this._shake > 0) {
      const a = this._shake;
      sx = Math.round(Math.sin(this._shakeT * 91) * a);
      sy = Math.round(Math.cos(this._shakeT * 73) * a);
    }
    this.screen.present(g, sx, sy);
  }
}

function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

const app = new App();
app.setScene('title');

let last = performance.now();
let acc = 0;
const STEP = 1 / 60;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (!Number.isFinite(dt) || dt < 0) dt = STEP;
  if (dt > 0.25) dt = 0.25;           // tab was backgrounded: don't fast-forward
  acc += dt;

  let steps = 0;
  while (acc >= STEP && steps < 5) {
    app.update(STEP);
    app.input.endFrame();
    acc -= STEP;
    steps++;
  }
  if (steps === 5) acc = 0;
  app.draw();
}

requestAnimationFrame(frame);

// expose for the automated browser check
window.__BITROT__ = app;
