import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, MICRO, ICON } from '../core/font.js';
import { panel, header, footer, Menu, bar, friendCard, paragraph, Popups } from '../ui/widgets.js';
import { friendTraits, friendSprite, rarityOrder } from '../game/friends.js';
import {
  restoreCost, restoreTotalCost, RESTORE_STEP, formatRf,
} from '../game/economy.js';

const COLS_GRID = 7;
const ROWS_GRID = 4;
const PAGE = COLS_GRID * ROWS_GRID;

export function createCollectionScene(app) {
  let t = 0;
  let focus = 'grid';
  let burnFx = 0;
  let restoredFx = 0;
  const popups = new Popups();
  let pending = false;
  const gridMenu = new Menu([], { columns: COLS_GRID, wrap: false });
  const actionMenu = new Menu([], { columns: 1 });

  function sorted() {
    return app.save.friends.slice().sort((a, b) => {
      const ra = rarityOrder(friendTraits(a.id).rarity);
      const rb = rarityOrder(friendTraits(b.id).rarity);
      if (rb !== ra) return rb - ra;
      if (b.integrity !== a.integrity) return b.integrity - a.integrity;
      return a.id < b.id ? -1 : 1;
    });
  }

  let list = sorted();
  gridMenu.setItems(list.map((f) => ({ label: f.id, id: f.id })), false);

  function selected() {
    const item = gridMenu.current;
    if (!item) return null;
    return app.save.friends.find((f) => f.id === item.id) || null;
  }

  function rebuildActions() {
    const f = selected();
    if (!f) { actionMenu.setItems([]); return; }
    const step = restoreCost(f);
    const all = restoreTotalCost(f);
    const equipped = app.save.equipped === f.id;
    actionMenu.setItems([
      {
        id: 'restore', label: `BURN ${step ?? 0} RF`,
        sub: step === null ? 'FULLY RESTORED' : `+${Math.min(RESTORE_STEP, 100 - f.integrity)}% INTEGRITY`,
        disabled: step === null || app.save.rf < step,
      },
      {
        id: 'restoreAll', label: `BURN ${all} RF`,
        sub: all === 0 ? 'FULLY RESTORED' : 'RESTORE TO 100%',
        disabled: all === 0 || app.save.rf < all,
      },
      {
        id: 'equip', label: equipped ? 'EQUIPPED' : 'EQUIP',
        sub: equipped ? 'ACTIVE AVATAR' : 'USE AS DIVE AVATAR',
        disabled: equipped,
      },
    ]);
  }
  rebuildActions();

  function doRestore(toFull) {
    const f = selected();
    if (!f || pending) return;
    pending = true;
    app.economy.burnRestore(f.id, toFull).then((res) => {
      pending = false;
      if (!res.ok) {
        app.audio.sfx('deny');
        popups.add(String(res.reason || 'REFUSED').toUpperCase(), 330, 200, { life: 1.1 });
        app.say(String(res.reason || 'refused'));
        rebuildActions();
        return;
      }
      list = sorted();
      gridMenu.setItems(list.map((x) => ({ label: x.id, id: x.id })));
      const i = list.findIndex((x) => x.id === f.id);
      if (i >= 0) gridMenu.index = i;
      burnFx = 0.5;
      app.audio.sfx('burn');
      popups.add(`-${res.spent} RF BURNED`, 330, 196, { life: 1.3, vy: -14 });
      app.shake(2);
      if (res.restored) {
        restoredFx = 1.2;
        app.audio.sfx('restored');
        app.flash(0.1);
        popups.add('RESTORED', 330, 176, { life: 1.6, vy: -8, scale: 2 });
        app.say(`${friendTraits(f.id).label} fully restored. Perk unlocked.`);
      } else {
        app.say(`Burned ${res.spent} simulated RF.`);
      }
      rebuildActions();
    });
  }

  function doEquip() {
    const f = selected();
    if (!f || pending) return;
    pending = true;
    app.economy.equip(f.id).then((res) => {
      pending = false;
      if (!res.ok) {
        app.audio.sfx('deny');
        popups.add(String(res.reason || 'REFUSED').toUpperCase(), 330, 200, { life: 1 });
        return;
      }
      app.audio.sfx('equip');
      popups.add('EQUIPPED', 330, 200, { life: 0.9 });
      app.say(`${friendTraits(f.id).label} equipped.`);
      rebuildActions();
    });
  }

  function activate(id) {
    if (id === 'restore') doRestore(false);
    else if (id === 'restoreAll') doRestore(true);
    else if (id === 'equip') doEquip();
  }

  function hit(rects, p) {
    for (const r of rects) {
      if (p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h) return r.i;
    }
    return -1;
  }

  return {
    enter() {
      app.audio.playTrack('hub');
      app.say(app.save.friends.length
        ? 'Friend archive. Burn simulated RF to restore corrupted pixels.'
        : 'Friend archive is empty. Dive and rescue a capsule first.');
    },

    update(dt) {
      t += dt;
      popups.update(dt);
      if (burnFx > 0) burnFx -= dt;
      if (restoredFx > 0) restoredFx -= dt;

      if (list.length === 0) {
        if (app.input.pressed('cancel') || app.input.pressed('confirm') || app.input.pointer.pressed) {
          app.audio.sfx('back');
          app.setScene('hub');
        }
        return;
      }

      const p = app.input.pointer;
      if (focus === 'grid') {
        const hitAction = p.pressed ? hit(actionMenu.hitRects, p) : -1;
        if (hitAction >= 0 && !actionMenu.items[hitAction].disabled) {
          actionMenu.index = hitAction;
          activate(actionMenu.items[hitAction].id);
          return;
        }
        const before = gridMenu.index;
        const action = gridMenu.handle(app.input, app.audio);
        if (gridMenu.index !== before) rebuildActions();
        if (action === 'select') { focus = 'actions'; actionMenu.index = 0; app.audio.sfx('select'); }
        else if (action === 'back') { app.audio.sfx('back'); app.setScene('hub'); }
      } else {
        const hitGrid = p.pressed ? hit(gridMenu.hitRects, p) : -1;
        if (hitGrid >= 0) {
          gridMenu.index = hitGrid;
          focus = 'grid';
          rebuildActions();
          app.audio.sfx('move');
          return;
        }
        const action = actionMenu.handle(app.input, app.audio);
        if (action === 'select') {
          const item = actionMenu.current;
          if (!item || item.disabled) app.audio.sfx('deny');
          else activate(item.id);
        } else if (action === 'back') { focus = 'grid'; app.audio.sfx('back'); }
      }
    },

    draw(g) {
      const save = app.save;
      g.clear(PAPER);
      g.dither(0, 0, W, H, 2, INK, 0);
      header(g, 'FRIEND ARCHIVE', `${ICON.rf} ${formatRf(save.rf)} RF`);

      if (list.length === 0) {
        const p = panel(g, 80, 90, 320, 130, { title: 'ARCHIVE EMPTY' });
        drawTextCentered(g, 'NO FRIENDS RECOVERED YET', p.x, p.w, p.y + 16, { v: INK });
        paragraph(g,
          'DIVE INTO THE ARCHIVE AND REACH A CAPSULE BEFORE THE ROT BURIES IT. EVERY FRIEND YOU PULL OUT ARRIVES CORRUPTED — BURNING SIMULATED RF REBUILDS THEIR PIXELS AND UNLOCKS THEIR PERK.',
          p.x + 8, p.y + 40, p.w - 16, { lineGap: 4 });
        drawTextCentered(g, 'PRESS ENTER TO GO BACK', p.x, p.w, p.y + 96, { v: INK, font: MICRO });
        footer(g, 'ESC BACK');
        return;
      }

      /* ---- grid -------------------------------------------------------- */
      const page = Math.floor(gridMenu.index / PAGE);
      const start = page * PAGE;
      gridMenu.beginDraw();
      for (let k = 0; k < PAGE; k++) {
        const i = start + k;
        if (i >= list.length) break;
        const f = list[i];
        const cx = 8 + (k % COLS_GRID) * 24;
        const cy = 22 + Math.floor(k / COLS_GRID) * 24;
        gridMenu.rect(i, cx, cy, 22, 22);
        friendCard(g, f.id, f.integrity, cx, cy, 1, {
          t, selected: i === gridMenu.index && focus === 'grid',
        });
        if (save.equipped === f.id) {
          g.rect(cx + 15, cy + 15, 5, 5, INK);
          g.px(cx + 17, cy + 17, PAPER);
        }
        if (f.integrity >= 100) g.rect(cx, cy, 3, 3, INK);
      }
      gridMenu.endDraw();

      const gridBottom = 22 + ROWS_GRID * 24;
      drawText(g, `${list.length} FRIEND${list.length === 1 ? '' : 'S'} HELD`, 8, gridBottom + 2, { font: MICRO });
      const pages = Math.ceil(list.length / PAGE);
      if (pages > 1) drawTextRight(g, `PAGE ${page + 1}/${pages}`, 176, gridBottom + 2, { font: MICRO });
      drawText(g, `RESTORED ${list.filter((f) => f.integrity >= 100).length}`, 8, gridBottom + 11, { font: MICRO });

      /* ---- legend ------------------------------------------------------ */
      const lp = panel(g, 8, gridBottom + 22, 168, 156, { title: 'LEGEND' });
      const legend = [
        'DOTTED FRAME  COMMON',
        'SOLID FRAME   RARE',
        'CORNER PINS   EPIC',
        'LIVE FRAME    GENESIS',
        '',
        'TOP-LEFT PIP  RESTORED',
        'BOTTOM-RIGHT  EQUIPPED',
        '',
        'MISSING PIXELS ARE ROT.',
        'BURN RF TO REBUILD THEM.',
      ];
      legend.forEach((line, i) => drawText(g, line, lp.x + 4, lp.y + 2 + i * 9, { font: MICRO }));

      /* ---- detail ------------------------------------------------------ */
      const f = selected();
      const traits = friendTraits(f.id);
      const dp = panel(g, 184, 22, 288, 282, { title: `FRIEND ${traits.label}` });

      const portraitScale = 7;
      const psize = 16 * portraitScale;
      const pxx = dp.x + 6, pyy = dp.y + 6;
      g.rect(pxx - 3, pyy - 3, psize + 6, psize + 6, PAPER);
      g.frame(pxx - 3, pyy - 3, psize + 6, psize + 6, INK);
      g.spriteScaled(friendSprite(f.id, f.integrity), pxx, pyy, portraitScale, {
        phase: Math.floor(t * 6) & 3,
        corruptLevel: burnFx > 0 ? 10 : 5,
      });
      if (burnFx > 0) {
        const k = 1 - burnFx / 0.5;
        g.ringInvert(pxx + psize / 2, pyy + psize / 2, 8 + k * psize * 0.8, 3);
      }
      if (restoredFx > 0 && (Math.floor(t * 12) & 1)) {
        g.frame(pxx - 5, pyy - 5, psize + 10, psize + 10, INK);
      }

      const ix = dp.x + psize + 16;
      const iw = dp.w - psize - 22;
      drawText(g, traits.name, ix, dp.y + 6, { v: INK, scale: 2 });
      drawText(g, `ID ${traits.id}   SERIAL ${traits.serial}`, ix, dp.y + 24, { font: MICRO });
      g.rect(ix, dp.y + 34, 74, 10, INK);
      drawTextCentered(g, traits.rarity, ix, 74, dp.y + 36, { v: PAPER, font: MICRO });
      drawText(g, `GEN-${traits.generation}`, ix + 80, dp.y + 36, { font: MICRO });

      drawText(g, 'INTEGRITY', ix, dp.y + 50, { font: MICRO });
      drawTextRight(g, `${f.integrity}%`, ix + iw, dp.y + 50, { font: MICRO });
      bar(g, ix, dp.y + 58, iw, 10, f.integrity / 100, { style: f.integrity >= 100 ? 'solid' : 'dither', ticks: 10 });

      drawText(g, 'PERK', ix, dp.y + 74, { font: MICRO });
      drawText(g, traits.perk ? traits.perk.name : '—', ix, dp.y + 83, { v: INK });
      drawText(g, traits.perkText, ix, dp.y + 95, { font: MICRO });
      const isActive = f.integrity >= 100;
      g.rect(ix, dp.y + 105, iw, 10, isActive ? INK : PAPER);
      g.frame(ix, dp.y + 105, iw, 10, INK);
      drawTextCentered(g, isActive ? 'PERK ACTIVE WHEN EQUIPPED' : 'LOCKED UNTIL 100%', ix, iw, dp.y + 107,
        { v: isActive ? PAPER : INK, font: MICRO });

      /* ---- traits -------------------------------------------------------- */
      const ty = dp.y + 124;
      drawText(g, 'TRAITS', dp.x + 6, ty, { font: MICRO });
      const traitRows = [
        ['FORM', traits.head], ['CREST', traits.ears], ['OPTICS', traits.eyes],
        ['VOX', traits.mouth], ['GEAR', traits.accessory], ['MARK', traits.pattern],
      ];
      traitRows.forEach(([k, v], i) => {
        const col = i % 3;
        const cx = dp.x + 6 + col * 94;
        const cy = ty + 10 + ((i / 3) | 0) * 11;
        drawText(g, k, cx, cy, { font: MICRO });
        drawTextRight(g, v, cx + 82, cy, { font: MICRO });
        if (col < 2) g.dither(cx + 88, cy - 1, 1, 8, 8, INK, 0);
      });

      /* ---- actions -------------------------------------------------------- */
      actionMenu.beginDraw();
      const ay = dp.y + 160;
      for (let i = 0; i < actionMenu.items.length; i++) {
        const item = actionMenu.items[i];
        const bx = dp.x + 6;
        const by = ay + i * 27;
        const bw = dp.w - 12;
        actionMenu.rect(i, bx, by, bw, 25);
        const sel = focus === 'actions' && i === actionMenu.index;
        g.rect(bx, by, bw, 25, sel ? INK : PAPER);
        g.frame(bx, by, bw, 25, INK);
        if (sel) g.frame(bx - 1, by - 1, bw + 2, 27, INK);
        if (item.disabled) g.dither(bx + 1, by + 1, bw - 2, 23, 3, sel ? PAPER : INK, 1);
        const fg = sel ? PAPER : INK;
        drawText(g, item.label, bx + 6, by + 4, { v: fg });
        drawText(g, item.sub, bx + 6, by + 15, { v: fg, font: MICRO });
        if (i < 2) drawTextRight(g, `${ICON.rf} BURN`, bx + bw - 6, by + 9, { v: fg, font: MICRO });
      }
      actionMenu.endDraw();

      drawText(g, 'BURNED RF IS DESTROYED.', dp.x + 6, dp.y + 248, { font: MICRO });
      drawTextRight(g, `TOTAL BURNED ${formatRf(save.rfBurned)}`, dp.x + dp.w - 6, dp.y + 248, { font: MICRO });

      popups.draw(g);
      footer(g,
        focus === 'grid' ? 'ARROWS PICK   ENTER ACTIONS   ESC BACK' : 'ARROWS PICK ACTION   ENTER CONFIRM   ESC GRID',
        app.save.equipped ? `EQUIPPED ${friendTraits(app.save.equipped).name}` : 'NONE EQUIPPED');
    },
  };
}
