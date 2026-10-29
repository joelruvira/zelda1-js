// P22: every bosses-B routine (Moldorm, Gleeok and its heads, Patra and its children, Ganon, Zelda, the
// guard fires, the Z_01 palette-row helpers) vs. the original 6502 code (jsnes CPU, real ROM) on random
// states. The routines P22 calls in other packages run as their real JS ports (integration), so a
// divergence comes from P22 or from what it calls. Compares the whole RAM (stack page excepted), the
// SRAM and the output registers. Every entry point and every internal label is run on its own.
// Skipped without roms/zelda.nes or jsnes. P22_N = states per routine, P22_ONLY = a,b to filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunP08Oracle, createP08Oracle, memDiff } from './p08-harness.mjs';
import { rng } from './p04-harness.mjs';

const ok = await canRunP08Oracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = Number(process.env.P22_N ?? 200);

const V = ok ? await import('../../src/core/vars.js') : {};
const { ram, sram, cpu } = await import('../../src/core/ram.js');
const { switchBank } = await import('../../src/core/asm.js');
const { bus } = await import('../../src/core/bus.js');
const imp = async (p) => (ok ? import(p) : {});
const MO = await imp('../../src/game/bosses/moldorm.js');
const GL = await imp('../../src/game/bosses/gleeok.js');
const PA = await imp('../../src/game/bosses/patra.js');
const GA = await imp('../../src/game/bosses/ganon.js');
const ZE = await imp('../../src/game/bosses/zelda.js');

const DIRS = [1, 2, 4, 8];
const DIRS8 = [...DIRS, 5, 6, 9, 10];
const pick = (r, arr) => arr[r.int(arr.length)];
const UW_TILES = [0x74, 0x76, 0x78, 0x7a, 0xb0, 0xb4, 0xf4, 0xf8, 0x68, 0x6c, 0xaa];

// A random but plausible mode-5 UW state: Link in slot 0, weapons and objects in the other slots.
function randomState(r, o) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  const sr = o.baseSram();
  for (let i = 0x530; i < 0x7f0; i++) sr[i] = r.chance(0.6) ? pick(r, UW_TILES) : r.byte();
  for (let i = 0x87e; i < 0xc90; i++) sr[i] = r.byte();
  st[V.CurLevel] = r.chance(0.9) ? 1 + r.int(9) : 0;
  st[V.GameMode] = 5;
  st[V.CurSaveSlot] = r.int(3);
  st[V.QuestNumbers + st[V.CurSaveSlot]] = r.chance(0.5) ? 0 : 1;
  st[V.ObjX] = r.chance(0.5) ? pick(r, [0x60, 0x80, 0x78, 0x40]) : r.byte();
  st[V.ObjY] = r.chance(0.5) ? pick(r, [0x5d, 0x7d, 0x8d, 0xad]) : r.byte();
  st[V.ObjDir] = pick(r, DIRS);
  st[V.ObjState] = r.chance(0.7) ? 0 : pick(r, [0x40, r.byte()]);
  st[V.ObjInvincibilityTimer] = r.chance(0.6) ? 0 : r.byte();
  st[V.ObjStunTimer] = r.chance(0.8) ? 0 : r.byte();
  st[V.LinkParalyzed] = r.chance(0.8) ? 0 : r.byte();
  for (let i = 1; i < 0x14; i++) {
    st[V.ObjType + i] = r.chance(0.4) ? 0 : r.int(0x5d);
    st[V.ObjDir + i] = r.chance(0.8) ? pick(r, DIRS8) : r.int(16);
    st[V.ObjMetastate + i] = r.chance(0.8) ? 0 : r.byte();
    st[V.ObjShoveDir + i] = r.chance(0.7) ? 0 : r.byte();
    st[V.ObjStunTimer + i] = r.chance(0.8) ? 0 : r.byte();
    st[V.ObjInvincibilityTimer + i] = r.chance(0.7) ? 0 : r.byte();
    st[V.ObjTimer + i] = r.chance(0.5) ? 0 : r.byte();
    if (r.chance(0.5)) {
      st[V.ObjX + i] = (st[V.ObjX] + r.int(0x30) - 0x18) & 0xff;
      st[V.ObjY + i] = (st[V.ObjY] + r.int(0x30) - 0x18) & 0xff;
    }
  }
  // Weapons: sometimes active right on top of the monsters.
  for (const w of [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12]) {
    if (r.chance(0.5)) st[V.ObjState + w] = 0;
    else if (w === 0x0d) st[V.ObjState + w] = r.chance(0.6) ? 2 : r.byte();
    else if (w === 0x12) st[V.ObjState + w] = r.chance(0.6) ? 0x10 : r.byte();
  }
  st[V.Items] = 1 + r.int(3);
  st[V.InvClock] = r.chance(0.8) ? 0 : 1;
  st[V.ActiveMonsterShots] = r.int(6);
  st[V.ObjectFirstUnwalkableTile] = pick(r, [0x78, 0x84, 0x89]);
  st[V.DynTileBufLen] = r.chance(0.7) ? r.int(0x30) : r.byte();
  st[V.CandleState] = r.int(3);
  st[V.InvArrow] = r.chance(0.7) ? 2 : r.int(3);
  return { st, sr };
}

