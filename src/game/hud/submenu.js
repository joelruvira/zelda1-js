// Submenu (MenuState machine: scroll down, active item selection, scroll up), submenu item sprites
// and cursor, item slot search; world scrolling between rooms (ScrollWorld, mode 7) (Z_05). Package P11.

import { ram, peek, poke } from '../../core/ram.js';
import { bus } from '../../core/bus.js';
import { table, label } from '../../core/rom.js';
import { tableJump } from '../../core/asm.js';
import { $br, $pxa } from '../../core/timing.js';
import {
  MenuState, TileBufSelector, CurLevel, CurVScroll, SwitchNameTablesReq, SubmenuScrollProgress, CurScanRoomId,
  Sprites, GameMode, RoomId, LevelInfo_SubmenuMapRotation, ButtonsDown, ButtonsPressed,
  SongEnvelopeSelector, InvTriforce, Items, Potion, SelectedItemSlot, FrameCounter, ObjInputDir,
  Tune1Request, Bow, VScrollStartFrame, ObjDir, CurRow, ObjY, VScrollAddrLo, VScrollAddrHi,
  GameSubmode, CurColumn, ObjX, CurHScroll, OddBaseNameTableOverride,
} from '../../core/vars.js';
import { HideAllSprites } from '../boot.js';
import { EndGameMode } from '../modes/dispatch.js';
import { WriteBlankPrioritySprites } from '../draw/sprites.js';
import { Negate } from '../movement/math.js';
import * as mode5 from '../modes/mode5-play.js';
import * as mode11 from '../modes/mode11-death.js';
import {
  UpdatePlayerPositionMarker, UpdateTriforcePositionMarker, DrawItemInInventory, DrawItemInInventoryWithX,
} from './statusbar.js';
import {
  HasCompass, HasMap, Submenu_CueTransferRowUW, Submenu_CueTransferRowOW,
} from './map.js';

// UpdateHeartsAndRupees (P05) and SilenceSound (P25): namespace imports, resolved at call time
// (mode5-play.js and mode11-death.js import this module indirectly).
const UpdateHeartsAndRupees = (...args) => mode5.UpdateHeartsAndRupees(...args);
const SilenceSound = (...args) => mode11.SilenceSound(...args);

const EF = 0xef; // [$EF]: item search direction of the previous frame (unnamed in Variables.inc)

// ------------------------------------------------------------------ menu state machine

/** UpdateMenuAndMeters (Z_05) */
export function UpdateMenuAndMeters() {
  // UpdateMenuAndMeters (Z_05)
  UpdateMenu();
  return UpdateHeartsAndRupees();
}

let handlersUW;
let handlersOW;
/** UpdateMenu (Z_05): TableJump on MenuState (UW and OW tables). */
export function UpdateMenu() {
  // UpdateMenu (Z_05)
  const a = ram[MenuState];
  if (!$br('Z_05:162', ram[CurLevel] === 0)) {
    handlersUW ??= [UpdateMenu_Return, UpdateMenuCommon1, UpdateMenuCommon2, UpdateMenuCommon3,
      UpdateMenuCommon4, UpdateMenu5UW, UpdateMenuScrollDownUW, UpdateMenuActive, UpdateMenuScrollUp];
    return tableJump(label('UpdateMenuUW_JumpTable').addr, a, handlersUW);
  }
  handlersOW ??= [UpdateMenu_Return, UpdateMenuStartOW, UpdateMenuCommon1, UpdateMenuCommon2,
    UpdateMenuCommon3, UpdateMenuCommon4, UpdateMenu5OW, UpdateMenuScrollDownOW, UpdateMenuActive,
    UpdateMenuScrollUp];
  return tableJump(label('UpdateMenuOW_JumpTable').addr, a, handlersOW);
}

