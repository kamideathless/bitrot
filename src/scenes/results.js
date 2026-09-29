import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, MICRO, ICON } from '../core/font.js';
import { panel, header, footer, Menu, drawList, friendCard, paragraph } from '../ui/widgets.js';
import { friendTraits, startingIntegrity } from '../game/friends.js';
import { PAYOUT, sectorMultiplier, formatTime, formatRf, applyRunToSave } from '../game/economy.js';

export function createResultsScene(app, params) {
  const result = params.result;
  let t = 0;

  // Where these numbers came from decides everything on this screen.
  //   server   — the dive was replayed and scored by the server; the save it
  //              returned has already been adopted, so nothing is applied here.
  //   rejected — the submission was refused; the dive counts for nothing.
  //   local    — offline sandbox; apply it to the local copy and say so.
  const server = params.server || null;
  const rejected = params.rejected || null;
  const verified = !!server;

  let fresh = [];
  let dupes = [];
  let salvageTotal = 0;
  let payout = 0;
  let newBest = false;

  if (server) {
    fresh = (server.fresh || []).map((id) => ({ id }));
    dupes = server.dupes || [];
    salvageTotal = dupes.reduce((n, d) => n + d.salvage, 0);
    payout = server.payout ?? 0;
    newBest = app.save.best.score === Math.round(result.score) && result.score > 0;
  } else if (!rejected) {
    const applied = applyRunToSave(app.save, result);
    app.save = applied.save;
    fresh = applied.fresh;
    dupes = applied.dupes;
    salvageTotal = applied.salvage;
    payout = applied.payout;
    newBest = applied.newBest;
    app.persist();
  }

  const save = app.save;

  const menu = new Menu([
    { label: 'DIVE AGAIN', id: 'play', right: 'R' },
    { label: 'RESTORE FRIENDS', id: 'collection' },
    { label: 'UPGRADES', id: 'upgrades' },
    { label: 'TERMINAL', id: 'hub' },
  ]);

  const revealTotal = 0.75;
  const ease = (k) => 1 - Math.pow(1 - Math.min(1, Math.max(0, k)), 3);
  const grow = (v) => Math.round(v * ease(t / revealTotal));

  return {
    enter() {
      app.audio.playTrack('hub');
      app.audio.setTempoScale(1);
      app.say(
        `Dive over. Survived ${formatTime(result.time)}, rescued ${result.rescues} friends, earned ${payout} simulated RF.`,
      );
      if (newBest) app.audio.sfx('restored');
    },

    update(dt) {
      t += dt;
      const action = menu.handle(app.input, app.audio);
      if (app.input.pressed('restart')) { app.audio.sfx('select'); app.setScene('play'); return; }
      if (action === 'select') {
        app.audio.sfx('select');
        app.setScene(menu.current.id);
      } else if (action === 'back') {
        app.audio.sfx('back');
        app.setScene('hub');
      }
    },

    draw(g) {
      g.clear(PAPER);
      g.dither(0, 0, W, H, 2, INK, 0);
      header(g, 'DIVE REPORT', `${ICON.rf} ${formatRf(save.rf)} RF`);

      /* ---- run log --------------------------------------------------- */
      const lp = panel(g, 8, 22, 220, 176, { title: 'RUN LOG' });
      const rows = [
        ['SURVIVED', formatTime(result.time)],
        ['DEEPEST SECTOR', String(result.sector)],
        ['SHARDS', String(grow(result.shards))],
        ['FRIENDS RECOVERED', String(result.rescues)],
        ['FRIENDS LOST', String(result.lostCapsules)],
        ['DEFRAGS', String(result.defrags)],
        ['PURGES FIRED', String(result.purges)],
        ['HITS TAKEN', String(result.hits)],
        ['FINAL DECAY', `${Math.round(result.coverage * 100)}%`],
      ];
      rows.forEach(([k, v], i) => {
        const y = lp.y + 2 + i * 12;
        drawText(g, k, lp.x + 4, y, { font: MICRO });
        drawTextRight(g, v, lp.x + lp.w - 4, y - 1, { v: INK });
        if (i < rows.length - 1) g.dither(lp.x + 4, y + 8, lp.w - 8, 1, 8, INK, 0);
      });

      const sy = lp.y + 116;
      g.rect(lp.x + 2, sy, lp.w - 4, 30, INK);
      drawText(g, 'SCORE', lp.x + 6, sy + 4, { v: PAPER, font: MICRO });
      drawTextRight(g, String(grow(result.score)), lp.x + lp.w - 6, sy + 11, { v: PAPER, scale: 2 });
      if (newBest && (Math.floor(t * 3) & 1)) {
        drawText(g, 'NEW BEST!', lp.x + 6, sy + 14, { v: PAPER, font: MICRO });
      } else if (!newBest) {
        drawText(g, `BEST ${save.best.score}`, lp.x + 6, sy + 14, { v: PAPER, font: MICRO });
      }

      /* ---- recovered friends ----------------------------------------- */
      const rp = panel(g, 236, 22, 236, 176, { title: 'RECOVERED FRIENDS' });
      if (fresh.length === 0 && dupes.length === 0) {
        drawTextCentered(g, 'NO CAPSULES RECOVERED', rp.x, rp.w, rp.y + 54, { v: INK });
        paragraph(g,
          'CAPSULES SURFACE EVERY FEW SECONDS. REACH ONE BEFORE THE ROT BURIES IT AND THE FRIEND INSIDE JOINS YOUR ARCHIVE.',
          rp.x + 8, rp.y + 72, rp.w - 16, { lineGap: 4 });
      } else {
        const all = [...fresh.map((f) => ({ ...f, dup: false })), ...dupes.map((d) => ({ ...d, dup: true }))];
        const shown = all.slice(0, 6);
        shown.forEach((entry, i) => {
          const col = i % 3;
          const row = (i / 3) | 0;
          const x = rp.x + 8 + col * 74;
          const y = rp.y + 2 + row * 76;
          const appear = Math.min(1, Math.max(0, (t - 0.25 - i * 0.18) * 5));
          if (appear <= 0) return;
          const traits = friendTraits(entry.id);
          friendCard(g, entry.id, entry.dup ? 100 : startingIntegrity(entry.id), x + 8, y, 3, { t });
          g.rect(x + 2, y + 52, 64, 11, INK);
          drawTextCentered(g, entry.dup ? `DUP +${entry.salvage}` : 'NEW', x + 2, 64, y + 54, { v: PAPER });
          drawTextCentered(g, traits.name, x - 1, 70, y + 65, { font: MICRO });
          drawTextCentered(g, `${traits.rarity} GEN-${traits.generation}`, x - 1, 70, y + 72, { font: MICRO });
          if (appear < 1) g.dither(x, y - 2, 70, 78, Math.round((1 - appear) * 16), PAPER, 1);
        });
        if (all.length > 6) {
          drawTextRight(g, `+${all.length - 6} MORE`, rp.x + rp.w - 4, rp.y + rp.h - 10, { font: MICRO });
        }
      }

      /* ---- payout ----------------------------------------------------- */
      const pp = panel(g, 8, 202, 300, 102, { title: 'SIMULATED RF PAYOUT' });
      const mult = sectorMultiplier(result.sector);
      const lines = [
        [`${result.shards} SHARDS x ${PAYOUT.perShard}`, result.shards * PAYOUT.perShard],
        [`${result.rescues} RESCUES x ${PAYOUT.perRescue}`, result.rescues * PAYOUT.perRescue],
        [`${result.defrags} DEFRAGS x ${PAYOUT.perDefrag}`, result.defrags * PAYOUT.perDefrag],
        [`SECTOR DEPTH BONUS`, (result.sector - 1) * PAYOUT.perSector],
      ];
      lines.forEach(([k, v], i) => {
        const y = pp.y + 2 + i * 11;
        drawText(g, k, pp.x + 4, y, { font: MICRO });
        drawTextRight(g, String(Math.round(v)), pp.x + 150, y, { font: MICRO });
      });
      drawText(g, `SECTOR MULTIPLIER x${mult.toFixed(2)}`, pp.x + 4, pp.y + 48, { font: MICRO });
      if (salvageTotal) drawText(g, `DUPLICATE SALVAGE +${salvageTotal}`, pp.x + 4, pp.y + 57, { font: MICRO });
      g.hline(pp.x + 4, pp.x + 150, pp.y + 46, INK);

      g.rect(pp.x + 158, pp.y + 2, pp.w - 162, 64, INK);
      drawText(g, 'TOTAL EARNED', pp.x + 162, pp.y + 6, { v: PAPER, font: MICRO });
      drawText(g, `${grow(payout)}`, pp.x + 162, pp.y + 17, { v: PAPER, scale: 3 });
      drawText(g, 'RF (SIMULATED)', pp.x + 162, pp.y + 52, { v: PAPER, font: MICRO });
      drawText(g, verified ? 'VERIFIED AND BANKED BY THE ARCHIVE.'
        : rejected ? 'REFUSED BY THE ARCHIVE - NOT BANKED.'
        : 'LOCAL SANDBOX - THIS DIVE IS NOT RECORDED.', pp.x + 4, pp.y + 74, { font: MICRO });

      /* ---- menu -------------------------------------------------------- */
      panel(g, 316, 202, 156, 102, { title: 'NEXT' });
      drawList(g, menu, 322, 221, 144, 18, t);

      footer(g, 'ENTER SELECT   R DIVE AGAIN   ESC TERMINAL',
        rejected ? 'NOT RECORDED' : verified ? 'SERVER VERIFIED' : 'LOCAL SANDBOX');
    },
  };
}
