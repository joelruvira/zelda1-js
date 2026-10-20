import { DUTY_TABLE, LENGTH_TABLE } from './tables.js';
import { Envelope } from './envelope.js';

// Canal de pulso. `onesComplement` = true para el pulso 1 ($4000), cuyo sweep
// en modo negación resta (cambio + 1); el pulso 2 resta solo el cambio.
export class Pulse {
  constructor(onesComplement) {
    this.onesComplement = onesComplement;
    this.envelope = new Envelope();
    this.reset();
  }

  reset() {
    this.envelope.reset();
    this.enabled = false;
    this.duty = 0;
    this.sequence = 0;
    this.period = 0;
    this.timer = 0;
    this.length = 0;
    this.sweepEnabled = false;
    this.sweepPeriod = 0;
    this.sweepNegate = false;
    this.sweepShift = 0;
    this.sweepDivider = 0;
    this.sweepReload = false;
  }

  write(reg, value) {
    switch (reg) {
      case 0:
        this.duty = value >> 6;
        this.envelope.write(value);
        break;
      case 1:
        this.sweepEnabled = (value & 0x80) !== 0;
        this.sweepPeriod = (value >> 4) & 7;
        this.sweepNegate = (value & 0x08) !== 0;
        this.sweepShift = value & 7;
        this.sweepReload = true;
        break;
      case 2:
        this.period = (this.period & 0x700) | value;
        break;
      case 3:
        this.period = (this.period & 0xff) | ((value & 7) << 8);
        if (this.enabled) this.length = LENGTH_TABLE[value >> 3];
        this.sequence = 0;
        this.envelope.start = true;
        break;
    }
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.length = 0;
  }

  // Timer: se clockea cada ciclo de APU (cada 2 ciclos de CPU).
  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.period;
      this.sequence = (this.sequence - 1) & 7;
    } else {
      this.timer--;
    }
  }

  clockQuarter() {
    this.envelope.clock();
  }

  clockHalf() {
    if (this.length > 0 && !this.envelope.loop) this.length--;
    const divZero = this.sweepDivider === 0;
    if (divZero && this.sweepEnabled && this.sweepShift > 0 && !this.muted()) {
      this.period = this.sweepTarget();
    }
    if (divZero || this.sweepReload) {
      this.sweepDivider = this.sweepPeriod;
      this.sweepReload = false;
    } else {
      this.sweepDivider--;
    }
  }

  // Periodo objetivo del sweep (se calcula continuamente).
  sweepTarget() {
    const change = this.period >> this.sweepShift;
    if (!this.sweepNegate) return this.period + change;
    const t = this.period - change - (this.onesComplement ? 1 : 0);
    return t < 0 ? 0 : t;
  }

  // El sweep silencia el canal si el periodo < 8 o el objetivo > $7FF, aunque esté desactivado.
  muted() {
    return this.period < 8 || this.sweepTarget() > 0x7ff;
  }

  output() {
    if (this.length === 0 || this.muted()) return 0;
    if (DUTY_TABLE[this.duty][this.sequence] === 0) return 0;
    return this.envelope.output();
  }
}
