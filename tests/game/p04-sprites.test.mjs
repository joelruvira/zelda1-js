// P04 unit tests that need neither the ROM nor jsnes (routines without ROM tables).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ram } from '../../src/core/ram.js';
import {
  Sprites, RollingSpriteIndex, FirstSpriteIndex, LeftSpriteOffset, RightSpriteOffset, ObjX, ObjY,
  ObjAnimCounter, ObjAnimFrame, ObjDir, ObjInvincibilityTimer,
} from '../../src/core/vars.js';
import {
  CycleSpriteIndexInA, CycleCurSpriteIndex, HideObjectSprites, HideSpritesOverLink,
  Anim_WriteSpritePair, Anim_WriteHorizontallyFlippableSpritePair, Anim_EndWriteSprite,
} from '../../src/game/draw/sprites.js';
import {
  Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor, SetUpWalkingSprites, RollOverAnimCounter,
} from '../../src/game/draw/anim.js';

test('CycleSpriteIndexInA wraps $27 -> 0 and stores RollingSpriteIndex', () => {
  assert.equal(CycleSpriteIndexInA(0x26), 0x27);
  assert.equal(ram[RollingSpriteIndex], 0x27);
  assert.equal(CycleCurSpriteIndex(), 0);
  assert.equal(ram[RollingSpriteIndex], 0);
  assert.equal(CycleSpriteIndexInA(0xff), 0); // ADC wraps to 0, not $28
});

test('HideObjectSprites hides records $60-$FC and advances FirstSpriteIndex', () => {
  ram.fill(0x11, Sprites, Sprites + 0x100);
  ram[FirstSpriteIndex] = 0x27;
  HideObjectSprites();
  for (let i = 0; i < 0x100; i++) assert.equal(ram[Sprites + i], i >= 0x60 && (i & 3) === 0 ? 0xf8 : 0x11);
  assert.equal(ram[FirstSpriteIndex], 0);
  assert.equal(ram[RollingSpriteIndex], 0);
  HideSpritesOverLink();
  assert.equal(ram[Sprites + 0x40], 0xf8);
  assert.equal(ram[Sprites + 0x44], 0xf8);
});

test('Anim_WriteSpritePair writes two records, flashes palette and cycles the index', () => {
  ram.fill(0, 0, 0x800);
  ram.set([0x30, 0x50, 0xa0, 0xa2, 0x41, 0x02, 0, 1, 5, 0, 8], 0); // [00]..[0A]
  ram[LeftSpriteOffset] = 0x60;
  ram[RightSpriteOffset] = 0x64;
  ram[ObjInvincibilityTimer + 5] = 0x07;
  ram[RollingSpriteIndex] = 3;
  assert.equal(Anim_WriteSpritePair(5), 5);
  assert.deepEqual([...ram.subarray(Sprites + 0x60, Sprites + 0x68)], [0x50, 0xa0, 0x43, 0x30, 0x50, 0xa2, 0x03, 0x38]);
  assert.equal(ram[0x00], 0x40);
  assert.equal(ram[0x07], 0xff);
  assert.equal(ram[RollingSpriteIndex], 5);
});

test('Anim_WriteHorizontallyFlippableSpritePair swaps sides when [0F] is set', () => {
  ram.fill(0, 0, 0x800);
  ram.set([0x30, 0x50, 0xa0, 0xa2, 0x01, 0x01, 0, 1, 0, 0, 8], 0);
  ram[0x0f] = 1;
  ram[LeftSpriteOffset] = 0x48;
  ram[RightSpriteOffset] = 0x4c;
  Anim_WriteHorizontallyFlippableSpritePair(0);
  assert.deepEqual([...ram.subarray(Sprites + 0x48, Sprites + 0x50)], [0x50, 0xa2, 0x41, 0x30, 0x50, 0xa0, 0x41, 0x38]);
  assert.equal(ram[RollingSpriteIndex], 0); // [08] = 0: no cycling
});

test('Anim_EndWriteSprite writes Y and [03] attributes', () => {
  ram[0x03] = 0x22;
  ram[RollingSpriteIndex] = 0x27;
  assert.equal(Anim_EndWriteSprite(0x77, 0x80), 0);
  assert.equal(ram[Sprites + 0x80], 0x77);
  assert.equal(ram[Sprites + 0x82], 0x22);
});

test('walking animation: counter rollover, position and flip', () => {
  ram.fill(0, 0, 0x800);
  ram[ObjX + 3] = 0x40;
  ram[ObjY + 3] = 0x60;
  ram[ObjAnimCounter + 3] = 1;
  ram[0x0f] = 9;
  assert.equal(Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor(0x0a, 3), 0);
  assert.equal(ram[ObjAnimCounter + 3], 0x0a);
  assert.equal(ram[ObjAnimFrame + 3], 1);
  assert.deepEqual([ram[0x00], ram[0x01], ram[0x0f]], [0x40, 0x60, 0]);
  ram[ObjDir + 3] = 0x02; // left
  assert.equal(SetUpWalkingSprites(3), 1);
  assert.equal(ram[0x0f], 1);
  ram[ObjDir + 3] = 0x04; // down
  assert.equal(SetUpWalkingSprites(3), 2);
  assert.equal(ram[0x0f], 1); // = ObjAnimFrame
  ram[0x00] = 6;
  assert.equal(RollOverAnimCounter(3), 0);
});
