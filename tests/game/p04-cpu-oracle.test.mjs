// P04: every ported routine vs. the original 6502 code (jsnes CPU, real ROM) on random RAM states.
// Compares the whole RAM (stack page excepted, incl. temporaries $00-$0F and OAM) and the output
// registers each routine documents. Skipped without roms/zelda.nes or jsnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRunCpuOracle, createCpuOracle, ramDiff, rng } from './p04-harness.mjs';
import * as S from '../../src/game/draw/sprites.js';
import * as I from '../../src/game/draw/items.js';
import * as A from '../../src/game/draw/anim.js';
import {
  ObjInvincibilityTimer, RollingSpriteIndex, ObjAnimCounter, ObjMetastate, ObjType, ObjAttr,
  LeftAlignHalfWidthObj, ObjDir,
} from '../../src/core/vars.js';

const ok = await canRunCpuOracle();
const skip = !ok && 'needs roms/zelda.nes and tools/oracle jsnes';
const N = 300;

// Random RAM with the fields that select code paths biased toward realistic values.
function randomState(r, { x = 0 } = {}) {
  const st = new Uint8Array(0x800);
  for (let i = 0; i < st.length; i++) st[i] = r.byte();
  st[RollingSpriteIndex] = r.chance(0.9) ? r.int(0x28) : r.byte();
  for (let i = 0; i < 0x14; i++) if (r.chance(0.6)) st[ObjInvincibilityTimer + i] = 0;
  if (r.chance(0.5)) st[LeftAlignHalfWidthObj] = 0;
  if (r.chance(0.3)) st[ObjAnimCounter + x] = 1;
  if (r.chance(0.2)) st[0x0f] = 0;
  if (r.chance(0.3)) st[0x0c] = 0;
  return st;
}

