import { PULSE_TABLE, TND_TABLE } from './tables.js';
import { Pulse } from './pulse.js';
import { Triangle } from './triangle.js';
import { Noise } from './noise.js';
import { Dmc } from './dmc.js';
import { FrameCounter, QUARTER, HALF } from './frame-counter.js';

export { CPU_HZ, FRAME_CYCLES, FRAME_HZ } from './tables.js';

// APU 2A03 (NTSC) emulada ciclo a ciclo de CPU.
// - writeRegister(addr, value): escritura inmediata en el ciclo actual de la APU.
// - clock(cycles, sink): avanza `cycles` ciclos de CPU; `sink.push(nivel)` recibe la salida
//   del mezclador en cada ciclo (ver Resampler).
// - readMemory(addr): callback para que el DMC lea memoria de CPU ($8000-$FFFF).
export class Apu {
  constructor({ readMemory = () => 0 } = {}) {
    this.pulse1 = new Pulse(true);
    this.pulse2 = new Pulse(false);
    this.triangle = new Triangle();
    this.noise = new Noise();
    this.dmc = new Dmc((addr) => this.readMemory(addr));
    this.frameCounter = new FrameCounter();
    this.readMemory = readMemory;
    this.cycles = 0; // ciclos de CPU totales
  }

  reset() {
    for (const ch of [this.pulse1, this.pulse2, this.triangle, this.noise, this.dmc]) ch.reset();
    this.frameCounter.reset();
  }

  writeRegister(addr, value) {
    value &= 0xff;
    if (addr < 0x4000 || addr > 0x4017) return;
    if (addr <= 0x4003) this.pulse1.write(addr & 3, value);
    else if (addr <= 0x4007) this.pulse2.write(addr & 3, value);
    else if (addr <= 0x400b) this.triangle.write(addr & 3, value);
    else if (addr <= 0x400f) this.noise.write(addr & 3, value);
    else if (addr <= 0x4013) this.dmc.write(addr & 3, value);
    else if (addr === 0x4015) this.writeStatus(value);
    else if (addr === 0x4017) this.frameCounter.write(value, (this.cycles & 1) === 1);
  }

  writeStatus(value) {
    this.pulse1.setEnabled((value & 0x01) !== 0);
    this.pulse2.setEnabled((value & 0x02) !== 0);
    this.triangle.setEnabled((value & 0x04) !== 0);
    this.noise.setEnabled((value & 0x08) !== 0);
    this.dmc.setEnabled((value & 0x10) !== 0);
  }

  // Lectura de $4015 (borra el flag de IRQ de frame).
  readStatus() {
    let s = 0;
    if (this.pulse1.length > 0) s |= 0x01;
    if (this.pulse2.length > 0) s |= 0x02;
    if (this.triangle.length > 0) s |= 0x04;
    if (this.noise.length > 0) s |= 0x08;
    if (this.dmc.bytesRemaining > 0) s |= 0x10;
    if (this.frameCounter.irq) s |= 0x40;
    if (this.dmc.irq) s |= 0x80;
    this.frameCounter.irq = false;
    return s;
  }

  get irq() {
    return this.frameCounter.irq || this.dmc.irq;
  }

  // Salida del mezclador no lineal, 0..~1.
  mix() {
    const p = this.pulse1.output() + this.pulse2.output();
    const tnd = 3 * this.triangle.output() + 2 * this.noise.output() + this.dmc.output();
    return PULSE_TABLE[p] + TND_TABLE[tnd];
  }

  clockQuarter() {
    this.pulse1.clockQuarter();
    this.pulse2.clockQuarter();
    this.triangle.clockQuarter();
    this.noise.clockQuarter();
  }

  clockHalf() {
    this.pulse1.clockHalf();
    this.pulse2.clockHalf();
    this.triangle.clockHalf();
    this.noise.clockHalf();
  }

  clock(cycles, sink = null) {
    for (let i = 0; i < cycles; i++) {
      const fc = this.frameCounter.step();
      if (fc & QUARTER) this.clockQuarter();
      if (fc & HALF) this.clockHalf();
      if ((this.cycles & 1) === 1) {
        this.pulse1.clockTimer();
        this.pulse2.clockTimer();
      }
      this.triangle.clockTimer();
      this.noise.clockTimer();
      this.dmc.clockTimer();
      this.cycles++;
      if (sink) sink.push(this.mix());
    }
  }
}
