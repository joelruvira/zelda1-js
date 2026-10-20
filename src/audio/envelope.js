// Generador de envolvente (pulsos y ruido), clocked en cada quarter frame.
export class Envelope {
  constructor() {
    this.reset();
  }

  reset() {
    this.start = false;
    this.loop = false; // también es el "halt" del length counter
    this.constant = false;
    this.volume = 0; // V: volumen constante o periodo del divisor
    this.divider = 0;
    this.decay = 0;
  }

  // Bits 5-0 del registro de control ($4000/$4004/$400C).
  write(value) {
    this.loop = (value & 0x20) !== 0;
    this.constant = (value & 0x10) !== 0;
    this.volume = value & 0x0f;
  }

  clock() {
    if (this.start) {
      this.start = false;
      this.decay = 15;
      this.divider = this.volume;
      return;
    }
    if (this.divider > 0) {
      this.divider--;
      return;
    }
    this.divider = this.volume;
    if (this.decay > 0) this.decay--;
    else if (this.loop) this.decay = 15;
  }

  output() {
    return this.constant ? this.volume : this.decay;
  }
}
