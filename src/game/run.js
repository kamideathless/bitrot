// A single dive: player physics, pickups, the rot clock and the run result.
// Deliberately free of rendering so it can be stepped headlessly in tests and
// in the balance harness.

import { Rng } from '../core/rng.js';
import {
  COLS, ROWS, CELL, ROT, CLEAN, WALL,
  createField, step, bitFlip, purgeCircle, defrag as defragField,
  seed, idx, inBounds, genInterval, coverage, distanceToRot, rotCount,
} from './automaton.js';
import { rollFriendId } from './friends.js';
import { runPayout, runScore } from './economy.js';

export const FIELD_X = 0;
export const FIELD_Y = 44;
export const FIELD_W = COLS * CELL;   // 480
export const FIELD_H = ROWS * CELL;   // 276

export const TUNING = {
  pressureRampSeconds: 150,
  sectorSeconds: 45,
  dashSeconds: 0.16,
  dashSpeedMul: 3.2,
  iframeSeconds: 1.35,
  purgeCooldown: 0.3,
  // how long a purge keeps eating after the press; matches its effect on screen
  purgeBurnSeconds: 0.26,
  shardTarget: 6,
  shardMinDist: 5,      // cells — far enough that shards can never be farmed in place
  shardRespawn: 0.5,    // seconds between replacements
  shardRadius: 4,
  huntFirst: 18,        // the rot starts seeding next to you after this
  huntIntervalLo: 13,   // seconds between hunt seeds at sector 1
  huntIntervalHi: 6,    // ...and at sector 6+
  purgeCostPerSector: 0.11,
  capsuleFirst: 14,
  capsuleEvery: 19,
  capsuleLife: 30,
  capsuleBuryLimit: 6,
  defragFirst: 42,
  defragEvery: 40,
  defragLife: 18,
  playerRadius: 5,
  startClearRadius: 4.5,
  startSeeds: 4,
};

/**
 * Rot pressure over time. Starts just above zero so the arena is already
 * breathing on second one, reaches 1.0 at 150s and keeps creeping after that
 * (the automaton caps it at 1.8).
 */
export function PRESSURE(t) {
  return 0.12 + Math.max(0, t / TUNING.pressureRampSeconds);
}

export const RunState = {
  PLAYING: 'playing',
  OVER: 'over',
};

export class Run {
  constructor({ stats, seed: runSeed = (Math.random() * 1e9) | 0, friendId = null }) {
    this.stats = stats;
    this.rng = new Rng(runSeed);
    this.seedValue = runSeed;
    this.friendId = friendId;

    this.field = createField();
    this.state = RunState.PLAYING;
    this.time = 0;
    this.sector = 1;
    this.genAcc = 0;

    this.hp = stats.maxHp;
    this.maxHp = stats.maxHp;
    this.energy = stats.energyMax;
    this.iframe = 0;
    this.dashTime = 0;
    this.dashCd = 0;
    this.purgeCd = 0;
    this.purgeHeld = false;
    this.purgeBurn = 0;
    this.facing = { x: 0, y: 1 };

    this.x = FIELD_W / 2;
    this.y = FIELD_H / 2;
    this.vx = 0;
    this.vy = 0;

    this.shards = [];
    this.shardCd = 0;
    this.capsule = null;
    this.defrag = null;
    this.nextCapsule = TUNING.capsuleFirst;
    this.nextDefrag = TUNING.defragFirst;
    this.nextSector = TUNING.sectorSeconds;
    this.nextHunt = TUNING.huntFirst;

    this.counters = { shards: 0, rescues: 0, defrags: 0, purges: 0, hits: 0, lostShards: 0, lostCapsules: 0 };
    this.rescued = [];
    this.events = [];

    this._seedField();
    for (let i = 0; i < TUNING.shardTarget; i++) this._spawnShard();
  }

  _seedField() {
    const pc = this.playerCell();
    let placed = 0;
    let guard = 0;
    while (placed < TUNING.startSeeds && guard++ < 400) {
      const x = 2 + this.rng.int(COLS - 4);
      const y = 2 + this.rng.int(ROWS - 4);
      const dx = x - pc.x, dy = y - pc.y;
      if (dx * dx + dy * dy < 49) continue;   // keep spawn breathable
      if (seed(this.field, x, y)) placed++;
    }
    // guarantee the spawn pocket is clean
    purgeCircle(this.field, pc.x + 0.5, pc.y + 0.5, TUNING.startClearRadius, 20);
  }