const RA = (ret, o) => assert.equal(ret & 0xff, o.a, 'register A');
const RX = (ret, o) => assert.equal(ret & 0xff, o.x, 'register X');
const RXY = (ret, o) => { assert.equal(ret.x, o.x, 'register X'); assert.equal(ret.y, o.y, 'register Y'); };

const mix = (...fs) => (st, sr, r, g) => { for (const f of fs) f(st, sr, r, g); };
const slotIn = (lo, hi) => (r) => ({ x: lo + r.int(hi - lo + 1) });
const near = (st, r, i, j, d = 0x10) => {
  st[V.ObjX + i] = (st[V.ObjX + j] + r.int(2 * d) - d) & 0xff;
  st[V.ObjY + i] = (st[V.ObjY + j] + r.int(2 * d) - d) & 0xff;
};
// A weapon (sword / arrow) on top of slot i.
const weaponsOn = (st, r, i) => {
  if (r.chance(0.5)) { near(st, r, 0x0d, i, 8); st[V.ObjState + 0x0d] = 2; }
  if (r.chance(0.5)) { near(st, r, 0x12, i, 8); st[V.ObjState + 0x12] = 0x10; }
  if (r.chance(0.3)) { st[V.ObjX] = st[V.ObjX + i]; st[V.ObjY] = st[V.ObjY + i]; }
};

const moldorm = (st, sr, r, g) => {
  for (let i = 1; i <= 10; i++) {
    st[V.ObjType + i] = r.chance(0.85) ? 0x41 : 0x5d;
    st[V.Flyer_ObjFlyingState + i] = r.int(4);
    st[V.Moldorm_ObjOldDir + i] = pick(r, DIRS8);
    if (r.chance(0.3)) st[V.ObjDir + i] = 0;
    if (r.chance(0.5)) st[V.ObjTimer + i] = pick(r, [0, 0x10, 0x11, 1]);
    if (r.chance(0.5)) st[V.Moldorm_ObjBounceDir + i] = r.chance(0.5) ? 0 : pick(r, DIRS8);
    if (r.chance(0.5)) st[V.Flyer_ObjTurns + i] = r.int(3);
    if (r.chance(0.5)) st[V.Flyer_ObjSpeed + i] = pick(r, [0x80, 0x7f, 0x81]);
  }
  st[V.ObjType + 5] = 0x41; st[V.ObjType + 10] = 0x41;
  if (r.chance(0.5)) st[V.ObjType + 1] = 0x41;
  if (r.chance(0.5)) st[V.ObjType + 6] = 0x41;
  st[V.FlyingMaxSpeedFrac] = 0x80;
  if (r.chance(0.5)) st[V.InvClock] = 0;
  if (g.x >= 1 && g.x <= 10) {
    if (r.chance(0.4)) st[V.ObjMetastate + g.x] = 0;
    if (r.chance(0.5)) st[V.ObjInvincibilityTimer + g.x] = 0;
    if (r.chance(0.5)) st[V.ObjDir + g.x] = pick(r, DIRS8);
    if (r.chance(0.5)) weaponsOn(st, r, g.x);
    if (r.chance(0.3)) { st[V.ObjHP + g.x] = 0; st[V.ObjAttr + g.x] &= ~0x20; }
  }
};

