import { INK, PAPER, W, H } from '../core/gfx.js';
import { drawText, drawTextCentered, drawTextRight, measure, MICRO } from '../core/font.js';
import { panel, header, footer, paragraph, friendCard, bar } from '../ui/widgets.js';
import { PAYOUT, RESTORE_STEP, RESTORE_BASE_COST, BASE_STATS, sectorMultiplier } from '../game/economy.js';
import { RARITIES } from '../game/friends.js';
import { TUNING } from '../game/run.js';

// Derived so the briefing cannot drift away from the numbers the game runs on.
const SECTOR_BONUS_PCT = Math.round((sectorMultiplier(2) - 1) * 100);
const SALVAGE = Object.values(RARITIES).map((r) => r.salvage);

const PAGES = [
  {
    title: 'THE ARCHIVE IS DECAYING',
    body: [
      'RARE FRIENDS ARE STORED IN AN OLD ARCHIVE. THE MEDIUM IS FAILING: BITS FLIP, AND THE FLIPPED BITS SPREAD.',
      'YOU ARE THE ONLY PROCESS STILL RUNNING INSIDE IT. DIVE IN, HOLD BACK THE ROT, AND PULL FRIENDS OUT BEFORE THEY ARE OVERWRITTEN.',
      'EVERY FRIEND YOU RECOVER ARRIVES DAMAGED. THE PIXELS THAT ARE MISSING ARE THE PIXELS THE ROT ATE.',
    ],
    art: 'friends',
  },
  {
    title: 'CONTROLS',
    body: [],
    art: 'controls',
  },
  {
    title: 'HOW THE ROT THINKS',
    body: [
      'THE ARENA IS A CELLULAR AUTOMATON. EACH GENERATION, A CLEAN CELL MAY TURN ROTTEN - AND THE MORE ROTTEN NEIGHBOURS IT HAS, THE LIKELIER THAT IS.',
      'SO ROT NEVER SHRINKS ON ITS OWN, CONCAVE POCKETS CLOSE FAST, AND OPEN GROUND IS ONLY SLOWLY THREATENED.',
      'PURGE CLEARS A DISC AND LEAVES A SCAR: SCARRED GROUND CANNOT ROT AGAIN FOR A WHILE. GOOD PLAYERS DO NOT PANIC-PURGE - THEY SHAPE THE ARENA.',
      'TOUCHING ROT COSTS ONE INTEGRITY. DASH IS INVULNERABLE, SO YOU CAN CUT STRAIGHT THROUGH A THIN WALL.',
    ],
    art: 'rot',
  },
  {
    title: 'WHAT IS OUT THERE',
    body: [],
    art: 'pickups',
  },
  {
    title: 'SIMULATED RF ECONOMY',
    body: [],
    art: 'economy',
  },
  {
    title: 'RARE FRIENDS CONNECTION',
    body: [
      'EVERY FRIEND IS DERIVED FROM A 6-DIGIT ID: FORM, CREST, OPTICS, GEAR, RARITY AND PERK ALL COME OUT OF THAT ONE NUMBER, THE SAME WAY A TOKEN ID MAPS TO A GENERATIONS NFT.',
      'IN A PRODUCTION BUILD THAT ID IS THE TOKEN ID AND THE PORTRAIT IS THE CANONICAL ARTWORK SERVED THROUGH FRIENDSDK. HERE IT IS DRAWN PROCEDURALLY SO THE GAME RUNS WITH NO WALLET.',
      'ALL RF IS SIMULATED AND LOCAL TO THIS BROWSER. NOTHING IS MINTED, SPENT OR BURNED ON ANY CHAIN.',
    ],
    art: 'friends',
  },
];

