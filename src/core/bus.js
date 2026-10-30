// CPU address space for literal translations: read(addr)/write(addr, v) route to RAM,
// PPU/APU/input registers, SRAM, the mapper and PRG ROM, exactly as on the NES.
// Ported code may use the named RAM arrays directly (faster); the bus is for
// ($zp),Y pointers, register writes and anything whose target is computed.

import { ram, sram } from './ram.js';
import { timing } from './timing.js';

export const bus = {
  rom: null, // Rom
  mapper: null, // Mmc1
  ppu: null, // Ppu
  input: null, // Input
  /** APU register sink (set by src/audio): (addr, value) => void */
  apuWrite: null,
  /** APU status read ($4015): () => value */
  apuRead: null,
};

/** Wire the machine parts together. */
export function connect(parts) {
  Object.assign(bus, parts);
  if (bus.mapper && bus.ppu) {
    bus.ppu.chrOffset = (a) => bus.mapper.chrOffset(a);
    bus.mapper.onMirroringChange = (m) => bus.ppu.setMirroring(m);
    bus.ppu.setMirroring(bus.mapper.mirroring);
  }
}

export function read(addr) {
  addr &= 0xffff;
  if (addr < 0x2000) return ram[addr & 0x7ff];
  // cycle tracker (core/timing.js): I/O reads are breadcrumbs; the PPU is moved to the access cycle
  if (addr < 0x4020 && timing.on) timing.io(addr, false, 0);
  if (addr < 0x4000) {
    switch (addr & 7) {
      case 2: return bus.ppu.readStatus();
      case 4: return bus.ppu.oam[bus.ppu.oamAddr];
      case 7: return bus.ppu.readData();
      default: return 0;
    }
  }
  if (addr === 0x4015) return bus.apuRead ? bus.apuRead() : 0;
  if (addr === 0x4016) return bus.input ? bus.input.read(0) : 0x40;
  if (addr === 0x4017) return bus.input ? bus.input.read(1) : 0x40;
  if (addr < 0x6000) return 0;
  if (addr < 0x8000) return sram[addr - 0x6000];
  return bus.rom.prgByte(bus.mapper.prgBankAt(addr), addr);
}

export function write(addr, value) {
  addr &= 0xffff;
  value &= 0xff;
  if (addr < 0x2000) { ram[addr & 0x7ff] = value; return; }
  // cycle tracker: I/O and mapper writes are breadcrumbs (the PPU is moved to the access cycle)
  let timed = false;
  if (addr < 0x4020 || addr >= 0x8000) {
    if (timing.on) timed = timing.io(addr, true, value) >= 0;
    else if (timing.enabled) timing.noteWrite(addr, value);
  }
  if (addr < 0x4000) {
    const p = bus.ppu;
    switch (addr & 7) {
      case 0: p.writePPUCTRL(value); break;
      case 1: p.writePPUMASK(value); break;
      case 3: p.writeOAMADDR(value); break;
      case 4: p.writeOAMDATA(value); break;
      case 5: p.writeScroll(value); break;
      case 6: p.writeAddr(value); break;
      case 7: p.writeData(value); break;
    }
    return;
  }
  if (addr === 0x4014) {
    bus.ppu.oamDMA(ram.subarray(value << 8, (value << 8) + 256));
    if (!timed) bus.ppu.cpuCycles(513); // the tracker counts 513/514 itself
    return;
  }
  if (addr === 0x4016) { bus.input?.write4016(value); return; }
  if (addr < 0x4018) { bus.apuWrite?.(addr, value); return; }
  if (addr < 0x6000) return;
  if (addr < 0x8000) { sram[addr - 0x6000] = value; return; }
  bus.mapper.write(addr, value);
}

/** 16-bit little-endian read through the bus. */
export function read16(addr) {
  return read(addr) | (read(addr + 1) << 8);
}