/** UpdateMenuCommon1 (Z_05): start scrolling the submenu down (NT 2 above NT 0). */
export function UpdateMenuCommon1() {
  // UpdateMenuCommon1 (Z_05)
  HideAllSprites();
  UpdatePlayerPositionMarker();
  UpdateTriforcePositionMarker();
  ram[CurVScroll] = 0xef;
  ram[SwitchNameTablesReq] = 0xef;
  MovePositionMarkers(0x01);
  ram[MenuState]++;
  // Bits 1-7: submenu row; bit 0: transfer a black row first.
  ram[SubmenuScrollProgress] = 0x2b;
  ram[CurScanRoomId] = 0x7f; // UW: rooms scanned $7F..0 for the sheet map
  return UpdateMenu_Return();
}

/** UpdateMenu_Return (Z_05) */
export function UpdateMenu_Return() {
  // UpdateMenu_Return (Z_05)
}

/** UpdateMenuCommon2 (Z_05): first submenu attributes to NT 2. */
export function UpdateMenuCommon2() {
  // UpdateMenuCommon2 (Z_05)
  return SelectTransferBufAndIncState(0x48);
}

/** SelectTransferBufAndIncState (part of UpdateMenuCommon2, Z_05) */
function SelectTransferBufAndIncState(a) {
  ram[TileBufSelector] = a;
  return incMenuState();
}

function incMenuState() {
  ram[MenuState]++;
}

/** UpdateMenuCommon3 (Z_05): second submenu attributes to NT 2. */
export function UpdateMenuCommon3() {
  // UpdateMenuCommon3 (Z_05)
  $br('Z_05:252', true);
  return SelectTransferBufAndIncState(0x4a);
}

/** UpdateMenuCommon4 (Z_05): blank row at the bottom of NT 2. */
export function UpdateMenuCommon4() {
  // UpdateMenuCommon4 (Z_05)
  $br('Z_05:258', true);
  return SelectTransferBufAndIncState(0x4c);
}

/** UpdateMenu5UW (Z_05) */
export function UpdateMenu5UW() {
  // UpdateMenu5UW (Z_05)
  Submenu_CueTransferRowUW();
  return incMenuState();
}

/** UpdateMenu5OW (Z_05): "TRIFORCE" text. */
export function UpdateMenu5OW() {
  // UpdateMenu5OW (Z_05)
  $br('Z_05:267', true);
  return SelectTransferBufAndIncState(0x5c);
}

/** UpdateMenuScrollDownOW (Z_05) */
export function UpdateMenuScrollDownOW() {
  // UpdateMenuScrollDownOW (Z_05)
  Submenu_CueTransferRowOW();
  return scrollDown();
}

/** UpdateMenuScrollDownUW (Z_05): scroll down 3 pixels a frame until VScroll = $41. */
export function UpdateMenuScrollDownUW() {
  // UpdateMenuScrollDownUW (Z_05)
  Submenu_CueTransferRowUW();
  return scrollDown();
}

function scrollDown() {
  MovePositionMarkers(0x03);
  const a = (ram[CurVScroll] - 0x03) & 0xff;
  ram[CurVScroll] = a;
  if ($br('Z_05:287', a !== 0x41)) return; // @Exit
  ram[MenuState]++;
  if ($br('Z_05:294', ram[CurLevel] === 0)) return;
  if ($br('Z_05:297', ram[GameMode] === 0x09)) return; // cellar
  // Submenu map position marker: X = col*8 +/- rotation*8 + $62.
  ram[0x00] = (ram[RoomId] & 0x0f) << 3;
  let r = peek(LevelInfo_SubmenuMapRotation);
  let x;
  if (!$br('Z_05:318', r < 0x08)) {
    // CMP #$08 left C set: $10 - rotation, as a left rotation
    x = Negate((((0x10 - r) & 0xff) << 3) & 0xff);
  } else {
    x = (r << 3) & 0xff; // @ShortRotation
  }
  x = (x + ram[0x00]) & 0xff;
  ram[Sprites + 83] = (x + 0x62) & 0xff;
  // Y = row*8 + $69 (LSR leaves C = 0)
  ram[Sprites + 80] = (((ram[RoomId] & 0xf0) >> 1) + 0x69) & 0xff;
  ram[Sprites + 81] = 0x3e; // dot
  ram[Sprites + 82] = 0x00;
}

