// CHR-RAM pattern block transfers (Z_01, Z_02, Z_03). Package P03.
//   InitMode0 -> TransferCommonPatterns (bank 2), TransferDemoPatterns (bank 1)
//   InitMode2 -> TransferLevelPatternBlocks (bank 3)
// The sources are pattern blocks in the banked ROM, read through the bus ("LDA ($00), Y") with the bank
// the caller mapped, exactly like the original.

import { ram, cpu, word } from '../../core/ram.js';
import { read, write, bus } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { PatternBlockIndex, TransferredDemoPatterns, TransferredCommonPatterns, CurLevel } from '../../core/vars.js';
import { TurnOffAllVideo } from '../boot.js';
import { $br, $pxa } from '../../core/timing.js';

/**
 * Shared body of TransferPatternBlock_Bank1/2/3 (@Loop): copy [$03:02] bytes from [$00:01] to PpuData,
 * updating the temporaries byte by byte like the 6502 loop, then INC PatternBlockIndex.
 */
function copyPatternBytes(pxRef, br1, br2) {
  const y = 0x00;
  for (;;) {
    $pxa(pxRef, word(0x00), y);
    write(0x2007, read((word(0x00) + y) & 0xffff)); // LDA ($00), Y / STA PpuData_2007
    // Increment the 16-bit source address at [00:01].
    cpu.c = 0;
    ram[0x00] = cpu.adc(ram[0x00], 0x01);
    ram[0x01] = cpu.adc(ram[0x01], 0x00);
    // Decrement the 16-bit amount at [03:02].
    cpu.c = 1;
    ram[0x03] = cpu.sbc(ram[0x03], 0x01);
    ram[0x02] = cpu.sbc(ram[0x02], 0x00);
    if ($br(br1, ram[0x02] !== 0)) continue;
    if (!$br(br2, ram[0x03] !== 0)) break;
  }
  ram[PatternBlockIndex]++;
}

// ------------------------------------------------------------------ bank 1 (demo)

export function TransferDemoPatterns() {
  // TransferDemoPatterns (Z_01)
  TurnOffAllVideo();
  read(0x2002); // clear address latch
  const addrs = table(bus.rom, 'DemoPatternBlockAddrs');
  const sizes = table(bus.rom, 'DemoPatternBlockSizes');
  const vram = table(bus.rom, 'DemoPatternVramAddrs');
  for (;;) {
    // Put block address in [00:01] and size in [03:02]; the size and VRAM address are high byte first.
    let x = (ram[PatternBlockIndex] << 1) & 0xff;
    $pxa('Z_01:1633', addrs.addr, x); ram[0x00] = addrs.byte(x);
    $pxa('Z_01:1635', sizes.addr, x); ram[0x02] = sizes.byte(x);
    $pxa('Z_01:1637', vram.addr, x); write(0x2006, vram.byte(x));
    x = (x + 1) & 0xff;
    $pxa('Z_01:1640', addrs.addr, x); ram[0x01] = addrs.byte(x);
    $pxa('Z_01:1642', sizes.addr, x); ram[0x03] = sizes.byte(x);
    $pxa('Z_01:1644', vram.addr, x);
    TransferPatternBlock_Bank1(vram.byte(x));
    if (!$br('Z_01:1650', ram[PatternBlockIndex] !== 0x02)) break;
  }
  ram[TransferredDemoPatterns] = 0xa5;
  ram[PatternBlockIndex] = 0x00;
  return 0x00;
}

/** TransferPatternBlock_Bank1 (Z_01). [00:01] source, [03:02] size, A = low byte of the VRAM address. */
export function TransferPatternBlock_Bank1(a) {
  // TransferPatternBlock_Bank1 (Z_01)
  write(0x2006, a);
  copyPatternBytes('Z_01:1668', 'Z_01:1691', 'Z_01:1693');
}

// ------------------------------------------------------------------ bank 2 (common)

export function TransferCommonPatterns() {
  // TransferCommonPatterns (Z_02)
  TurnOffAllVideo();
  read(0x2002); // clear address latch and scroll
  const addrs = table(bus.rom, 'CommonPatternBlockAddrs');
  const sizes = table(bus.rom, 'CommonPatternBlockSizes');
  const vram = table(bus.rom, 'CommonPatternVramAddrs');
  for (;;) {
    let x = (ram[PatternBlockIndex] << 1) & 0xff;
    ram[0x00] = addrs.byte(x);
    $pxa('Z_02:84', sizes.addr, x); ram[0x02] = sizes.byte(x);
    $pxa('Z_02:86', vram.addr, x); write(0x2006, vram.byte(x));
    x = (x + 1) & 0xff;
    ram[0x01] = addrs.byte(x);
    $pxa('Z_02:91', sizes.addr, x); ram[0x03] = sizes.byte(x);
    $pxa('Z_02:93', vram.addr, x);
    TransferPatternBlock_Bank2(vram.byte(x));
    if (!$br('Z_02:99', ram[PatternBlockIndex] !== 0x03)) break;
  }
  ram[TransferredCommonPatterns] = 0x5a; // mark this block copied
  ram[PatternBlockIndex] = 0x00; // reset pattern block index
  return 0x00;
}

/** TransferPatternBlock_Bank2 (Z_02). [00:01] source, [03:02] size, A = low byte of the VRAM address. */
export function TransferPatternBlock_Bank2(a) {
  // TransferPatternBlock_Bank2 (Z_02)
  write(0x2006, a);
  copyPatternBytes('Z_02:117', 'Z_02:140', 'Z_02:142');
}

