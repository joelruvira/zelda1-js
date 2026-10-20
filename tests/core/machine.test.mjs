import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mmc1, MIRROR_VERTICAL, MIRROR_HORIZONTAL } from '../../src/core/mapper.js';
import { Input, BTN } from '../../src/core/input.js';
import { ram, sram, cpu, word, setWord, peek, poke } from '../../src/core/ram.js';
import { createMachine } from '../../src/core/machine.js';
import { read, write } from '../../src/core/bus.js';
import { createLoop, FRAME_MS } from '../../src/core/loop.js';
import { loadSram, saveSram, createAutoSaver } from '../../src/core/savestore.js';
import { loadRom } from '../../src/core/rom.js';
import { syntheticRom } from './helpers.mjs';

const serial = (m, addr, value) => { for (let i = 0; i < 5; i++) m.write(addr, (value >> i) & 1); };

test('MMC1 serial writes: control/mirroring, PRG bank, reset bit', () => {
  const m = new Mmc1();
  const seen = [];
  m.onMirroringChange = (x) => seen.push(x);
  serial(m, 0x8000, 0x0e); // SetMMC1Control with vertical mirroring
  assert.equal(m.mirroring, MIRROR_VERTICAL);
  serial(m, 0x8000, 0x0f);
  assert.equal(m.mirroring, MIRROR_HORIZONTAL);
  assert.deepEqual(seen, [MIRROR_VERTICAL, MIRROR_HORIZONTAL]);
  serial(m, 0xe000, 5); // SwitchBank 5
  assert.equal(m.prgBankAt(0x8000), 5);
  assert.equal(m.prgBankAt(0xc000), 7);
  m.write(0x8000, 1); m.write(0x8000, 0x80); // reset mid-sequence
  assert.equal(m.shift, 0x10);
  assert.equal(m.chrOffset(0x1abc), 0x1abc);
});

test('bus routes RAM mirrors, SRAM, PRG with the switched bank, PPU and mapper', () => {
  const mc = createMachine(loadRom(syntheticRom({ fill: (b) => b })));
  write(0x0805, 0x42);
  assert.equal(ram[5], 0x42);
  write(0x6001, 9);
  assert.equal(sram[1], 9);
  for (let i = 0; i < 5; i++) write(0xe000, (3 >> i) & 1);
  assert.equal(read(0x8000), 3);
  assert.equal(read(0xc000), 7);
  write(0x2006, 0x21); write(0x2006, 0x00); write(0x2007, 0x99);
  assert.equal(mc.ppu.peek(0x2100), 0x99);
  for (let i = 0; i < 0x100; i++) ram[0x200 + i] = i;
  write(0x4014, 0x02);
  assert.equal(mc.ppu.oam[0x80], 0x80);
  // Mirroring from the mapper reaches the PPU.
  for (let i = 0; i < 5; i++) write(0x8000, (0x0e >> i) & 1);
  assert.equal(mc.ppu.mirroring, MIRROR_VERTICAL);
});

test('controller protocol matches ReadOneController bit order', () => {
  const input = new Input();
  input.getGamepads = () => [];
  input.key('KeyX', true); // A
  input.key('ArrowLeft', true);
  input.write4016(1); input.write4016(0);
  let byte = 0;
  for (let i = 0; i < 8; i++) byte = (byte << 1) | (input.read(0) & 1);
  assert.equal(byte, BTN.A | BTN.LEFT);
  input.setOverride(1, BTN.UP | BTN.A);
  input.write4016(1); input.write4016(0);
  byte = 0;
  for (let i = 0; i < 8; i++) byte = (byte << 1) | (input.read(1) & 1);
  assert.equal(byte, 0x88);
  input.key('KeyM', true);
  assert.equal(input.read(0) & 0x04, 0x04);
});

test('CPU-lite flags: ADC/SBC carry and overflow, ROL/ROR through carry, stack', () => {
  cpu.reset();
  cpu.c = 0;
  assert.equal(cpu.adc(0xff, 0x01), 0x00);
  assert.equal(cpu.c, 1); assert.equal(cpu.z, 1);
  assert.equal(cpu.adc(0x7f, 0x00), 0x80); // + carry
  assert.equal(cpu.v, 1); assert.equal(cpu.n, 1);
  cpu.c = 1;
  assert.equal(cpu.sbc(0x00, 0x01), 0xff);
  assert.equal(cpu.c, 0);
  cpu.c = 1;
  assert.equal(cpu.ror(0x02), 0x81);
  assert.equal(cpu.c, 0);
  assert.equal(cpu.rol(0x80), 0x00);
  assert.equal(cpu.c, 1);
  cpu.cmp(5, 5); assert.equal(cpu.c, 1); assert.equal(cpu.z, 1);
  cpu.push(0xab); cpu.php();
  cpu.c = 0; cpu.plp();
  assert.equal(cpu.c, 1);
  assert.equal(cpu.pull(), 0xab);
  setWord(0x00, 0x1234);
  assert.equal(word(0x00), 0x1234);
  poke(0x6005, 7); assert.equal(peek(0x6005), 7);
});

test('loop runs 60.0988 frames per second regardless of wakeup rate', () => {
  let t = 0;
  let frames = 0;
  const loop = createLoop({ frame: () => frames++, now: () => t, schedule: () => {} });
  loop.start();
  for (let i = 0; i < 1440; i++) { t += 1000 / 144; loop.tick(); } // 10 s at 144 Hz
  assert.ok(Math.abs(frames - 601) <= 1, `frames=${frames}`);
  t += 10000; // a long stall only catches up a few frames
  assert.ok(loop.tick() <= 4);
  assert.ok(FRAME_MS > 16.6 && FRAME_MS < 16.7);
});

test('SRAM persistence round-trips and tolerates missing storage', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const a = new Uint8Array(0x2000); a[0x10] = 0x5a; a[0x1fff] = 1;
  assert.equal(saveSram(a, { storage }), true);
  const b = new Uint8Array(0x2000);
  assert.equal(loadSram(b, { storage }), true);
  assert.deepEqual(b, a);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadSram(b, { storage: broken }), false);
  assert.equal(saveSram(b, { storage: broken }), false);
  const auto = createAutoSaver(a, { storage });
  assert.equal(auto(), false);
  a[3] = 3;
  assert.equal(auto(), true);
});
