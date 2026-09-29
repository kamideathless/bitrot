import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, MICRO, ICON } from '../core/font.js';
import { panel, header, footer, bar, Menu, drawList, friendCard, paragraph } from '../ui/widgets.js';
import { friendTraits, STRAY_ID } from '../game/friends.js';
import { equippedFriend, activePerk, derivedStats, formatRf, formatTime } from '../game/economy.js';

export function createHubScene(app) {
  let t = 0;
  const menu = new Menu([
    { label: 'DIVE', id: 'play', right: 'ENTER' },
    { label: 'UPGRADES', id: 'upgrades' },
    { label: 'FRIENDS', id: 'collection' },
    { label: 'ARCHIVE / HOW TO PLAY', id: 'help' },
    { label: 'SETTINGS', id: 'settings' },
  ]);

  function refresh() {
    const save = app.save;
    menu.items[1].right = `LV ${Object.values(save.upgrades).reduce((a, b) => a + b, 0)}`;
    menu.items[2].right = `${save.friends.length}`;
  }
  refresh();

  return {
    enter() {
      app.audio.playTrack('hub');
      app.audio.setTempoScale(1);
      refresh();
      app.say('Archive terminal. Choose Dive to start a run.');
    },

    update() {
      const action = menu.handle(app.input, app.audio);
      if (action === 'select') {
        const item = menu.current;
        app.audio.sfx('select');
        if (item.id === 'play') app.setScene('play');
        else app.setScene(item.id);
      } else if (action === 'back') {
        app.audio.sfx('back');
        app.setScene('title');
      }
      t += 1 / 60;
    },

    draw(g) {
      const save = app.save;
      g.clear(PAPER);
      g.dither(0, 0, W, H, 2, INK, 0);

      header(g, 'ARCHIVE TERMINAL', `${ICON.rf} ${formatRf(save.rf)} RF`);

      /* ---- equipped Friend ------------------------------------------ */
      const lp = panel(g, 8, 22, 150, 200, { title: 'EQUIPPED FRIEND' });
      const eq = equippedFriend(save);
      const id = eq ? eq.id : STRAY_ID;
      const integrity = eq ? eq.integrity : 100;
      const traits = friendTraits(id);

      friendCard(g, id, integrity, 8 + (150 - 100) / 2, 42, 6, { t, frame: false });
      drawTextCentered(g, traits.label, 10, 146, 148, { v: INK });
      drawTextCentered(g, eq ? `${traits.rarity}  GEN-${traits.generation}` : 'NO FRIEND EQUIPPED', 10, 146, 158, { v: INK, font: MICRO });

      drawText(g, 'INTEGRITY', 16, 172, { font: MICRO });
      drawTextRight(g, `${integrity}%`, 150, 172, { font: MICRO });
      bar(g, 16, 180, 134, 8, integrity / 100, { style: integrity >= 100 ? 'solid' : 'dither' });

      const perk = activePerk(save);
      if (perk) {
        g.rect(14, 192, 138, 9, INK);
        drawTextCentered(g, `${ICON.star} ${perk.name}`, 14, 138, 194, { v: PAPER, font: MICRO });
        drawTextCentered(g, perk.text, 14, 138, 205, { v: INK, font: MICRO });
      } else if (eq) {
        drawTextCentered(g, 'PERK LOCKED', 14, 138, 194, { v: INK, font: MICRO });
        drawTextCentered(g, 'RESTORE TO 100%', 14, 138, 204, { v: INK, font: MICRO });
      } else {
        drawTextCentered(g, 'RESCUE A FRIEND', 14, 138, 194, { v: INK, font: MICRO });
        drawTextCentered(g, 'TO UNLOCK PERKS', 14, 138, 204, { v: INK, font: MICRO });
      }

      /* ---- menu ------------------------------------------------------ */
      drawList(g, menu, 166, 24, 306, 20, t);

      /* ---- run stats ------------------------------------------------- */
      const sp = panel(g, 166, 140, 306, 82, { title: 'DIVE RECORD' });
      const stats = derivedStats(save);
      const col = (label, value, x, y) => {
        drawText(g, label, x, y, { font: MICRO });
        drawText(g, value, x, y + 8, { v: INK });
      };
      col('BEST SCORE', String(save.best.score), sp.x + 4, sp.y + 4);
      col('BEST TIME', formatTime(save.best.time), sp.x + 108, sp.y + 4);
      col('DEEPEST SECTOR', String(save.best.sector), sp.x + 200, sp.y + 4);
      col('DIVES', String(save.runs), sp.x + 4, sp.y + 28);
      col('FRIENDS HELD', String(save.friends.length), sp.x + 108, sp.y + 28);
      col('RESTORED', String(save.friends.filter((f) => f.integrity >= 100).length), sp.x + 200, sp.y + 28);

      drawText(g, `LOADOUT  HP ${stats.maxHp}  PURGE ${Math.round(stats.purgeRadius)}PX  CELL ${stats.energyMax}  SPD ${Math.round(stats.speed)}`,
        sp.x + 4, sp.y + 54, { font: MICRO });

      /* ---- simulated ledger ------------------------------------------ */
      const bp = panel(g, 8, 228, 464, 64, { title: 'SIMULATED $RAREFRIENDS LEDGER' });
      const cols = [
        ['HELD', formatRf(save.rf)],
        ['EARNED', formatRf(save.rfEarned)],
        ['BURNED', formatRf(save.rfBurned)],
      ];
      cols.forEach(([label, value], i) => {
        const cx = bp.x + 6 + i * 118;
        drawText(g, label, cx, bp.y + 4, { font: MICRO });
        drawText(g, value, cx, bp.y + 13, { scale: 2, v: INK });
        if (i < 2) g.vline(cx + 110, bp.y + 2, bp.y + 36, INK);
      });
      g.vline(bp.x + 356, bp.y + 2, bp.y + 36, INK);
      paragraph(g,
        'ALL BALANCES SIMULATED. NO WALLET, NO CHAIN.',
        bp.x + 364, bp.y + 4, 92, { lineGap: 4 });

      // Say plainly whether this run will count. A player should never have to
      // guess whether their progress is being recorded.
      const link = app.netStatus === 'online'
        ? `${ICON.chip} ONLINE  ${app.account ? app.account.name : ''}`
        : app.netStatus === 'connecting' ? 'LINKING TO ARCHIVE...' : 'LOCAL SANDBOX - NOT RECORDED';
      footer(g, 'ENTER SELECT   ESC BACK   M MUTE', link);
    },
  };
}