// [routine, regs(r) -> {a,x,y}, js(regs) -> ret, compared output register, extra state tweak]
const cases = [
  ['HideObjectSprites', () => ({}), () => S.HideObjectSprites(), null],
  ['CycleCurSpriteIndex', () => ({}), () => S.CycleCurSpriteIndex(), 'a'],
  ['CycleSpriteIndexInA', (r) => ({ a: r.byte() }), (g) => S.CycleSpriteIndexInA(g.a), 'a'],
  ['ResetCurSpriteIndex', () => ({}), () => S.ResetCurSpriteIndex(), 'a'],
  ['ShowLinkSpritesBehindHorizontalDoors', () => ({}), () => S.ShowLinkSpritesBehindHorizontalDoors(), null],
  ['WriteBlankPrioritySprites', () => ({}), () => S.WriteBlankPrioritySprites(), null],
  ['HideSpritesOverLink', () => ({}), () => S.HideSpritesOverLink(), null],
  ['Unused_HideSpritesOverLink_Bank5', () => ({}), () => S.Unused_HideSpritesOverLink_Bank5(), null],
  ['Anim_WriteHorizontallyFlippableSpritePair', (r) => ({ x: r.int(0x14) }), (g) => S.Anim_WriteHorizontallyFlippableSpritePair(g.x), 'x',
    (st, r) => { st[0x07] = r.int(2); }],
  ['Anim_WriteSpritePair', (r) => ({ x: r.int(0x14) }), (g) => S.Anim_WriteSpritePair(g.x), 'x', (st, r) => { st[0x07] = r.int(2); }],
  ['Anim_WriteSpritePairNotFlashing', (r) => ({ x: r.int(0x14) }), () => S.Anim_WriteSpritePairNotFlashing(), 'x', (st, r) => { st[0x07] = r.int(2); if (r.chance(0.3)) st[0x08] = 0; }],
  ['Anim_WriteMirroredSpritePair', (r) => ({ x: r.int(0x14) }), (g) => S.Anim_WriteMirroredSpritePair(g.x), 'x', (st, r) => { st[0x07] = r.int(2); }],
  ['Anim_SetSpriteDescriptorRedPaletteRow', () => ({}), () => S.Anim_SetSpriteDescriptorRedPaletteRow(), 'a'],
  ['Anim_SetSpriteDescriptorAttributes', (r) => ({ a: r.byte() }), (g) => S.Anim_SetSpriteDescriptorAttributes(g.a), 'a'],
  ['Anim_WriteLevelPaletteSprite', (r) => ({ a: r.byte(), x: r.int(0x14) }), (g) => S.Anim_WriteLevelPaletteSprite(g.a, g.x), 'a'],
  ['Anim_WriteSprite', (r) => ({ a: r.byte(), x: r.int(0x14) }), (g) => S.Anim_WriteSprite(g.a, g.x), 'a'],
  ['Anim_WriteSpecificSprite', (r) => ({ a: r.byte(), x: r.int(0x14), y: r.byte() & 0xfc }), (g) => S.Anim_WriteSpecificSprite(g.a, g.x, g.y), 'a'],
  ['Anim_EndWriteSprite', (r) => ({ a: r.byte(), y: r.byte() & 0xfc }), (g) => S.Anim_EndWriteSprite(g.a, g.y), 'a'],
  ['Anim_WriteStaticItemSpritesWithAttributes', (r) => ({ a: r.byte(), x: r.int(0x14), y: r.int(0x25) }), (g) => I.Anim_WriteStaticItemSpritesWithAttributes(g.a, g.x, g.y), 'x'],
  ['Anim_WriteItemSprites', (r) => ({ x: r.int(0x14), y: r.int(0x25) }), (g) => I.Anim_WriteItemSprites(g.x, g.y), 'x', (st, r) => { st[0x0c] = r.int(4); }],
  ['Anim_WriteSpecificItemSprites', (r) => ({ x: r.int(0x14), y: r.int(0x25) }), (g) => I.Anim_WriteSpecificItemSprites(g.x, g.y), 'x', (st, r) => { st[0x0c] = r.int(4); }],
  ['DrawObjectMirrored', (r) => ({ a: r.int(4), x: r.int(0x14) }), (g) => A.DrawObjectMirrored(g.a, g.x), 'x', typeTweak],
  ['DrawObjectNotMirrored', (r) => ({ a: r.int(4), x: r.int(0x14) }), (g) => A.DrawObjectNotMirrored(g.a, g.x), 'x', typeTweak],
  ['DrawObjectWithType', (r) => ({ a: r.int(4), x: r.int(0x14), y: r.int(0x7e) }), (g) => A.DrawObjectWithType(g.a, g.x, g.y), 'x', typeTweak],
  ['DrawObjectWithAnim', (r) => ({ a: r.int(4), x: r.int(0x14), y: r.int(0x7f) }), (g) => A.DrawObjectWithAnim(g.a, g.x, g.y), 'x', typeTweak],
  ['DrawObjectWithAnimAndSpecificSprites', (r) => ({ a: r.byte(), x: r.int(0x14) }), (g) => A.DrawObjectWithAnimAndSpecificSprites(g.a, g.x), 'x',
    (st, r, g) => { typeTweak(st, r, g); st[0x0e] = r.int(0x7f); st[0x0d] = r.int(4); }],
  ['DrawObjectNotMirroredOverLink', (r) => ({ a: r.int(4), x: r.int(0x14) }), (g) => A.DrawObjectNotMirroredOverLink(g.a, g.x), 'x', typeTweak],
  ['DrawObjectMirroredOverLink', (r) => ({ a: r.int(4), x: r.int(0x14) }), (g) => A.DrawObjectMirroredOverLink(g.a, g.x), 'x', typeTweak],
  ['Unused_DrawObjectNotMirroredOverLink_Bank5', (r) => ({ a: r.int(4), x: r.int(0x14) }), (g) => A.Unused_DrawObjectNotMirroredOverLink_Bank5(g.a, g.x), 'x', typeTweak],
  ['Unused_DrawObjectMirroredOverLink_Bank5', (r) => ({ a: r.int(4), x: r.int(0x14), y: r.int(2) }), (g) => A.Unused_DrawObjectMirroredOverLink_Bank5(g.a, g.x, g.y), 'x', typeTweak],
  // x != 0 or counter != 1 avoids AnimateLinkObjState (P08, still a stub).
  ['AnimateObjectWalking', (r) => ({ x: 1 + r.int(0x13) }), (g) => A.AnimateObjectWalking(g.x), 'y'],
  ['AnimateAndDrawObjectWalking', (r) => ({ x: 1 + r.int(0x13) }), (g) => A.AnimateAndDrawObjectWalking(g.x), 'x', typeTweak],
  ['SetUpWalkingSprites', (r) => ({ x: r.int(0x14) }), (g) => A.SetUpWalkingSprites(g.x), 'y', dirTweak],
  ['SetUpHorizontalWalkingSprites', (r) => ({ x: r.int(0x14) }), (g) => A.SetUpHorizontalWalkingSprites(g.x), 'y'],
  ['Anim_SetObjHFlipForSpriteDescriptor', (r) => ({ x: r.int(0x14) }), (g) => A.Anim_SetObjHFlipForSpriteDescriptor(g.x), 'a'],
  ['Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor', (r) => ({ a: r.byte(), x: r.int(0x14) }),
    (g) => A.Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(g.a, g.x), 'a'],
  ['Anim_FetchObjPosForSpriteDescriptor', (r) => ({ x: r.int(0x14) }), (g) => A.Anim_FetchObjPosForSpriteDescriptor(g.x), 'a'],
  ['RollOverAnimCounter', (r) => ({ x: r.int(0x14) }), (g) => A.RollOverAnimCounter(g.x), 'a'],
  // Metastates $10-$1F only: 1..$F calls DrawCloud (P09, still a stub).
  ['AnimateAndDrawMetaObject', (r) => ({ x: r.int(0x14) }), (g) => A.AnimateAndDrawMetaObject(g.x), null,
    (st, r, g) => { st[ObjMetastate + g.x] = 0x10 + r.int(0x10); if (r.chance(0.5)) st[0x28 + g.x] = 0; }],
];

function typeTweak(st, r, g) {
  if (g.x !== undefined) {
    st[ObjType + g.x] = r.int(0x7e);
    st[ObjAttr + g.x] = r.byte() & (r.chance(0.5) ? 0xf5 : 0xff);
  }
}
function dirTweak(st, r, g) {
  st[ObjDir + g.x] = [1, 2, 4, 8][r.int(4)];
}

test('P04 routines match the original 6502 code on random states', { skip }, async (t) => {
  const o = await createCpuOracle();
  for (const [name, regs, js, out, tweak] of cases) {
    await t.test(name, () => {
      const r = rng(0x1234 + name.length * 7919 + name.charCodeAt(5));
      for (let i = 0; i < N; i++) {
        const g = { a: 0, x: 0, y: 0, ...regs(r) };
        const st = randomState(r, g);
        tweak?.(st, r, g);
        const orig = o.run(name, st, g);
        const port = o.runPort(() => js(g), st);
        const d = ramDiff(port.ram, orig.ram);
        assert.deepEqual(d, [], `${name} case ${i} regs ${JSON.stringify(g)}`);
        if (out) assert.equal(port.ret, orig[out], `${name} case ${i}: register ${out}`);
      }
    });
  }
});