const gleeokNecks = (st, sr, r) => {
  const necks = [[V.Gleeok_NeckXs0, V.Gleeok_NeckYs0, V.Gleook_HeadInfo0], [V.Gleeok_NeckXs1, V.Gleeok_NeckYs1, V.Gleook_HeadInfo1],
    [V.Gleeok_NeckXs2, V.Gleeok_NeckYs2, V.Gleook_HeadInfo2], [V.Gleeok_NeckXs3, V.Gleeok_NeckYs3, V.Gleook_HeadInfo3]];
  for (const [xs, ys, info] of necks) {
    for (let s = 0; s < 6; s++) {
      if (r.chance(0.8)) st[xs + s] = 0x7c + r.int(0x40) - 0x20;
      if (r.chance(0.8)) st[ys + s] = 0x6f + s * 5 + r.int(0x20) - 0x10;
    }
    if (r.chance(0.8)) st[xs] = 0x7c;
    if (r.chance(0.8)) st[ys] = 0x6f;
    if (r.chance(0.7)) {
      st[info + 0] = r.int(0x0d); st[info + 1] = r.int(7);
      st[info + 2] = r.chance(0.5) ? 0 : 0xff; st[info + 3] = r.chance(0.5) ? 0 : 0xff;
      st[info + 4] = r.int(5); st[info + 5] = r.chance(0.6) ? 0 : r.int(0x30);
    }
  }
};
const gleeok = (st, sr, r) => {
  st[V.ObjType + 1] = 0x42 + r.int(4); // other values make UpdateGleeok follow garbage neck pointers into I/O
  const n = st[V.ObjType + 1] - 0x41;
  st[V.GleeokCurNeck] = r.chance(0.9) ? r.int(Math.max(1, Math.min(4, n))) : r.byte();
  st[V.GleeokDeadNeckMask] = r.chance(0.5) ? 0 : r.int(16);
  if (r.chance(0.6)) st[V.GleeokAnimationTimer] = r.int(3);
  if (r.chance(0.6)) st[V.Gleeok_WrithingCounter] = r.int(3);
  if (r.chance(0.6)) st[V.GleeokBodyAnimationFrame] = r.int(4);
  if (r.chance(0.5)) st[V.ObjInvincibilityTimer + 5] = 0;
  if (r.chance(0.5)) st[V.ObjInvincibilityTimer + 1] = 0;
  if (r.chance(0.5)) st[V.Random + 5] = r.int(0x40);
  if (r.chance(0.5)) st[V.ObjType + 11] = 0;
  gleeokNecks(st, sr, r);
  // Slots 1-6 as UpdateGleeok loads them.
  for (let s = 0; s < 6; s++) {
    if (r.chance(0.7)) st[V.ObjX + 1 + s] = 0x7c + r.int(0x40) - 0x20;
    if (r.chance(0.7)) st[V.ObjY + 1 + s] = 0x6f + s * 5 + r.int(0x20) - 0x10;
    if (r.chance(0.5)) st[V.ObjMetastate + 1 + s] = 0;
    st[V.ObjInvincibilityMask + 1 + s] = 0xfe;
    if (r.chance(0.5)) st[V.ObjHP + 1 + s] = r.chance(0.5) ? 0 : 0xa0;
  }
  if (r.chance(0.5)) st[V.ObjAttr + 5] &= ~0x20;
  for (let i = 0; i < 6; i++) if (r.chance(0.6)) st[V.Gleeok_ObjHeadInfo + i] = [r.int(0x0d), r.int(7), r.chance(0.5) ? 0 : 0xff, r.chance(0.5) ? 0 : 0xff, r.int(5), r.chance(0.6) ? 0 : r.int(4)][i];
  if (r.chance(0.5)) weaponsOn(st, r, 5);
  else if (r.chance(0.3)) weaponsOn(st, r, 1);
  for (let k = 0; k < 2; k++) st[V.GleeokPrimarySegmentLimits + k] = r.chance(0.7) ? r.int(5) : r.byte();
  for (let k = 0; k < 2; k++) st[V.GleeokSecondarySegmentLimits + k] = r.chance(0.7) ? 4 + r.int(5) : r.byte();
  for (let k = 0; k < 2; k++) st[V.GleeokTertiarySegmentLimits + k] = r.chance(0.7) ? 8 + r.int(4) : r.byte();
};
const gleeokHead = (st, sr, r, g) => {
  st[V.ObjType + g.x] = 0x46;
  st[V.Flyer_ObjFlyingState + g.x] = r.int(4);
  if (r.chance(0.5)) st[V.ObjTimer + g.x] = 0;
  if (r.chance(0.5)) st[V.Flyer_ObjTurns + g.x] = r.int(3);
  st[V.FlyingMaxSpeedFrac] = 0xe0;
  if (r.chance(0.5)) st[V.Random + 1 + g.x] = r.int(0x40);
  if (r.chance(0.5)) st[V.ObjType + 11] = 0;
  if (r.chance(0.5)) weaponsOn(st, r, g.x);
};

