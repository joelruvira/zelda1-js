import { ApuStream } from './stream.js';

// AudioWorkletProcessor 'nes-apu'. Mensajes por MessagePort:
//   { type: 'frame', writes: Uint32Array, cycles }  lote de escrituras de un frame
//   { type: 'memory', bytes: Uint8Array, base }      copia de memoria de CPU para el DMC
//   { type: 'config', targetFrames, maxFrames }
//   { type: 'reset' }
// Responde { type: 'stats', buffered, underruns } cada ~0.5 s.

// Memoria de CPU visible para el DMC dentro del hilo de audio (copia de $8000-$FFFF).
export class MemoryWindow {
  constructor() {
    this.bytes = new Uint8Array(0);
    this.base = 0x8000;
  }

  set(bytes, base) {
    this.bytes = bytes;
    this.base = base;
  }

  read(addr) {
    const i = addr - this.base;
    return i >= 0 && i < this.bytes.length ? this.bytes[i] : 0;
  }
}

export function handleMessage(stream, memory, data) {
  switch (data.type) {
    case 'frame':
      stream.pushFrame(data.writes, data.cycles);
      break;
    case 'memory':
      memory.set(data.bytes, data.base);
      break;
    case 'config':
      if (data.targetFrames) stream.targetFrames = data.targetFrames;
      if (data.maxFrames) stream.maxFrames = data.maxFrames;
      break;
    case 'reset':
      stream.queue.length = 0;
      stream.current = null;
      stream.apu.reset();
      break;
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class NesApuProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const opts = options?.processorOptions ?? {};
      this.memory = new MemoryWindow();
      this.stream = new ApuStream({
        sampleRate,
        readMemory: (addr) => this.memory.read(addr),
        targetFrames: opts.targetFrames ?? 2,
        maxFrames: opts.maxFrames ?? 6,
      });
      this.statsCountdown = 0;
      this.port.onmessage = (e) => handleMessage(this.stream, this.memory, e.data);
    }

    process(_inputs, outputs) {
      const channels = outputs[0];
      if (!channels || channels.length === 0) return true;
      this.stream.render(channels[0]);
      for (let c = 1; c < channels.length; c++) channels[c].set(channels[0]);
      if (--this.statsCountdown <= 0) {
        this.statsCountdown = Math.round(sampleRate / 2 / channels[0].length);
        this.port.postMessage({
          type: 'stats',
          buffered: this.stream.bufferedCycles(),
          underruns: this.stream.underruns,
        });
      }
      return true;
    }
  }

  registerProcessor('nes-apu', NesApuProcessor);
}
