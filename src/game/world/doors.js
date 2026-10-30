// UW door logic (Z_05): door flags, shutters, doorways (touching doors while walking), door
// commands (opening/closing animations) and the open-door masks. Package P14.
// Contracts (docs/ARCHITECTURE.md §6, input registers as parameters in a, x, y order):
//   FindDoorTypeByDoorBit():          [$02] = door bit; returns A = door type (X untouched).
//   CalcOpenDoorwayMask(a, x):        A = door type, X = direction index; returns A untouched.
//   SetDoorFlag(x) / ResetDoorFlag(x): X = direction index; returns Y = RoomId ([$00:01] = flags addr).
//   AddDoorFlagsToCurOpenedDoors():   no parameters.
//   CheckDoorway():                   X = 0 (Link), [$0F] = moving direction (see the routine).
//   CheckShutters(), UpdateDoors():   no parameters.
import { ram, cpu, word, peek } from '../../core/ram.js';
import { bus, read, write } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import {
  RoomId, LevelBlockAttrsA, LevelBlockAttrsB, CurOpenedDoors, OpenDoorwayMask, ShutterTrigger,
  TriggeredDoorCmd, TriggeredDoorDir, DoorwayDir, ObjDir, ObjX, ObjY, ObjInputDir, ObjTimer,
  InvMagicKey, InvKeys, GameMode, DoorTimer, DynTileBuf, DynTileBufLen,
} from '../../core/vars.js';
import { GetRoomFlags } from './roomflags.js';
import {
  LayOutDoors, WriteDoorFaceTileHorizontally, FetchDoorAddrsFaceTilesSrcAndPlayAreaDst,
} from './doors-draw.js';
import { GetOppositeDir, reverseDirections } from '../movement/math.js';
import { GoToNextModeFromPlay } from '../movement/walker.js';
import { PlaySample } from '../audio/requests.js';
import { $br, $pxa } from '../../core/timing.js';

// $0519: unnamed in the asm (TouchDoorShutter keeps there the shutter doors walked through).
const ShutterDoorsPassed = 0x0519;

/** LevelMasks, X (with the page hint of the asm read at `ref`). */
const levelMasks = (x, ref) => {
  const t = table(bus.rom, 'LevelMasks');
  $pxa(ref, t.addr, x);
  return t.byte(x);
};
const flagsPtr = () => word(0x00);

// ------------------------------------------------------------------ door flags

/** SetDoorFlag (Z_05). X = door direction index. @returns Y = RoomId ([$00:01] = world flags) */
export function SetDoorFlag(x) {
  // SetDoorFlag (Z_05)
  const a = GetRoomFlags() | levelMasks(x, 'Z_05:2108');
  const y = ram[RoomId];
  write((flagsPtr() + y) & 0xffff, a);
  return y;
}

/** ResetDoorFlag (Z_05). X = door direction index. @returns Y = RoomId ([$00:01] = world flags) */
export function ResetDoorFlag(x) {
  // ResetDoorFlag (Z_05)
  GetRoomFlags();
  const y = ram[RoomId];
  const addr = (flagsPtr() + y) & 0xffff;
  const m = levelMasks(x, 'Z_05:2121') ^ 0xff;
  $pxa('Z_05:2123', ram[0x00], y);
  write(addr, m & read(addr));
  return y;
}

/**
 * CalcOpenDoorwayMask (Z_05). A = door type, X = direction index. Shifts the walkability of the
 * doorway (open type, or a door whose room flag is set) into OpenDoorwayMask. @returns A untouched
 */