/** UpdateMenuActive (Z_05): items, cursor; Start closes; Up+A on controller 2 -> mode 8. */
export function UpdateMenuActive() {
  // UpdateMenuActive (Z_05)
  DrawSubmenuItems();
  UpdateSubmenuSelection();
  if (!$br('Z_05:373', (ram[ButtonsDown + 1] & 0x88) !== 0x88)) {
    ram[MenuState] = EndGameMode();
    ram[GameMode] = 0x08;
    ram[SongEnvelopeSelector] = 0x00;
    return SilenceSound();
  }
  if ($br('Z_05:386', (ram[ButtonsPressed] & 0x10) === 0)) return; // Exit
  const linkY = ram[Sprites + 84];
  const triforceY = ram[Sprites + 88];
  HideAllSprites();
  ram[Sprites + 88] = triforceY;
  ram[Sprites + 84] = linkY;
  ram[MenuState]++;
}

/** UpdateMenuScrollUp (Z_05): scroll up 3 pixels a frame until VScroll >= $F0, then back to NT 0. */
export function UpdateMenuScrollUp() {
  // UpdateMenuScrollUp (Z_05)
  MovePositionMarkers(0xfd);
  const a = (ram[CurVScroll] + 0x03) & 0xff;
  ram[CurVScroll] = a;
  if ($br('Z_05:410', a < 0xf0)) return; // Exit
  ram[SwitchNameTablesReq] = a;
  if (!$br('Z_05:419', ram[CurLevel] === 0)) WriteBlankPrioritySprites(); // clears the submenu cursor
  ram[CurVScroll] = 0x00;
  ram[MenuState] = 0x00;
  return MovePositionMarkers(0x02); // overshot to $F2: falls through
}

/** MovePositionMarkers (Z_05): A = vertical velocity of the markers. */
export function MovePositionMarkers(a) {
  // MovePositionMarkers (Z_05)
  ram[0x00] = a;
  if (!$br('Z_05:441', ram[Sprites + 84] === 0xf8)) ram[Sprites + 84] = (ram[Sprites + 84] + ram[0x00]) & 0xff;
  if ($br('Z_05:448', ram[CurLevel] === 0)) return; // Exit
  if ($br('Z_05:450', HasCompass() === 0)) return;
  ram[Sprites + 88] = (ram[Sprites + 88] + ram[0x00]) & 0xff;
}

/** UpdateMenuStartOW (Z_05): build the submenu triforce in its transfer buffers (WRAM). */
export function UpdateMenuStartOW() {
  // UpdateMenuStartOW (Z_05)
  const buf = label('TriforceRow0TransferBuf').addr + 4; // RAM_06_DATA
  const offsets = table(bus.rom, 'TriforceTransferBufOffsets');
  const tiles = table(bus.rom, 'TriforceTransferBufTiles');
  const repl = table(bus.rom, 'TriforceTriforceBufReplacements');
  let y;
  for (y = 0x17; ;) {
    $pxa('Z_05:479', offsets.addr, y); $pxa('Z_05:480', tiles.addr, y);
    poke(buf + offsets.byte(y), tiles.byte(y));
    y--; if (!$br('Z_05:483', y >= 0)) break;
  }
  y = 0;
  ram[0x06] = 0x01; // level test bit
  do {
    ram[0x07] = 0x03;
    do {
      $pxa('Z_05:504', offsets.addr, y);
      const x = offsets.byte(y);
      if (!$br('Z_05:511', (ram[0x06] & ram[InvTriforce]) === 0)) {
        $pxa('Z_05:521', buf, x);
        let a = peek(buf + x);
        if ($br('Z_05:523', a === 0xe5) || $br('Z_05:525', a === 0xe6)) a = 0xf5;
        else { $pxa('Z_05:526', repl.addr, y); a = repl.byte(y); }
        poke(buf + x, a);
      }
      y++;
      ram[0x07]--;
    } while ($br('Z_05:541', ram[0x07] !== 0));
    ram[0x06] = (ram[0x06] << 1) & 0xff;
  } while ($br('Z_05:548', ram[0x06] !== 0));
  ram[MenuState]++;
}

