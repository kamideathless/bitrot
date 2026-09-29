// Static check: import every module that does not need a DOM at load time.
// Catches syntax errors, bad import names and module-level crashes without a
// browser. Run with `npm run check`.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = (await walk(SRC)).sort();
let failures = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  // these only run in a browser
  if (rel === 'src/main.js' || rel.startsWith('src/landing/')) continue;
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    console.error(`FAIL  ${rel}\n      ${err.message}`);
    failures++;
  }
}

const expected = {
  'src/scenes/title.js': 'createTitleScene',
  'src/scenes/hub.js': 'createHubScene',
  'src/scenes/play.js': 'createPlayScene',
  'src/scenes/results.js': 'createResultsScene',
  'src/scenes/upgrades.js': 'createUpgradesScene',
  'src/scenes/collection.js': 'createCollectionScene',
  'src/scenes/help.js': 'createHelpScene',
  'src/scenes/settings.js': 'createSettingsScene',
};
for (const [rel, name] of Object.entries(expected)) {
  try {
    const mod = await import(pathToFileURL(join(ROOT, rel)).href);
    if (typeof mod[name] !== 'function') {
      console.error(`FAIL  ${rel} is missing export ${name}`);
      failures++;
    }
  } catch {
    // already reported above
  }
}

if (failures) {
  console.error(`\ncheck: ${failures} problem(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`check: ${files.length} source files imported cleanly.`);