export function createHelpScene(app, params = {}) {
  const intro = !!params.intro;
  let page = 0;
  let t = 0;

  function next() {
    if (page < PAGES.length - 1) { page++; app.audio.sfx('select'); return; }
    finish();
  }
  function prev() {
    if (page > 0) { page--; app.audio.sfx('move'); return; }
    finish();
  }
  function finish() {
    if (intro && !app.save.seenIntro) {
      app.save.seenIntro = true;
      app.persist();
    }
    app.audio.sfx('back');
    app.setScene('hub');
  }

  return {
    enter() {
      app.audio.playTrack('hub');
      app.say(`Briefing page 1 of ${PAGES.length}: ${PAGES[0].title}`);
    },

    update(dt) {
      t += dt;
      const i = app.input;
      if (i.pressed('right') || i.pressed('down') || i.pressed('confirm')) { next(); app.say(`${PAGES[page].title}`); }
      else if (i.pressed('left') || i.pressed('up')) { prev(); }
      else if (i.pressed('cancel')) finish();
      else if (i.pointer.pressed) {
        if (i.pointer.x < W * 0.22) prev(); else next();
      }
    },

    draw(g) {
      const p = PAGES[page];
      g.clear(PAPER);
      g.dither(0, 0, W, H, 2, INK, 0);
      header(g, intro ? 'BRIEFING' : 'ARCHIVE MANUAL', `${page + 1} / ${PAGES.length}`);

      const box = panel(g, 8, 22, W - 16, 274, { title: p.title });
      let y = box.y + 4;
      for (const para of p.body) {
        y = paragraph(g, para, box.x + 6, y, box.w - 12, { lineGap: 4 }) + 6;
      }

      if (p.art === 'controls') drawControls(g, box, app);
      else if (p.art === 'pickups') drawPickups(g, box, t);
      else if (p.art === 'economy') drawEconomy(g, box);
      else if (p.art === 'friends') drawFriendStrip(g, box, t, y);
      else if (p.art === 'rot') drawRotArt(g, box, t);

      // page dots
      for (let i = 0; i < PAGES.length; i++) {
        const dx = Math.round(W / 2 - (PAGES.length * 8) / 2) + i * 8;
        if (i === page) g.rect(dx, H - 9, 5, 5, PAPER);
        else g.frame(dx, H - 9, 5, 5, PAPER);
      }
      footer(g, page === 0 ? 'ENTER NEXT' : 'LEFT BACK   ENTER NEXT',
        page === PAGES.length - 1 ? (intro ? 'ENTER: START' : 'ENTER: DONE') : '');
    },
  };
}

function kbd(g, x, y, label) {
  const w = measure(label, { font: MICRO }) + 8;
  g.rect(x, y, w, 12, PAPER);
  g.frame(x, y, w, 12, INK);
  g.hline(x + 1, x + w - 2, y + 11, INK);
  drawText(g, label, x + 4, y + 4, { font: MICRO });
  return w;
}

function drawControls(g, box, app) {
  const rows = [
    ['MOVE', ['W A S D', 'ARROWS'], 'DRIFT THROUGH THE ARENA.'],
    ['PURGE', ['SPACE', 'J'], `${BASE_STATS.purgeCost} OF THE ${BASE_STATS.energyMax} CELL PER PRESS - THE METER IS SPLIT INTO ONE SEGMENT PER PURGE. HOLDING DOES NOTHING. EATS A ${BASE_STATS.purgeRadius}PX DISC FOR AS LONG AS THE RING IS UP, CENTRED ON YOU, SO WALKING DRAGS IT ALONG.`],
    ['DASH', ['SHIFT', 'K'], 'SHORT INVULNERABLE BURST. CUT THROUGH THIN ROT.'],
    ['PAUSE', ['ESC', 'P'], 'PAUSE, RESTART OR ABANDON THE DIVE.'],
    ['MUTE', ['M'], 'TOGGLE ALL SOUND.'],
  ];
  // Rows flow off the height the description actually took, so copy can grow
  // without landing on the row below it.
  let y = box.y + 6;
  for (const [name, keys, desc] of rows) {
    drawText(g, name, box.x + 6, y + 2, { v: INK });
    let kx = box.x + 66;
    for (const k of keys) {
      kx += kbd(g, kx, y, k) + 4;
    }
    const end = paragraph(g, desc, box.x + 180, y + 2, box.w - 190, { lineGap: 4 });
    y = Math.max(y + 24, end + 6);
  }
  g.hline(box.x + 4, box.x + box.w - 5, y + 2, INK);
  y += 10;
  drawText(g, 'TOUCH', box.x + 6, y, { v: INK });
  y = paragraph(g,
    'DRAG ANYWHERE ON THE LEFT HALF TO STEER - THE STICK APPEARS WHERE YOUR FINGER LANDS. TAP PRG TO PURGE AND DSH TO DASH. THE SQUARE BUTTON TOP RIGHT PAUSES.',
    box.x + 66, y, box.w - 76, { lineGap: 4 }) + 6;
  drawText(g, 'ACCESS', box.x + 6, y, { v: INK });
  paragraph(g,
    'EVERY SCREEN IS KEYBOARD NAVIGABLE. MUTE, REDUCED MOTION AND PIXEL SMOOTHING LIVE IN SETTINGS.',
    box.x + 66, y, box.w - 76, { lineGap: 4 });
}