const patra = (st, sr, r, g) => {
  st[V.ObjType + 1] = pick(r, [0x47, 0x48]);
  const ct = st[V.ObjType + 1] === 0x47 ? 0x25 : 0x26;
  const kids = r.chance(0.3) ? 0 : r.int(9);
  for (let i = 2; i <= 9; i++) st[V.ObjType + i] = i - 2 < kids ? (r.chance(0.8) ? ct : pick(r, [0x25, 0x26])) : (r.chance(0.5) ? 0 : 0x5d);
  for (let i = 1; i <= 9; i++) {
    if (r.chance(0.5)) st[V.ObjState + i] = r.int(2);
    if (r.chance(0.5)) st[V.ObjAngleWhole + i] = r.chance(0.5) ? pick(r, [0, 0x18, 0x14, 0x10, 0x0c, 0x08, 0x04, 0x1c]) : r.int(0x20);
  }
  if (r.chance(0.4)) st[V.ObjAngleWhole + 3] = 0;
  if (r.chance(0.4)) st[V.ObjTimer + 2] = 0;
  if (r.chance(0.3)) st[V.ObjTimer + 1 + (g.x ?? 1)] = 0;
  st[V.Patra_ObjManeuverIndex + 1] = r.chance(0.9) ? r.int(2) : r.byte();
  if (r.chance(0.5)) st[V.Patra_ObjManeuverIndex + (g.x ?? 1)] = r.int(2);
  st[V.Flyer_ObjFlyingState + 1] = r.int(4);
  if (r.chance(0.5)) st[V.Flyer_ObjOffsetX + 1] = r.int(5) - 2;
  if (r.chance(0.5)) st[V.Flyer_ObjOffsetY + 1] = r.int(5) - 2;
  st[V.FlyingMaxSpeedFrac] = 0x40;
  if (r.chance(0.5)) st[V.ObjQSpeedFrac + (g.x ?? 1)] = 0x20;
  if (g.x && r.chance(0.5)) weaponsOn(st, r, g.x);
  if (g.x && r.chance(0.4)) st[V.ObjMetastate + g.x] = 0;
  if (g.x && r.chance(0.3)) { st[V.ObjInvincibilityTimer + g.x] = 0; st[V.ObjHP + g.x] = 0; }
};

// LevelInfo_WorldFlagsAddr -> one of the WorldFlags blocks in RAM (a random pointer may hit I/O).
const worldFlags = (sr, r) => {
  const a = pick(r, [0x067f, 0x06ff, 0x077f]);
  sr[0xbaf] = a & 0xff;
  sr[0xbb0] = a >> 8;
};
const ganon = (st, sr, r, g) => {
  const x = g.x ?? 1;
  st[V.ObjType + x] = 0x3e;
  st[V.CurObjIndex] = r.chance(0.85) ? x : 1 + r.int(11);
  st[V.Ganon_ScenePhase] = r.int(3); // other values jump to garbage through UpdateGanon_JumpTable
  st[V.ObjState + x] = r.chance(0.5) ? 0 : pick(r, [0xff, 0x30, 0x2f, 1, 2, r.byte()]);
  st[V.ObjTimer + x] = pick(r, [0, 0, 1, 2, 0x40, r.byte()]);
  st[V.Ganon_ObjPhase + x] = r.chance(0.5) ? 0 : pick(r, [0x4f, 0x50, 0x9f, 0xa0, 0xa1, 0xff, r.byte()]);
  st[V.Ganon_ObjCloudDist + x] = r.int(10);
  st[V.Ganon_ObjAnimationFrame + x] = r.chance(0.9) ? r.int(6) : r.byte();
  st[V.ObjTimer] = pick(r, [0, 0, 1, 2, 0x40, r.byte()]);
  st[V.FadeCycle] = pick(r, [0xc0, 0xc4, 0xc1, 0xd4, r.byte()]);
  st[V.ObjState + 19] = r.chance(0.5) ? 0xff : r.byte();
  if (r.chance(0.5)) st[V.ObjMetastate + x] = 0;
  if (r.chance(0.5)) st[V.ObjInvincibilityTimer + x] = 0;
  if (r.chance(0.3)) st[V.ObjHP + x] = 0;
  if (r.chance(0.6)) weaponsOn(st, r, x);
  if (r.chance(0.3)) { st[V.ObjX + 0x12] = st[V.ObjX + x] + 8 + r.int(8); st[V.ObjY + 0x12] = st[V.ObjY + x] + 8 + r.int(8); st[V.ObjState + 0x12] = 0x10; }
  if (r.chance(0.5)) st[V.FrameCounter] = pick(r, [0, 0x40, 0x80, 1, 8, r.byte()]);
  worldFlags(sr, r);
};