export function CalcOpenDoorwayMask(a, x) {
  // CalcOpenDoorwayMask (Z_05)
  const y = 0x00;
  const type = a; // PHA
  let c;
  if ($br('Z_05:7759', a < 0x04)) {
    // @ByDoorType: CMP #$00 sets C; "open" shifts a 1, any wall a 0.
    c = $br('Z_05:7788', a === 0x00) ? 1 : 0;
    if (!c) $br('Z_05:7790', true);
  } else {
    c = !$br('Z_05:7769', (GetRoomFlags() & levelMasks(x, 'Z_05:7768')) === 0) ? 1 : 0;
  }
  // @ShiftIntoMask
  $pxa('Z_05:7778', OpenDoorwayMask, y);
  const m = ram[OpenDoorwayMask + y];
  cpu.c = (m >> 7) & 1; // ROL
  ram[OpenDoorwayMask + y] = ((m << 1) | c) & 0x0f;
  return type; // PLA
}

/** AddDoorFlagsToCurOpenedDoors (Z_05): CurOpenedDoors |= the door flags set in the room's flags. */
export function AddDoorFlagsToCurOpenedDoors() {
  // AddDoorFlagsToCurOpenedDoors (Z_05)
  GetRoomFlags();
  const y = ram[RoomId];
  for (let x = 0x03; ; x--) {
    $pxa('Z_05:7797', ram[0x00], y);
    const a = read((flagsPtr() + y) & 0xffff) & levelMasks(x, 'Z_05:7798');
    if (!$br('Z_05:7799', a === 0)) ram[CurOpenedDoors] = a | ram[CurOpenedDoors];
    if (!$br('Z_05:7804', x - 1 >= 0)) break;
  }
}

/**
 * FindDoorTypeByDoorBit (Z_05). [$02] = door bit (1 E, 2 W, 4 S, 8 N).
 * @returns A = door type of that direction in RoomId ($08 if none; unverified code);
 *   [$00] = isolated door attribute, [$01] = matching single-bit mask, [$03] = reverse dir index.
 */
export function FindDoorTypeByDoorBit() {
  // FindDoorTypeByDoorBit (Z_05)
  ram[0x01] = 0x01;
  ram[0x03] = 0x03;
  for (;;) {
    // @LoopDoorBit
    $pxa('Z_05:4551', LevelBlockAttrsA, ram[RoomId]);
    let a = peek(LevelBlockAttrsA + ram[RoomId]); // S/N doors
    if (!$br('Z_05:4554', ram[0x03] < 0x02)) { // E/W doors
      $pxa('Z_05:4556', LevelBlockAttrsB, ram[RoomId]);
      a = peek(LevelBlockAttrsB + ram[RoomId]);
    }
    ram[0x00] = a;
    if (!$br('Z_05:4561', (ram[0x03] & 0x01) !== 0)) ram[0x00] >>= 3; // even counter: N/W doors
    ram[0x00] >>= 2;
    if ($br('Z_05:4574', (ram[0x02] & ram[0x01]) !== 0)) return ram[0x00] & 0x07; // BIT $01
    ram[0x01] <<= 1;
    ram[0x03] = (ram[0x03] - 1) & 0xff;
    if (!$br('Z_05:4577', (ram[0x03] & 0x80) === 0)) return 0x08; // unverified code 1642C: invalid door type
  }
}

// ------------------------------------------------------------------ shutters

/** CheckShutters (Z_05): when ShutterTrigger is set, open the first closed shutter (door type 7). */
export function CheckShutters() {
  // CheckShutters (Z_05)
  if (!$br('Z_05:2132', ram[ShutterTrigger] === 0)) {
    ram[0x0e] = 0x08;
    for (;;) {
      // @LoopOpenedDoorBit
      if ($br('Z_05:2143', (ram[0x0e] & ram[CurOpenedDoors]) === 0)) {
        // @TriggerIfShutter
        ram[0x02] = ram[0x0e];
        if (!$br('Z_05:2165', FindDoorTypeByDoorBit() !== 0x07)) {
          if ($br('Z_05:2169', ram[TriggeredDoorCmd] !== 0)) return;
          return TriggerOpenDoor(ram[0x02]);
        }
      }
      // @NextLoopOpenedDoorBit
      ram[0x0e] >>= 1;
      if (!$br('Z_05:2150', ram[0x0e] !== 0)) break;
    }
  }
  ram[ShutterTrigger] = 0x00;
}

