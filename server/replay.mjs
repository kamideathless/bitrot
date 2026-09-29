// Server-side re-simulation of a submitted dive.
//
// The client sends a seed ticket and an input trace. The server runs the exact
// same `Run` class the browser did, with the stat block the server recorded
// when the run was issued, and derives the score, the RF and the rescued
// Friend ids itself. Nothing the client claims about the outcome is read.

import { Run, RunState } from '../src/game/run.js';
import { decodeTrace, iterateTrace, TICK_RATE, MAX_TICKS } from '../src/game/trace.js';

const STEP = 1 / TICK_RATE;

/** Wall-clock ceiling for one replay, so a pathological trace cannot hog a core. */
export const REPLAY_BUDGET_MS = 1500;

export class ReplayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReplayError';
    this.code = code;
  }
}

/**
 * @param {object} ticket  { seed, stats, shardValue }
 * @param {string} traceText
 * @returns {{ result: object, ticks: number, ms: number }}
 */
export function replayRun(ticket, traceText) {
  let decoded;
  try {
    decoded = decodeTrace(traceText, { maxTicks: MAX_TICKS });
  } catch (err) {
    throw new ReplayError('bad_trace', err.message);
  }
  if (decoded.ticks === 0) throw new ReplayError('empty_trace', 'trace has no ticks');

  const started = Date.now();
  const run = new Run({ stats: ticket.stats, seed: ticket.seed });

  let ticks = 0;
  let checked = 0;
  for (const intent of iterateTrace(decoded.pairs)) {
    if (run.state !== RunState.PLAYING) break;
    run.update(STEP, intent);
    run.drainEvents();
    ticks++;
    // check the clock every 2048 ticks rather than every tick
    if ((++checked & 2047) === 0 && Date.now() - started > REPLAY_BUDGET_MS) {
      throw new ReplayError('replay_timeout', 'replay exceeded its time budget');
    }
  }

  // A trace that keeps going after the player died is either a broken client or
  // someone padding the clock. Either way it is not a run we will record.
  if (ticks < decoded.ticks - 1) {
    throw new ReplayError('trace_overrun', 'trace continues past the end of the run');
  }
  // Surviving to the cap is a legitimate ending — the dive is scored where it
  // was cut off. Anything shorter than the cap has to have actually finished.
  const cappedOut = decoded.ticks >= MAX_TICKS;
  if (run.state === RunState.PLAYING && !cappedOut) {
    throw new ReplayError('run_unfinished', 'the dive never ended');
  }

  const result = run.result(ticket.shardValue);
  return { result, ticks, ms: Date.now() - started };
}