  /**
   * Drop fresh rot seeds in a ring around the player. Called on every sector
   * change: it is what stops turtling in a cleared corner from being a winning
   * strategy — the rot comes to you.
   */
  _seedNearPlayer(count, minDist = 5, maxDist = 9) {
    const pc = this.playerCell();
    let placed = 0;
    let guard = 0;
    while (placed < count && guard++ < 160) {
      const ang = this.rng.next() * Math.PI * 2;
      const dist = minDist + this.rng.next() * (maxDist - minDist);
      const x = Math.round(pc.x + Math.cos(ang) * dist);
      const y = Math.round(pc.y + Math.sin(ang) * dist);
      if (x < 1 || y < 1 || x >= COLS - 1 || y >= ROWS - 1) continue;
      const i = idx(x, y);
      if (this.field.cells[i] !== CLEAN) continue;
      this.field.scar[i] = 0;
      this.field.cells[i] = ROT;
      this.field.age[i] = 0;
      placed++;
    }
    return placed;
  }

  playerCell() {
    return {
      x: Math.max(0, Math.min(COLS - 1, Math.floor(this.x / CELL))),
      y: Math.max(0, Math.min(ROWS - 1, Math.floor(this.y / CELL))),
    };
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  get pressure() { return PRESSURE(this.time); }

  get coverage() { return coverage(this.field); }

  /* ------------------------------------------------------------------ */

  update(dt, intent) {
    if (this.state !== RunState.PLAYING) return;
    const s = this.stats;
    this.time += dt;

    // --- timers -------------------------------------------------------
    if (this.iframe > 0) this.iframe -= dt;
    if (this.dashTime > 0) this.dashTime -= dt;
    if (this.dashCd > 0) this.dashCd -= dt;
    if (this.purgeCd > 0) this.purgeCd -= dt;
    this.energy = Math.min(s.energyMax, this.energy + s.energyRegen * dt);

    // --- input --------------------------------------------------------
    let ax = intent.ax || 0;
    let ay = intent.ay || 0;
    const mag = Math.hypot(ax, ay);
    if (mag > 1) { ax /= mag; ay /= mag; }
    if (mag > 0.05) { this.facing.x = ax / (mag || 1); this.facing.y = ay / (mag || 1); }

    if (intent.dash && this.dashCd <= 0) {
      this.dashTime = TUNING.dashSeconds;
      this.dashCd = s.dashCooldown;
      this.iframe = Math.max(this.iframe, TUNING.dashSeconds + 0.06);
      const dx = mag > 0.05 ? ax : this.facing.x;
      const dy = mag > 0.05 ? ay : this.facing.y;
      this.dashDir = { x: dx, y: dy };
      this.emit('dash', { x: this.x, y: this.y });
    }

    // --- movement -----------------------------------------------------
    let speed = s.speed;
    let mx = ax, my = ay;
    if (this.dashTime > 0 && this.dashDir) {
      speed = s.speed * TUNING.dashSpeedMul;
      mx = this.dashDir.x;
      my = this.dashDir.y;
    }
    this.vx = mx * speed;
    this.vy = my * speed;
    this._moveAxis(this.vx * dt, 0);
    this._moveAxis(0, this.vy * dt);

    // Purge after moving, so the ground that clears is the ground the player
    // is standing on this frame rather than where they were last frame.
    this._updatePurge(dt, !!intent.purge);

    // --- automaton ----------------------------------------------------
    const p = this.pressure;
    this.genAcc += dt;
    const gi = genInterval(p);
    let guard = 0;
    while (this.genAcc >= gi && guard++ < 6) {
      this.genAcc -= gi;
      step(this.field, p, () => this.rng.next());
      bitFlip(this.field, p, () => this.rng.next(), this.playerCell(), 3);
      this.emit('gen');
    }
    if (guard >= 6) this.genAcc = 0;

    // --- collisions & pickups ----------------------------------------
    this._checkRotDamage();
    this._updateShards(dt);
    this._updateCapsule(dt);
    this._updateDefrag(dt);

    // --- schedule -----------------------------------------------------
    if (this.time >= this.nextSector) {
      this.nextSector += TUNING.sectorSeconds;
      this.sector++;
      // no free heal here: integrity only comes back by rescuing a Friend,
      // which keeps the core loop the thing that keeps you alive.
      this._seedNearPlayer(1 + Math.min(4, this.sector), 5, 9);
      this.emit('sector', { sector: this.sector });
    }
    if (this.time >= this.nextHunt) {
      const k = Math.min(1, (this.sector - 1) / 5);
      this.nextHunt = this.time + (TUNING.huntIntervalLo + (TUNING.huntIntervalHi - TUNING.huntIntervalLo) * k);
      const placed = this._seedNearPlayer(this.sector >= 4 ? 2 : 1, 4, 8);
      if (placed) this.emit('hunt', { sector: this.sector });
    }
    if (!this.capsule && this.time >= this.nextCapsule) {
      this.nextCapsule = this.time + TUNING.capsuleEvery;
      this._spawnCapsule();
    }
    if (!this.defrag && this.time >= this.nextDefrag) {
      this.nextDefrag = this.time + TUNING.defragEvery;
      this._spawnDefrag();
    }
  }

  _moveAxis(dx, dy) {
    const r = TUNING.playerRadius;
    let nx = this.x + dx;
    let ny = this.y + dy;
    // walls are the outer ring of cells
    const minC = CELL + r;
    const maxX = FIELD_W - CELL - r;
    const maxY = FIELD_H - CELL - r;
    if (nx < minC) nx = minC;
    if (nx > maxX) nx = maxX;
    if (ny < minC) ny = minC;
    if (ny > maxY) ny = maxY;
    this.x = nx;
    this.y = ny;
  }

  /**
   * Energy a purge costs right now. It climbs with the sector: the deeper the
   * dive, the more the archive resists being cleaned, so parking in one cleared
   * pocket stops being sustainable no matter how good your gear is.
   */
  get purgeCost() {
    return Math.round(this.stats.purgeCost * (1 + TUNING.purgeCostPerSector * (this.sector - 1)));
  }

  /**
   * Purge is a brush, not a stamp.
   *
   * Tapping spends one full charge and clears a disc where you stand. Holding
   * keeps clearing at wherever you are *now*, draining continuously — so the
   * cleared ground follows you instead of staying where the key went down.
   * That is what a player expects from a button labelled "purge", and it is
   * what makes the radius upgrade feel like a wider brush.
   */
  /** Clear a disc of rot centred on the player, right now. */
  _clearAround() {
    const s = this.stats;
    return purgeCircle(
      this.field, this.x / CELL, this.y / CELL,
      s.purgeRadius / CELL, Math.round(s.scarGens),
    );
  }

  /**
   * One press, one charge, one purge — holding the key does nothing extra.
   *
   * The catch the first version got wrong: a purge is not instantaneous. It
   * burns for as long as its effect is on screen, and for that whole window it
   * eats rot around wherever the player is *now*. Walk while it fires and the
   * cleared ground comes with you, which is what the ring around the character
   * has been promising all along.
   */
  _updatePurge(dt, wants) {
    const rising = wants && !this.purgeHeld;
    this.purgeHeld = !!wants;

    // A short cooldown between presses: without it, mashing empties the cell
    // into five overlapping discs in five frames, which is a far stronger clear
    // than the same charges spread over a second.
    if (rising && this.purgeCd <= 0) {
      const unit = this.purgeCost;
      if (this.energy < unit) {
        this.emit('purgeFail', { x: this.x, y: this.y });
      } else {
        this.energy -= unit;
        this.purgeCd = TUNING.purgeCooldown;
        this.counters.purges++;
        this.purgeBurn = TUNING.purgeBurnSeconds;
        const cleared = this._clearAround();
        this.emit('purge', { x: this.x, y: this.y, radius: this.stats.purgeRadius, cleared });
      }
    }

    // keep eating for the length of the effect, centred on the player
    if (this.purgeBurn > 0) {
      this.purgeBurn = Math.max(0, this.purgeBurn - dt);
      const cleared = this._clearAround();
      if (!rising && cleared > 0) this.emit('scrub', { x: this.x, y: this.y, cleared });
      return true;
    }
    return rising;
  }

  /**
   * Stop the dive from outside. Used when the input trace hits its ceiling: the
   * server will only score the first 600 seconds, so the client has to end
   * there too or the two would report different runs.
   */
  end(reason = 'ended') {
    if (this.state !== RunState.PLAYING) return false;
    this.state = RunState.OVER;
    this.emit('gameover', { reason });
    return true;
  }

  /** True while the purge is still eating — the scenes draw the ring from this. */
  get purgeActive() { return this.purgeBurn > 0; }

  /** Kept for the tests and the balance harness: one deliberate press. */
  _tryPurge() {
    this.purgeHeld = false;
    return this._updatePurge(1 / 60, true);
  }

  _checkRotDamage() {
    if (this.iframe > 0) return;
    const c = this.playerCell();
    if (!inBounds(c.x, c.y)) return;
    if (this.field.cells[idx(c.x, c.y)] !== ROT) return;
    this.hp -= 1;
    this.counters.hits++;
    this.iframe = TUNING.iframeSeconds;
    // a small reprieve, deliberately weaker than a real purge so that taking a
    // hit is never a cheaper way to clear ground than spending energy
    purgeCircle(this.field, this.x / CELL, this.y / CELL, 1.2, 5);
    this.emit('hurt', { x: this.x, y: this.y, hp: this.hp });
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = RunState.OVER;
      this.emit('gameover', {});
    }
  }

