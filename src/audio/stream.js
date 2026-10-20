import { Apu } from './apu.js';
import { FRAME_CYCLES } from './tables.js';
import { Resampler } from './resampler.js';

// Formato de una escritura empaquetada en un Uint32: ciclo<<13 | (addr-$4000)<<8 | valor.
export function packWrite(cycle, addr, value) {
  return ((cycle << 13) | ((addr - 0x4000) << 8) | (value & 0xff)) >>> 0;
}

export function unpackWrite(word) {
  return { cycle: word >>> 13, addr: 0x4000 + ((word >>> 8) & 0x1f), value: word & 0xff };
}

// Reproductor en tiempo real: recibe lotes de escrituras por frame (con su timestamp en
// ciclos de CPU) y genera muestras bajo demanda. Mantiene ~`targetFrames` frames en cola
// ajustando la velocidad ±0.5 % (sin derivas), descarta retrasos grandes y, si se queda
// sin frames, congela la APU (el paso-alto lleva la salida a silencio).
export class ApuStream {
  constructor({ sampleRate = 48000, readMemory, targetFrames = 2, maxFrames = 6 } = {}) {
    this.apu = new Apu({ readMemory });
    this.resampler = new Resampler({ sampleRate });
    this.targetFrames = targetFrames;
    this.maxFrames = maxFrames;
    this.queue = [];
    this.current = null;
    this.writeIndex = 0;
    this.position = 0;
    this.primed = false;
    this.underruns = 0;
  }

  // `writes`: Uint32Array de escrituras empaquetadas, en orden de ciclo. `cycles`: duración del frame.
  pushFrame(writes, cycles = Math.round(FRAME_CYCLES)) {
    this.queue.push({ writes, cycles });
    if (this.queue.length > this.maxFrames) this.skipBacklog();
  }

  bufferedCycles() {
    let total = this.current ? this.current.cycles - this.position : 0;
    for (const f of this.queue) total += f.cycles;
    return total;
  }

  // Ajuste proporcional de la velocidad para mantener la cola en `targetFrames`.
  updateRate() {
    const target = this.targetFrames * FRAME_CYCLES;
    const err = (this.bufferedCycles() - target) / target;
    const ratio = 1 - Math.max(-0.005, Math.min(0.005, err * 0.005));
    this.resampler.setRateRatio(ratio);
  }

  // Se ejecutan (sin generar audio) los frames sobrantes para no acumular latencia.
  skipBacklog() {
    while (this.queue.length > this.targetFrames) {
      if (!this.current) this.nextFrame();
      this.runCurrent(Infinity, null);
    }
  }

  nextFrame() {
    this.current = this.queue.shift() ?? null;
    this.writeIndex = 0;
    this.position = 0;
  }

  // Avanza el frame actual hasta `maxCycles` ciclos, aplicando las escrituras en su ciclo.
  runCurrent(maxCycles, sink) {
    const f = this.current;
    let budget = maxCycles;
    while (budget > 0) {
      while (this.writeIndex < f.writes.length) {
        const w = f.writes[this.writeIndex];
        if (w >>> 13 > this.position) break;
        this.apu.writeRegister(0x4000 + ((w >>> 8) & 0x1f), w & 0xff);
        this.writeIndex++;
      }
      const nextWrite = this.writeIndex < f.writes.length ? f.writes[this.writeIndex] >>> 13 : f.cycles;
      const end = Math.max(this.position, Math.min(nextWrite, f.cycles));
      if (end === this.position && this.position >= f.cycles) {
        // Escrituras con ciclo más allá del final del frame: se aplican al final.
        while (this.writeIndex < f.writes.length) {
          const w = f.writes[this.writeIndex++];
          this.apu.writeRegister(0x4000 + ((w >>> 8) & 0x1f), w & 0xff);
        }
        this.current = null;
        return;
      }
      const n = Math.min(end - this.position, budget);
      this.apu.clock(n, sink);
      this.position += n;
      budget -= n;
    }
  }

  // Rellena `out` (Float32Array) completo.
  render(out) {
    this.updateRate();
    let filled = this.resampler.read(out);
    while (filled < out.length) {
      if (!this.current) {
        if (!this.primed && this.queue.length < this.targetFrames) break;
        if (this.queue.length === 0) {
          this.primed = false;
          this.underruns++;
          break;
        }
        this.primed = true;
        this.nextFrame();
      }
      const need = out.length - filled;
      this.runCurrent(Math.ceil(need * this.resampler.cyclesPerSample) + 1, this.resampler);
      filled += this.resampler.read(out, filled);
    }
    if (filled < out.length) {
      // Sin datos: se mantiene el nivel actual del mezclador (el paso-alto lo lleva a 0).
      const level = this.apu.mix();
      for (let i = filled; i < out.length; i++) this.resampler.emit(level);
      this.resampler.read(out, filled);
    }
  }
}
