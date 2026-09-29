import { INK, PAPER, W, H, makeSprite } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, measure, MICRO, ICON } from '../core/font.js';
import { bar, Menu, drawList, panel, Popups } from '../ui/widgets.js';
import { drawField } from '../ui/field.js';
import { Run, RunState, FIELD_Y, FIELD_W, FIELD_H, TUNING } from '../game/run.js';

import { derivedStats, activePerk, formatTime, shardValueFor } from '../game/economy.js';
import { TraceRecorder, quantiseIntent } from '../game/trace.js';
import { friendSprite, STRAY_ID } from '../game/friends.js';

const SHARD = makeSprite([
  '....#....',
  '...#o#...',
  '..#ooo#..',
  '.#ooooo#.',
  '#ooo#ooo#',
  '.#ooooo#.',
  '..#ooo#..',
  '...#o#...',
  '....#....',
]);

const CANISTER = makeSprite([
  '..#####..',
  '.#ooooo#.',
  '#oo#o#oo#',
  '#o##o##o#',
  '#ooooooo#',
  '#o##o##o#',
  '#oo#o#oo#',
  '.#ooooo#.',
  '..#####..',
]);

const HEART = makeSprite([
  '.##.##.',
  '#######',
  '#######',
  '.#####.',
  '..###..',
  '...#...',
]);

