import { CPU_HZ } from './tables.js';
import { NesFilterChain } from './filters.js';

// Convierte la salida del mezclador (1 valor por ciclo de CPU) a la frecuencia de muestreo
// de salida: promedio por caja (anti-alias) + cadena de filtros de la NES. Las muestras se
// guardan en un buffer circular.
export class Resampler {
  constructor({ sampleRate = 48000, capacity = 8192, filter = true, gain = 1 } = {}) {
    this.sampleRate = sampleRate;
    this.baseCyclesPerSample = CPU_HZ / sampleRate;
    this.cyclesPerSample = this.baseCyclesPerSample;
    this.filter = filter ? new NesFilterChain(sampleRate) : null;
    this.gain = gain;
    this.ring = new Float32Array(capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.count = 0;
    this.sum = 0;
    this.acc = 0; // ciclos acumulados en la muestra en curso
  }

  // Ajuste fino de velocidad (control de latencia): ratio 1 = tiempo real exacto.
  setRateRatio(ratio) {
    this.cyclesPerSample = this.baseCyclesPerSample * ratio;
  }

  push(level) {
    this.sum += level;
    this.acc += 1;
    if (this.acc >= this.cyclesPerSample) {
      // El ciclo que cruza el borde se reparte entre esta muestra y la siguiente.
      const over = this.acc - this.cyclesPerSample;
      const value = (this.sum - level * over) / this.cyclesPerSample;
      this.emit(value);
      this.sum = level * over;
      this.acc = over;
    }
  }

  emit(value) {
    const out = (this.filter ? this.filter.process(value) : value) * this.gain;
    if (this.count === this.ring.length) {
      this.readPos = (this.readPos + 1) % this.ring.length; // desborde: descarta la más antigua
      this.count--;
    }
    this.ring[this.writePos] = out;
    this.writePos = (this.writePos + 1) % this.ring.length;
    this.count++;
  }

  get available() {
    return this.count;
  }

  // Copia hasta out.length muestras a `out`; devuelve cuántas copió.
  read(out, offset = 0, length = out.length - offset) {
    const n = Math.min(length, this.count);
    for (let i = 0; i < n; i++) {
      out[offset + i] = this.ring[this.readPos];
      this.readPos = (this.readPos + 1) % this.ring.length;
    }
    this.count -= n;
    return n;
  }

  // Devuelve todas las muestras pendientes en un Float32Array nuevo.
  take() {
    const out = new Float32Array(this.count);
    this.read(out);
    return out;
  }
}
