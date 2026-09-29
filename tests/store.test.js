import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSave, normalizeSave, loadSave, writeSave, clearSave, SAVE_KEY } from '../src/core/store.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('a default save is self-consistent', () => {
  const s = defaultSave();
  assert.equal(s.rf, 0);
  assert.equal(s.friends.length, 0);
  assert.equal(s.equipped, null);
  assert.deepEqual(normalizeSave(s), s);
});

test('garbage input falls back to defaults', () => {
  for (const junk of [null, undefined, 42, 'nope', [], true]) {
    assert.deepEqual(normalizeSave(junk), defaultSave());
  }
});

test('hostile values are clamped rather than trusted', () => {
  const s = normalizeSave({
    rf: -900,
    rfBurned: Number.NaN,
    runs: 1e12,
    upgrades: { purge: 99, energy: -4, bogus: 3 },
    best: { score: '12', time: -5 },
    friends: 'not an array',
    settings: { mute: 'yes', crt: false },
  });
  assert.equal(s.rf, 0);
  assert.equal(s.rfBurned, 0);
  assert.equal(s.upgrades.purge, 8);
  assert.equal(s.upgrades.energy, 0);
  assert.equal(s.upgrades.bogus, undefined);
  assert.equal(s.best.score, 0);
  assert.equal(s.best.time, 0);
  assert.deepEqual(s.friends, []);
  assert.equal(s.settings.mute, true);
  assert.equal(s.settings.crt, false);
});

test('friends are validated, de-duplicated and clamped', () => {
  const s = normalizeSave({
    friends: [
      { id: '7a31c4', integrity: 55 },
      { id: '7A31C4', integrity: 10 },      // duplicate
      { id: 'ZZZZZZ', integrity: 50 },      // not hex
      { id: '123', integrity: 50 },         // too short
      { id: 'ABCDEF', integrity: 5000 },    // clamped
      'nope',
      null,
    ],
    equipped: 'ABCDEF',
  });
  assert.deepEqual(s.friends.map((f) => f.id), ['7A31C4', 'ABCDEF']);
  assert.equal(s.friends[0].integrity, 55);
  assert.equal(s.friends[1].integrity, 100);
  assert.equal(s.equipped, 'ABCDEF');
});

test('an equipped friend you do not own is dropped', () => {
  const s = normalizeSave({ friends: [{ id: 'ABCDEF', integrity: 50 }], equipped: 'FFFFFF' });
  assert.equal(s.equipped, null);
});

test('round-trips through storage', () => {
  const storage = memoryStorage();
  const s = defaultSave();
  s.rf = 123;
  s.friends.push({ id: 'ABCDEF', integrity: 70, rescuedAt: 5 });
  s.equipped = 'ABCDEF';
  assert.equal(writeSave(s, storage), true);
  const back = loadSave(storage);
  assert.equal(back.rf, 123);
  assert.equal(back.equipped, 'ABCDEF');
  assert.equal(back.friends[0].integrity, 70);
  clearSave(storage);
  assert.equal(storage.getItem(SAVE_KEY), null);
  assert.deepEqual(loadSave(storage), defaultSave());
});

test('corrupt JSON in storage does not break the game', () => {
  const storage = memoryStorage();
  storage.setItem(SAVE_KEY, '{ this is not json');
  const s = loadSave(storage);
  assert.deepEqual(s, defaultSave());
});

test('a storage that throws is survivable', () => {
  const hostile = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  assert.deepEqual(loadSave(hostile), defaultSave());
  assert.equal(writeSave(defaultSave(), hostile), false);
  assert.doesNotThrow(() => clearSave(hostile));
});
