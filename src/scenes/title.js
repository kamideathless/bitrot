import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, measure, MICRO } from '../core/font.js';
import { createField, step, bitFlip, defrag, seed, COLS, ROWS, genInterval } from '../game/automaton.js';
import { drawField } from '../ui/field.js';
import { friendCard } from '../ui/widgets.js';
import { Rng } from '../core/rng.js';

const SHOWCASE = ['7A31C4', 'E90B2F', '2C77D1', 'B45E08'];

export function createTitleScene(app) {
  const rng = new Rng(20260930);
  let field = createField();
  let acc = 0;
  let t = 0;
  const pressure = 0.75;
  let wipeIn = 0;

  function reseed() {
    field = createField();
    for (let i = 0; i < 9; i++) {
      seed(field, 2 + rng.int(COLS - 4), 2 + rng.int(ROWS - 4));
    }
  }
  reseed();
  // let the backdrop start mid-decay instead of empty
  for (let i = 0; i < 90; i++) {
    step(field, pressure, () => rng.next());
    bitFlip(field, pressure, () => rng.next());
  }

  const MARQUEE = 'ARCHIVE INTEGRITY FALLING  ·  RESCUE PROTOCOL ONLINE  ·  SIMULATED LEDGER ATTACHED  ·  ';

  return {
    enter() {
      app.audio.playTrack('hub');
      app.say('BITROT title screen. Press Enter to boot.');
    },

    update(dt) {
      t += dt;
      acc += dt;
      const gi = genInterval(pressure) * (app.reduced ? 2.5 : 1);
      let guard = 0;
      while (acc >= gi && guard++ < 4) {
        acc -= gi;
        step(field, pressure, () => rng.next());
        bitFlip(field, pressure, () => rng.next());
      }
      if (wipeIn > 0) wipeIn -= dt;
      let rot = 0;
      for (let i = 0; i < field.cells.length; i++) if (field.cells[i] === 1) rot++;
      if (rot / field.playable > 0.72) {
        defrag(field, 4);
        for (let i = 0; i < 4; i++) seed(field, 2 + rng.int(COLS - 4), 2 + rng.int(ROWS - 4));
        wipeIn = 0.25;
      }

      if (app.input.pressed('confirm') || app.input.pointer.pressed || app.input.pressed('cancel')) {
        app.audio.sfx('select');
        if (!app.save.seenIntro) app.setScene('help', { intro: true });
        else app.setScene('hub');
      }
    },

    draw(g) {
      g.clear(PAPER);
      drawField(g, field, 0, 44, { phase: app.reduced ? 0 : Math.floor(t * 5) & 3, showScars: false });

      // status strip where the HUD lives during a dive
      g.rect(0, 0, W, 44, INK);
      const span = MARQUEE.length * (MICRO.w + MICRO.gap);
      const scroll = Math.floor(t * 18) % span;
      for (let x = -scroll; x < W; x += span) {
        drawText(g, MARQUEE, x, 4, { v: PAPER, font: MICRO });
        drawText(g, MARQUEE, x, 34, { v: PAPER, font: MICRO });
      }
      for (let i = 0; i < 12; i++) {
        const lv = 4 + ((Math.floor(t * 3) + i * 5) % 12);
        g.dither(8 + i * 38, 14, 30, 14, lv, PAPER, i & 3);
      }
      g.rect(0, 42, W, 2, INK);

      if (wipeIn > 0) g.invertRect(0, 0, W, H);

      // logo plate
      const px = 44, py = 74, pw = W - 88, ph = 116;
      g.dither(px + 3, py + 3, pw, ph, 8, INK, 1);
      g.rect(px, py, pw, ph, PAPER);
      g.frame(px, py, pw, ph, INK);
      g.frame(px + 2, py + 2, pw - 4, ph - 4, INK);

      const scale = 6;
      const title = 'BITROT';
      const tw = measure(title, { scale });
      const tx = Math.round((W - tw) / 2);
      drawText(g, title, tx, py + 16, { scale, v: INK });
      // a bite taken out of the logo, drifting
      const bite = Math.floor(t * 1.4) % 5;
      g.dither(tx + bite * 34, py + 16, 18, 42, 7, PAPER, Math.floor(t * 6) & 3);

      drawTextCentered(g, 'THE ARCHIVE IS DECAYING', 0, W, py + 66, { v: INK });
      drawTextCentered(g, 'A RARE FRIENDS RESCUE', 0, W, py + 80, { v: INK, font: MICRO });
      g.hline(px + 18, px + pw - 19, py + 94, INK);
      drawTextCentered(g, '1-BIT CELLULAR ARCADE', 0, W, py + 100, { v: INK, font: MICRO });

      // showcase friends on the plate corners
      friendCard(g, SHOWCASE[0], 100, px + 10, py + 74, 1, { t, frame: false });
      friendCard(g, SHOWCASE[1], 100, px + 28, py + 74, 1, { t, frame: false });
      friendCard(g, SHOWCASE[2], 100, px + pw - 44, py + 74, 1, { t, frame: false });
      friendCard(g, SHOWCASE[3], 100, px + pw - 26, py + 74, 1, { t, frame: false });

      // prompt
      if ((Math.floor(t * 1.8) & 1) === 0) {
        const msg = app.input.hasTouch ? 'TAP TO BOOT' : 'PRESS ENTER TO BOOT';
        const mw = measure(msg, { scale: 1 });
        const mx = Math.round((W - mw) / 2);
        g.rect(mx - 8, 224, mw + 16, 15, PAPER);
        g.frame(mx - 8, 224, mw + 16, 15, INK);
        drawText(g, msg, mx, 228, { v: INK });
      }

      // footer strip
      g.rect(0, H - 14, W, 14, INK);
      drawText(g, 'SIMULATED ECONOMY — NO WALLET REQUIRED', 6, H - 11, { v: PAPER, font: MICRO });
      const best = app.save.best.score;
      drawText(g, best ? `BEST ${best}` : 'NEW ARCHIVE', W - 6 - measure(best ? `BEST ${best}` : 'NEW ARCHIVE', { font: MICRO }), H - 11, { v: PAPER, font: MICRO });
    },
  };
}
