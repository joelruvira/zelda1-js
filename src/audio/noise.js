import { LENGTH_TABLE, NOISE_PERIODS } from './tables.js';
import { Envelope } from './envelope.js';

// Canal de ruido: LFSR de 15 bits, modo largo (tap bit 1) o corto (tap bit 6).
export class Noise {
  constructor() {
    this.envelope = new Envelope();
    this.reset();
  }

  reset() {
    this.envelope.reset();
    this.enabled = false;
    this.shortMode = false;
    this.period = NOISE_PERIODS[0];
    this.timer = 0;
    this.shift = 1;
    this.length = 0;
  }

  write(reg, value) {
    switch (reg) {
      case 0:
        this.envelope.write(value);
        break;
      case 2:
        this.shortMode = (value & 0x80) !== 0;
        this.period = NOISE_PERIODS[value & 0x0f];
        break;
      case 3:
        if (this.enabled) this.length = LENGTH_TABLE[value >> 3];
        this.envelope.start = true;
        break;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  // Timer: se clockea cada ciclo de CPU con el periodo de la tabla (en ciclos de CPU).
  clockTimer() {
    if (this.timer > 0) {
      this.timer--;
      return;
    }
    this.timer = this.period - 1;
    const tap = this.shortMode ? 6 : 1;
    const feedback = (this.shift ^ (this.shift >> tap)) & 1;
    this.shift = (this.shift >> 1) | (feedback << 14);
  }

  clockQuarter() {
    this.envelope.clock();
  }

  clockHalf() {
    if (this.length > 0 && !this.envelope.loop) this.length--;
  }

  output() {
    if (this.length === 0 || (this.shift & 1) !== 0) return 0;
    return this.envelope.output();
  }
}
