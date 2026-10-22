// Drawing UW doors: copying the door face tiles for each direction, type and state to the play
// area map, and the horizontal reading of door faces for nametable transfers. Package P12, bank 5.

import { ram, cpu, word } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table } from '../../core/rom.js';
import { CurOpenedDoors, DynTileBuf } from '../../core/vars.js';
import { AddToInt16At0, Add1ToInt16At0, AddToInt16At2, Add1ToInt16At2 } from '../util/int16.js';
import { FindDoorTypeByDoorBit, CalcOpenDoorwayMask, SetDoorFlag } from './doors.js';

/**
 * WriteDoorFaceTileHorizontally (Z_05): X = DynTileBuf offset; [$02:03] door face tiles,
 * [$04] tiles remaining, [$07] tile index (0-3), [$09] door direction index.
 * @returns X + 1; cpu.z = 1 if [$04] became 0 (Z after DEC $04)
 */
export function WriteDoorFaceTileHorizontally(x) {
  // WriteDoorFaceTileHorizontally (Z_05)
  let y = ram[0x09];
  let a = table(bus.rom, 'HorizontalDoorFaceIndexesBaseOffsets').byte(y);
  a = (a + ram[0x07]) & 0xff; // CLC / ADC $07
  y = table(bus.rom, 'HorizontalDoorFaceIndexes').byte(a);
  ram[DynTileBuf + x] = read(word(0x02) + y);
  x = (x + 1) & 0xff;
  ram[0x07]++;
  ram[0x04] = cpu.nz(ram[0x04] - 1);
  return x;
}

/** LayOutDoors (Z_05): door faces of the 4 doors into the play area map; falls into the loop. */
export function LayOutDoors() {
  // LayOutDoors (Z_05)
  return L_LayOutDoors_LoopDoors(0x03);
}

/**
 * L_LayOutDoors_LoopDoors (Z_05): X = door (direction) index, from X down to 0.
 * Clears from CurOpenedDoors the doorways that are not true doors, sets door flags of opened
 * doors, builds OpenDoorwayMask (CalcOpenDoorwayMask) and copies the door face tiles.
 */
export function L_LayOutDoors_LoopDoors(x) {
  // L_LayOutDoors_LoopDoors (Z_05)
  const doorBits = table(bus.rom, 'DoorBits');
  const secondHalf = table(bus.rom, 'DirIndexToDoorSecondHalfOffsets');
  const colCount = table(bus.rom, 'DirIndexToDoorColumnCount');
  const rowCount = table(bus.rom, 'DirIndexToDoorRowCountMinusOne');
  const nextTile = table(bus.rom, 'NextDoorTileOffsets');
  for (;;) {
    ram[0x06] = 0x01;
    for (;;) {
      // L_LayOutDoors_LoopHalves
      const dir = x; // PHA: direction index
      ram[0x0b] = x;
      ram[0x02] = doorBits.byte(x);
      let a = FindDoorTypeByDoorBit();
      if (a >= 0x05) {
        // provisional face = door type
      } else if (a === 0x04) {
        a = 0x08;
      } else {
        // @ClearFromOpenedMask
        ram[CurOpenedDoors] = (ram[0x02] ^ 0xff) & ram[CurOpenedDoors];
        if (a < 0x01) a = 0x04;
      }
      // @DoneClosedPF
      if ((ram[CurOpenedDoors] & ram[0x02]) === ram[0x02]) {
        x = dir;
        if (a !== 0x07) {
          SetDoorFlag(x);
          a = a === 0x08 ? 0x09 : 0x04; // @SetPF9 or LDA #$04
        } else {
          a = 0x04;
        }
      }
      // @DoneOpenPF
      x = ram[0x06];
      if (x !== 0) {
        x = ram[0x0b];
        const pf = a; // PHA
        CalcOpenDoorwayMask(FindDoorTypeByDoorBit(), x);
        a = pf; // PLA
      }
      if (a >= 0x04) {
        let y = (a - 0x03) & 0xff;
        if (y >= 0x03) y--;
        x = FetchDoorAddrsFaceTilesSrcAndPlayAreaDst(dir, y);
        if (ram[0x06] === 0) {
          AddToInt16At0(secondHalf.byte(x));
          AddToInt16At2(0x06);
        }
        y = 0;
        ram[0x05] = colCount.byte(x);
        do {
          // @LoopColumn
          x = rowCount.byte(dir);
          do {
            // @LoopRowTile
            write(word(0x00) + y, read(word(0x02) + y));
            Add1ToInt16At2();
            AddToInt16At0(nextTile.byte(x));
            if (x === 0 && dir < 0x02) Add1ToInt16At0();
            x = (x - 1) & 0xff;
          } while (x < 0x80);
          ram[0x05]--;
        } while (ram[0x05] !== 0);
      }
      // @NextLoopDoorHalf
      x = dir; // PLA / TAX
      ram[0x06]--;
      if (ram[0x06] & 0x80) break;
    }
    x = (x - 1) & 0xff;
    if (x & 0x80) return; // L165D4_Exit
  }
}

/**
 * FetchDoorAddrsFaceTilesSrcAndPlayAreaDst (Z_05): A = direction index, Y = face index.
 * [$00:01] = door address in the play area map; [$02:03] = door face tiles + $C * (face - 1).
 * @returns X = direction index
 */
export function FetchDoorAddrsFaceTilesSrcAndPlayAreaDst(a, y) {
  // FetchDoorAddrsFaceTilesSrcAndPlayAreaDst (Z_05)
  const x = a;
  ram[0x02] = table(bus.rom, 'DoorFaceTilesAddrsLo').byte(x);
  ram[0x03] = table(bus.rom, 'DoorFaceTilesAddrsHi').byte(x);
  ram[0x00] = table(bus.rom, 'PlayAreaDoorFaceAddrsLo').byte(x);
  ram[0x01] = table(bus.rom, 'PlayAreaDoorFaceAddrsHi').byte(x);
  for (;;) {
    y = (y - 1) & 0xff;
    if (y === 0) return x;
    AddToInt16At2(0x0c);
  }
}
