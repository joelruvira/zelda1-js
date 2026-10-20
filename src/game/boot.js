// Power-on path and video/RAM clearing helpers (Z_07, Z_05, Z_01, Z_06, Z_02). Package P01.
//   IsrReset -> RunGame -> InitSaveRam, ClearRam, ClearAllAudioAndVideo -> LoopForever

import { ram, cpu, peek, poke, word } from '../core/ram.js';
import { read, write, bus } from '../core/bus.js';
import { switchBank } from '../core/asm.js';
import { table } from '../core/rom.js';
import {
  InitializedGame, CurPpuControl_2000, CurPpuMask_2001, CurHScroll, CurVScroll, Sprites, DynTileBuf,
  SaveRamBegin, SaveRamEnd, IsSaveFileBCommitted, ReturnToBank4, TransferredCommonPatterns,
  TransferredDemoPatterns, _Unknown_F3, CurEdgeSpawnCell, Random, IsRegisterSaveFileOptionEnabled,
  IsEliminateSaveFileOptionEnabled, GameSubmode, RoomId,
} from '../core/vars.js';
import { CopyBlock } from './loaders/levelblocks.js';

// ------------------------------------------------------------------ reset

/**
 * Thrown after a `JMP IsrReset` made from inside the NMI (InitModeD with bad save RAM). In the original
 * IsrReset reloads the stack pointer and ends in LoopForever, so the interrupted IsrNmi never resumes
 * (no @EnableNMI, no RTI). The port unwinds the JS call stack the same way; IsrNmi catches it.
 */
export class IsrResetJump extends Error {
  name = 'IsrResetJump';
}

/** `JMP IsrReset` from game code running inside the NMI: reset, then abandon the current IsrNmi. */
export function JumpToIsrReset() {
  IsrReset();
  throw new IsrResetJump('JMP IsrReset');
}

export function IsrReset() {
  // IsrReset (Z_07)
  // SEI/CLD/TXS have no state in the port (the stack page is not compared).
  write(0x2000, 0x00);
  // The two "wait for VBLANK" loops (LDA $2002 / AND #$80 / BEQ) only burn time before the
  // first frame; the port runs reset before any frame, so only the exiting reads remain.
  read(0x2002);
  read(0x2002);
  let a = 0xff; // ORA #$FF
  write(0x8000, a); // reset all MMC1 shift registers
  write(0xa000, a);
  write(0xc000, a);
  write(0xe000, a);
  SetMMC1Control(0x0f);
  a = 0x00; // CHR RAM bank 0 for $0000
  for (let i = 0; i < 5; i++) { write(0xa000, a); a >>= 1; }
  SwitchBank(7);
  return RunGame();
}

/** SetMMC1Control (Z_07): five serial writes of A to $8000. Returns A (value >> 4). */
export function SetMMC1Control(a) {
  // SetMMC1Control (Z_07)
  a &= 0xff;
  write(0x8000, a);
  for (let i = 0; i < 4; i++) { a >>= 1; write(0x8000, a); }
  return a;
}

/** SetMMC1Control_Local5 (Z_05): bank-5 copy of SetMMC1Control. */
export function SetMMC1Control_Local5(a) {
  // SetMMC1Control_Local5 (Z_05)
  return SetMMC1Control(a);
}

/** SwitchBank (Z_07): returns A (bank >> 4). Same as core/asm.js switchBank. */
export function SwitchBank(a) {
  // SwitchBank (Z_07)
  return switchBank(a);
}

export function SwitchBank_Local1(a) {
  // SwitchBank_Local1 (Z_01): bank-1 copy of SwitchBank (unreferenced)
  return switchBank(a);
}

export function SwitchBank_Local2(a) {
  // SwitchBank_Local2 (Z_02): bank-2 copy of SwitchBank
  return switchBank(a);
}

export function SwitchBank_Local5(a) {
  // SwitchBank_Local5 (Z_05): bank-5 copy of SwitchBank
  return switchBank(a);
}

export function RunGame() {
  // RunGame (Z_07)
  ram[InitializedGame] = 0;
  switchBank(5);
  InitSaveRam();
  ClearRam();
  ClearAllAudioAndVideo();
  const a = ram[CurPpuControl_2000] | 0xa0; // enable NMI
  write(0x2000, a);
  ram[CurPpuControl_2000] = a;
  return LoopForever();
}