function drawPickups(g, box, t) {
  const items = [
    ['SHARD', `${PAYOUT.perShard} RF EACH, PLUS PURGE ENERGY. IF THE ROT REACHES A SHARD FIRST IT IS GONE.`],
    ['CAPSULE', `A TRAPPED FRIEND. FIRST ONE AT ${TUNING.capsuleFirst}S, THEN EVERY ${TUNING.capsuleEvery}S. IT SURVIVES ${TUNING.capsuleBuryLimit}S UNDER ROT - PURGE IT FREE. RESCUING ALSO HEALS ONE INTEGRITY.`],
    ['DEFRAG', `WIPES EVERY ROTTEN CELL ON THE BOARD AND REFILLS YOUR CELL. IT ALWAYS SPAWNS IN THE WORST PLACE ON THE MAP.`],
    ['SECTOR', `EVERY ${TUNING.sectorSeconds}S THE ARCHIVE DROPS A SECTOR: DECAY SPEEDS UP, THE PAYOUT MULTIPLIER RISES, AND EVERY PURGE COSTS MORE ENERGY.`],
    ['HUNT', `FROM ${TUNING.huntFirst}S THE ROT SEEDS ITSELF NEXT TO YOU ON A TIMER. CAMPING ONE CLEARED CORNER IS NOT A STRATEGY.`],
  ];
  let y = box.y + 6;
  for (const [name, desc] of items) {
    g.rect(box.x + 6, y, 52, 11, INK);
    drawText(g, name, box.x + 9, y + 2, { v: PAPER, font: MICRO });
    const end = paragraph(g, desc, box.x + 64, y, box.w - 74, { lineGap: 4 });
    y = Math.max(y + 18, end + 8);
  }
  g.hline(box.x + 4, box.x + box.w - 5, y, INK);
  // chain off the returned y, so the copy can grow without colliding
  y = paragraph(g,
    'THE DECAY METER IS HOW MUCH OF THE ARENA THE ROT HOLDS. YOU DO NOT LOSE WHEN IT FILLS - YOU LOSE WHEN YOUR INTEGRITY DOES.',
    box.x + 6, y + 8, box.w - 12, { lineGap: 4 });
  paragraph(g,
    'INTEGRITY ONLY COMES BACK BY RESCUING A FRIEND. THE THING THAT KEEPS YOU ALIVE IS THE THING THE GAME IS ABOUT.',
    box.x + 6, y + 6, box.w - 12, { lineGap: 4 });
}