// ------------------------------------------------------------------ submenu items and cursor

/** DrawSubmenuItems (Z_05) */
export function DrawSubmenuItems() {
  // DrawSubmenuItems (Z_05)
  let x;
  for (x = 0x1e; ;) {
    $pxa('Z_05:7845', Items, x);
    if ($br('Z_05:7846', ram[Items + x] !== 0)) {
      // @FoundBoomerang
      ram[0x01] = 0x36;
      ram[0x00] = 0x80;
      DrawItemInInventory(x, x);
      break;
    }
    x--;
    if (!$br('Z_05:7849', x !== 0x1c)) { $br('Z_05:7850', true); break; }
  }
  // @DrawOtherItems
  for (x = 0x01; ;) {
    $pxa('Z_05:7866', Items, x);
    let a = ram[Items + x];
    if (!$br('Z_05:7870', x !== 0x10)) {
      a = HasCompass();
      x = 0x10;
    }
    if (!$br('Z_05:7876', x !== 0x11)) {
      a = HasMap();
      x = 0x11;
    }
    // the potion is drawn instead of the letter
    if (!$br('Z_05:7882', a === 0) && !(!$br('Z_05:7888', x !== 0x0f) && $br('Z_05:7890', ram[Potion] !== 0))) {
      const slot = x; // PHA
      $pxa('Z_05:7897', table(bus.rom, 'SubmenuItemXs').addr, x);
      ram[0x00] = table(bus.rom, 'SubmenuItemXs').byte(x);
      if ($br('Z_05:7904', x < 0x05)) a = 0x36;
      else if ($br('Z_05:7910', x === 0x0f) || $br('Z_05:7912', x < 0x09)) a = 0x46;
      else if ($br('Z_05:7918', x < 0x10)) a = 0x1e;
      else {
        ram[0x00] = 0x2c;
        a = $br('Z_05:7926', x < 0x11) ? 0x9e : 0x76; // compass, map
      }
      ram[0x01] = a;
      DrawItemInInventoryWithX(x);
      x = slot; // PLA
    }
    // @NextLoopDrawItem
    x++;
    if (!$br('Z_05:7939', x < 0x12)) break;
  }
}

