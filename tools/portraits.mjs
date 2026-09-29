// Contact sheet: prints Friend portraits as ASCII so the procedural art can be
// eyeballed without opening a browser.
//
//   node tools/portraits.mjs [count] [integrity]
//   node tools/portraits.mjs --id 7A31C4

import { friendSprite, friendTraits } from '../src/game/friends.js';
import { Rng } from '../src/core/rng.js';

const args = process.argv.slice(2);
const CH = { 0: ' ', 1: '#', 2: '.', 4: ':' };

function render(id, integrity) {
  const spr = friendSprite(id, integrity);
  const rows = [];
  for (let y = 0; y < spr.h; y++) {
    let line = '';
    for (let x = 0; x < spr.w; x++) line += CH[spr.data[y * spr.w + x]];
    rows.push(line);
  }
  return rows;
}

function sheet(ids, integrity, perRow = 6) {
  for (let i = 0; i < ids.length; i += perRow) {
    const group = ids.slice(i, i + perRow);
    const blocks = group.map((id) => render(id, integrity));
    for (let y = 0; y < 16; y++) {
      console.log(blocks.map((b) => b[y]).join('  '));
    }
    console.log(group.map((id) => {
      const t = friendTraits(id);
      return `${t.name}`.padEnd(16).slice(0, 16);
    }).join('  '));
    console.log(group.map((id) => {
      const t = friendTraits(id);
      return `${t.rarity} G${t.generation}`.padEnd(16).slice(0, 16);
    }).join('  '));
    console.log(group.map((id) => {
      const t = friendTraits(id);
      return `${t.head}/${t.ears}`.padEnd(16).slice(0, 16);
    }).join('  '));
    console.log(group.map((id) => {
      const t = friendTraits(id);
      return `${t.eyes}/${t.mouth}`.padEnd(16).slice(0, 16);
    }).join('  '));
    console.log(group.map((id) => {
      const t = friendTraits(id);
      return `${t.accessory}/${t.pattern}`.padEnd(16).slice(0, 16);
    }).join('  '));
    console.log('');
  }
}

if (args[0] === '--id') {
  sheet([args[1].toUpperCase()], Number(args[2] || 100), 1);
} else {
  const count = Number(args[0] || 12);
  const integrity = Number(args[1] || 100);
  const rng = new Rng(4242);
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(rng.hex(6));
  sheet(ids, integrity);
}
