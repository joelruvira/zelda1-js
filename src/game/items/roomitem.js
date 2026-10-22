// Stubs created by P23 until P10 ports these routines (docs/PORT_MAP.md rule 5).
import { stub, stubRegs } from '../stub.js';

export const AnimateItemObject = stub('AnimateItemObject');

// Stub created by P12 until P10 ports it. Contract: returns {a, y}:
// A = X coordinate, Y = Y coordinate of the shortcut (OW) or item (UW) of RoomId.
export const GetShortcutOrItemXY = stubRegs('GetShortcutOrItemXY');

// Stubs added by P05 (object dispatch / mode 5 loop) until P10 ports them (docs/PORT_MAP.md rule 5).
// stubX(name): called as fn(x) with X = object slot; stub(name): no parameters.
import { stubX } from '../stub.js';
export const GetRoomFlagUWItemState = stub('GetRoomFlagUWItemState');
export const CheckLiftItem = stub('CheckLiftItem');
export const MoveAndDrawRoomItem = stub('MoveAndDrawRoomItem');
export const UpdateItem = stubX('UpdateItem');
