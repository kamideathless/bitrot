// Guard against the classic bitmap-font bug: a screen ships a character the
// font has no glyph for and it silently renders as "?".
//
// Scans every scene/ui source file for the strings that are handed to the text
// helpers and asserts each character exists in both fonts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT, MICRO } from '../src/core/font.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['src/scenes', 'src/ui'];

// Matches the first argument of the text helpers, quoted with ' " or `.
const CALL = /(?:drawText|drawTextCentered|drawTextRight|paragraph|kbd)\s*\(\s*g\s*,\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
// Plain arrays of UI copy (menus, legends, tables) use bare literals too.
const LITERAL = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

function literalsFrom(source, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(source)) !== null) out.push(m[2]);
  return out;
}

/** Drop template holes and escapes so only literal glyphs remain. */
function clean(str) {
  return str
    .replace(/\$\{[^}]*\}/g, '0')
    .replace(/\\n|\\t|\\r/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')   // real newlines inside template literals
    .replace(/\\(.)/g, '$1');
}

function isCopy(str) {
  if (!str) return false;
  // a fragment of a nested template literal that the regex could not resolve
  if (/[${}`]/.test(clean(str))) return false;
  if (/^[a-z][a-zA-Z0-9_]*$/.test(str)) return false;        // identifier / key
  if (/\.(js|css|html|png|svg)$/.test(str)) return false;     // module path
  if (/^[#.][a-zA-Z-]+$/.test(str)) return false;             // selector
  if (/^\\u[0-9a-fA-F]{4}$/.test(str)) return false;
  if (!/[A-Z0-9]/.test(str)) return false;                    // no visible copy
  return true;
}

async function sources() {
  const files = [];
  for (const dir of DIRS) {
    for (const name of await readdir(join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push(join(ROOT, dir, name));
    }
  }
  return files;
}

test('every UI string is drawable in the 5x7 font', async () => {
  const missing = new Map();
  for (const file of await sources()) {
    const src = await readFile(file, 'utf8');
    for (const raw of literalsFrom(src, CALL).filter(isCopy)) {
      for (const ch of clean(raw)) {
        if (!FONT.glyphs.has(ch.toUpperCase())) {
          missing.set(ch, (missing.get(ch) || new Set()).add(file));
        }
      }
    }
  }
  assert.equal(missing.size, 0,
    `missing glyphs: ${[...missing.keys()].map((c) => JSON.stringify(c)).join(', ')}`);
});

test('every UI string is drawable in the 3x5 micro font', async () => {
  const missing = new Set();
  for (const file of await sources()) {
    const src = await readFile(file, 'utf8');
    const all = literalsFrom(src, LITERAL).filter(isCopy);
    for (const raw of all) {
      for (const ch of clean(raw)) {
        if (!MICRO.glyphs.has(ch.toUpperCase())) missing.add(ch);
      }
    }
  }
  assert.equal(missing.size, 0,
    `micro font is missing: ${[...missing].map((c) => JSON.stringify(c)).join(', ')}`);
});