/** UpdateSubmenuSelection (Z_05): selected item box, flashing cursor, move with left/right. */
export function UpdateSubmenuSelection() {
  // UpdateSubmenuSelection (Z_05)
  let x = ram[SelectedItemSlot];
  let draw = true;
  if (!$br('Z_05:7950', x !== 0)) {
    // Boomerang pseudo-slot: magic one first.
    for (x = 0x1e; ;) {
      $pxa('Z_05:7956', Items, x);
      if ($br('Z_05:7957', ram[Items + x] !== 0)) break;
      x--;
      if (!$br('Z_05:7960', x !== 0x1c)) {
        $br('Z_05:7961', true);
        draw = false;
        break;
      }
    }
  }
  if (draw) {
    // @DrawBreakoutItem
    $pxa('Z_05:7973', Items, x);
    let a = ram[Items + x];
    if (!$br('Z_05:7974', a === 0) && !(!$br('Z_05:7976', x !== 0x0f) && $br('Z_05:7978', ram[Potion] !== 0))) {
      if (x === 0x0f) a = 0x01; // letter and no potion
      ram[0x04] = a;
      ram[0x01] = 0x36;
      ram[0x00] = 0x40;
      DrawItemInInventoryWithX(x);
    }
  }
  // @AfterBreakoutItem: letter selected + potions -> select the potion slot.
  let y = ram[SelectedItemSlot];
  if (!$br('Z_05:7993', y !== 0x0f)) {
    y = 0x07;
    $pxa('Z_05:7995', Items, y);
    if (!$br('Z_05:7996', ram[Items + y] === 0)) ram[SelectedItemSlot] = y;
  }
  // @DrawCursor
  $pxa('Z_05:8005', table(bus.rom, 'SubmenuCursorXs').addr, y);
  let a = table(bus.rom, 'SubmenuCursorXs').byte(y);
  ram[Sprites + 31] = a;
  ram[Sprites + 35] = (a + 0x08) & 0xff;
  a = $br('Z_05:8014', y < 0x05) ? 0x36 : 0x46;
  ram[Sprites + 28] = a;
  ram[Sprites + 32] = a;
  ram[Sprites + 29] = 0x1e; // cursor tile
  ram[Sprites + 33] = 0x1e;
  a = ((ram[FrameCounter] & 0x08) >> 3) + 0x01; // palettes 5/6 (C = 0 after the LSRs)
  ram[Sprites + 30] = a;
  ram[Sprites + 34] = a | 0x40; // flipped horizontally
  a = ram[ObjInputDir];
  if ($br('Z_05:8043', a === ram[EF])) return; // L177F1_Exit
  if ($br('Z_05:8051', a === 0) || $br('Z_05:8053', a >= 0x04)) return FindAndSelectOccupiedItemSlot(a, y);
  ram[Tune1Request] = 0x01; // "selection changed"
  const old = ram[SelectedItemSlot]; // PHA
  FindAndSelectOccupiedItemSlot(a, y);
  if ($br('Z_05:8070', old === ram[SelectedItemSlot])) {
    ram[Tune1Request] >>= 1; // @CancelTune
    return;
  }
  y = ram[SelectedItemSlot];
  $pxa('Z_05:8075', Items, y);
  if (!$br('Z_05:8076', ram[Items + y] !== 0)) ram[Tune1Request] >>= 1; // @CancelTune
}

// FindAndSelectOccupiedItemSlot and its labels share one search loop (entered at different labels).
const LOOP = 0, CHECK_NEXT = 1, FOUND = 2;

function searchItemSlot(state, x, y) {
  for (;;) {
    switch (state) {
      case LOOP: // LoopItemSlot
        y = Cycle9InDirection(y);
        if ($br('Z_05:8097', y === 0x00)) {
          // CheckBoomerangs
          let yy = 0x1e;
          let found = false;
          for (;;) {
            $pxa('Z_05:8128', Items, yy);
            if ($br('Z_05:8129', ram[Items + yy] !== 0)) { found = true; break; }
            yy--;
            if (!$br('Z_05:8132', yy !== 0x1c)) break;
          }
          y = 0x00;
          state = found ? FOUND : CHECK_NEXT;
          continue;
        }
        if ($br('Z_05:8099', y === 0x03)) { state = CHECK_NEXT; continue; } // bow slot: not selectable
        $pxa('Z_05:8100', Items, y);
        if ($br('Z_05:8101', ram[Items + y] !== 0)) { state = FOUND; continue; }
        if ($br('Z_05:8103', y === 0x07)) {
          // CheckLetter
          y = 0x0f;
          $pxa('Z_05:8142', Items, y);
          if (!$br('Z_05:8143', ram[Items + y] !== 0)) {
            y = 0x07;
            $br('Z_05:8145', true);
            state = CHECK_NEXT;
            continue;
          }
          if (!$br('Z_05:8148', ram[Potion] === 0)) { y = 0x07; $br('Z_05:8151', true); } // unverified in the original
          ram[SelectedItemSlot] = y; // SetSlotFound
          return y;
        }
        state = CHECK_NEXT;
        continue;
      case CHECK_NEXT: // CheckNextItem
        x = (x - 1) & 0xff;
        if ($br('Z_05:8107', (x & 0x80) === 0)) { state = LOOP; continue; }
        y = 0x00; // no items
        state = FOUND;
        continue;
      case FOUND: // FoundSlot: the arrow slot needs the bow (else keep looking, without DEX)
        if (!$br('Z_05:8112', y !== 0x02) && $br('Z_05:8114', ram[Bow] === 0)) { state = LOOP; continue; }
        ram[SelectedItemSlot] = y; // SetSlotFound
        return y;
    }
  }
}