/** TriggerOpenDoor (Z_05). A = door direction: TriggeredDoorDir = A, TriggeredDoorCmd = 6 (open). */
export function TriggerOpenDoor(a) {
  // TriggerOpenDoor (Z_05)
  ram[TriggeredDoorDir] = a;
  ram[TriggeredDoorCmd] = 0x06;
}

// ------------------------------------------------------------------ doorways

const doorwayTable = (name) => table(bus.rom, name);

/**
 * Doorway search with the Over or Under bounds: @returns Y of the doorway found, or -1.
 * `r` = asm lines of the loop: [CMP req, BNE, CMP min, BCC, CMP max, BCC found, BPL loop].
 */
function searchDoorways(minName, maxName, r) {
  const req = doorwayTable('DoorwayRequiredCoord');
  const min = doorwayTable(minName);
  const max = doorwayTable(maxName);
  for (let y = 0x03; ; y--) {
    $pxa(r[0], req.addr, y);
    if (!$br(r[1], ram[0x00] !== req.byte(y))) {
      const a = ram[0x01];
      $pxa(r[2], min.addr, y);
      if (!$br(r[3], a < min.byte(y))) {
        $pxa(r[4], max.addr, y);
        if ($br(r[5], a < max.byte(y))) return y;
      }
    }
    if (!$br(r[6], y - 1 >= 0)) return -1;
  }
}

/**
 * CheckDoorway (Z_05). Link (X = 0) in the UW, [$0F] = moving direction.
 * [$0E] = reverse index of the doorway found, or $FF if a door blocks; [$0F] is left as is, or set
 * from 0 to the doorway's direction. False walls and bombed walls pass to the next room.
 */
export function CheckDoorway() {
  // CheckDoorway (Z_05)
  let y = -1;
  let search = 'over';
  if ($br('Z_05:3750', ram[DoorwayDir] !== 0)) {
    // @InDoorway
    const dir = ram[DoorwayDir]; // PHA
    GetPlayerCoordsForDirection(dir);
    const ry = GetOppositeDir(dir).y; // PLA / JSR GetOppositeDir
    const a = ram[0x01];
    search = 'under';
    const minO = doorwayTable('DoorwayBoundsMinOver');
    const maxO = doorwayTable('DoorwayBoundsMaxOver');
    $pxa('Z_05:3799', minO.addr, ry);
    if (!$br('Z_05:3800', a < minO.byte(ry))) {
      $pxa('Z_05:3801', maxO.addr, ry);
      if (!$br('Z_05:3802', a >= maxO.byte(ry))
        && $br('Z_05:3805', ram[DoorwayDir] === ram[ObjDir])) search = 'over';
    }
  }
  if (search === 'over') {
    // @SearchOverflowBounds
    GetPlayerCoordsForDirection(ram[ObjDir]);
    y = searchDoorways('DoorwayBoundsMinOver', 'DoorwayBoundsMaxOver',
      ['Z_05:3768', 'Z_05:3769', 'Z_05:3771', 'Z_05:3772', 'Z_05:3773', 'Z_05:3774', 'Z_05:3777']);
  } else {
    // @SearchUnderflowDoorway
    y = searchDoorways('DoorwayBoundsMinUnder', 'DoorwayBoundsMaxUnder',
      ['Z_05:3819', 'Z_05:3820', 'Z_05:3822', 'Z_05:3823', 'Z_05:3824', 'Z_05:3825', 'Z_05:3828']);
    if (y < 0) $br('Z_05:3829', true);
  }
  if (y < 0) {
    // @NotInDoorway
    ram[DoorwayDir] = 0x00;
    return;
  }

  // @TestDoorwayDoor
  ram[0x0e] = y;
  const input = ram[ObjInputDir] & 0x0f;
  ram[0x02] = input;
  ram[0x0c] = input;
  if ($br('Z_05:3845', input !== reverseDirections(y, 'Z_05:3844'))) return;
  const type = FindDoorTypeByDoorBit();
  ram[0x0d] = type;
  TouchDoor(type);
  y = ram[0x0e];
  if ($br('Z_05:3854', (y & 0x80) !== 0)) return; // blocked
  const dir = reverseDirections(y, 'Z_05:3857');
  ram[ObjDir] = dir;
  ram[0x0f] = dir;
  ram[DoorwayDir] = dir;
  const t = ram[0x0d] & 0x07;
  if ($br('Z_05:3868', t === 0x02) || $br('Z_05:3870', t === 0x03) || $br('Z_05:3872', t === 0x04)) return GoToNextModeFromPlay();
}