export function LoopForever() {
  // LoopForever (Z_07): JMP LoopForever. In the port every frame is one IsrNmi call
  // (core/loop.js runFrame), so the idle loop is simply "return to the caller".
}

// ------------------------------------------------------------------ RAM / SRAM

/** InitSaveRam (Z_05). @returns C: 1 if save RAM was cleared, 0 if already initialised (also in cpu.c). */
export function InitSaveRam() {
  // InitSaveRam (Z_05)
  if (peek(SaveRamBegin) === 0x5a && peek(SaveRamEnd) === 0xa5) {
    cpu.c = 0;
    return 0;
  }
  // Since we're clearing save RAM, treat file B as committed.
  poke(IsSaveFileBCommitted, 0xff);
  poke(IsSaveFileBCommitted + 1, 0xff);
  poke(IsSaveFileBCommitted + 2, 0xff);
  ram[0x01] = 0x65; // clear $6530 to the end of save RAM
  ram[0x00] = 0x30;
  do {
    write(word(0x00), 0x00); // STA ($00),Y with Y = 0
    cpu.c = 0;
    ram[0x00] = cpu.adc(ram[0x00], 1);
    ram[0x01] = cpu.adc(ram[0x01], 0);
  } while (ram[0x01] !== 0x80);
  cpu.c = 1;
  return 1;
}

export function ClearRam() {
  // ClearRam (Z_05)
  ClearRam0300UpTo(0x07, 0xfe); // doesn't touch [$07FF]
  ram[ReturnToBank4] = 0;
  ram[TransferredCommonPatterns] = 0;
  ram[TransferredDemoPatterns] = 0;
  ram[_Unknown_F3] = 0;
  for (let y = 0xef; y !== 0xff; y = (y - 1) & 0xff) ram[y] = 0; // $0000-$00EF
  ram[CurEdgeSpawnCell] = 0x40;
  ram[Random] = 0x40;
  ram[IsRegisterSaveFileOptionEnabled] = 0x01;
  ram[IsEliminateSaveFileOptionEnabled] = 0x01;
  return 0x01;
}

/**
 * ClearRam0300UpTo (Z_07): zeroes from byte Y of page A down to $0300, then DynTileBuf = $FF.
 * Leaves [$00] = 0, [$01] = 2.
 */
export function ClearRam0300UpTo(a, y) {
  // ClearRam0300UpTo (Z_07)
  ram[0x01] = a;
  ram[0x00] = 0x00;
  y &= 0xff;
  do {
    do {
      ram[(word(0x00) + y) & 0x7ff] = 0x00; // STA ($00),Y (RAM pages 3..7)
      y = (y - 1) & 0xff;
    } while (y !== 0xff);
    ram[0x01]--;
  } while (ram[0x01] >= 0x03);
  ram[DynTileBuf] = 0xff;
  return 0xff;
}

/** SplitRoomId (Z_05, unreferenced/unverified): Y = RoomId & $0F, X = RoomId >> 4, A = X. */
export function SplitRoomId() {
  // SplitRoomId (Z_05)
  const r = ram[RoomId];
  const y = r & 0x0f;
  const x = r >> 4;
  return { a: x, x, y };
}

/** CopyCommonCodeToRam (Z_01): copies BANK_01_CODE ($A500 in bank 1) to WRAM $6C90-$7EFF. */
export function CopyCommonCodeToRam() {
  // CopyCommonCodeToRam (Z_01)
  // Linker constants, immediates in the asm (SEGMENTS.BANK_01_CODE in core/symbols.js).
  const LOAD = 0xa500; // __BANK_01_CODE_LOAD__
  const RUN = 0x6c90; // __BANK_01_CODE_RUN__
  const end = 0x7f00; // __BANK_01_CODE_RUN_END__
  ram[0x00] = LOAD & 0xff;
  ram[0x01] = LOAD >> 8;
  ram[0x02] = RUN & 0xff;
  ram[0x03] = RUN >> 8;
  let a;
  do {
    write(word(0x02), read(word(0x00))); // LDA ($00),Y / STA ($02),Y with Y = 0
    cpu.c = 0;
    ram[0x00] = cpu.adc(ram[0x00], 1);
    ram[0x01] = cpu.adc(ram[0x01], 0);
    cpu.c = 0;
    ram[0x02] = cpu.adc(ram[0x02], 1);
    a = ram[0x03] = cpu.adc(ram[0x03], 0);
  } while (a !== (end >> 8) || ram[0x02] !== (end & 0xff));
  return ram[0x02];
}