/**
 * FindAndSelectOccupiedItemSlot (Z_05): A = direction to search (0 none, 1 forward, 2 backward),
 * Y = starting slot. Sets [$EF] = A and SelectedItemSlot. Returns Y.
 */
export function FindAndSelectOccupiedItemSlot(a, y) {
  // FindAndSelectOccupiedItemSlot (Z_05)
  ram[EF] = a;
  return searchItemSlot(LOOP, 0x09, y); // check 9 slots
}

/** CheckNextItem (Z_05): entry into the search loop of FindAndSelectOccupiedItemSlot. */
export function CheckNextItem(x, y) {
  // CheckNextItem (Z_05)
  return searchItemSlot(CHECK_NEXT, x, y);
}

/** FoundSlot (Z_05): entry into the search loop of FindAndSelectOccupiedItemSlot. */
export function FoundSlot(x, y) {
  // FoundSlot (Z_05)
  return searchItemSlot(FOUND, x, y);
}

/** Cycle9InDirection (Z_05): [$EF] & 3 = 1: Y = (Y+1) mod 9; 2: Y = (Y-1) mod 9. Returns Y. */
export function Cycle9InDirection(y) {
  // Cycle9InDirection (Z_05)
  const a = ram[EF] & 0x03;
  if ($br('Z_05:8173', a === 0)) return y;
  y = (y + 1) & 0xff;
  if (!$br('Z_05:8176', (a & 0x01) !== 0)) y = (y - 2) & 0xff;
  if (!$br('Z_05:8181', y !== 0xff)) y = 0x08;
  if ($br('Z_05:8185', y !== 0x09)) return y;
  y = 0x00;
  return y;
}

// ------------------------------------------------------------------ world scrolling (mode 7)

/**
 * ScrollWorld (Z_05): one step of the scroll to the next room. Vertical: one row every 2 (OW) or 4
 * (UW) frames, when (FrameCounter & mask) = VScrollStartFrame; horizontal: every frame.
 * Internal labels: ScrollWorldDownOrH, ScrollWorldH, ScrollWorldRight.
 */
export function ScrollWorld() {
  // ScrollWorld (Z_05)
  let a = ram[FrameCounter] & 0x03;
  if (!$br('Z_05:561', ram[CurLevel] !== 0)) a &= 0x01;
  if ($br('Z_05:565', a !== ram[VScrollStartFrame])) return ScrollWorldH();
  if ($br('Z_05:568', (ram[ObjDir] & 0x08) === 0)) return ScrollWorldDownOrH();
  // Scroll up (from the top of NT 2 at $2800).
  ram[CurRow]--;
  if (!$br('Z_05:575', ram[ObjY] >= 0xdd)) ram[ObjY] += 0x08; // C = 0 after BCS not taken
  a = ram[VScrollAddrLo] - 0x20;
  ram[VScrollAddrLo] = a & 0xff;
  if (!$br('Z_05:583', a >= 0)) ram[VScrollAddrHi]--;
  a &= 0xff;
  if ($br('Z_05:587', a !== 0xe0)) return; // @Exit
  a = ram[VScrollAddrHi];
  if ($br('Z_05:590', a === 0x20)) {
    // @LimitLow: reached the status bar: stay at $2100.
    ram[VScrollAddrHi]++;
    return ResetVScrollLo();
  }
  if ($br('Z_05:592', a !== 0x27)) return;
  // $27E0: rolled from the top of NT 2 to the last row of NT 0 ($23A0).
  ram[VScrollAddrHi] = 0x23;
  ram[VScrollAddrLo] = 0xa0;
}

