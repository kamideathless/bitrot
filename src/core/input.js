// Keyboard + pointer + touch input, normalised into named actions and a
// logical-pixel pointer position.

import { W, H } from './gfx.js';

const KEYMAP = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  purge: ['Space', 'KeyJ', 'KeyZ'],
  dash: ['ShiftLeft', 'ShiftRight', 'KeyK', 'KeyX'],
  confirm: ['Enter', 'NumpadEnter', 'Space', 'KeyJ'],
  cancel: ['Escape', 'Backspace'],
  pause: ['Escape', 'KeyP'],
  mute: ['KeyM'],
  restart: ['KeyR'],
  tabNext: ['Tab'],
};

const PREVENT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'Tab', 'Backspace',
]);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressedKeys = new Set();
    this.releasedKeys = new Set();
    this.pointers = new Map(); // id -> {x, y, sx, sy, startX, startY, moved}
    this.pointer = { x: -1, y: -1, down: false, pressed: false, released: false, inside: false };
    // every pointerdown since the last frame, so a tap shorter than one frame
    // is still seen by the on-screen buttons
    this.downEvents = [];
    this.hasTouch = false;
    this.anyInputSeen = false;
    this._firstGestureHandlers = [];

    // reverse lookup: code -> [actions]
    this._codeActions = new Map();
    for (const [action, codes] of Object.entries(KEYMAP)) {
      for (const code of codes) {
        if (!this._codeActions.has(code)) this._codeActions.set(code, []);
        this._codeActions.get(code).push(action);
      }
    }

    this._bind();
  }

  onFirstGesture(fn) { this._firstGestureHandlers.push(fn); }

  _fireFirstGesture() {
    if (this.anyInputSeen) return;
    this.anyInputSeen = true;
    for (const fn of this._firstGestureHandlers) {
      try { fn(); } catch (e) { console.warn('first-gesture handler failed', e); }
    }
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { if (PREVENT.has(e.code)) e.preventDefault(); return; }
      if (PREVENT.has(e.code)) e.preventDefault();
      this._fireFirstGesture();
      this.down.add(e.code);
      this.pressedKeys.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
      this.releasedKeys.add(e.code);
    });

    window.addEventListener('blur', () => {
      this.down.clear();
      this.pointers.clear();
      this.pointer.down = false;
    });

    const toLogical = (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return { x: -1, y: -1 };
      return {
        x: ((e.clientX - r.left) / r.width) * W,
        y: ((e.clientY - r.top) / r.height) * H,
      };
    };

    const c = this.canvas;
    c.style.touchAction = 'none';

    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._fireFirstGesture();
      if (e.pointerType === 'touch') this.hasTouch = true;
      const p = toLogical(e);
      try { c.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.pointers.set(e.pointerId, {
        id: e.pointerId, x: p.x, y: p.y, startX: p.x, startY: p.y, moved: false, type: e.pointerType,
      });
      this.pointer.x = p.x; this.pointer.y = p.y;
      this.pointer.down = true;
      this.pointer.pressed = true;
      this.pointer.inside = true;
      if (this.downEvents.length < 16) this.downEvents.push({ x: p.x, y: p.y, type: e.pointerType });
    });

    c.addEventListener('pointermove', (e) => {
      const p = toLogical(e);
      const rec = this.pointers.get(e.pointerId);
      if (rec) {
        rec.x = p.x; rec.y = p.y;
        if (Math.abs(p.x - rec.startX) > 2 || Math.abs(p.y - rec.startY) > 2) rec.moved = true;
      }
      if (e.pointerType !== 'touch' || rec) {
        this.pointer.x = p.x;
        this.pointer.y = p.y;
      }
      this.pointer.inside = p.x >= 0 && p.y >= 0 && p.x < W && p.y < H;
    });

    const endPointer = (e) => {
      const rec = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      try { c.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (this.pointers.size === 0) {
        this.pointer.down = false;
        this.pointer.released = true;
        if (rec) { this.pointer.x = rec.x; this.pointer.y = rec.y; }
      }
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    if (navigator.maxTouchPoints > 0) this.hasTouch = true;
  }

  /** Is an action's key currently held? */
  held(action) {
    const codes = KEYMAP[action];
    if (!codes) return false;
    for (const code of codes) if (this.down.has(code)) return true;
    return false;
  }

  /** Was an action's key pressed this frame? */
  pressed(action) {
    const codes = KEYMAP[action];
    if (!codes) return false;
    for (const code of codes) if (this.pressedKeys.has(code)) return true;
    return false;
  }

  keyPressed(code) { return this.pressedKeys.has(code); }

  /** Normalised movement vector from the keyboard. */
  keyAxis() {
    let x = 0, y = 0;
    if (this.held('left')) x -= 1;
    if (this.held('right')) x += 1;
    if (this.held('up')) y -= 1;
    if (this.held('down')) y += 1;
    if (x !== 0 && y !== 0) {
      const inv = Math.SQRT1_2;
      x *= inv; y *= inv;
    }
    return { x, y };
  }

  /** All active pointers as an array (logical coords). */
  activePointers() { return [...this.pointers.values()]; }

  endFrame() {
    this.pressedKeys.clear();
    this.releasedKeys.clear();
    this.pointer.pressed = false;
    this.pointer.released = false;
    this.downEvents.length = 0;
  }
}

export { KEYMAP };
