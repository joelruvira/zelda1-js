// On-screen controls of the Android shell: D-pad on the left, B/A on the right, Select/Start at the bottom
// centre, a small menu button. One overlay element receives every pointer (true multitouch): each finger
// is tied to a zone when it goes down (D-pad, buttons, Select, Start, menu) and its buttons are
// recomputed on every move, so sliding changes the D-pad direction or goes from B to A without lifting.
// The geometry and the finger -> NES button mapping are pure functions (tests/android/touch.test.mjs).

import { BTN } from '../../src/core/input.js';

const SECTOR_BITS = [ // 45° sectors clockwise from "right" (screen y grows downwards)
  BTN.RIGHT, BTN.RIGHT | BTN.DOWN, BTN.DOWN, BTN.DOWN | BTN.LEFT,
  BTN.LEFT, BTN.LEFT | BTN.UP, BTN.UP, BTN.UP | BTN.RIGHT,
];
const DIRECTIONS = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

/** Dead zone of the D-pad, as a fraction of its radius. */
export const DPAD_DEAD_ZONE = 0.22;
/** Hit radius of A/B as a multiple of the drawn radius: the enlarged circles overlap between the two
 *  buttons, so a thumb in the middle presses both (like rolling the thumb on a real pad). */
export const BUTTON_HIT = 1.3;