  /* ------------------------------ pickups --------------------------- */

  _freeCell({ minPlayerDist = 4, maxPlayerDist = 99, requireClean = true, wantDanger = false }) {
    let best = null;
    let bestScore = -Infinity;
    const pc = this.playerCell();
    for (let tries = 0; tries < 90; tries++) {
      const x = 1 + this.rng.int(COLS - 2);
      const y = 1 + this.rng.int(ROWS - 2);
      const i = idx(x, y);
      if (this.field.cells[i] === WALL) continue;
      if (requireClean && this.field.cells[i] !== CLEAN) continue;
      if (this._occupied(x, y)) continue;
      const dx = x - pc.x, dy = y - pc.y;
      const d = Math.hypot(dx, dy);
      if (d < minPlayerDist || d > maxPlayerDist) continue;
      const danger = distanceToRot(this.field, x, y, 6);
      const score = wantDanger ? -danger + this.rng.next() : danger + this.rng.next() * 2;
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    return best;
  }

  /**
   * Same as _freeCell but relaxes its constraints until something is found.
   * Capsules and defrag canisters must always appear — a buried capsule is a
   * fine outcome, a missing one just makes the run stall.
   */
  _freeCellRelaxed(opts) {
    const ladder = [
      opts,
      { ...opts, minPlayerDist: Math.max(3, (opts.minPlayerDist || 4) - 2), maxPlayerDist: 99 },
      { ...opts, minPlayerDist: 3, maxPlayerDist: 99, requireClean: false },
      { ...opts, minPlayerDist: 2, maxPlayerDist: 99, requireClean: false, wantDanger: false },
    ];
    for (const attempt of ladder) {
      const spot = this._freeCell(attempt);
      if (spot) return spot;
    }
    return null;
  }

  _occupied(x, y) {
    for (const sh of this.shards) if (sh.cx === x && sh.cy === y) return true;
    if (this.capsule && this.capsule.cx === x && this.capsule.cy === y) return true;
    if (this.defrag && this.defrag.cx === x && this.defrag.cy === y) return true;
    return false;
  }

  _spawnShard() {
    // deliberately NOT relaxed: when the arena is dying, shards get scarce.
    // That is what stops a cornered player from farming them forever.
    const spot = this._freeCell({ minPlayerDist: TUNING.shardMinDist });
    if (!spot) return false;
    this.shards.push({
      cx: spot.x, cy: spot.y,
      x: spot.x * CELL + CELL / 2,
      y: spot.y * CELL + CELL / 2,
      phase: this.rng.next() * Math.PI * 2,
      pulled: false,
    });
    return true;
  }

  _updateShards(dt) {
    const s = this.stats;
    const magnet = s.magnet;
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const sh = this.shards[i];
      const cell = this.field.cells[idx(sh.cx, sh.cy)];
      if (cell === ROT && !sh.pulled) {
        this.shards.splice(i, 1);
        this.counters.lostShards++;
        this.emit('shardLost', { x: sh.x, y: sh.y });
        continue;
      }
      const dx = this.x - sh.x, dy = this.y - sh.y;
      const d = Math.hypot(dx, dy);
      if (d < magnet + TUNING.playerRadius) {
        sh.pulled = true;
        const pull = Math.min(1, dt * 9);
        sh.x += dx * pull;
        sh.y += dy * pull;
      }
      if (d < TUNING.playerRadius + 4) {
        this.shards.splice(i, 1);
        this.counters.shards++;
        this.energy = Math.min(s.energyMax, this.energy + 9);
        this.emit('shard', { x: sh.x, y: sh.y });
      }
    }
    if (this.shardCd > 0) this.shardCd -= dt;
    if (this.shards.length < TUNING.shardTarget && this.shardCd <= 0) {
      if (this._spawnShard()) this.shardCd = TUNING.shardRespawn;
      else this.shardCd = 1.5;   // nowhere safe left; try again shortly
    }
  }