/**
 * GetPlayerCoordsForDirection (Z_05). A = direction.
 * [$00] = Y if facing left/right, else X; [$01] = X if facing left/right, else Y.
 */
export function GetPlayerCoordsForDirection(a) {
  // GetPlayerCoordsForDirection (Z_05)
  let x = ram[ObjX];
  let y = ram[ObjY];
  if (!$br('Z_05:3893', (a & 0x03) === 0)) {
    y = ram[ObjX];
    x = ram[ObjY];
  }
  ram[0x00] = x;
  ram[0x01] = y;
}

let touchHandlers;
/** TouchDoor (Z_05). A = door type; [$0C] = door direction, [$0E] = reverse index ($FF = blocked). */
export function TouchDoor(a) {
  // TouchDoor (Z_05)
  touchHandlers ??= [TouchDoorOpen, TouchDoorWall, TouchDoorFalse, TouchDoorFalse,
    TouchDoorBombable, TouchDoorKey, TouchDoorKey, TouchDoorShutter];
  return tableJump(label('TouchDoor_JumpTable').addr, a & 0x07, touchHandlers);
}

/** TouchDoorWall (Z_05): blocks the movement ([$0E] = $FF). */
export function TouchDoorWall() {
  // TouchDoorWall (Z_05)
  ram[0x0e] = 0xff;
  return TouchDoorOpen(); // falls through
}

/** TouchDoorOpen (Z_05): nothing blocks. */
export function TouchDoorOpen() {
  // TouchDoorOpen (Z_05)
}

/** TouchDoorFalse (Z_05): blocks for $18 frames of Link's timer, then lets Link through. */
export function TouchDoorFalse() {
  // TouchDoorFalse (Z_05)
  const a = ram[ObjTimer];
  if ($br('Z_05:3933', a === 0)) {
    ram[ObjTimer] = 0x18; // @SetTimer
  } else if (!$br('Z_05:3935', a !== 0x01)) {
    return;
  }
  return TouchDoorWall(); // @BlockMovement
}

/** TouchDoorBombable (Z_05): blocks unless the door is in the opened door mask. */
export function TouchDoorBombable() {
  // TouchDoorBombable (Z_05)
  if ($br('Z_05:3949', (ram[0x0c] & ram[CurOpenedDoors]) === 0)) return TouchDoorWall();
}

/** TouchDoorShutter (Z_05): blocks while a door command runs or if the shutter is closed. */
export function TouchDoorShutter() {
  // TouchDoorShutter (Z_05)
  if ($br('Z_05:3956', ram[TriggeredDoorCmd] !== 0)) return TouchDoorWall();
  const a = ram[0x0c] & ram[CurOpenedDoors];
  if ($br('Z_05:3959', a === 0)) return TouchDoorWall();
  if (!$br('Z_05:3963', (a & ram[ShutterDoorsPassed]) === 0)) { $br('Z_05:3964', true); return BlockUntilTime(); }
  ram[ShutterDoorsPassed] = ram[ShutterDoorsPassed] | ram[0x0c];
}