/** 8-way D-pad: NES direction bits of the vector (dx, dy) from its centre; 0 inside the dead zone. */
export function dpadBits(dx, dy, radius, deadZone = DPAD_DEAD_ZONE) {
  if (Math.hypot(dx, dy) < radius * deadZone) return 0;
  const sector = ((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8;
  return SECTOR_BITS[sector];
}

/** A/B under the point (x, y): 0, BTN.A, BTN.B or both. */
export function faceBits(x, y, layout) {
  let bits = 0;
  if (Math.hypot(x - layout.a.cx, y - layout.a.cy) <= layout.a.r * BUTTON_HIT) bits |= BTN.A;
  if (Math.hypot(x - layout.b.cx, y - layout.b.cy) <= layout.b.r * BUTTON_HIT) bits |= BTN.B;
  return bits;
}

const inRect = (x, y, r, pad = 0) => x >= r.x - pad && x < r.x + r.w + pad && y >= r.y - pad && y < r.y + r.h + pad;

/** Zone a finger going down at (x, y) belongs to: 'menu' | 'select' | 'start' | 'dpad' | 'face'. */
export function zoneAt(x, y, layout) {
  if (inRect(x, y, layout.menu, layout.menu.slop)) return 'menu';
  if (inRect(x, y, layout.select, layout.pillSlop)) return 'select';
  if (inRect(x, y, layout.start, layout.pillSlop)) return 'start';
  return x < layout.width / 2 ? 'dpad' : 'face';
}

/** Buttons held by one finger of `zone` at (x, y). */
export function fingerBits(zone, x, y, layout) {
  switch (zone) {
    case 'dpad': return dpadBits(x - layout.dpad.cx, y - layout.dpad.cy, layout.dpad.r);
    case 'face': return faceBits(x, y, layout);
    case 'select': return inRect(x, y, layout.select, layout.pillSlop) ? BTN.SELECT : 0;
    case 'start': return inRect(x, y, layout.start, layout.pillSlop) ? BTN.START : 0;
    default: return 0;
  }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Positions of the controls (CSS px) for a landscape screen.
 * @param {{width: number, height: number, game: {x: number, y: number, w: number, h: number},
 *   safe?: {left: number, right: number, top: number, bottom: number}}} o
 *   game: rectangle of the picture; safe: insets to avoid (display cutout).
 */
export function computeLayout({ width, height, game, safe = { left: 0, right: 0, top: 0, bottom: 0 } }) {
  const left0 = safe.left;
  const right1 = width - safe.right;
  // side bands next to the picture; when the picture leaves no room (narrow screen) use a fixed band
  const minBand = Math.min(width * 0.28, height * 0.62);
  const leftW = Math.max(game.x - left0, minBand);
  const rightW = Math.max(right1 - (game.x + game.w), minBand);
  const leftCx = left0 + leftW / 2;
  const rightCx = right1 - rightW / 2;

  const dr = clamp(Math.min(leftW * 0.4, height * 0.25), 44, 130);
  const dcy = clamp(height * 0.6, safe.top + dr + 12, height - safe.bottom - dr - 12);
  const dpad = { cx: clamp(leftCx, left0 + dr + 8, width / 2 - dr), cy: dcy, r: dr };

  const br = clamp(Math.min(rightW * 0.2, height * 0.115), 26, 64);
  const gap = br * 0.3;
  const fcx = clamp(rightCx, width / 2 + 2 * br + gap, right1 - 2 * br - gap / 2 - 8);
  const b = { cx: fcx - br - gap / 2, cy: dcy + br * 0.18, r: br };
  const a = { cx: fcx + br + gap / 2, cy: dcy - br * 0.18, r: br };

  const pillW = clamp(height * 0.15, 44, 84);
  const pillH = clamp(height * 0.05, 16, 28);
  const pillY = height - safe.bottom - pillH - clamp(height * 0.015, 4, 12);
  const select = { x: width / 2 - pillW - 10, y: pillY, w: pillW, h: pillH };
  const start = { x: width / 2 + 10, y: pillY, w: pillW, h: pillH };

  const ms = clamp(height * 0.08, 26, 44);
  const menu = { x: right1 - ms - 10, y: safe.top + 10, w: ms, h: ms, slop: 8 };
  return { width, height, dpad, a, b, select, start, menu, pillSlop: pillH * 0.6 };
}

/**
 * The overlay: draws the controls, tracks every pointer and reports the held NES buttons.
 * @param {HTMLElement} root container that covers the whole screen
 * @param {{onChange: (bits: number) => void, onPress?: (bits: number) => void, onMenu?: () => void,
 *   onActivity?: () => void}} handlers onPress: newly pressed buttons (haptics)
 */
export class TouchControls {
  constructor(root, { onChange, onPress = () => {}, onMenu = () => {}, onActivity = () => {} }) {
    this.root = root;
    this.onChange = onChange;
    this.onPress = onPress;
    this.onMenu = onMenu;
    this.onActivity = onActivity;
    this.layout = null;
    this.fingers = new Map(); // pointerId -> {zone, bits}
    this.bits = 0;
    this.enabled = true;
    this.el = this.build();
    const opts = { passive: false };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      root.addEventListener(type, (e) => this.handle(e), opts);
    }
    for (const type of ['touchstart', 'touchmove', 'touchend', 'contextmenu', 'dblclick']) {
      root.addEventListener(type, (e) => { if (e.cancelable) e.preventDefault(); }, opts);
    }
  }

  build() {
    const make = (cls, html = '') => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      this.root.appendChild(d);
      return d;
    };
    return {
      dpad: make('tc-dpad', `<svg viewBox="-100 -100 200 200" aria-hidden="true">
        <circle class="tc-ring" r="97"/>
        <path class="tc-cross" d="M-30-84h60v54h54v60h-54v54h-60v-54h-54v-60h54z"/>
        <path class="tc-arm" data-bit="${BTN.UP}" d="M-24-78h48v40l-24 24-24-24z"/>
        <path class="tc-arm" data-bit="${BTN.DOWN}" d="M-24 78h48v-40l-24-24-24 24z"/>
        <path class="tc-arm" data-bit="${BTN.LEFT}" d="M-78-24v48h40l24-24-24-24z"/>
        <path class="tc-arm" data-bit="${BTN.RIGHT}" d="M78-24v48h-40l-24-24 24-24z"/>
      </svg>`),
      b: make('tc-btn', '<span>B</span>'),
      a: make('tc-btn', '<span>A</span>'),
      select: make('tc-pill', '<span>SELECT</span>'),
      start: make('tc-pill', '<span>START</span>'),
      menu: make('tc-menu', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>'),
    };
  }

  /** Lays the controls out for the current screen (see computeLayout). */
  setLayout(layout) {
    this.layout = layout;
    const place = (el, x, y, w, h) => Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    const { dpad, a, b, select, start, menu } = layout;
    place(this.el.dpad, dpad.cx - dpad.r, dpad.cy - dpad.r, dpad.r * 2, dpad.r * 2);
    place(this.el.b, b.cx - b.r, b.cy - b.r, b.r * 2, b.r * 2);
    place(this.el.a, a.cx - a.r, a.cy - a.r, a.r * 2, a.r * 2);
    place(this.el.select, select.x, select.y, select.w, select.h);
    place(this.el.start, start.x, start.y, start.w, start.h);
    place(this.el.menu, menu.x, menu.y, menu.w, menu.h);
    for (const el of [this.el.b, this.el.a]) el.style.fontSize = `${b.r * 0.8}px`;
    for (const el of [this.el.select, this.el.start]) el.style.fontSize = `${select.h * 0.5}px`;
  }

  /** Rectangles (CSS px) where the system back gesture must not steal the fingers. */
  exclusionRects() {
    if (!this.layout) return [];
    const { dpad, a, b } = this.layout;
    const m = dpad.r * 0.4;
    return [
      { x: dpad.cx - dpad.r - m, y: dpad.cy - dpad.r - m, w: 2 * (dpad.r + m), h: 2 * (dpad.r + m) },
      { x: b.cx - b.r * 1.5, y: Math.min(a.cy, b.cy) - a.r * 1.5, w: a.cx - b.cx + 3 * a.r, h: Math.abs(a.cy - b.cy) + 3 * a.r },
    ];
  }

  handle(e) {
    if (e.cancelable) e.preventDefault();
    if (!this.layout) return;
    const { pointerId: id, clientX: x, clientY: y } = e;
    if (e.type === 'pointerdown') {
      this.onActivity();
      const zone = zoneAt(x, y, this.layout);
      if (zone === 'menu') { this.onMenu(); return; }
      this.fingers.set(id, { zone, bits: fingerBits(zone, x, y, this.layout) });
    } else if (e.type === 'pointermove') {
      const f = this.fingers.get(id);
      if (!f) return;
      f.bits = fingerBits(f.zone, x, y, this.layout);
    } else {
      if (!this.fingers.delete(id)) return;
    }
    this.update();
  }

  /** Releases every finger (menu opened, app paused). */
  releaseAll() {
    this.fingers.clear();
    this.update();
  }

  update() {
    let bits = 0;
    for (const f of this.fingers.values()) bits |= f.bits;
    if (bits === this.bits) return;
    const pressed = bits & ~this.bits;
    this.bits = bits;
    for (const arm of this.el.dpad.querySelectorAll('.tc-arm')) arm.classList.toggle('on', (bits & Number(arm.dataset.bit)) !== 0);
    this.el.a.classList.toggle('on', (bits & BTN.A) !== 0);
    this.el.b.classList.toggle('on', (bits & BTN.B) !== 0);
    this.el.select.classList.toggle('on', (bits & BTN.SELECT) !== 0);
    this.el.start.classList.toggle('on', (bits & BTN.START) !== 0);
    this.onChange(bits);
    if (pressed) this.onPress(pressed);
  }
}

export { DIRECTIONS };
