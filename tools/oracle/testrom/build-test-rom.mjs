// Builds a synthetic MMC1 + CHR-RAM test ROM shaped like Zelda's board (SNROM-like,
// 8x16KB PRG, battery SRAM). It contains no Nintendo data. It exercises the features
// the oracle needs from the emulator:
//  - MMC1 serial writes, 16KB PRG switching at $8000, fixed last bank at $C000
//  - code executed from SRAM ($6000) and SRAM writes
//  - CHR-RAM uploads through $2006/$2007
//  - a Zelda-like NMI that waits for sprite 0 hit and reads the controller like ReadInputs
//
// RAM results: $0300 = bank marker read from bank 3 ($03), $0301 = 1 (SRAM routine ran),
// $0302 = sprite 0 hits seen, $0303 = controller byte (A=$80 .. Right=$01), $0304 = NMI count.
// SRAM $7000 = NMI count.
import { assemble } from './mini-asm.mjs';

export const TEST_ROM_SOURCE = `
.org $C000
reset:
  SEI
  CLD
  LDA #$00
  STA $2000
  LDX #$FF
  TXS
vb1:
  LDA $2002
  BPL vb1
vb2:
  LDA $2002
  BPL vb2
  LDA #$80
  STA $8000
  LDA #$0F
  JSR mmc1ctrl
  LDA #$03
  JSR switchbank
  LDA $8000
  STA $0300
  LDA #$EE           ; SRAM routine: INC $0301 / RTS
  STA $6000
  LDA #$01
  STA $6001
  LDA #$03
  STA $6002
  LDA #$60
  STA $6003
  JSR $6000
  LDA #$00           ; CHR-RAM tile 0: solid color 1
  STA $2006
  STA $2006
  LDX #$08
  LDA #$FF
chr0:
  STA $2007
  DEX
  BNE chr0
  LDX #$08
  LDA #$00
chr1:
  STA $2007
  DEX
  BNE chr1
  LDA #$20           ; clear name table 0 + attributes
  STA $2006
  LDA #$00
  STA $2006
  LDY #$04
ntOuter:
  LDX #$00
ntInner:
  STA $2007
  INX
  BNE ntInner
  DEY
  BNE ntOuter
  LDA #$3F           ; palettes
  STA $2006
  LDA #$00
  STA $2006
  LDA #$0F
  STA $2007
  LDA #$30
  STA $2007
  LDA #$3F
  STA $2006
  LDA #$11
  STA $2006
  LDA #$16
  STA $2007
  LDA #$3F           ; sprite 0 at (64, 64)
  STA $0200
  LDA #$00
  STA $0201
  STA $0202
  LDA #$40
  STA $0203
  LDX #$04
  LDA #$F8
hide:
  STA $0200,X
  INX
  BNE hide
  LDA #$1E
  STA $2001
  LDA #$80
  STA $2000
forever:
  JMP forever

nmi:
  LDA #$02
  STA $4014
  LDA #$00
  STA $2005
  STA $2005
waitClear:
  BIT $2002
  BVS waitClear
waitHit:
  BIT $2002
  BVC waitHit
  INC $0302
  LDA #$01
  STA $4016
  LDA #$00
  STA $4016
  LDX #$08
readPad:
  LDA $4016
  LSR A
  ROL $0303
  DEX
  BNE readPad
  INC $0304
  LDA $0304
  STA $7000
  RTI

mmc1ctrl:
  STA $8000
  LSR A
  STA $8000
  LSR A
  STA $8000
  LSR A
  STA $8000
  LSR A
  STA $8000
  RTS

switchbank:
  STA $E000
  LSR A
  STA $E000
  LSR A
  STA $E000
  LSR A
  STA $E000
  LSR A
  STA $E000
  RTS

.org $FFFA
  .word nmi,reset,reset
`;

export function buildTestRom() {
  const { bytes } = assemble(TEST_ROM_SOURCE);
  const rom = new Uint8Array(16 + 8 * 0x4000).fill(0xff);
  rom.set([0x4e, 0x45, 0x53, 0x1a, 8, 0, 0x12, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (let bank = 0; bank < 7; bank++) rom[16 + bank * 0x4000] = bank;
  for (const [addr, value] of bytes) rom[16 + 7 * 0x4000 + (addr - 0xc000)] = value;
  return rom;
}
