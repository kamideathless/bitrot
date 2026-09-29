import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, MICRO, ICON } from '../core/font.js';
import { panel, header, footer, Menu, drawList, paragraph } from '../ui/widgets.js';
import { formatRf, formatTime } from '../game/economy.js';

export function createSettingsScene(app) {
  let t = 0;
  let confirmReset = false;

  const menu = new Menu([
    { id: 'mute', label: 'SOUND' },
    { id: 'reduced', label: 'REDUCED MOTION' },
    { id: 'smooth', label: 'PIXEL SMOOTHING' },
    { id: 'crt', label: 'CRT OVERLAY' },
    { id: 'invert', label: 'INVERT PALETTE' },
    { id: 'manual', label: 'OPEN MANUAL' },
    { id: 'reset', label: 'WIPE ARCHIVE' },
    { id: 'back', label: 'BACK TO TERMINAL' },
  ]);

  const valueOf = (item) => {
    const s = app.save.settings;
    switch (item.id) {
      case 'mute': return s.mute ? 'OFF' : 'ON';
      case 'reduced': return s.reduced ? 'ON' : 'OFF';
      case 'smooth': return s.smooth ? 'ON' : 'OFF';
      case 'crt': return s.crt ? 'ON' : 'OFF';
      case 'invert': return s.invert ? 'DARK' : 'LIGHT';
      case 'reset': return confirmReset ? 'CONFIRM?' : '';
      default: return '';
    }
  };

  function activate(id) {
    const s = app.save.settings;
    if (id !== 'reset') confirmReset = false;
    switch (id) {
      case 'mute':
        s.mute = !s.mute;
        app.audio.init();
        app.audio.setMuted(s.mute);
        if (!s.mute) app.audio.playTrack('hub', true);
        app.audio.sfx('select');
        break;
      case 'reduced':
        s.reduced = !s.reduced;
        app.applySettings();
        app.audio.sfx('select');
        break;
      case 'smooth':
        s.smooth = !s.smooth;
        app.applySettings();
        app.audio.sfx('select');
        break;
      case 'crt':
        s.crt = !s.crt;
        app.applySettings();
        app.audio.sfx('select');
        break;
      case 'invert':
        s.invert = !s.invert;
        app.applySettings();
        app.audio.sfx('select');
        break;
      case 'manual':
        app.audio.sfx('select');
        app.setScene('help');
        return;
      case 'reset':
        if (!confirmReset) {
          confirmReset = true;
          app.audio.sfx('deny');
          app.say('Press enter again to wipe the archive.');
          return;
        }
        confirmReset = false;
        app.resetSave();
        app.audio.sfx('burn');
        app.say('Archive wiped.');
        break;
      case 'back':
        app.audio.sfx('back');
        app.setScene('hub');
        return;
      default: break;
    }
    app.persist();
  }

  return {
    enter() {
      app.audio.playTrack('hub');
      app.say('Settings.');
    },

    update(dt) {
      t += dt;
      const action = menu.handle(app.input, app.audio);
      if (action === 'select') activate(menu.current.id);
      else if (action === 'back') { app.audio.sfx('back'); app.setScene('hub'); }
      else if (action === 'move') confirmReset = false;
    },

    draw(g) {
      const save = app.save;
      g.clear(PAPER);
      g.dither(0, 0, W, H, 2, INK, 0);
      header(g, 'SETTINGS', `${ICON.rf} ${formatRf(save.rf)} RF`);

      panel(g, 8, 22, 260, 200, { title: 'OPTIONS' });
      drawList(g, menu, 16, 40, 244, 20, t, { rightOf: valueOf });

      const dp = panel(g, 276, 22, 196, 200, { title: 'NOTES' });
      const notes = {
        mute: 'ALL AUDIO IS GENERATED LIVE BY A TINY SQUARE-WAVE SYNTH. NO AUDIO FILES ARE LOADED.',
        reduced: 'DISABLES SCREEN SHAKE, FLASHES, DITHER ANIMATION AND PARTICLES. THE GAME ALSO HONOURS YOUR SYSTEM SETTING.',
        smooth: 'ROUNDS OFF SINGLE-PIXEL CORNERS AND DIAGONALS AS THE SCREEN IS BLOWN UP. STILL PIXEL ART, JUST A FINER GRAIN. TURN IT OFF FOR HARD EDGES.',
        crt: 'A SUBTLE SCANLINE AND VIGNETTE LAYER OVER THE CANVAS. PURELY COSMETIC.',
        invert: 'SWAPS INK AND PAPER. THE WHOLE GAME IS TWO COLOURS, SO THIS IS A TRUE DARK MODE.',
        manual: 'CONTROLS, HOW THE ROT AUTOMATON WORKS, AND THE FULL SIMULATED ECONOMY TABLE.',
        reset: 'DELETES THE COPY OF YOUR SAVE IN THIS BROWSER. WHEN YOU ARE ONLINE THE ARCHIVE KEEPS THE REAL ONE AND WILL HAND IT BACK ON THE NEXT CONNECT.',
        back: 'RETURN TO THE ARCHIVE TERMINAL.',
      };
      paragraph(g, notes[menu.current.id] || '', dp.x + 4, dp.y + 4, dp.w - 8, { lineGap: 4 });

      if (menu.current.id === 'reset' && confirmReset) {
        g.rect(dp.x + 2, dp.y + 70, dp.w - 4, 24, INK);
        drawTextCentered(g, 'PRESS ENTER AGAIN', dp.x + 2, dp.w - 4, dp.y + 74, { v: PAPER, font: MICRO });
        drawTextCentered(g, 'TO WIPE EVERYTHING', dp.x + 2, dp.w - 4, dp.y + 84, { v: PAPER, font: MICRO });
      }

      drawText(g, 'SAVE', dp.x + 4, dp.y + 104, { v: INK });
      const online = app.netStatus === 'online';
      const rows = [
        ['STORED IN', online ? 'THE ARCHIVE' : 'THIS BROWSER'],
        ['DIVES', String(save.runs)],
        ['TIME IN ARCHIVE', formatTime(save.totals.time)],
        ['SHARDS TAKEN', String(Math.round(save.totals.shards))],
        ['PURGES FIRED', String(Math.round(save.totals.purges))],
        ['RF BURNED', formatRf(save.rfBurned)],
      ];
      rows.forEach(([k, v], i) => {
        const y = dp.y + 118 + i * 10;
        drawText(g, k, dp.x + 4, y, { font: MICRO });
        drawTextRight(g, v, dp.x + dp.w - 4, y, { font: MICRO });
      });

      const cp = panel(g, 8, 228, 464, 64, { title: 'ABOUT' });
      drawText(g, 'BITROT  v1.0', cp.x + 4, cp.y + 2, { v: INK });
      paragraph(g,
        'BUILT FOR THE RARE FRIENDS VIBEATHON BY KAMIYAHAME. NO FRIENDSDK AND NO WALLET - PLAIN ES MODULES, A 480x320 ONE-BIT RENDERER, AND A SERVER THAT REPLAYS EVERY DIVE TO VERIFY IT. EVERY BALANCE IS SIMULATED.',
        cp.x + 4, cp.y + 14, cp.w - 8, { lineGap: 4 });

      footer(g, 'ENTER TOGGLE   ESC BACK', app.save.settings.mute ? 'MUTED' : '');
    },
  };
}
