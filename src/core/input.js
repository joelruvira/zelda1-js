// Keyboard + Gamepad -> NES controller bytes, plus the $4016/$4017 serial protocol.
// Byte layout as the game assembles it (ReadOneController ROLs 8 reads, first read = bit 7):
//   bit7 A, bit6 B, bit5 Select, bit4 Start, bit3 Up, bit2 Down, bit1 Left, bit0 Right.

export const BTN = Object.freeze({ A: 0x80, B: 0x40, SELECT: 0x20, START: 0x10, UP: 0x08, DOWN: 0x04, LEFT: 0x02, RIGHT: 0x01 });

/** Default keyboard mapping (KeyboardEvent.code -> [pad, button]). Configurable. */
export const DEFAULT_KEYMAP = {
  ArrowUp: [0, BTN.UP], ArrowDown: [0, BTN.DOWN], ArrowLeft: [0, BTN.LEFT], ArrowRight: [0, BTN.RIGHT],
  KeyX: [0, BTN.A], KeyZ: [0, BTN.B], Enter: [0, BTN.START], ShiftRight: [0, BTN.SELECT],
  KeyW: [1, BTN.UP], KeyS: [1, BTN.DOWN], KeyA: [1, BTN.LEFT], KeyD: [1, BTN.RIGHT],
  KeyG: [1, BTN.A], KeyF: [1, BTN.B], KeyT: [1, BTN.START], KeyR: [1, BTN.SELECT],
};
/** Famicom controller-2 microphone (Pols Voice). The US PRG0 ROM never reads it; kept for completeness. */
export const DEFAULT_MIC_KEY = 'KeyM';

// Standard Gamepad API layout -> NES button.
const PAD_BUTTONS = [[0, BTN.A], [1, BTN.B], [2, BTN.B], [3, BTN.A], [8, BTN.SELECT], [9, BTN.START],
  [12, BTN.UP], [13, BTN.DOWN], [14, BTN.LEFT], [15, BTN.RIGHT]];

export class Input {
  constructor({ keymap = DEFAULT_KEYMAP, micKey = DEFAULT_MIC_KEY } = {}) {
    this.keymap = { ...keymap };
    this.micKey = micKey;
    this.keyState = [0, 0];
    this.mic = false;
    this.state = [0, 0]; // latched each poll
    this.shift = [0, 0];
    this.strobe = 0;
    this.getGamepads = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []);
  }

  /** Attach keyboard listeners to a target (window). Returns a detach function. */
  attach(target) {
    const down = (e) => { if (this.key(e.code, true)) e.preventDefault(); };
    const up = (e) => { if (this.key(e.code, false)) e.preventDefault(); };
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    return () => { target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); };
  }

  /** Apply a key event; returns true if the key is mapped. */
  key(code, pressed) {
    if (code === this.micKey) { this.mic = pressed; return true; }
    const m = this.keymap[code];
    if (!m) return false;
    const [pad, bit] = m;
    this.keyState[pad] = pressed ? this.keyState[pad] | bit : this.keyState[pad] & ~bit;
    return true;
  }

  /** Current buttons of pad 0/1 (keyboard OR gamepad), in the game's byte layout. */
  buttons(pad) {
    let b = this.keyState[pad];
    const gp = this.getGamepads()?.[pad];
    if (gp) {
      for (const [i, bit] of PAD_BUTTONS) if (gp.buttons[i]?.pressed) b |= bit;
      const [ax = 0, ay = 0] = gp.axes;
      if (ax < -0.5) b |= BTN.LEFT; if (ax > 0.5) b |= BTN.RIGHT;
      if (ay < -0.5) b |= BTN.UP; if (ay > 0.5) b |= BTN.DOWN;
    }
    return b;
  }

  /** Force pad state (replays, tests, oracle). null returns control to devices. */
  setOverride(pad, value) { (this.override ??= [null, null])[pad] = value; }

  latch() {
    for (let p = 0; p < 2; p++) {
      const o = this.override?.[p];
      this.state[p] = o ?? this.buttons(p);
      this.shift[p] = this.state[p];
    }
  }

  /** CPU write $4016. */
  write4016(value) {
    const s = value & 1;
    if (s || this.strobe) this.latch();
    this.strobe = s;
  }

  /** CPU read $4016 (pad 0) / $4017 (pad 1). Bit 0 = button; bit 2 of $4016 = mic on Famicom. */
  read(pad) {
    if (this.strobe) this.latch();
    const bit = (this.shift[pad] >> 7) & 1;
    this.shift[pad] = ((this.shift[pad] << 1) | 1) & 0xff; // after 8 reads, official pads return 1
    let v = 0x40 | bit;
    if (pad === 0 && this.mic) v |= 0x04;
    return v;
  }
}