/** TouchDoorKey (Z_05): an unopened key door uses a key (or the magic key) to open itself. */
export function TouchDoorKey() {
  // TouchDoorKey (Z_05)
  if ($br('Z_05:3975', (ram[0x0c] & ram[CurOpenedDoors]) !== 0)) return; // L15292_Exit
  if ($br('Z_05:3979', ram[TriggeredDoorCmd] !== 0)) return BlockUntilTime();
  if (!$br('Z_05:3984', ram[InvMagicKey] !== 0)) {
    if ($br('Z_05:3986', ram[InvKeys] === 0)) return BlockAtWall();
    ram[InvKeys]--;
  }
  // @TriggerDoor
  TriggerOpenDoor(ram[0x0c]);
  ram[ObjTimer] = 0x20;
  return BlockAtWall(); // falls through
}

// BlockAtWall (Z_05, label in TouchDoorKey)
function BlockAtWall() {
  return TouchDoorWall();
}

// BlockUntilTime (Z_05, label in TouchDoorShutter/TouchDoorKey): block while Link's timer <> 0.
function BlockUntilTime() {
  if ($br('Z_05:4006', ram[ObjTimer] !== 0)) return BlockAtWall();
  // L15292_Exit
}

// ------------------------------------------------------------------ door commands

/**
 * UpdateDoors (Z_05): runs TriggeredDoorCmd (2/3 close, 6/7 open): every 8 frames writes the door
 * face to the nametable; at the end updates the door flags and the opened mask and lays out doors.
 */
export function UpdateDoors() {
  // UpdateDoors (Z_05)
  if ($br('Z_05:5035', ram[GameMode] === 0x12)) return; // L165D4_Exit
  if ($br('Z_05:5037', ram[DoorTimer] !== 0)) return;
  let a = ram[TriggeredDoorCmd];
  if ($br('Z_05:5039', a === 0)) return;

  // cmd 7 6 3 2 -> [08] 2 0 0 0
  a &= 0x07;
  ram[0x02] = 0x01;
  if (!$br('Z_05:5056', (a & ram[0x02]) === 0)) a >>= 1; // BIT $02 / LSR
  if (!$br('Z_05:5060', a !== 0x02)) ram[ObjTimer] = 0x30;
  a = ((a & 0x03) - 0x01) & 0xff; // SEC / SBC #$01
  ram[0x08] = a & 0x02;

  if (!$br('Z_05:5076', ram[TriggeredDoorCmd] >= 0x05)) {
    ram[0x02] = ram[TriggeredDoorDir];
    if (!$br('Z_05:5081', FindDoorTypeByDoorBit() === 0x07)) return L_ResetDoorCmdAndLayOutDoors();
  }
  let x = PrepareWriteHorizontalDoorTransferRecords();

  do {
    // @LoopTransferRec
    ram[0x04] = ram[0x06];
    ram[DynTileBuf + x] = ram[0x00];
    x = (x + 1) & 0xff;
    ram[DynTileBuf + x] = ram[0x01];
    x = (x + 1) & 0xff;
    ram[DynTileBuf + x] = ram[0x06];
    x = (x + 1) & 0xff;
    do {
      x = WriteDoorFaceTileHorizontally(x);
    } while ($br('Z_05:5110', !cpu.z));
    ram[0x01] = 0x20 | ram[0x01];
    ram[0x05] = (ram[0x05] - 1) & 0xff;
  } while ($br('Z_05:5122', ram[0x05] !== 0));

  ram[DynTileBuf + x] = 0xff;
  ram[DynTileBufLen] = x;
  ram[TriggeredDoorCmd]++;
  if (!$br('Z_05:5140', (ram[TriggeredDoorCmd] & 0x03) === 0)) {
    ram[DoorTimer] = 0x08;
    return;
  }
  if (!$br('Z_05:5153', ram[TriggeredDoorCmd] !== 0x04)) {
    // Was 3: close the door.
    ResetDoorFlag(ram[0x09]);
    a = (ram[TriggeredDoorDir] ^ 0x0f) & ram[CurOpenedDoors];
    return L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors(a);
  }
  // Was 7: open the door.
  ram[0x02] = ram[TriggeredDoorDir];
  if (!$br('Z_05:5177', FindDoorTypeByDoorBit() === 0x07)) {
    x = ram[0x09];
    let y = SetDoorFlag(x);
    const next = table(bus.rom, 'DoorNextRoomIdOffsets');
    $pxa('Z_05:5186', next.addr, x);
    y = (y + next.byte(x)) & 0xff; // next room
    x ^= 0x01; // opposite door
    const addr = (flagsPtr() + y) & 0xffff;
    $pxa('Z_05:5195', ram[0x00], y);
    const f = read(addr);
    write(addr, f | levelMasks(x, 'Z_05:5196'));
  }
  a = ram[TriggeredDoorDir] | ram[CurOpenedDoors];
  return L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors(a);
}