/** ResetVScrollLo (Z_05) */
export function ResetVScrollLo() {
  // ResetVScrollLo (Z_05)
  ram[VScrollAddrLo] = 0x00;
  return IncSubmode(); // falls through
}

/** IncSubmode (Z_05) */
export function IncSubmode() {
  // IncSubmode (Z_05)
  ram[GameSubmode]++;
}

/** ScrollWorldDownOrH (part of ScrollWorld, Z_05): A = 8 >> 1. */
function ScrollWorldDownOrH() {
  if ($br('Z_05:621', (ram[ObjDir] & 0x04) === 0)) return ScrollWorldH();
  // Scroll down.
  ram[CurRow]++;
  if (!$br('Z_05:627', ram[ObjY] < 0x3e)) ram[ObjY] -= 0x08; // C = 1 after BCC not taken
  let a = ram[VScrollAddrLo] + 0x20;
  ram[VScrollAddrLo] = a & 0xff;
  if (!$br('Z_05:635', a <= 0xff)) ram[VScrollAddrHi]++;
  a &= 0xff;
  if ($br('Z_05:639', a !== 0xc0)) return; // L14287_Exit
  if ($br('Z_05:642', ram[VScrollAddrHi] !== 0x23)) return;
  // $23C0, the bottom of NT 0: roll to $2800, the top of NT 2.
  ram[VScrollAddrHi] = 0x28;
  return ResetVScrollLo();
}

/** ScrollWorldH (part of ScrollWorld, Z_05): 2 pixels a frame (UW) or 4 (OW). */
function ScrollWorldH() {
  let a = 0x02;
  let x = 0xfe;
  if (!$br('Z_05:654', ram[CurLevel] !== 0)) {
    a = 0x04;
    x = 0xfc;
  }
  ram[0x00] = a; // speed
  ram[0x01] = x; // X position where NT 1 becomes the base nametable
  if ($br('Z_05:662', (ram[ObjDir] & 0x02) === 0)) return ScrollWorldRight();
  // Scroll left.
  ram[CurColumn]--;
  if (!$br('Z_05:668', ram[ObjX] >= 0xf0)) ram[ObjX] += ram[0x00];
  a = (ram[CurHScroll] - ram[0x00]) & 0xff;
  ram[CurHScroll] = a;
  if ($br('Z_05:676', a === 0)) return IncSubmode();
  if ($br('Z_05:678', a !== ram[0x01])) return; // L14287_Exit
  return SwitchToNT1();
}

/** SwitchToNT1 (Z_05): base the horizontal scroll position on NT 1. */
export function SwitchToNT1() {
  // SwitchToNT1 (Z_05)
  ram[OddBaseNameTableOverride] = 0x01;
}

/** ScrollWorldRight (part of ScrollWorld, Z_05): A = 2 >> 1. */
function ScrollWorldRight() {
  if ($br('Z_05:701', (ram[ObjDir] & 0x01) === 0)) return; // L14287_Exit
  ram[CurColumn]++;
  if (!$br('Z_05:705', ram[ObjX] < 0x01)) ram[ObjX] -= ram[0x00];
  const a = (ram[CurHScroll] + ram[0x00]) & 0xff;
  ram[CurHScroll] = a;
  if ($br('Z_05:713', a !== 0)) return;
  // The new room is fully shown with the old attributes: use NT 1 until they are copied.
  SwitchToNT1();
  return IncSubmode();
}
