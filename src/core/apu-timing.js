// DMC fetch calendar for the cycle tracker (docs/TIMING.md §3.3): when the DMC reads a sample byte the
// CPU is halted for a few cycles right after the current instruction. The tracker asks this model, per
// "APU call" (one per instruction, NMI sequence or halt chunk), whether a fetch happened.
//
// Two models:
//  * JsnesApuTiming: bit-exact copy of what jsnes 2.1.0 does (the CI oracle, "jsnes-compat" mode):
//    the APU is clocked once per instruction with its cycle count, channel ticks are deferred past the
//    next audio sample boundary (sampleTimer / extraCycles), the DMC timer counts in 1/8 cycles and every
//    fetch halts the CPU 4 cycles. Only the state that decides WHEN a fetch happens is modelled.
//  * HardwareApuTiming: the same calendar without jsnes' sample-boundary deferral (4-cycle halts; on
//    hardware a halt is 1-4 cycles depending on the cycle, see docs/TIMING.md §4: not modelled yet).
// Only CPU-visible registers drive it ($4010, $4013, $4015 writes; the tracker passes them in).

const CPU_FREQ_NTSC = 1789772.5; // jsnes constant
const SAMPLE_RATE = 48000; // jsnes default (the oracle does not change it)
// DMC timer periods in CPU cycles x 8 (jsnes dmcFreqLookup; NTSC rate table of the 2A03, not ROM data)
const DMC_FREQ = [0xd60, 0xbe0, 0xaa0, 0xa00, 0x8f0, 0x7f0, 0x710, 0x6b0, 0x5f0, 0x500, 0x470, 0x400, 0x350, 0x2a0, 0x240, 0x1b0];
const MODE_NORMAL = 0, MODE_LOOP = 1, MODE_IRQ = 2;

export class JsnesApuTiming {
  constructor({ deferToSamples = true } = {}) {
    this.deferToSamples = deferToSamples;
    this.sampleTimerMax = Math.floor((1024.0 * CPU_FREQ_NTSC) / SAMPLE_RATE);
    this.reset();
  }

  reset() {
    this.sampleTimer = 0;
    this.extraCycles = 0;
    // ChannelDM after papu.reset(): $4010=$10, $4011-$4013=0, channels disabled
    this.isEnabled = false;
    this.hasSample = false;
    this.playMode = MODE_NORMAL;
    this.dmaFrequency = DMC_FREQ[0];
    this.dmaCounter = 0;
    this.shiftCounter = 0;
    this.playLength = 1;
    this.playLengthCounter = 0;
    this.fetchesPending = 0; // fetches made by a register write (counted by the next call)
  }

  /** CPU write to an APU register (value matters only for the DMC). */
  write(addr, value) {
    if (addr === 0x4010) {
      this.playMode = value >> 6 === 0 ? MODE_NORMAL : ((value >> 6) & 1) === 1 ? MODE_LOOP : MODE_IRQ;
      this.dmaFrequency = DMC_FREQ[value & 0xf];
    } else if (addr === 0x4013) {
      this.playLength = (value << 4) + 1;
    } else if (addr === 0x4015) {
      this.isEnabled = (value & 0x10) !== 0;
      if (!this.isEnabled) this.playLengthCounter = 0;
      else if (this.playLengthCounter === 0) {
        this.playLengthCounter = this.playLength;
        if (!this.hasSample && this.playLengthCounter > 0) {
          this.fetch(); // immediate DMA fetch on enable (halt after this instruction)
          this.dmaCounter = 8;
          this.shiftCounter = this.dmaFrequency;
        }
      }
    }
  }

  fetch() {
    this.fetchesPending++;
    this.playLengthCounter--;
    this.hasSample = true;
  }

  clockDmc() {
    this.dmaCounter--;
    if (this.dmaCounter <= 0) {
      this.hasSample = false;
      if (this.playLengthCounter === 0 && this.playMode === MODE_LOOP) this.playLengthCounter = this.playLength;
      if (this.playLengthCounter > 0) this.fetch();
      this.dmaCounter = 8;
    }
  }

  /** True when the DMC can fetch again without a new $4015 write (a sample is playing). */
  get active() {
    return this.isEnabled && (this.playLengthCounter > 0 || this.playMode === MODE_LOOP || this.hasSample);
  }

  /**
   * One papu.clockFrameCounter(n) call (after an instruction, the NMI sequence or a halt chunk).
   * Returns the number of DMC fetches (each halts the CPU 4 cycles after this call).
   */
  call(n) {
    if (this.deferToSamples) {
      n += this.extraCycles;
      const maxCycles = this.sampleTimerMax - this.sampleTimer;
      if ((n << 10) > maxCycles) {
        this.extraCycles = ((n << 10) - maxCycles) >> 10;
        n -= this.extraCycles;
      } else this.extraCycles = 0;
    }
    if (this.isEnabled) {
      this.shiftCounter -= n << 3;
      while (this.shiftCounter <= 0 && this.dmaFrequency > 0) {
        this.shiftCounter += this.dmaFrequency;
        this.clockDmc();
      }
    }
    if (this.deferToSamples) {
      this.sampleTimer += n << 10;
      if (this.sampleTimer >= this.sampleTimerMax) this.sampleTimer -= this.sampleTimerMax;
    }
    const f = this.fetchesPending;
    this.fetchesPending = 0;
    return f;
  }

  /**
   * Cycles that can be clocked as one block (many calls) without any fetch: a lower bound of the
   * distance to the next fetch. Infinity when no sample is playing.
   */
  safeCycles() {
    if (!this.isEnabled) return Infinity;
    if (!this.active) return Infinity;
    const period = this.dmaFrequency >> 3;
    // clocks until dmaCounter reaches 0: dmaCounter clocks; the first after ceil(shiftCounter/8) cycles
    const first = Math.max(0, Math.ceil(this.shiftCounter / 8));
    return first + (this.dmaCounter - 1) * period - 16; // margin for the per-call deferral (< 15 cycles)
  }

  /**
   * Clocks `total` cycles made of many calls whose exact boundaries do not matter (no fetch can happen,
   * see safeCycles): only the sample timer phase and the DMC counters advance. `last` is the size of
   * the final call, which is done exactly (it may end on a sample boundary).
   */
  bulk(total, last) {
    const n = total - last;
    if (n > 0) {
      let consumed = n;
      if (this.deferToSamples) {
        // all n cycles (plus the deferral pending from the previous call) are consumed by the end of the
        // block; walk the sample boundaries they cross
        consumed = n + this.extraCycles;
        this.extraCycles = 0;
        let c = consumed, t = this.sampleTimer;
        const max = this.sampleTimerMax;
        for (;;) {
          const need = Math.ceil((max - t) / 1024);
          if (c < need) { t += c << 10; break; }
          c -= need;
          t = t + (need << 10) - max;
        }
        this.sampleTimer = t;
      }
      if (this.isEnabled) {
        this.shiftCounter -= consumed << 3;
        while (this.shiftCounter <= 0 && this.dmaFrequency > 0) {
          this.shiftCounter += this.dmaFrequency;
          this.clockDmc();
        }
        if (this.fetchesPending) throw new Error('apu-timing: bulk() crossed a DMC fetch (safeCycles violated)');
      }
    }
    return last > 0 ? this.call(last) : 0;
  }

  snapshot() {
    return { ...this };
  }

  restore(s) {
    Object.assign(this, s);
  }
}

export class HardwareApuTiming extends JsnesApuTiming {
  constructor() { super({ deferToSamples: false }); }
}
