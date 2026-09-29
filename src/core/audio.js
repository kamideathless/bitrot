// Small WebAudio chip-synth: square/triangle blips, noise bursts and a
// lookahead step sequencer for the two background loops.

const NOTES = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** "A2" -> Hz */
export function noteFreq(name) {
  const m = /^([A-G]#?)(-?\d)$/.exec(name);
  if (!m) return 0;
  const semitone = NOTES[m[1]] + (Number(m[2]) + 1) * 12;
  return 440 * Math.pow(2, (semitone - 69) / 12);
}

// step patterns: '-' = rest, otherwise a note name
const TRACKS = {
  hub: {
    bpm: 96,
    bass: ['A1', '-', '-', 'A1', '-', '-', 'E1', '-', 'F1', '-', '-', 'F1', '-', '-', 'G1', '-'],
    lead: ['A3', '-', 'C4', '-', 'E4', '-', 'C4', '-', 'F3', '-', 'A3', '-', 'C4', '-', 'G3', '-'],
    leadVol: 0.055,
    bassVol: 0.09,
    hat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0],
  },
  run: {
    bpm: 132,
    bass: ['D1', 'D1', '-', 'D1', '-', 'D1', 'A#0', '-', 'C1', 'C1', '-', 'C1', '-', 'G0', '-', 'A0'],
    lead: ['D3', '-', 'F3', 'A3', '-', 'F3', '-', 'D3', 'C3', '-', 'D#3', 'G3', '-', 'D#3', '-', 'C3'],
    leadVol: 0.045,
    bassVol: 0.085,
    hat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1],
  },
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.muted = false;
    this.track = null;
    this.trackName = null;
    this.step = 0;
    this.nextStepTime = 0;
    this.timer = null;
    this.tempoScale = 1;
    this.ready = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.85;
    this.musicGain.connect(this.master);

    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 1;
    this.sfxGain.connect(this.master);

    // shared noise buffer
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuffer.getChannelData(0);
    let seed = 1;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (seed / 0x3fffffff) - 1;
    }
    this.ready = true;
    if (this.trackName) this.playTrack(this.trackName, true);
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, 0.02);
    }
  }

  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  _now() { return this.ctx ? this.ctx.currentTime : 0; }

  tone({ freq = 440, to = null, dur = 0.08, type = 'square', vol = 0.18, attack = 0.002, dest = null, delay = 0 }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, freq), t0);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(dest || this.sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  noise({ dur = 0.1, vol = 0.14, freq = 1200, q = 0.7, type = 'bandpass', dest = null, delay = 0, sweepTo = null }) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, vol), t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest || this.sfxGain);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  sfx(name) {
    if (!this.ready || this.muted) return;
    switch (name) {
      case 'move':
        this.tone({ freq: 620, dur: 0.035, vol: 0.06, type: 'square' });
        break;
      case 'select':
        this.tone({ freq: 880, to: 1320, dur: 0.07, vol: 0.11 });
        break;
      case 'back':
        this.tone({ freq: 520, to: 300, dur: 0.08, vol: 0.09 });
        break;
      case 'deny':
        this.tone({ freq: 180, to: 110, dur: 0.16, vol: 0.13, type: 'square' });
        break;
      case 'shard':
        this.tone({ freq: 1180, to: 1760, dur: 0.06, vol: 0.09, type: 'square' });
        this.tone({ freq: 1760, dur: 0.05, vol: 0.05, type: 'triangle', delay: 0.05 });
        break;
      case 'purge':
        this.noise({ dur: 0.22, vol: 0.16, freq: 2600, sweepTo: 240, q: 1.2 });
        this.tone({ freq: 300, to: 90, dur: 0.18, vol: 0.09, type: 'triangle' });
        break;
      case 'dash':
        this.noise({ dur: 0.1, vol: 0.09, freq: 900, sweepTo: 2800, q: 2 });
        break;
      case 'hurt':
        this.tone({ freq: 240, to: 70, dur: 0.3, vol: 0.2, type: 'sawtooth' });
        this.noise({ dur: 0.25, vol: 0.14, freq: 500, sweepTo: 120 });
        break;
      case 'rescue':
        [0, 0.09, 0.18, 0.3].forEach((d, i) => {
          this.tone({ freq: [523, 659, 784, 1047][i], dur: 0.16, vol: 0.12, type: 'square', delay: d });
        });
        break;
      case 'defrag':
        this.noise({ dur: 0.7, vol: 0.2, freq: 180, sweepTo: 5200, q: 0.9 });
        [0, 0.12, 0.24].forEach((d, i) => this.tone({ freq: [392, 523, 784][i], dur: 0.3, vol: 0.1, delay: d, type: 'triangle' }));
        break;
      case 'sector':
        this.tone({ freq: 196, to: 392, dur: 0.5, vol: 0.12, type: 'triangle' });
        break;
      case 'gameover':
        [0, 0.16, 0.32, 0.5].forEach((d, i) => {
          this.tone({ freq: [392, 330, 262, 196][i], dur: 0.36, vol: 0.14, type: 'square', delay: d });
        });
        break;
      case 'buy':
        this.tone({ freq: 660, to: 990, dur: 0.1, vol: 0.12 });
        this.tone({ freq: 1320, dur: 0.1, vol: 0.07, delay: 0.08, type: 'triangle' });
        break;
      case 'burn':
        this.noise({ dur: 0.45, vol: 0.14, freq: 320, sweepTo: 3200, q: 1.1 });
        this.tone({ freq: 140, to: 900, dur: 0.4, vol: 0.09, type: 'sawtooth' });
        break;
      case 'restored':
        [0, 0.1, 0.2, 0.32, 0.46].forEach((d, i) => {
          this.tone({ freq: [523, 659, 784, 1047, 1319][i], dur: 0.22, vol: 0.12, type: 'square', delay: d });
        });
        break;
      case 'equip':
        this.tone({ freq: 740, to: 1100, dur: 0.12, vol: 0.1, type: 'triangle' });
        break;
      case 'lost':
        this.tone({ freq: 420, to: 120, dur: 0.35, vol: 0.12, type: 'sawtooth' });
        break;
      case 'seed':
        this.noise({ dur: 0.18, vol: 0.07, freq: 220, sweepTo: 90, q: 2.2 });
        this.tone({ freq: 110, to: 70, dur: 0.2, vol: 0.05, type: 'square' });
        break;
      default:
        break;
    }
  }

  playTrack(name, force = false) {
    if (!force && this.trackName === name) return;
    this.trackName = name;
    if (!this.ready) return;
    this.track = TRACKS[name] || null;
    this.step = 0;
    this.nextStepTime = this.ctx.currentTime + 0.05;
    if (!this.timer) this.timer = setInterval(() => this._schedule(), 25);
  }

  stopTrack() {
    this.trackName = null;
    this.track = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  setTempoScale(s) { this.tempoScale = Math.max(0.5, Math.min(2.2, s)); }

  _schedule() {
    if (!this.ready || !this.track || this.muted) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') return;
    const t = this.track;
    const stepDur = 60 / (t.bpm * this.tempoScale) / 4; // 16th notes
    let guard = 0;
    while (this.nextStepTime < ctx.currentTime + 0.14 && guard++ < 32) {
      const i = this.step % 16;
      const when = Math.max(this.nextStepTime, ctx.currentTime + 0.005);
      const delay = when - ctx.currentTime;

      const bass = t.bass[i];
      if (bass && bass !== '-') {
        this.tone({
          freq: noteFreq(bass), dur: stepDur * 1.7, vol: t.bassVol,
          type: 'square', dest: this.musicGain, delay,
        });
      }
      const lead = t.lead[i];
      if (lead && lead !== '-') {
        this.tone({
          freq: noteFreq(lead), dur: stepDur * 1.2, vol: t.leadVol,
          type: 'triangle', dest: this.musicGain, delay,
        });
      }
      if (t.hat[i]) {
        this.noise({ dur: 0.028, vol: 0.035, freq: 6800, q: 1.4, dest: this.musicGain, delay });
      }

      this.nextStepTime += stepDur;
      this.step++;
    }
    if (guard >= 32) this.nextStepTime = ctx.currentTime + 0.05;
  }
}
