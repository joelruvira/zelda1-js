import { Apu } from '../../src/audio/apu.js';
import { CPU_HZ } from '../../src/audio/tables.js';

// Frecuencia (Hz) de un canal contando las subidas desde 0 de su nivel en bruto.
// Vale para pulsos con duty 12.5/25/50 % y para el triángulo (0 -> 1 una vez por periodo).
export function measureFrequency(apu, channelOutput, cycles) {
  let prev = channelOutput();
  let rises = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < cycles; i++) {
    apu.clock(1);
    const v = channelOutput();
    if (prev === 0 && v > 0) {
      if (first < 0) first = i;
      last = i;
      rises++;
    }
    prev = v;
  }
  return rises > 1 ? ((rises - 1) * CPU_HZ) / (last - first) : 0;
}

export function newApu(opts) {
  const apu = new Apu(opts);
  apu.writeRegister(0x4017, 0x40); // modo 4 pasos, sin IRQ
  apu.clock(10);
  return apu;
}

// Frecuencia por cruces por cero ascendentes (interpolados) de una señal muestreada.
export function zeroCrossingHz(samples, sampleRate, skip = 0) {
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = Math.max(1, skip); i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) {
      const t = i - 1 + -samples[i - 1] / (samples[i] - samples[i - 1]);
      if (first < 0) first = t;
      last = t;
      n++;
    }
  }
  return n > 1 ? ((n - 1) * sampleRate) / (last - first) : 0;
}

// Magnitud de la DFT de `samples` en la frecuencia `hz` (Goertzel).
export function goertzel(samples, sampleRate, hz) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s = x + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / samples.length;
}