export function createPlayScene(app) {
  // Online, the seed and the stat block come from the server with a one-shot
  // ticket; the dive is then replayed server-side from the input trace, so
  // nothing here is trusted. Offline, the same code runs on a local seed and
  // simply never submits.
  let stats = derivedStats(app.save);
  let shardValue = shardValueFor(app.save);
  let ticket = null;
  let phase = app.online ? 'booting' : 'playing';
  let bootError = null;
  let submitState = null;      // null | 'sending' | 'done' | 'failed'
  let submitMessage = '';
  let trace = new TraceRecorder();

  const equippedId = app.save.equipped || STRAY_ID;
  const equippedFriendRec = app.save.friends.find((f) => f.id === app.save.equipped);
  const avatarIntegrity = equippedFriendRec ? equippedFriendRec.integrity : 100;

  let run = new Run({ stats, friendId: equippedId });
  const popups = new Popups();
  let waves = [];
  let sparks = [];
  let t = 0;
  let paused = false;
  let overT = -1;
  let banner = null;
  let hurtPulse = 0;
  const rescuedSprites = [];

  const pauseMenu = new Menu([
    { label: 'RESUME', id: 'resume' },
    { label: 'RESTART DIVE', id: 'restart' },
    { label: 'ABANDON DIVE', id: 'quit' },
  ]);

  // ---- touch control state ------------------------------------------
  const touch = {
    stickId: null, sx: 0, sy: 0, cx: 0, cy: 0,
    purgeDown: false, purgeWas: false, purgeTap: false,
    dashDown: false, dashWas: false, dashTap: false,
    pauseDown: false, pauseWas: false, pauseTap: false,
  };
  const BTN = {
    purge: { x: 432, y: 252, r: 27 },
    dash: { x: 374, y: 292, r: 21 },
    pause: { x: 462, y: 21, r: 13 },
  };

  function inCircle(p, c) {
    const dx = p.x - c.x, dy = p.y - c.y;
    return dx * dx + dy * dy <= c.r * c.r;
  }

  function readTouch() {
    if (!app.input.hasTouch) return;
    const ptrs = app.input.activePointers();
    touch.purgeWas = touch.purgeDown;
    touch.dashWas = touch.dashDown;
    touch.pauseWas = touch.pauseDown;
    touch.purgeDown = false;
    touch.dashDown = false;
    touch.pauseDown = false;
    touch.purgeTap = false;
    touch.dashTap = false;
    touch.pauseTap = false;

    // a tap shorter than one frame still counts
    for (const d of app.input.downEvents) {
      if (inCircle(d, BTN.purge)) touch.purgeTap = true;
      else if (inCircle(d, BTN.dash)) touch.dashTap = true;
      else if (inCircle(d, BTN.pause)) touch.pauseTap = true;
    }

    let stick = null;
    for (const p of ptrs) {
      if (inCircle(p, BTN.purge)) { touch.purgeDown = true; continue; }
      if (inCircle(p, BTN.dash)) { touch.dashDown = true; continue; }
      if (inCircle(p, BTN.pause)) { touch.pauseDown = true; continue; }
      if (p.startX < W * 0.55 && !stick) stick = p;
    }
    if (stick) {
      touch.stickId = stick.id;
      touch.sx = stick.startX; touch.sy = stick.startY;
      touch.cx = stick.x; touch.cy = stick.y;
    } else {
      touch.stickId = null;
    }
  }

  function touchAxis() {
    if (touch.stickId === null) return { x: 0, y: 0 };
    const dx = touch.cx - touch.sx;
    const dy = touch.cy - touch.sy;
    const d = Math.hypot(dx, dy);
    if (d < 5) return { x: 0, y: 0 };
    const k = Math.min(1, d / 28) / d;
    return { x: dx * k, y: dy * k };
  }

  function addWave(x, y, maxR, thickness = 2, life = 0.24, follow = false) {
    const wave = { x, y, maxR, thickness, life: app.reduced ? life * 0.5 : life, t: 0, follow };
    waves.push(wave);
  }

  function addSparks(x, y, n, speed = 60) {
    if (app.reduced) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.8);
      sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, t: 0, life: 0.3 + Math.random() * 0.3 });
    }
  }

  function handleEvents() {
    for (const e of run.drainEvents()) {
      switch (e.type) {
        case 'purge':
          app.audio.sfx('purge');
          // follow:true keeps the ring on the player, because that is where it
          // is still clearing — a ring left behind would be a lie
          addWave(e.x, e.y + FIELD_Y, e.radius + 6, 2, 0.26, true);
          app.shake(1.2);
          break;
        case 'scrub':
          if (!app.reduced && (Math.floor(t * 30) & 1) === 0) addSparks(e.x, e.y + FIELD_Y, 1, 26);
          break;
        case 'purgeFail':
          app.audio.sfx('deny');
          popups.add('NO CHARGE', e.x, e.y + FIELD_Y - 12, { life: 0.6 });
          break;
        case 'dash':
          app.audio.sfx('dash');
          break;
        case 'shard':
          app.audio.sfx('shard');
          popups.add(`+${shardValue === 1 ? '1' : shardValue.toFixed(1)}${ICON.rf}`, e.x, e.y + FIELD_Y - 6, { life: 0.7 });
          addSparks(e.x, e.y + FIELD_Y, 4, 40);
          break;
        case 'shardLost':
          app.audio.sfx('lost');
          popups.add('LOST', e.x, e.y + FIELD_Y - 4, { life: 0.5 });
          break;
        case 'hurt':
          app.audio.sfx('hurt');
          app.shake(5);
          app.flash(0.07);
          hurtPulse = 0.5;
          addWave(e.x, e.y + FIELD_Y, 34, 3, 0.3);
          break;
        case 'rescue': {
          app.audio.sfx('rescue');
          app.shake(2.5);
          addWave(e.x, e.y + FIELD_Y, 70, 3, 0.5);
          addSparks(e.x, e.y + FIELD_Y, 16, 90);
          popups.add('FRIEND SAVED', e.x, e.y + FIELD_Y - 16, { life: 1.4, vy: -12 });
          banner = { text: 'FRIEND RECOVERED', sub: e.friendId, t: 0, life: 2.0 };
          rescuedSprites.push(e.friendId);
          break;
        }
        case 'capsuleLost':
          app.audio.sfx('lost');
          popups.add('FRIEND LOST', e.x, e.y + FIELD_Y - 10, { life: 1.4, vy: -8 });
          banner = { text: 'FRIEND LOST TO ROT', sub: e.friendId, t: 0, life: 1.6 };
          break;
        case 'capsuleSpawn':
          app.audio.sfx('select');
          banner = { text: 'CAPSULE DETECTED', sub: null, t: 0, life: 1.3 };
          break;
        case 'defrag':
          app.audio.sfx('defrag');
          app.shake(6);
          app.flash(0.12);
          addWave(e.x, e.y + FIELD_Y, 420, 5, 0.7);
          popups.add(`DEFRAG ${e.cleared}`, e.x, e.y + FIELD_Y - 14, { life: 1.3, vy: -10 });
          banner = { text: 'FULL DEFRAG', sub: `${e.cleared} SECTORS CLEARED`, t: 0, life: 1.8 };
          break;
        case 'defragSpawn':
          banner = { text: 'DEFRAG CANISTER', sub: 'DEEP IN THE ROT', t: 0, life: 1.4 };
          break;
        case 'hunt':
          app.audio.sfx('seed');
          break;
        case 'sector':
          app.audio.sfx('sector');
          app.audio.setTempoScale(1 + Math.min(0.5, (e.sector - 1) * 0.08));
          banner = { text: `SECTOR ${e.sector}`, sub: 'DECAY ACCELERATING', t: 0, life: 1.8 };
          break;
        case 'gameover':
          app.audio.sfx('gameover');
          app.audio.stopTrack();
          app.shake(8);
          app.flash(0.2);
          overT = 0;
          break;
        default:
          break;
      }
    }
  }

  /** Ask the server for a seed. Falls back to a local sandbox dive. */
  async function requestTicket() {
    try {
      const t0 = await app.api.startRun();
      ticket = t0.ticket;
      stats = t0.stats;
      shardValue = t0.shardValue;
      run = new Run({ stats, seed: t0.seed, friendId: equippedId });
      trace = new TraceRecorder();
      phase = 'playing';
      app.say('Dive started. Move with WASD, purge with space, dash with shift.');
    } catch (err) {
      if (err.code === 'offline') { app.online = false; app.netStatus = 'offline'; }
      bootError = err.message || 'could not reach the archive';
      ticket = null;
      run = new Run({ stats, friendId: equippedId });
      trace = new TraceRecorder();
      phase = 'playing';
      app.say('Archive unreachable. Playing a local sandbox dive.');
    }
  }

  /** Hand the recorded inputs to the server, which scores the dive itself. */
  async function submitRun() {
    if (!ticket || submitState) return;
    submitState = 'sending';
    try {
      const out = await app.api.submitRun(ticket, trace.encode());
      app.adoptServerSave(out.save);
      app.api.standing = out.standing || app.api.standing;
      submitState = 'done';
      app.setScene('results', { result: out.result, server: out });
    } catch (err) {
      if (err.code === 'offline') { app.online = false; app.netStatus = 'offline'; }
      submitState = 'failed';
      submitMessage = err.message || 'submission refused';
      app.say(`Dive not recorded: ${submitMessage}`);
      app.setScene('results', { result: run.result(shardValue), rejected: submitMessage });
    }
  }

  function restart() {
    ticket = null;
    submitState = null;
    trace = new TraceRecorder();
    if (app.online) {
      phase = 'booting';
      bootError = null;
      requestTicket();
    } else {
      run = new Run({ stats, friendId: equippedId });
    }
    popups.clear();
    waves = [];
    sparks = [];
    rescuedSprites.length = 0;
    overT = -1;
    banner = null;
    paused = false;
    app.audio.playTrack('run');
    app.audio.setTempoScale(1);
  }

  return {
    /** Exposed for the automated browser smoke check (tools/smoke.mjs). */
    debug: () => ({ run, stats, paused, overT }),

    enter() {
      app.audio.playTrack('run');
      app.audio.setTempoScale(1);
      if (phase === 'booting') {
        app.say('Asking the archive for a dive seed.');
        requestTicket();
      } else {
        app.say('Dive started. Move with WASD, purge with space, dash with shift.');
      }
    },

    leave() { app.audio.setTempoScale(1); },

    onHide() { if (run.state === RunState.PLAYING) paused = true; },

    update(dt) {
      t += dt;
      readTouch();
      if (hurtPulse > 0) hurtPulse -= dt;

      // ---- waiting on the server for a seed --------------------------
      if (phase === 'booting') {
        if (app.input.pressed('cancel')) { app.audio.stopTrack(); app.setScene('hub'); }
        return;
      }

      // ---- game over -------------------------------------------------
      if (overT >= 0) {
        overT += dt;
        popups.update(dt);
        updateFx(dt);
        if (ticket && !submitState) { submitRun(); return; }
        if (submitState === 'sending') return;            // the report waits for the verdict
        if (overT > 1.5 || app.input.pressed('confirm') || app.input.pointer.pressed) {
          app.setScene('results', { result: run.result(shardValue), local: !ticket });
        }
        return;
      }

      // ---- pause -----------------------------------------------------
      const pausePressed = app.input.pressed('pause') || touch.pauseTap || (touch.pauseDown && !touch.pauseWas);
      if (paused) {
        const action = pauseMenu.handle(app.input, app.audio);
        if (action === 'select') {
          app.audio.sfx('select');
          const id = pauseMenu.current.id;
          if (id === 'resume') { paused = false; app.audio.playTrack('run'); }
          else if (id === 'restart') restart();
          else if (id === 'quit') { app.audio.stopTrack(); app.setScene('hub'); }
        } else if (action === 'back' || (pausePressed && action !== 'back')) {
          paused = false;
          app.audio.playTrack('run');
        }
        return;
      }
      if (pausePressed) {
        paused = true;
        pauseMenu.index = 0;
        app.audio.sfx('back');
        app.say('Paused.');
        return;
      }

      // ---- intent ----------------------------------------------------
      const k = app.input.keyAxis();
      const ta = touchAxis();
      const intent = {
        ax: k.x || ta.x,
        ay: k.y || ta.y,
        // one press, one purge; holding does nothing (run.js guards it too)
        purge: app.input.pressed('purge') || touch.purgeTap || (touch.purgeDown && !touch.purgeWas),
        dash: app.input.pressed('dash') || touch.dashTap || (touch.dashDown && !touch.dashWas),
      };

      // Quantise first, then feed the *quantised* values to the simulation, so
      // the server's replay of this trace is bit-for-bit identical.
      const q = quantiseIntent(intent);
      trace.push(q.code);
      run.update(dt, q);
      // the recorder is full: end here, because the server will only ever score
      // the ticks it was given
      if (trace.overflowed) {
        banner = { text: 'DIVE BANKED', sub: 'RECORDER FULL', t: 0, life: 2 };
        run.end('trace_full');
      }
      handleEvents();
      popups.update(dt);
      updateFx(dt);
      if (banner) { banner.t += dt; if (banner.t >= banner.life) banner = null; }
    },

    draw(g) {
      g.clear(PAPER);

      if (phase === 'booting') {
        g.dither(0, 0, W, H, 3, INK, 0);
        const p = panel(g, 110, 118, 260, 84, { title: 'ARCHIVE LINK' });
        drawTextCentered(g, 'REQUESTING A DIVE SEED', p.x, p.w, p.y + 12, { v: INK });
        const dots = '.'.repeat(1 + (Math.floor(t * 3) % 3));
        drawTextCentered(g, dots, p.x, p.w, p.y + 28, { v: INK, scale: 2 });
        drawTextCentered(g, 'THE SERVER PICKS THE SEED AND VERIFIES', p.x, p.w, p.y + 50, { font: MICRO });
        drawTextCentered(g, 'THE DIVE WHEN IT ENDS.  ESC CANCELS.', p.x, p.w, p.y + 58, { font: MICRO });
        return;
      }

      /* -------------------------- playfield -------------------------- */
      g.clip(0, FIELD_Y, FIELD_W, FIELD_H);
      drawField(g, run.field, 0, FIELD_Y, {
        phase: app.reduced ? 0 : Math.floor(t * 6) & 3,
      });

      // shards
      for (const sh of run.shards) {
        const bob = app.reduced ? 0 : Math.sin(t * 4 + sh.phase) * 1.2;
        g.sprite(SHARD, Math.round(sh.x - 4), Math.round(sh.y + FIELD_Y - 4 + bob));
      }

      // defrag canister
      if (run.defrag) {
        const d = run.defrag;
        const pulse = 4 + Math.sin(t * 9) * 2;
        g.ringInvert(d.x, d.y + FIELD_Y, 8 + pulse, 1);
        g.sprite(CANISTER, Math.round(d.x - 4), Math.round(d.y + FIELD_Y - 4));
        if (d.life < 6 && (Math.floor(t * 8) & 1)) {
          g.rect(Math.round(d.x - 4), Math.round(d.y + FIELD_Y - 4), 9, 9, PAPER);
        }
      }

      // capsule
      if (run.capsule) {
        const c = run.capsule;
        const cx = Math.round(c.x - 10);
        const cy = Math.round(c.y + FIELD_Y - 10);
        g.rect(cx, cy, 20, 20, PAPER);
        g.frame(cx, cy, 20, 20, INK);
        g.dashFrame(cx - 2, cy - 2, 24, 24, INK, 4, Math.floor(t * 10));
        const corrupted = Math.max(8, 42 - Math.floor(c.buried * 6));
        g.sprite(friendSprite(c.friendId, corrupted), cx + 2, cy + 2, { phase: Math.floor(t * 7) & 3 });
        // bury / life meter
        const frac = 1 - Math.min(1, c.buried / TUNING.capsuleBuryLimit);
        g.rect(cx, cy + 21, 20, 3, PAPER);
        g.rect(cx, cy + 21, Math.round(20 * frac), 3, INK);
        if (c.buried > 1 && (Math.floor(t * 6) & 1)) {
          g.frame(cx - 4, cy - 4, 28, 28, INK);
        }
      }

      // player
      const px = Math.round(run.x);
      const py = Math.round(run.y + FIELD_Y);
      if (!app.reduced) g.discDither(px, py, stats.magnet + 6, 3, PAPER, Math.floor(t * 3) & 3);
      if (run.dashTime > 0 && run.dashDir) {
        for (let i = 1; i <= 3; i++) {
          const gx = px - run.dashDir.x * i * 5;
          const gy = py - run.dashDir.y * i * 5;
          g.discDither(gx, gy, 6 - i, 8, INK, i);
        }
      }
      // while the purge is still eating, show exactly what it is eating
      if (run.purgeActive) {
        g.ring(px, py, stats.purgeRadius, INK, 1);
        g.discDither(px, py, stats.purgeRadius - 1, 4, PAPER, Math.floor(t * 12) & 3);
      }

      const blink = run.iframe > 0 && (Math.floor(t * 18) & 1);
      if (!blink) {
        g.discDither(px, py + 8, 6, 6, INK, 0);
        g.sprite(friendSprite(equippedId, avatarIntegrity), px - 8, py - 9, {
          phase: Math.floor(t * 7) & 3,
        });
      }

      // fx
      for (const w of waves) {
        const k = w.t / w.life;
        const wx = w.follow ? px : w.x;
        const wy = w.follow ? py : w.y;
        g.ringInvert(wx, wy, 2 + k * w.maxR, w.thickness);
      }
      for (const s of sparks) {
        g.px(Math.round(s.x), Math.round(s.y), INK);
        g.px(Math.round(s.x) + 1, Math.round(s.y), INK);
      }
      popups.draw(g);
      g.noClip();

      /* ---------------------------- HUD ------------------------------ */
      drawHud(g);

      /* -------------------------- overlays --------------------------- */
      if (banner) drawBanner(g);
      if (app.input.hasTouch && !paused && overT < 0) drawTouchControls(g);
      if (paused) drawPause(g);
      if (overT >= 0) drawGameOver(g);
    },
  };

  /* ------------------------------------------------------------------ */

  function updateFx(dt) {
    for (let i = waves.length - 1; i >= 0; i--) {
      waves[i].t += dt;
      if (waves[i].t >= waves[i].life) waves.splice(i, 1);
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.t += dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= 0.92;
      s.vy *= 0.92;
      if (s.t >= s.life) sparks.splice(i, 1);
    }
  }

  function drawHud(g) {
    g.rect(0, 0, W, FIELD_Y - 2, INK);
    g.rect(0, FIELD_Y - 2, W, 2, INK);

    // integrity
    drawText(g, 'INTEGRITY', 6, 4, { v: PAPER, font: MICRO });
    for (let i = 0; i < run.maxHp; i++) {
      const hx = 6 + i * 10;
      if (i < run.hp) g.sprite(HEART, hx, 12, { invert: true });
      else g.dither(hx, 12, 7, 6, 5, PAPER, 1);
    }
    if (hurtPulse > 0 && (Math.floor(t * 20) & 1)) {
      g.frame(4, 10, run.maxHp * 10 + 2, 10, PAPER);
    }
    const cost = run.purgeCost;
    // The cell is one pool, not a single charge you wait to fill: a purge costs
    // a slice of it. Divide the meter into purge-sized segments so that reads
    // at a glance, and say outright how many are available right now.
    const ready = Math.floor(run.energy / cost);
    drawText(g, 'PURGE CELL', 6, 24, { v: PAPER, font: MICRO });
    drawTextRight(g, ready > 0 ? `${ready} READY` : 'CHARGING', 118, 24, { v: PAPER, font: MICRO });

    const bx = 6, by = 31, bw = 112, bh = 9, inner = bw - 4;
    g.rect(bx, by, bw, bh, INK);
    g.frame(bx, by, bw, bh, PAPER);
    const fill = Math.round(Math.max(0, Math.min(1, run.energy / stats.energyMax)) * inner);
    if (fill > 0) g.rect(bx + 2, by + 2, fill, bh - 4, PAPER);
    for (let k = 1; k * cost < stats.energyMax; k++) {
      const dx = bx + 2 + Math.round(((k * cost) / stats.energyMax) * inner);
      // invert whatever is under it, so the divider shows on filled and empty alike
      for (let yy = by + 1; yy < by + bh - 1; yy++) g.px(dx, yy, g.get(dx, yy) ? PAPER : INK);
    }
    if (ready === 0 && (Math.floor(t * 5) & 1)) {
      g.frame(4, 29, 116, 13, PAPER);
    }

    // time + sector
    g.vline(126, 4, 39, PAPER);
    drawText(g, 'TIME', 134, 4, { v: PAPER, font: MICRO });
    drawText(g, formatTime(run.time), 134, 12, { v: PAPER, scale: 2 });
    drawText(g, `SECTOR ${run.sector}`, 134, 32, { v: PAPER, font: MICRO });

    // shards + rf
    g.vline(206, 4, 39, PAPER);
    drawText(g, 'SHARDS', 214, 4, { v: PAPER, font: MICRO });
    drawText(g, `${ICON.shard}${run.counters.shards}`, 214, 12, { v: PAPER, scale: 2 });
    const rfNow = Math.round(run.counters.shards * shardValue + run.counters.rescues * 24 + run.counters.defrags * 12);
    drawText(g, `${ICON.rf} ${rfNow} RF`, 214, 32, { v: PAPER, font: MICRO });

    // decay meter + rescued
    g.vline(286, 4, 39, PAPER);
    const cov = run.coverage;
    const barW = app.input.hasTouch ? 152 : 180;   // leave room for the touch pause button
    drawText(g, 'ARCHIVE DECAY', 294, 4, { v: PAPER, font: MICRO });
    bar(g, 294, 12, barW, 9, cov, { v: PAPER, style: cov > 0.6 ? 'solid' : 'dither', ticks: 4 });
    if (cov > 0.6 && (Math.floor(t * 4) & 1)) {
      drawTextRight(g, 'CRITICAL', 294 + barW, 4, { v: PAPER, font: MICRO });
    }
    drawText(g, 'RESCUED', 294, 27, { v: PAPER, font: MICRO });
    const shown = rescuedSprites.slice(-5);
    shown.forEach((id, i) => {
      g.sprite(friendSprite(id, 100), 340 + i * 17, 25);
    });
    if (rescuedSprites.length > 5) {
      drawText(g, `+${rescuedSprites.length - 5}`, 340 + 5 * 17, 32, { v: PAPER, font: MICRO });
    }
    if (shown.length === 0) drawText(g, 'NONE YET', 342, 27, { v: PAPER, font: MICRO });
  }

  function drawBanner(g) {
    const k = banner.t / banner.life;
    const alpha = k < 0.12 ? k / 0.12 : k > 0.82 ? (1 - k) / 0.18 : 1;
    if (alpha <= 0) return;
    const y = FIELD_Y + 16;
    const text = banner.text;
    const tw = measure(text, { scale: 2 });
    const bw = Math.max(tw + 24, banner.sub ? measure(banner.sub, { font: MICRO }) + 24 : 0);
    const bx = Math.round((W - bw) / 2);
    const bh = banner.sub ? 34 : 24;
    g.rect(bx, y, bw, bh, INK);
    g.frame(bx - 2, y - 2, bw + 4, bh + 4, INK);
    g.frame(bx + 1, y + 1, bw - 2, bh - 2, PAPER);
    drawTextCentered(g, text, bx, bw, y + 6, { v: PAPER, scale: 2 });
    if (banner.sub) drawTextCentered(g, banner.sub, bx, bw, y + 24, { v: PAPER, font: MICRO });
    if (alpha < 1) g.dither(bx - 2, y - 2, bw + 4, bh + 4, Math.round((1 - alpha) * 16), PAPER, 2);
  }

  function drawPause(g) {
    g.dither(0, 0, W, H, 11, INK, 0);
    const p = panel(g, 150, 96, 180, 128, { title: 'PAUSED' });
    drawList(g, pauseMenu, p.x + 6, p.y + 8, p.w - 12, 20, t);
    drawTextCentered(g, 'ESC RESUMES', p.x, p.w, p.y + 84, { font: MICRO });
    drawTextCentered(g, `DECAY ${Math.round(run.coverage * 100)}%   ${formatTime(run.time)}`, p.x, p.w, p.y + 94, { font: MICRO });
  }

  function drawGameOver(g) {
    const k = Math.min(1, overT / 0.5);
    g.dither(0, FIELD_Y, W, FIELD_H, Math.round(k * 13), INK, 0);
    const y = 120;
    const tw = measure('SIGNAL LOST', { scale: 3 });
    const bx = Math.round((W - tw) / 2) - 12;
    g.rect(bx, y - 8, tw + 24, 40, PAPER);
    g.frame(bx, y - 8, tw + 24, 40, INK);
    drawTextCentered(g, 'SIGNAL LOST', 0, W, y, { scale: 3, v: INK });
    drawTextCentered(g, `${run.counters.rescues} FRIENDS OUT   ${formatTime(run.time)}`, 0, W, y + 22, { font: MICRO, v: INK });

    if (submitState === 'sending') {
      const dots = '.'.repeat(1 + (Math.floor(t * 4) % 3));
      drawTextCentered(g, `VERIFYING WITH THE ARCHIVE${dots}`, 0, W, y + 44, { font: MICRO, v: PAPER });
    } else if (!ticket) {
      drawTextCentered(g, 'LOCAL SANDBOX - NOT SUBMITTED', 0, W, y + 44, { font: MICRO, v: PAPER });
    }
  }

  function drawTouchControls(g) {
    // stick
    if (touch.stickId !== null) {
      g.ring(touch.sx, touch.sy, 28, INK, 1);
      g.discDither(touch.cx, touch.cy, 10, 9, INK, 0);
    } else {
      g.discDither(70, 250, 26, 2, INK, 0);
      g.ring(70, 250, 26, INK, 1);
      drawTextCentered(g, 'MOVE', 70 - 20, 40, 247, { font: MICRO });
    }
    const btn = (c, label, active) => {
      g.disc(c.x, c.y, c.r, PAPER);
      g.ring(c.x, c.y, c.r, INK, active ? 3 : 1);
      g.discDither(c.x, c.y, c.r - 3, active ? 10 : 4, INK, 0);
      drawTextCentered(g, label, c.x - 20, 40, c.y - 3, { v: INK, font: MICRO });
    };
    btn(BTN.purge, 'PRG', touch.purgeDown);
    btn(BTN.dash, 'DSH', touch.dashDown);
    g.rect(BTN.pause.x - 8, BTN.pause.y - 8, 16, 16, PAPER);
    g.frame(BTN.pause.x - 8, BTN.pause.y - 8, 16, 16, INK);
    g.rect(BTN.pause.x - 3, BTN.pause.y - 4, 2, 8, INK);
    g.rect(BTN.pause.x + 1, BTN.pause.y - 4, 2, 8, INK);
  }
}
