import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantiseIntent, packTick, unpackTick, encodeTrace, decodeTrace, iterateTrace,
  TraceRecorder, MAX_TICKS, TICK_RATE,
} from '../src/game/trace.js';
import { Run, RunState } from '../src/game/run.js';
import { derivedStats } from '../src/game/economy.js';
import { defaultSave } from '../src/core/store.js';

test('a quantised intent survives a round trip through the wire format', () => {
  for (let x = -8; x <= 8; x++) {
    for (let y = -8; y <= 8; y++) {
      for (const purge of [false, true]) {
        for (const dash of [false, true]) {
          const q = quantiseIntent({ ax: x / 8, ay: y / 8, purge, dash });
          const back = unpackTick(q.code);
          assert.equal(back.ax, q.ax);
          assert.equal(back.ay, q.ay);
          assert.equal(back.purge, purge);
          assert.equal(back.dash, dash);
        }
      }
    }
  }
});

test('out-of-range axes are clamped, not wrapped', () => {
  const big = quantiseIntent({ ax: 12, ay: -9 });
  assert.equal(big.ax, 1);
  assert.equal(big.ay, -1);
  const back = unpackTick(big.code);
  assert.equal(back.ax, 1);
  assert.equal(back.ay, -1);
});

test('run-length encoding collapses held inputs', () => {
  const rec = new TraceRecorder();
  const hold = quantiseIntent({ ax: 1, ay: 0 }).code;
  for (let i = 0; i < 5000; i++) rec.push(hold);
  const encoded = rec.encode();
  assert.equal(rec.ticks, 5000);
  assert.ok(encoded.length < 40, `5000 identical ticks encoded to ${encoded.length} chars`);
  const decoded = decodeTrace(encoded);
  assert.equal(decoded.ticks, 5000);
});

test('a real input pattern round-trips tick for tick', () => {
  const rec = new TraceRecorder();
  const expected = [];
  for (let i = 0; i < 1200; i++) {
    const q = quantiseIntent({
      ax: Math.sin(i * 0.05), ay: Math.cos(i * 0.03),
      purge: i % 37 === 0, dash: i % 211 === 0,
    });
    rec.push(q.code);
    expected.push(q);
  }
  const decoded = decodeTrace(rec.encode());
  assert.equal(decoded.ticks, 1200);
  const got = [...iterateTrace(decoded.pairs)];
  assert.equal(got.length, 1200);
  for (let i = 0; i < got.length; i++) {
    assert.equal(got[i].ax, expected[i].ax, `tick ${i} ax`);
    assert.equal(got[i].ay, expected[i].ay, `tick ${i} ay`);
    assert.equal(got[i].purge, expected[i].purge, `tick ${i} purge`);
    assert.equal(got[i].dash, expected[i].dash, `tick ${i} dash`);
  }
});

test('hostile traces are rejected rather than parsed', () => {
  assert.throws(() => decodeTrace('A'), /base64 length|bad/);
  assert.throws(() => decodeTrace('!!!!'), /bad characters/);
  assert.throws(() => decodeTrace('AAAAA'), /truncated|base64/);
  assert.throws(() => decodeTrace(null), /not a string/);
  assert.throws(() => decodeTrace(123), /not a string/);
  // a zero-length run is meaningless and must not be accepted
  const zeroCount = Buffer.from([0x00, 0x05, 0x00, 0x00]).toString('base64url');
  assert.throws(() => decodeTrace(zeroCount), /zero-length/);
  // a tick code outside the 12-bit space is not something we ever emit
  const badCode = Buffer.from([0xff, 0xff, 0x00, 0x01]).toString('base64url');
  assert.throws(() => decodeTrace(badCode), /bad tick code/);
  // tick budget
  const pairs = [];
  for (let i = 0; i < 20; i++) pairs.push(0, 0xffff);
  assert.throws(() => decodeTrace(encodeTrace(pairs)), /too many ticks/);
});

test('the recorder stops at the tick ceiling instead of growing forever', () => {
  const rec = new TraceRecorder();
  const a = packTick(1, 0, false, false);
  const b = packTick(-1, 0, false, false);
  for (let i = 0; i < MAX_TICKS + 500; i++) rec.push(i % 2 ? a : b);
  assert.equal(rec.ticks, MAX_TICKS);
  assert.equal(rec.overflowed, true);
  assert.equal(decodeTrace(rec.encode()).ticks, MAX_TICKS);
});

test('replaying a recorded trace reproduces the dive exactly', () => {
  const stats = derivedStats(defaultSave());
  const seed = 24601;
  const step = 1 / TICK_RATE;

  // play once, recording
  const live = new Run({ stats, seed });
  const rec = new TraceRecorder();
  let i = 0;
  while (live.state === RunState.PLAYING && i < TICK_RATE * 300) {
    const target = live.capsule || live.shards[0];
    const raw = target
      ? (() => {
        const dx = target.x - live.x, dy = target.y - live.y;
        const d = Math.hypot(dx, dy) || 1;
        return { ax: dx / d, ay: dy / d, purge: i % 31 === 0, dash: i % 150 === 0 };
      })()
      : { ax: 0, ay: 0, purge: i % 45 === 0 };
    const q = quantiseIntent(raw);
    rec.push(q.code);
    live.update(step, q);
    live.drainEvents();
    i++;
  }
  assert.equal(live.state, RunState.OVER);

  // replay from the wire format alone
  const replay = new Run({ stats, seed });
  for (const intent of iterateTrace(decodeTrace(rec.encode()).pairs)) {
    if (replay.state !== RunState.PLAYING) break;
    replay.update(step, intent);
    replay.drainEvents();
  }

  const a = live.result();
  const b = replay.result();
  assert.equal(b.score, a.score);
  assert.equal(b.shards, a.shards);
  assert.equal(b.rescues, a.rescues);
  assert.equal(b.defrags, a.defrags);
  assert.equal(b.purges, a.purges);
  assert.equal(b.hits, a.hits);
  assert.deepEqual(b.rescued, a.rescued);
  assert.equal(b.time.toFixed(6), a.time.toFixed(6));
});
