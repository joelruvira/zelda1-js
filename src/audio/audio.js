import { ApuStream, packWrite } from './stream.js';
import { FRAME_CYCLES } from './tables.js';
import { MemoryWindow, handleMessage } from './worklet.js';

// Separación por defecto (ciclos de CPU) entre escrituras sin timestamp explícito: ~LDA+STA.
const DEFAULT_WRITE_SPACING = 4;
const MAX_WRITES_PER_FRAME = 1024;

// Fachada de audio para el juego.
//   const audio = new NesAudio();
//   audio.setReadMemory((addr) => read(addr));          // para el DMC (read de src/core/bus.js)
//   button.onclick = () => audio.init();                  // tras un gesto del usuario
//   cada frame: audio.writeRegister(addr, value[, ciclo]); ... audio.endFrame();
// Antes de init() las escrituras se descartan (no hay AudioContext).
export class NesAudio {
  constructor({ targetFrames = 2, maxFrames = 6, sampleRate } = {}) {
    this.targetFrames = targetFrames;
    this.maxFrames = maxFrames;
    this.sampleRate = sampleRate;
    this.context = null;
    this.node = null;
    this.gain = null;
    this.stream = null; // solo en el modo ScriptProcessor
    this.memory = new MemoryWindow();
    this.readMemory = null;
    this.writes = new Uint32Array(MAX_WRITES_PER_FRAME);
    this.writeCount = 0;
    this.cursor = 0;
    this.frameFraction = 0;
    this.stats = { buffered: 0, underruns: 0 };
  }

  get ready() {
    return this.node !== null;
  }

  // Debe llamarse desde un gesto del usuario (click/tecla) por la política de autoplay.
  async init() {
    if (this.context) {
      await this.context.resume();
      return;
    }
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    const options = { latencyHint: 'interactive' };
    if (this.sampleRate) options.sampleRate = this.sampleRate;
    this.context = new Ctx(options);
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    if (this.context.audioWorklet) {
      try {
        await this.initWorklet();
      } catch (err) {
        console.warn('AudioWorklet no disponible, uso ScriptProcessor', err);
        this.initScriptProcessor();
      }
    } else {
      this.initScriptProcessor();
    }
    this.sendMemory();
    await this.context.resume();
  }

  async initWorklet() {
    await this.context.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.context, 'nes-apu', {
      numberOfInputs: 0,
      outputChannelCount: [1],
      processorOptions: { targetFrames: this.targetFrames, maxFrames: this.maxFrames },
    });
    this.node.port.onmessage = (e) => {
      if (e.data.type === 'stats') this.stats = e.data;
    };
    this.node.connect(this.gain);
  }

  initScriptProcessor() {
    this.stream = new ApuStream({
      sampleRate: this.context.sampleRate,
      readMemory: (addr) => (this.readMemory ? this.readMemory(addr) : this.memory.read(addr)),
      targetFrames: this.targetFrames,
      maxFrames: this.maxFrames,
    });
    const node = this.context.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = (e) => {
      this.stream.render(e.outputBuffer.getChannelData(0));
      this.stats = { buffered: this.stream.bufferedCycles(), underruns: this.stream.underruns };
    };
    node.connect(this.gain);
    this.node = node;
  }

  // Conecta el DMC a la memoria de CPU. En modo AudioWorklet se envía una copia de
  // $8000-$FFFF (Zelda solo usa samples del banco fijo $C000+); volver a llamar si cambia.
  setReadMemory(readMemory) {
    this.readMemory = readMemory;
    this.sendMemory();
  }

  sendMemory() {
    if (!this.readMemory) return;
    const bytes = new Uint8Array(0x8000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = this.readMemory(0x8000 + i) & 0xff;
    this.memory.set(bytes, 0x8000);
    this.post({ type: 'memory', bytes, base: 0x8000 });
  }

  post(message, transfer) {
    if (this.node?.port) this.node.port.postMessage(message, transfer ?? []);
    else if (this.stream) handleMessage(this.stream, this.memory, message);
  }

  // Escritura a un registro $4000-$4017. `cycle`: ciclo de CPU dentro del frame (opcional).
  writeRegister(addr, value, cycle) {
    if (addr < 0x4000 || addr > 0x4017 || addr === 0x4014 || addr === 0x4016) return;
    if (this.writeCount === this.writes.length) return;
    const c = Math.max(cycle ?? this.cursor, this.cursor);
    this.writes[this.writeCount++] = packWrite(c, addr, value);
    this.cursor = c + DEFAULT_WRITE_SPACING;
  }

  // Cierra el frame actual (llamar una vez por frame de vídeo, 60.0988 Hz) y lo envía al APU.
  endFrame() {
    this.frameFraction += FRAME_CYCLES;
    const cycles = Math.floor(this.frameFraction);
    this.frameFraction -= cycles;
    const writes = this.writes.slice(0, this.writeCount);
    this.writeCount = 0;
    this.cursor = 0;
    if (!this.node) return;
    this.post({ type: 'frame', writes, cycles }, [writes.buffer]);
  }

  // Frames de audio en cola (para que el bucle principal pueda medir la latencia).
  get bufferedFrames() {
    return this.stats.buffered / FRAME_CYCLES;
  }

  setVolume(v) {
    if (this.gain) this.gain.gain.value = v;
  }

  async suspend() {
    await this.context?.suspend();
  }

  async resume() {
    await this.context?.resume();
  }
}
