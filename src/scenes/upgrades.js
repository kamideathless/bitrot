import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, MICRO, ICON } from '../core/font.js';
import { panel, header, footer, Menu, pips, bar, paragraph, Popups } from '../ui/widgets.js';
import {
  UPGRADES, nextCost, maxLevel, upgradeBonus, derivedStats, BASE_STATS, formatRf,
} from '../game/economy.js';

export function createUpgradesScene(app) {
  let t = 0;
  const popups = new Popups();
  let pending = false;
  const menu = new Menu(UPGRADES.map((u) => ({ label: u.name, id: u.id })));

  function buy() {
    const def = UPGRADES[menu.index];
    if (pending) return;
    pending = true;
    app.economy.buyUpgrade(def.id).then((res) => {
      pending = false;
      if (!res.ok) {
        app.audio.sfx('deny');
        popups.add(String(res.reason || 'REFUSED').toUpperCase(), 158, 200, { life: 1.1 });
        app.say(String(res.reason || 'refused'));
        return;
      }
      app.audio.sfx('buy');
      popups.add(`-${res.spent} RF`, 158, 200, { life: 0.9 });
      app.say(`${def.name} upgraded. ${res.spent} simulated RF spent.`);
    });
  }

  return {
    enter() {
      app.audio.playTrack('hub');
      app.say('Upgrade bay. Spend simulated RF on permanent dive gear.');
    },

    update(dt) {
      t += dt;
      popups.update(dt);
      const action = menu.handle(app.input, app.audio);
      if (action === 'select') buy();
      else if (action === 'back') { app.audio.sfx('back'); app.setScene('hub'); }
    },

    draw(g) {
      const save = app.save;
      g.clear(PAPER);
      g.dither(0, 0, W, H, 2, INK, 0);
      header(g, 'UPGRADE BAY', `${ICON.rf} ${formatRf(save.rf)} RF`);

      /* ---- upgrade rows ---------------------------------------------- */
      menu.beginDraw();
      const x = 8, w = 300, rowH = 27, gap = 2;
      for (let i = 0; i < UPGRADES.length; i++) {
        const def = UPGRADES[i];
        const lvl = save.upgrades[def.id] || 0;
        const cost = nextCost(def, lvl);
        const maxed = cost === null;
        const affordable = !maxed && save.rf >= cost;
        const y = 22 + i * (rowH + gap);
        const active = i === menu.index;
        menu.rect(i, x, y, w, rowH);

        if (active) {
          g.rect(x, y, w, rowH, INK);
          g.frame(x - 1, y - 1, w + 2, rowH + 2, INK);
        } else {
          g.rect(x, y, w, rowH, PAPER);
          g.frame(x, y, w, rowH, INK);
        }
        const fg = active ? PAPER : INK;

        drawText(g, def.name, x + 6, y + 4, { v: fg });
        pips(g, x + 6, y + 15, maxLevel(def), lvl, 5, 2, fg);

        const bonus = upgradeBonus(def, lvl);
        drawText(g, `${BASE_STATS[def.stat]}${bonus ? `+${bonus}` : ''} ${def.unit}`, x + 100, y + 16, { v: fg, font: MICRO });

        if (maxed) {
          drawTextRight(g, 'MAX', x + w - 8, y + 10, { v: fg });
        } else {
          drawTextRight(g, `${cost} RF`, x + w - 8, y + 5, { v: fg });
          drawTextRight(g, affordable ? 'BUY' : 'LOCKED', x + w - 8, y + 17, { v: fg, font: MICRO });
          if (!affordable && !active) g.dither(x + 1, y + 1, w - 2, rowH - 2, 4, INK, 1);
        }
      }
      menu.endDraw();

      /* ---- detail ------------------------------------------------------ */
      const def = UPGRADES[menu.index];
      const lvl = save.upgrades[def.id] || 0;
      const cost = nextCost(def, lvl);
      const dp = panel(g, 316, 22, 156, 172, { title: 'SPEC' });
      drawText(g, def.name, dp.x + 4, dp.y + 2, { v: INK });
      paragraph(g, def.blurb, dp.x + 4, dp.y + 14, dp.w - 8, { lineGap: 4 });
      drawText(g, 'LEVEL', dp.x + 4, dp.y + 48, { font: MICRO });
      pips(g, dp.x + 44, dp.y + 47, maxLevel(def), lvl, 6, 3);
      const cur = BASE_STATS[def.stat] + upgradeBonus(def, lvl);
      const nxt = cost === null ? cur : BASE_STATS[def.stat] + upgradeBonus(def, lvl + 1);
      drawText(g, 'NOW', dp.x + 4, dp.y + 64, { font: MICRO });
      drawText(g, `${round1(cur)} ${def.unit}`, dp.x + 4, dp.y + 73, { v: INK });
      drawText(g, 'NEXT', dp.x + 80, dp.y + 64, { font: MICRO });
      drawText(g, cost === null ? 'MAX' : `${round1(nxt)} ${def.unit}`, dp.x + 80, dp.y + 73, { v: INK });

      const canBuy = cost !== null && save.rf >= cost;
      g.rect(dp.x + 4, dp.y + 92, dp.w - 8, 22, canBuy ? INK : PAPER);
      g.frame(dp.x + 4, dp.y + 92, dp.w - 8, 22, INK);
      if (!canBuy) g.dither(dp.x + 5, dp.y + 93, dp.w - 10, 20, 4, INK, 1);
      drawTextCentered(
        g,
        cost === null ? 'FULLY UPGRADED' : canBuy ? `BUY  ${cost} RF` : `NEED ${cost - save.rf} MORE RF`,
        dp.x + 4, dp.w - 8, dp.y + 99,
        { v: canBuy ? PAPER : INK },
      );
      drawTextCentered(g, 'ENTER', dp.x + 4, dp.w - 8, dp.y + 120, { font: MICRO });

      /* ---- loadout ----------------------------------------------------- */
      const stats = derivedStats(save);
      const lp = panel(g, 8, 198, 300, 106, { title: 'CURRENT LOADOUT' });
      const rows = [
        ['MAX INTEGRITY', `${stats.maxHp}`],
        ['PURGE RADIUS', `${round1(stats.purgeRadius)} PX`],
        ['PURGE COST', `${stats.purgeCost} / ${stats.energyMax}`],
        ['ENERGY REGEN', `${round1(stats.energyRegen)}/S`],
        ['SCAR DURATION', `${round1(stats.scarGens)} GEN`],
        ['MOVE SPEED', `${round1(stats.speed)} PX/S`],
        ['PICKUP RANGE', `${round1(stats.magnet)} PX`],
        ['DASH COOLDOWN', `${stats.dashCooldown.toFixed(2)}S`],
      ];
      rows.forEach(([k, v], i) => {
        const cx = lp.x + 4 + (i % 2) * 148;
        const cy = lp.y + 2 + ((i / 2) | 0) * 11;
        drawText(g, k, cx, cy, { font: MICRO });
        drawTextRight(g, v, cx + 142, cy, { font: MICRO });
      });
      drawText(g, 'PERKS FROM A FULLY RESTORED FRIEND STACK ON TOP.', lp.x + 4, lp.y + 50, { font: MICRO });
      g.hline(lp.x + 2, lp.x + lp.w - 3, lp.y + 60, INK);
      drawText(g, 'SPENT RF IS REMOVED FROM YOUR SIMULATED BALANCE', lp.x + 4, lp.y + 66, { font: MICRO });
      drawText(g, 'BUT IS NOT COUNTED AS A BURN — ONLY RESTORATION', lp.x + 4, lp.y + 74, { font: MICRO });
      drawText(g, 'BURNS RF. SEE THE FRIENDS SCREEN.', lp.x + 4, lp.y + 82, { font: MICRO });

      const bp = panel(g, 316, 198, 156, 106, { title: 'LEDGER' });
      drawText(g, 'HELD', bp.x + 4, bp.y + 2, { font: MICRO });
      drawText(g, formatRf(save.rf), bp.x + 4, bp.y + 11, { v: INK, scale: 2 });
      drawText(g, 'EARNED', bp.x + 4, bp.y + 30, { font: MICRO });
      drawText(g, formatRf(save.rfEarned), bp.x + 4, bp.y + 39, { v: INK });
      drawText(g, 'BURNED', bp.x + 80, bp.y + 30, { font: MICRO });
      drawText(g, formatRf(save.rfBurned), bp.x + 80, bp.y + 39, { v: INK });
      bar(g, bp.x + 4, bp.y + 54, bp.w - 8, 8, save.rfEarned ? save.rfBurned / Math.max(1, save.rfEarned) : 0);
      drawText(g, 'BURN RATIO (BURNED / EARNED)', bp.x + 4, bp.y + 66, { font: MICRO });
      drawText(g, 'SIMULATED — NOTHING ON CHAIN.', bp.x + 4, bp.y + 78, { font: MICRO });

      popups.draw(g);
      footer(g, 'ENTER BUY   ARROWS MOVE   ESC BACK');
    },
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}
