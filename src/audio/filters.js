// Filtros de primer orden de la salida analógica de la NES (nesdev "APU Mixer"):
// paso-alto 90 Hz, paso-alto 440 Hz y paso-bajo 14 kHz.

export class HighPass {
  constructor(cutoff, sampleRate) {
    const rc = 1 / (2 * Math.PI * cutoff);
    this.alpha = rc / (rc + 1 / sampleRate);
    this.prevIn = NaN; // se inicializa con la primera muestra para no producir un "pop" al arrancar
    this.prevOut = 0;
  }

  process(x) {
    if (Number.isNaN(this.prevIn)) this.prevIn = x;
    const y = this.alpha * (this.prevOut + x - this.prevIn);
    this.prevIn = x;
    this.prevOut = y;
    return y;
  }
}

export class LowPass {
  constructor(cutoff, sampleRate) {
    const rc = 1 / (2 * Math.PI * cutoff);
    const dt = 1 / sampleRate;
    this.alpha = dt / (rc + dt);
    this.prevOut = 0;
  }

  process(x) {
    this.prevOut += this.alpha * (x - this.prevOut);
    return this.prevOut;
  }
}

// Cadena completa de la NES.
export class NesFilterChain {
  constructor(sampleRate) {
    this.hp90 = new HighPass(90, sampleRate);
    this.hp440 = new HighPass(440, sampleRate);
    this.lp14k = new LowPass(14000, sampleRate);
  }

  process(x) {
    return this.lp14k.process(this.hp440.process(this.hp90.process(x)));
  }
}