  _spawnCapsule() {
    const spot = this._freeCellRelaxed({ minPlayerDist: 6, maxPlayerDist: 22 });
    if (!spot) { this.nextCapsule = this.time + 4; return; }
    this.capsule = {
      cx: spot.x, cy: spot.y,
      x: spot.x * CELL + CELL / 2,
      y: spot.y * CELL + CELL / 2,
      friendId: rollFriendId(this.rng),
      life: TUNING.capsuleLife,
      buried: 0,
    };
    this.emit('capsuleSpawn', { x: this.capsule.x, y: this.capsule.y });
  }

  _updateCapsule(dt) {
    const c = this.capsule;
    if (!c) return;
    c.life -= dt;
    const cell = this.field.cells[idx(c.cx, c.cy)];
    if (cell === ROT) c.buried += dt; else c.buried = Math.max(0, c.buried - dt * 0.6);

    const d = Math.hypot(this.x - c.x, this.y - c.y);
    if (d < TUNING.playerRadius + 6) {
      this.capsule = null;
      this.counters.rescues++;
      this.rescued.push(c.friendId);
      this.hp = Math.min(this.maxHp, this.hp + 1);
      this.emit('rescue', { x: c.x, y: c.y, friendId: c.friendId });
      return;
    }
    if (c.buried >= TUNING.capsuleBuryLimit || c.life <= 0) {
      this.capsule = null;
      this.counters.lostCapsules++;
      this.emit('capsuleLost', { x: c.x, y: c.y, friendId: c.friendId });
    }
  }