const zelda = (st, sr, r, g) => {
  const x = g.x ?? 1;
  st[V.ObjType + x] = 0x37;
  st[V.ObjState + x] = r.chance(0.6) ? 0 : r.chance(0.8) ? 1 : r.byte();
  st[V.ObjTimer + x] = pick(r, [0, 0, 1, 0x80, r.byte()]);
  if (r.chance(0.6)) { st[V.ObjX] = 0x6f + r.int(0x14); st[V.ObjY] = pick(r, [0x95, 0x95, 0x94, 0x96]); }
  // UpdateZelda_State1 reads the timer of the slot Link's drawing leaves in X (0, 1 or 5).
  st[V.InvMagicShield] = r.chance(0.5) ? 0 : 1;
  st[V.WhirlwindTeleportingState] = r.chance(0.85) ? 0 : 1 + r.int(2);
  for (const i of [0, 1, 5]) st[V.ObjTimer + i] = pick(r, [0, 0, 1, 0x80]);
};
const fire = (st, sr, r, g) => {
  st[V.ObjType + g.x] = 0x3f;
  if (r.chance(0.6)) weaponsOn(st, r, g.x);
  if (r.chance(0.5)) st[V.ObjMetastate + g.x] = 0;
  if (r.chance(0.5)) st[V.ObjInvincibilityTimer + g.x] = 0;
};
const cur = (st, sr, r, g) => { if (g.x !== undefined) st[V.CurObjIndex] = g.x; };

const slot = slotIn(1, 0x0b);
const seg = slotIn(1, 10);
const seg02 = slotIn(0, 2);
const head = slotIn(7, 10);
const none = () => ({});
const xy = (r) => ({ x: r.int(3), y: r.byte() });
const C = mix(cur);