/** CopyCommonDataToRam (Z_06): copies CommonDataBlock_Bank6 to WRAM $67F0-$687D. */
export function CopyCommonDataToRam() {
  // CopyCommonDataToRam (Z_06)
  const t = table(bus.rom, 'CommonDataBlockAddr_Bank6');
  ram[0x00] = t.byte(0);
  ram[0x01] = t.byte(1);
  FetchDestAddrForCommonDataBlock();
  CopyBlock();
  ram[GameSubmode] = 0;
  return 0;
}

export function FetchDestAddrForCommonDataBlock() {
  // FetchDestAddrForCommonDataBlock (Z_06): [$02:03] = $67F0, [$04:05] = $687D
  ram[0x02] = 0xf0;
  ram[0x03] = 0x67;
  ram[0x04] = 0x7d;
  ram[0x05] = 0x68;
  return 0x68;
}

// ------------------------------------------------------------------ video

export function ClearAllAudioAndVideo() {
  // ClearAllAudioAndVideo (Z_07)
  write(0x4011, 0x00);
  write(0x4015, 0x0f); // audio on except DMC
  write(0x2001, 0x06); // video off (clipping disabled)
  return TurnOffVideoAndClearArtifacts();
}

export function TurnOffVideoAndClearArtifacts() {
  // TurnOffVideoAndClearArtifacts (Z_07)
  HideAllSprites();
  ResetPpuRegisters();
  TurnOffAllVideo();
  ClearNameTableWithHiAddr(0x20);
  return ClearNameTableWithHiAddr(0x28); // LDA #$28, falls through
}

export function ClearNameTableWithHiAddr(a) {
  // ClearNameTableWithHiAddr (Z_07): tile $24, attribute 0
  return ClearNameTable(a, 0x24, 0x00);
}

export function ResetPpuRegisters() {
  // ResetPpuRegisters (Z_07)
  write(0x2005, 0x00);
  ram[CurHScroll] = 0x00;
  write(0x2005, 0x00);
  ram[CurVScroll] = 0x00;
  write(0x2000, 0x30);
  ram[CurPpuControl_2000] = 0x30;
  return 0x30;
}

/**
 * ClearNameTable (Z_07)
 * @param a hi byte of the nametable VRAM address  @param x tile  @param y attribute byte
 * @returns {{a:number,x:number,y:number}} X = passed X, Y = passed Y
 */
export function ClearNameTable(a, x, y) {
  // ClearNameTable (Z_07)
  ram[0x00] = a;
  ram[0x01] = x;
  ram[0x02] = y;
  read(0x2002);
  a = ram[CurPpuControl_2000] & 0xfb; // auto-increment by 1
  write(0x2000, a);
  ram[CurPpuControl_2000] = a;
  a = ram[0x00];
  write(0x2006, a);
  write(0x2006, 0x00);
  x = 0x04;
  if (a < 0x20) x = ram[0x02]; // unverified code 1E5B6
  y = 0x00;
  a = ram[0x01];
  do {
    do {
      write(0x2007, a);
      y = (y - 1) & 0xff;
    } while (y !== 0);
    x = (x - 1) & 0xff;
  } while (x !== 0);
  y = ram[0x02];
  a = ram[0x00];
  if (a >= 0x20) {
    a = (a + 0x02 + 1) & 0xff; // ADC #$02 with C = 1 from the CMP
    write(0x2006, a);
    a = 0xc0;
    write(0x2006, a);
    for (x = 0x40; x !== 0; x--) write(0x2007, y);
  }
  x = ram[0x01];
  return { a, x, y };
}

export function HideAllSprites() {
  // HideAllSprites (Z_07): every sprite's Y = $F8. Returns A = $F8 (X = Y = 0).
  for (let y = 0; y < 0x100; y += 4) ram[Sprites + y] = 0xf8;
  return 0xf8;
}

export function TurnOffAllVideo() {
  // TurnOffAllVideo (Z_07): returns A = 0
  write(0x2001, 0x00);
  ram[CurPpuMask_2001] = 0x00;
  return 0;
}
