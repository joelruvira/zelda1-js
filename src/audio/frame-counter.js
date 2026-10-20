// Frame counter ($4017): secuenciador de 4 o 5 pasos que genera los clocks de quarter/half frame.
// Tiempos en ciclos de CPU desde el último reset (nesdev "APU Frame Counter", NTSC).
const STEP1 = 7457;
const STEP2 = 14913;
const STEP3 = 22371;
const STEP4 = 29829; // modo 4 pasos: quarter + half + IRQ
const PERIOD4 = 29830;
const STEP5 = 37281; // modo 5 pasos: quarter + half
const PERIOD5 = 37282;

export const QUARTER = 1;
export const HALF = 2;

export class FrameCounter {
  constructor() {
    this.reset();
  }

  reset() {
    this.cycle = 0;
    this.fiveStep = false;
    this.irqInhibit = false;
    this.irq = false;
    this.pendingReset = 0; // ciclos hasta que la escritura a $4017 surte efecto
  }

  // Escritura a $4017. `oddCycle`: paridad del ciclo de CPU en que ocurre la escritura.
  write(value, oddCycle) {
    this.fiveStep = (value & 0x80) !== 0;
    this.irqInhibit = (value & 0x40) !== 0;
    if (this.irqInhibit) this.irq = false;
    this.pendingReset = oddCycle ? 4 : 3;
  }

  // Avanza un ciclo de CPU; devuelve una máscara QUARTER|HALF con los clocks a emitir.
  step() {
    let clocks = 0;
    if (this.pendingReset > 0 && --this.pendingReset === 0) {
      this.cycle = 0;
      // Con el modo de 5 pasos, el reset genera inmediatamente quarter + half.
      return this.fiveStep ? QUARTER | HALF : 0;
    }
    const c = ++this.cycle;
    if (c === STEP1 || c === STEP3) clocks = QUARTER;
    else if (c === STEP2) clocks = QUARTER | HALF;
    else if (this.fiveStep) {
      if (c === STEP5) clocks = QUARTER | HALF;
      else if (c === PERIOD5) this.cycle = 0;
    } else {
      if (c === STEP4 - 1) this.raiseIrq();
      else if (c === STEP4) {
        clocks = QUARTER | HALF;
        this.raiseIrq();
      } else if (c === PERIOD4) {
        this.raiseIrq();
        this.cycle = 0;
      }
    }
    return clocks;
  }

  raiseIrq() {
    if (!this.irqInhibit) this.irq = true;
  }
}