// ------------------------------------------------------------------ bank 3 (level)

export function TransferLevelPatternBlocks() {
  // TransferLevelPatternBlocks (Z_03)
  TurnOffAllVideo();
  read(0x2002);
  ResetPatternBlockIndex();
  if ($br('Z_03:68', ram[CurLevel] !== 0)) return TransferLevelPatternBlocksUW();
  for (;;) {
    // @LoopBlockOW: there are two blocks.
    FetchPatternBlockInfoOW();
    TransferPatternBlock_Bank3();
    if (!$br('Z_03:75', ram[PatternBlockIndex] !== 0x02)) break;
  }
  return ResetPatternBlockIndex(); // falls through
}

/** ResetPatternBlockIndex (Z_03). Returns A = 0. */
export function ResetPatternBlockIndex() {
  // ResetPatternBlockIndex (Z_03)
  ram[PatternBlockIndex] = 0x00;
  return 0x00;
}

export function TransferLevelPatternBlocksUW() {
  // TransferLevelPatternBlocksUW (Z_03)
  for (;;) {
    FetchPatternBlockAddrUW();
    FetchPatternBlockSizeUW(); // falls through into TransferPatternBlock_Bank3
    if (!$br('Z_03:87', ram[PatternBlockIndex] !== 0x02)) break;
  }
  // Two common blocks (BG and sprites) are done; now the level's special and boss sprite patterns.
  FetchPatternBlockAddrUWSpecial();
  FetchPatternBlockSizeUW();
  FetchPatternBlockUWBoss();
  FetchPatternBlockSizeUW();
  return ResetPatternBlockIndex();
}

export function FetchPatternBlockAddrUW() {
  // FetchPatternBlockAddrUW (Z_03): [$00:01] = PatternBlockSrcAddrsUW[PatternBlockIndex]
  const t = table(bus.rom, 'PatternBlockSrcAddrsUW');
  let x = (ram[PatternBlockIndex] << 1) & 0xff;
  $pxa('Z_03:102', t.addr, x); ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  $pxa('Z_03:105', t.addr, x);
  const a = ram[0x01] = t.byte(x);
  return a;
}

/** FetchPatternBlockInfoOW (Z_03): [$00:01] source address, [$03:02] size. */
export function FetchPatternBlockInfoOW() {
  // FetchPatternBlockInfoOW (Z_03)
  const src = table(bus.rom, 'PatternBlockSrcAddrsOW');
  const sizes = table(bus.rom, 'PatternBlockSizesOW');
  let x = (ram[PatternBlockIndex] << 1) & 0xff;
  $pxa('Z_03:117', src.addr, x); ram[0x00] = src.byte(x);
  $pxa('Z_03:119', sizes.addr, x); ram[0x02] = sizes.byte(x);
  x = (x + 1) & 0xff;
  $pxa('Z_03:122', src.addr, x); ram[0x01] = src.byte(x);
  $pxa('Z_03:124', sizes.addr, x);
  const a = ram[0x03] = sizes.byte(x);
  return a;
}

export function FetchPatternBlockAddrUWSpecial() {
  // FetchPatternBlockAddrUWSpecial (Z_03): [$00:01] = LevelPatternBlockSrcAddrs[CurLevel]
  const t = table(bus.rom, 'LevelPatternBlockSrcAddrs');
  let x = (ram[CurLevel] << 1) & 0xff;
  ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  
  const a = ram[0x01] = t.byte(x);
  return a;
}

export function FetchPatternBlockUWBoss() {
  // FetchPatternBlockUWBoss (Z_03): [$00:01] = BossPatternBlockSrcAddrs[CurLevel]
  const t = table(bus.rom, 'BossPatternBlockSrcAddrs');
  let x = (ram[CurLevel] << 1) & 0xff;
  $pxa('Z_03:143', t.addr, x); ram[0x00] = t.byte(x);
  x = (x + 1) & 0xff;
  $pxa('Z_03:146', t.addr, x);
  const a = ram[0x01] = t.byte(x);
  return a;
}

export function FetchPatternBlockSizeUW() {
  // FetchPatternBlockSizeUW (Z_03): [$03:02] = PatternBlockSizesUW[PatternBlockIndex]; falls through
  const t = table(bus.rom, 'PatternBlockSizesUW');
  let x = (ram[PatternBlockIndex] << 1) & 0xff;
  $pxa('Z_03:154', t.addr, x); ram[0x02] = t.byte(x);
  x = (x + 1) & 0xff;
  $pxa('Z_03:157', t.addr, x); ram[0x03] = t.byte(x);
  return TransferPatternBlock_Bank3();
}

/**
 * TransferPatternBlock_Bank3 (Z_03): [$00:01] source, [$03:02] size; the destination PPU address is
 * PatternBlockPpuAddrs[PatternBlockIndex] (indices 2-3 read on into PatternBlockPpuAddrsExtra).
 */
export function TransferPatternBlock_Bank3() {
  // TransferPatternBlock_Bank3 (Z_03)
  const t = table(bus.rom, 'PatternBlockPpuAddrs');
  let x = (ram[PatternBlockIndex] << 1) & 0xff;
  $pxa('Z_03:170', t.addr, x); write(0x2006, t.byte(x));
  x = (x + 1) & 0xff;
  $pxa('Z_03:173', t.addr, x); write(0x2006, t.byte(x));
  copyPatternBytes('Z_03:178', 'Z_03:201', 'Z_03:203');
}
