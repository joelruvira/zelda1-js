import { LENGTH_TABLE, TRIANGLE_SEQUENCE } from './tables.js';

// Canal triángulo con linear counter.
export class Triangle {
  constructor() {
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.control = false; // también es el "halt" del length counter
    this.linearReloadValue = 0;
    this.linear = 0;
    this.linearReload = false;
    this.period = 0;
    this.timer = 0;
    this.sequence = 0;
    this.length = 0;
  }

  write(reg, value) {
    switch (reg) {
      case 0:
        this.control = (value & 0x80) !== 0;
        this.linearReloadValue = value & 0x7f;
        break;
      case 2:
        this.period = (this.period & 0x700) | value;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((value & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[value >> 3];
        this.linearReload = true;
        break;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  // Timer: se clockea cada ciclo de CPU.
  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.period;
      if (this.length > 0 && this.linear > 0) this.sequence = (this.sequence + 1) & 31;
    } else {
      this.timer--;
    }
  }

  clockQuarter() {
    if (this.linearReload) this.linear = this.linearReloadValue;
    else if (this.linear > 0) this.linear--;
    if (!this.control) this.linearReload = false;
  }

  clockHalf() {
    if (this.length > 0 && !this.control) this.length--;
  }

  // Igual que el hardware: al pararse, el triángulo mantiene su último nivel (no cae a 0).
  output() {
    return TRIANGLE_SEQUENCE[this.sequence];
  }
}