/** L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors (Z_05). A = new CurOpenedDoors. */
export function L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors(a) {
  // L_SetOpenedDoorMaskAndResetCmdAndLayOutDoors (Z_05)
  ram[CurOpenedDoors] = a;
  return L_ResetDoorCmdAndLayOutDoors(); // falls through
}

/** L_ResetDoorCmdAndLayOutDoors (Z_05): TriggeredDoorCmd = 0; LayOutDoors. */
export function L_ResetDoorCmdAndLayOutDoors() {
  // L_ResetDoorCmdAndLayOutDoors (Z_05)
  ram[TriggeredDoorCmd] = 0x00;
  return LayOutDoors();
}

/**
 * PrepareWriteHorizontalDoorTransferRecords (Z_05). [$08] = 0 if closed.
 * @returns X = DynTileBufLen; [$00]/[$01] = door VRAM address hi/lo, [$02:03] = door face tiles,
 *   [$05] = 2 records, [$06] = 2 tiles each, [$07] = 0, [$09] = door direction index.
 */
export function PrepareWriteHorizontalDoorTransferRecords() {
  // PrepareWriteHorizontalDoorTransferRecords (Z_05)
  ram[0x02] = ram[TriggeredDoorDir];
  let a = FindDoorTypeByDoorBit();
  if (!$br('Z_05:5231', a < 0x05)) {
    const saved = a; // PHA
    PlaySample(0x04); // door sound
    a = saved; // PLA
  }
  if (!$br('Z_05:5242', a !== 0x04)) a = 0x08;
  if (!$br('Z_05:5246', a !== 0x01)) a = 0x04; // unverified code 166CD
  let y = (a - 0x03) & 0xff;
  let forward = false;
  if (!$br('Z_05:5262', ram[0x08] === 0)) {
    if ($br('Z_05:5264', y === 0x05)) forward = true;
    else y = 0x01;
  }
  if (!forward && !$br('Z_05:5268', y < 0x03)) y = (y - 1) & 0xff;
  // @MakeForwardIndex
  a = (0x03 - ram[0x03]) & 0xff;
  let x = FetchDoorAddrsFaceTilesSrcAndPlayAreaDst(a, y);
  const hi = table(bus.rom, 'DoorVramAddrsHi');
  const lo = table(bus.rom, 'DoorVramAddrsLo');
  $pxa('Z_05:5285', hi.addr, x);
  ram[0x00] = hi.byte(x);
  $pxa('Z_05:5287', lo.addr, x);
  ram[0x01] = lo.byte(x);
  ram[0x09] = x;
  x = ram[DynTileBufLen];
  ram[0x07] = 0x00;
  ram[0x06] = 0x02;
  ram[0x05] = 0x02;
  return x;
}