// [routine, bank mapped by the caller, regs(r), js(regs) -> ret, compare(ret, orig), tweak]
const cases = [
  // Moldorm
  ['InitMoldorm', 4, slotIn(1, 1), () => MO.InitMoldorm(), null, moldorm],
  ['UpdateMoldorm', 4, seg, (g) => MO.UpdateMoldorm(g.x), null, mix(cur, moldorm)],
  ['ControlMoldormFlight', 4, seg, (g) => MO.ControlMoldormFlight(g.x), null, moldorm],
  ['Moldorm_Chase', 4, seg, (g) => MO.Moldorm_Chase(g.x), null, moldorm],
  ['Moldorm_ChangeFlyingState', 4, (r) => ({ x: pick(r, [5, 10]) }), (g) => MO.Moldorm_ChangeFlyingState(g.x), null, moldorm],
  ['Moldorm_Wander', 4, seg, (g) => MO.Moldorm_Wander(g.x), null, moldorm],
  ['Moldorm_PropagateDirs', 4, (r) => ({ x: pick(r, [5, 10]) }), (g) => MO.Moldorm_PropagateDirs(g.x), null, moldorm],
  ['L1156B_Exit', 4, seg, () => MO.L1156B_Exit(), null, moldorm],
  ['Flyer_MoldormDecideState', 4, seg, (g) => MO.Flyer_MoldormDecideState(g.x), RA, moldorm],
  // Gleeok
  ['InitGleeok', 4, slotIn(1, 1), () => GL.InitGleeok(), null, gleeok],
  ['InitGleeokHead', 4, head, (g) => GL.InitGleeokHead(g.x), null, gleeokHead],
  ['UpdateGleeokHead', 4, head, (g) => GL.UpdateGleeokHead(g.x), null, mix(cur, gleeokHead)],
  ['ControlGleeokHeadFlight', 4, head, (g) => GL.ControlGleeokHeadFlight(g.x), null, gleeokHead],
  ['Flyer_GleeokHeadDecideState', 4, head, (g) => GL.Flyer_GleeokHeadDecideState(g.x), null, gleeokHead],
  ['UpdateGleeok', 4, slotIn(1, 1), () => GL.UpdateGleeok(), null, mix(cur, gleeok)],
  ['Gleeok_FetchNeckAddrs', 4, none, () => GL.Gleeok_FetchNeckAddrs(), RXY, gleeok],
  ['Gleeok_MoveNeck', 4, none, () => GL.Gleeok_MoveNeck(), null, gleeok],
  ['L_Gleeok_UDiv4', 4, (r) => ({ a: r.byte() }), (g) => GL.L_Gleeok_UDiv4(g.a), null, gleeok],
  // L_Gleeok_StoreRefSegDistance's Abs branches on the N flag its callers leave (the harness cannot set
  // it): covered through Gleeok_MoveNeck (both signs) and L_Gleeok_UDiv4.
  ['Gleeok_CalcSegmentLimits', 4, (r) => ({ a: r.chance(0.7) ? r.int(0x10) : r.byte(), x: r.int(2) }), (g) => GL.Gleeok_CalcSegmentLimits(g.a, g.x), RA, gleeok],
  ['Gleeok_StretchNeck', 4, seg02, (g) => GL.Gleeok_StretchNeck(g.x), null, gleeok],
  ['Gleeok_ExpandSegment', 4, seg02, (g) => GL.Gleeok_ExpandSegment(g.x), null, gleeok],
  ['L_Gleeok_DecSegmentY', 4, xy, (g) => GL.L_Gleeok_DecSegmentY(g.x, g.y), null, gleeok],
  ['L_Gleeok_SetSegmentY', 4, xy, (g) => GL.L_Gleeok_SetSegmentY(g.x, g.y), null, gleeok],
  ['Gleeok_IgnoreSegment', 4, none, () => GL.Gleeok_IgnoreSegment(), null, gleeok],
  ['Gleeok_ContractSegmentY', 4, seg02, (g) => GL.Gleeok_ContractSegmentY(g.x), null, gleeok],
  ['L_Gleeok_ExpandHorizontally', 4, seg02, (g) => GL.L_Gleeok_ExpandHorizontally(g.x), null, gleeok],
  ['Gleeok_ContractSegmentX', 4, seg02, (g) => GL.Gleeok_ContractSegmentX(g.x), null, gleeok],
  ['L_Gleeok_DecSegmentX', 4, xy, (g) => GL.L_Gleeok_DecSegmentX(g.x, g.y), null, gleeok],
  ['L_Gleeok_SetSegmentX', 4, xy, (g) => GL.L_Gleeok_SetSegmentX(g.x, g.y), null, gleeok],
  ['Gleeok_ContractSegment', 4, seg02, (g) => GL.Gleeok_ContractSegment(g.x), null, gleeok],
  ['Gleeok_WriteHeadOrBaseSpriteAndCheckCollisions', 4, (r) => ({ a: r.byte(), x: pick(r, [1, 5, 1 + r.int(5)]) }),
    (g) => GL.Gleeok_WriteHeadOrBaseSpriteAndCheckCollisions(g.a, g.x), null, gleeok],
  ['Gleeok_DrawHeadAndCheckCollisions', 4, none, () => GL.Gleeok_DrawHeadAndCheckCollisions(), null, gleeok],
  ['Gleeok_DrawSegmentAndCheckCollisions', 4, slotIn(1, 5), (g) => GL.Gleeok_DrawSegmentAndCheckCollisions(g.x), null, gleeok],
  ['Gleeok_CheckCollisions', 4, slotIn(1, 5), (g) => GL.Gleeok_CheckCollisions(g.x), null, gleeok],
  ['Gleeok_MoveHead', 4, none, () => GL.Gleeok_MoveHead(), null, gleeok],
  ['L127FA_Exit', 4, none, () => GL.L127FA_Exit(), null, gleeok],
  ['Gleeok_DecHeadTimer', 4, none, () => GL.Gleeok_DecHeadTimer(), null, gleeok],
  // Gleeok_ChangeCoordinateBySpeedFlag branches on the Z flag of the caller's LDY (the harness cannot
  // set it): it is covered through Gleeok_MoveHead.
  ['L_Gleeok_DecAnimTimerAndDraw', 4, none, () => GL.L_Gleeok_DecAnimTimerAndDraw(), RX, gleeok],
  ['Gleeok_DrawBody', 4, none, () => GL.Gleeok_DrawBody(), RX, gleeok],
  ['L_Gleeok_WriteSprites', 4, none, () => GL.L_Gleeok_WriteSprites(), RX, gleeok],
  // Patra
  ['InitPatra', 4, slotIn(1, 1), (g) => PA.InitPatra(g.x), null, patra],
  ['UpdatePatra', 4, slotIn(1, 1), (g) => PA.UpdatePatra(g.x), null, mix(cur, patra)],
  ['ControlPatraFlight', 4, slotIn(1, 1), (g) => PA.ControlPatraFlight(g.x), null, patra],
  ['Flyer_PatraDecideState', 4, slotIn(1, 1), (g) => PA.Flyer_PatraDecideState(g.x), RA, patra],
  ['UpdatePatraChild', 4, slotIn(2, 9), (g) => PA.UpdatePatraChild(g.x), null, mix(cur, patra)],
  ['PatraChild_State1', 4, slotIn(2, 9), (g) => PA.PatraChild_State1(g.x), null, mix(cur, patra)],
  ['PatraChild_Draw', 4, slotIn(2, 9), (g) => PA.PatraChild_Draw(g.x), null, patra],
  // Zelda and the guard fires
  ['InitZelda', 4, slotIn(1, 1), () => ZE.InitZelda(), null, zelda],
  ['UpdateZelda', 4, slotIn(1, 1), (g) => ZE.UpdateZelda(g.x), null, zelda],
  ['L129B7_Exit', 4, slotIn(1, 1), () => ZE.L129B7_Exit(), null, zelda],
  ['UpdateZelda_State1', 4, slotIn(1, 1), (g) => ZE.UpdateZelda_State1(g.x), null, zelda],
  ['UpdateGuardFire', 4, slotIn(2, 5), (g) => ZE.UpdateGuardFire(g.x), null, mix(cur, fire)],
  ['SetDeadDummyObjType', 4, slot, (g) => ZE.SetDeadDummyObjType(g.x), RA, fire],
  ['L129EA_Exit', 4, slot, () => ZE.L129EA_Exit(), null, fire],
  // Ganon
  ['InitGanon', 4, slotIn(1, 1), (g) => GA.InitGanon(g.x), null, ganon],
  ['UpdateGanon', 4, slotIn(1, 1), (g) => GA.UpdateGanon(g.x), null, ganon],
  ['Ganon_ScenePhase0', 4, slotIn(1, 1), (g) => GA.Ganon_ScenePhase0(g.x), null, ganon],
  ['Ganon_ScenePhase1', 4, slotIn(1, 1), (g) => GA.Ganon_ScenePhase1(g.x), null, ganon],
  ['Ganon_DrawBodyFrame0', 4, slotIn(1, 1), (g) => GA.Ganon_DrawBodyFrame0(g.x), null, ganon],
  ['Ganon_ScenePhase2', 4, slotIn(1, 1), (g) => GA.Ganon_ScenePhase2(g.x), null, ganon],
  ['Ganon_RandomizeLocation', 4, slotIn(1, 1), (g) => GA.Ganon_RandomizeLocation(g.x), RA, ganon],
  ['Ganon_MoveAndShoot', 4, slotIn(1, 1), (g) => GA.Ganon_MoveAndShoot(g.x), null, ganon],
  ['Ganon_UpdateBrownState', 4, slotIn(1, 1), (g) => GA.Ganon_UpdateBrownState(g.x), null, ganon],
  ['L_Ganon_DrawBody', 4, slotIn(1, 1), (g) => GA.L_Ganon_DrawBody(g.x), null, ganon],
  ['Ganon_Dying', 4, slotIn(1, 1), (g) => GA.Ganon_Dying(g.x), null, ganon],
  ['Ganon_SetUpBurstRays', 4, slotIn(1, 1), (g) => GA.Ganon_SetUpBurstRays(g.x), null, ganon],
  ['Ganon_DrawCloud', 4, slotIn(1, 1), (g) => GA.Ganon_DrawCloud(g.x), RA, ganon],
  ['Ganon_DrawBurst', 4, slotIn(1, 1), (g) => GA.Ganon_DrawBurst(g.x), null, ganon],
  ['Ganon_GetCurCloudLeft', 4, slotIn(1, 1), (g) => GA.Ganon_GetCurCloudLeft(g.x), RA, ganon],
  ['Ganon_GetCurCloudRight', 4, slotIn(1, 1), (g) => GA.Ganon_GetCurCloudRight(g.x), RA, ganon],
  ['Ganon_GetCurCloudTop', 4, slotIn(1, 1), (g) => GA.Ganon_GetCurCloudTop(g.x), RA, ganon],
  ['Ganon_GetCurCloudBottom', 4, slotIn(1, 1), (g) => GA.Ganon_GetCurCloudBottom(g.x), RA, ganon],
  ['Ganon_DrawBody', 4, slotIn(1, 1), (g) => GA.Ganon_DrawBody(g.x), null, ganon],
  ['Ganon_CheckCollisions', 4, slotIn(1, 1), (g) => GA.Ganon_CheckCollisions(g.x), RX, ganon],
  ['Ganon_AppendPaletteRowTransferRecord_Brown', 4, slot, () => GA.Ganon_AppendPaletteRowTransferRecord_Brown(), RX, C],
  ['Ganon_AppendPaletteRowTransferRecord_Blue', 4, slot, () => GA.Ganon_AppendPaletteRowTransferRecord_Blue(), RX, C],
  ['Ganon_AppendPaletteRowTransferRecord_Triforce', 4, slot, () => GA.Ganon_AppendPaletteRowTransferRecord_Triforce(), RX, C],
  ['Ganon_DrawAshes', 4, slotIn(1, 1), (g) => GA.Ganon_DrawAshes(g.x), null, ganon],
  ['Ganon_ActivateRoomItem', 4, slotIn(1, 1), () => GA.Ganon_ActivateRoomItem(), null, ganon],
  // Z_01 palette rows (bank 1)
  ['ReplaceGanonBrownPaletteRow', 1, slot, () => GA.ReplaceGanonBrownPaletteRow(), RX, C],
  ['ReplaceGanonBluePaletteRow', 1, slot, () => GA.ReplaceGanonBluePaletteRow(), RX, C],
  ['ReplaceAshesPaletteRow', 1, slot, () => GA.ReplaceAshesPaletteRow(), RX, C],
  ['Unused_DrawAshes_Bank1', 1, slotIn(1, 1), (g) => GA.Unused_DrawAshes_Bank1(g.x), null, ganon],
  ['Unused_ActivateRoomItem_Bank1', 1, slotIn(1, 1), () => GA.Unused_ActivateRoomItem_Bank1(), null, ganon],
];

