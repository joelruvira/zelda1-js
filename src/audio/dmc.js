import { DMC_PERIODS } from './tables.js';

// Canal DMC (delta modulation). Lee bytes de la memoria de CPU con `readMemory(addr)`.
// Zelda reproduce sus samples (PcmSamples, banco fijo $C000+) por este canal.
export class Dmc {
  constructor(readMemory) {
    this.readMemory = readMemory;
    this.reset();
  }

  reset() {
    this.irqEnabled = false;
    this.loop = false;
    this.period = DMC_PERIODS[0];
    this.timer = DMC_PERIODS[0] - 1;
    this.level = 0;
    this.sampleAddress = 0xc000;
    this.sampleLength = 1;
    this.address = 0xc000;
    this.bytesRemaining = 0;
    this.buffer = 0;
    this.bufferEmpty = true;
    this.shift = 0;
    this.bitsRemaining = 8;
    this.silence = true;
    this.irq = false;
  }

  write(reg, value) {
    switch (reg) {
      case 0:
        this.irqEnabled = (value & 0x80) !== 0;
        if (!this.irqEnabled) this.irq = false;
        this.loop = (value & 0x40) !== 0;
        this.period = DMC_PERIODS[value & 0x0f];
        break;
      case 1:
        this.level = value & 0x7f;
        break;
      case 2:
        this.sampleAddress = 0xc000 | (value << 6);
        break;
      case 3:
        this.sampleLength = (value << 4) | 1;
        break;
    }
  }

  // Bit 4 de $4015.
  setEnabled(on) {
    this.irq = false;
    if (!on) {
      this.bytesRemaining = 0;
    } else if (this.bytesRemaining === 0) {
      this.restart();
      this.fetch();
    }
  }

  restart() {
    this.address = this.sampleAddress;
    this.bytesRemaining = this.sampleLength;
  }

  // Lector de memoria: rellena el buffer de sample si está vacío (sin modelar el robo de ciclos a la CPU).
  fetch() {
    if (!this.bufferEmpty || this.bytesRemaining === 0) return;
    this.buffer = this.readMemory(this.address) & 0xff;
    this.bufferEmpty = false;
    this.address = this.address === 0xffff ? 0x8000 : this.address + 1;
    if (--this.bytesRemaining === 0) {
      if (this.loop) this.restart();
      else if (this.irqEnabled) this.irq = true;
    }
  }

  // Timer: se clockea cada ciclo de CPU con el periodo de la tabla (en ciclos de CPU).
  clockTimer() {
    if (this.timer > 0) {
      this.timer--;
      return;
    }
    this.timer = this.period - 1;
    this.clockOutput();
  }

  clockOutput() {
    if (!this.silence) {
      if (this.shift & 1) {
        if (this.level <= 125) this.level += 2;
      } else if (this.level >= 2) {
        this.level -= 2;
      }
    }
    this.shift >>= 1;
    if (--this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.bufferEmpty) {
        this.silence = true;
      } else {
        this.silence = false;
        this.shift = this.buffer;
        this.bufferEmpty = true;
        this.fetch();
      }
    }
  }

  output() {
    return this.level;
  }
}