function drawEconomy(g, box) {
  drawText(g, 'EARNING RF', box.x + 6, box.y + 4, { v: INK });
  const earn = [
    ['SHARD', `${PAYOUT.perShard} RF`],
    ['FRIEND RESCUED', `${PAYOUT.perRescue} RF`],
    ['DEFRAG', `${PAYOUT.perDefrag} RF`],
    ['PER SECTOR', `${PAYOUT.perSector} RF`],
    ['SECTOR BONUS', `+${SECTOR_BONUS_PCT}% EACH`],
    ['DUPLICATE', `SALVAGED ${Math.min(...SALVAGE)}-${Math.max(...SALVAGE)}`],
  ];
  earn.forEach(([k, v], i) => {
    const y = box.y + 18 + i * 13;
    drawText(g, k, box.x + 6, y);
    drawTextRight(g, v, box.x + 214, y);
    if (i < earn.length - 1) g.dither(box.x + 6, y + 9, 208, 1, 8, INK, 0);
  });

  drawText(g, 'SPENDING RF', box.x + 232, box.y + 4, { v: INK });
  const spend = [
    ['UPGRADES', '40 - 420 RF'],
    ['  DIVE GEAR', 'SPENT'],
    ['RESTORATION', `${RESTORE_BASE_COST}+ RF PER ${RESTORE_STEP}%`],
    ['  REBUILDS A FRIEND', 'BURNED'],
    ['  COST RISES WITH', 'RARITY'],
    ['  AT 100%', 'PERK UNLOCKS'],
  ];
  spend.forEach(([k, v], i) => {
    const y = box.y + 18 + i * 13;
    drawText(g, k, box.x + 236, y);
    drawTextRight(g, v, box.x + box.w - 6, y);
    if (i < spend.length - 1) g.dither(box.x + 236, y + 9, box.w - 242, 1, 8, INK, 0);
  });

  g.hline(box.x + 4, box.x + box.w - 5, box.y + 104, INK);
  drawText(g, 'WHY BURNING MATTERS', box.x + 6, box.y + 112, { v: INK });
  paragraph(g,
    'UPGRADES ARE A FAUCET SINK: RF LEAVES YOUR WALLET BUT THE SUPPLY IS UNCHANGED IN THE FICTION. RESTORATION IS A TRUE BURN - THOSE TOKENS ARE DESTROYED AND THE LEDGER TRACKS THEM SEPARATELY.',
    box.x + 6, box.y + 126, box.w - 12, { lineGap: 4 });
  paragraph(g,
    'THAT GIVES THE ECONOMY TWO COMPETING PULLS: SPEND ON GEAR TO SURVIVE LONGER AND EARN MORE, OR BURN ON A FRIEND TO UNLOCK A PERMANENT PERK AND A FULLY INTACT PORTRAIT. A RESTORED GENESIS FRIEND IS THE END OF THE CHASE.',
    box.x + 6, box.y + 164, box.w - 12, { lineGap: 4 });

  const warn = box.y + 212;
  g.rect(box.x + 4, warn, box.w - 8, 26, INK);
  drawTextCentered(g, 'EVERYTHING HERE IS SIMULATED', box.x + 4, box.w - 8, warn + 4, { v: PAPER });
  drawTextCentered(g, 'NO WALLET, NO CHAIN, NO REAL $RAREFRIENDS MOVED OR BURNED.',
    box.x + 4, box.w - 8, warn + 15, { v: PAPER, font: MICRO });
}

function drawFriendStrip(g, box, t, y) {
  const ids = ['7A31C4', 'E90B2F', '2C77D1', 'B45E08', '19FFA6', 'CD3021'];
  const integrities = [18, 34, 52, 71, 88, 100];
  const baseY = Math.max(y + 8, box.y + 150);
  drawText(g, 'RESTORATION, STEP BY STEP', box.x + 6, baseY - 14, { v: INK });
  ids.forEach((id, i) => {
    const x = box.x + 12 + i * 74;
    friendCard(g, id, integrities[i], x, baseY, 3, { t });
    drawTextCentered(g, `${integrities[i]}%`, x - 3, 58, baseY + 56, { font: MICRO });
    bar(g, x - 2, baseY + 64, 56, 6, integrities[i] / 100, { style: integrities[i] >= 100 ? 'solid' : 'dither' });
    if (i < ids.length - 1) {
      drawText(g, '>', x + 60, baseY + 22, { v: INK });
    }
  });
  drawText(g, 'SAME FRIEND ID, MORE PIXELS PAID FOR. THE ORDER PIXELS RETURN IN IS FIXED PER FRIEND.',
    box.x + 6, baseY + 78, { font: MICRO });
}

function drawRotArt(g, box, t) {
  const y = box.y + 158;
  drawText(g, 'BIRTH CHANCE BY ROTTEN NEIGHBOURS', box.x + 6, y - 14, { v: INK });
  const vals = [0, 0.5, 0.9, 1.7, 3.4, 7.8, 17.5, 38, 78];
  for (let n = 1; n <= 8; n++) {
    const x = box.x + 10 + (n - 1) * 54;
    const h = Math.round(Math.pow(vals[n] / 78, 0.5) * 56);
    g.frame(x, y, 40, 58, INK);
    g.dither(x + 2, y + 58 - h, 36, Math.max(1, h - 2), n >= 6 ? 16 : 6 + n, INK, 0);
    drawTextCentered(g, String(n), x, 40, y + 62, { font: MICRO });
    drawTextCentered(g, `${vals[n]}%`, x, 40, y + 71, { font: MICRO });
  }
  drawText(g, 'AT FULL PRESSURE THESE ROUGHLY QUADRUPLE.', box.x + 6, y + 82, { font: MICRO });
}