test('P22 routines match the original 6502 code on random states', { skip, timeout: 3600000 }, async (t) => {
  const o = await createP08Oracle();
  for (const [name, bank, regs, js, cmp, tweak] of cases) {
    if (process.env.P22_ONLY && !process.env.P22_ONLY.split(',').includes(name)) continue;
    await t.test(name, async () => {
      const r = rng(0x22 + name.length * 7919 + name.charCodeAt(3) * 31 + name.charCodeAt(name.length - 1));
      let hung = 0;
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, c: 0, ...regs(r) };
        const { st, sr } = randomState(r, o);
        tweak?.(st, sr, r, g);
        let orig;
        try {
          orig = o.run(name, st, sr, bank, g);
        } catch (e) {
          if (!/did not return|Game crashed/.test(e.message)) throw e;
          hung++;
          continue;
        }
        ram.set(st);
        sram.set(sr);
        bus.mapper.shift = 0x10;
        switchBank(bank);
        cpu.c = g.c;
        let ret;
        try {
          ret = js(g);
        } catch (e) {
          if (/did not return/.test(e.message)) { hung++; continue; }
          throw e;
        }
        const d = [...memDiff(ram, orig.ram), ...memDiff(sram, orig.sram, 0x6000)];
        if (d.length && process.env.P22_DUMP) (await import('node:fs')).writeFileSync(process.env.P22_DUMP, JSON.stringify({ name, st: [...st], sr: [...sr], g }));
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        cmp?.(ret, orig);
      }
      assert.ok(hung <= N / 4, `${name}: ${hung}/${N} random states hang the original`);
      if (hung) t.diagnostic(`${name}: ${hung}/${N} states skipped (the original does not return)`);
    });
  }
});