  _spawnDefrag() {
    const spot = this._freeCellRelaxed({ minPlayerDist: 5, wantDanger: true });
    if (!spot) { this.nextDefrag = this.time + 4; return; }
    this.defrag = {
      cx: spot.x, cy: spot.y,
      x: spot.x * CELL + CELL / 2,
      y: spot.y * CELL + CELL / 2,
      life: TUNING.defragLife,
    };
    this.emit('defragSpawn', { x: this.defrag.x, y: this.defrag.y });
  }

  _updateDefrag(dt) {
    const d = this.defrag;
    if (!d) return;
    d.life -= dt;
    const dist = Math.hypot(this.x - d.x, this.y - d.y);
    if (dist < TUNING.playerRadius + 6) {
      const cleared = defragField(this.field, 8);
      this.defrag = null;
      this.counters.defrags++;
      this.energy = this.stats.energyMax;
      // the archive immediately starts rotting again, from fresh seeds
      const pc = this.playerCell();
      let placed = 0, guard = 0;
      const want = 2 + Math.min(4, Math.floor(this.sector / 2));
      while (placed < want && guard++ < 200) {
        const x = 2 + this.rng.int(COLS - 4);
        const y = 2 + this.rng.int(ROWS - 4);
        if (Math.hypot(x - pc.x, y - pc.y) < 7) continue;
        if (seed(this.field, x, y)) placed++;
      }
      this.emit('defrag', { x: d.x, y: d.y, cleared });
      return;
    }
    if (d.life <= 0) {
      this.defrag = null;
      this.emit('defragLost', { x: d.x, y: d.y });
    }
  }

  /* ------------------------------ result ---------------------------- */

  result(shardValue = 1) {
    const base = {
      time: this.time,
      sector: this.sector,
      shards: this.counters.shards,
      rescues: this.counters.rescues,
      defrags: this.counters.defrags,
      purges: this.counters.purges,
      hits: this.counters.hits,
      lostShards: this.counters.lostShards,
      lostCapsules: this.counters.lostCapsules,
      rescued: this.rescued.slice(),
      coverage: this.coverage,
      rot: rotCount(this.field),
    };
    base.rf = runPayout(base, shardValue);
    base.score = runScore(base);
    return base;
  }
}
