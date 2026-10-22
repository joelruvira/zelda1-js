// P17: hand-checked unit tests of the enemy-core routines that need no ROM data (rotation arithmetic,
// flyer states, shot bookkeeping). The full comparison with the original code is p17-routines.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ram, cpu } from '../../src/core/ram.js';
import {
  ObjAngleFrac, ObjAngleWhole, Flyer_ObjSpeed, Flyer_ObjFlyingState, FlyingMaxSpeedFrac, ObjTimer, Random,
  ObjDir, ChaseTargetX, ChaseTargetY, ObjX, ObjY, ObjWantsToShoot, ObjType, ActiveMonsterShots, EmptyMonsterSlot,
  CurObjIndex, ObjState, SampleRequest, EffectRequest, ObjMetastate, ObjInvincibilityTimer, Flyer_ObjTurns,
} from '../../src/core/vars.js';
import { ShiftMultiply, DecreaseObjectAngle, InitWalker, PlayBossHitCryIfNeeded, PlayBossDeathCryIfNeeded } from '../../src/game/enemies/common.js';
import { Flyer_SpeedUp, Flyer_SlowDown, Flyer_Delay, Flyer_Chase } from '../../src/game/enemies/flyer.js';
import { _ShootIfWanted, ShootLimited, Shoot } from '../../src/game/enemies/shots.js';

const reset = () => ram.fill(0);

test('ShiftMultiply: [02:03] = A * (high Y bits of [00]), leaves [01] = A', () => {
  reset();
  ram[0x00] = 0x80;
  ShiftMultiply(0x20, 8); // 0x20 * 0x80 = 0x1000
  assert.deepEqual([ram[0x01], ram[0x02], ram[0x03]], [0x20, 0x00, 0x10]);
  ram[0x00] = 0x7d;
  ShiftMultiply(0x20, 3); // high 3 bits of $7D = 011 -> 0x20 * 3
  assert.deepEqual([ram[0x02], ram[0x03]], [0x60, 0x00]);
  assert.equal(ram[0x00], 0xe8); // the multiplier is shifted out
});

test('DecreaseObjectAngle: 16-bit subtraction with the whole part capped at $1F', () => {
  reset();
  ram[ObjAngleFrac + 3] = 0x10;
  ram[ObjAngleWhole + 3] = 0x00;
  ram[0x0b] = 0x00;
  assert.equal(DecreaseObjectAngle(0x60, 3), 0x1f);
  assert.equal(ram[ObjAngleFrac + 3], 0xb0);
  assert.equal(ram[0x0a], 0x60);
});

test('Flyer_SpeedUp / Flyer_SlowDown switch flying states by speed thresholds', () => {
  reset();
  ram[FlyingMaxSpeedFrac] = 0xa0;
  ram[Flyer_ObjSpeed + 2] = 0x9f;
  Flyer_SpeedUp(2);
  assert.equal(ram[Flyer_ObjFlyingState + 2], 1);
  ram[Flyer_ObjFlyingState + 2] = 4;
  ram[Flyer_ObjSpeed + 2] = 0x20;
  ram[Random + 2] = 0x05;
  Flyer_SlowDown(2);
  assert.equal(ram[Flyer_ObjFlyingState + 2], 5);
  assert.equal(ram[ObjTimer + 2], 0x45);
  ram[ObjTimer + 2] = 0;
  Flyer_Delay(2);
  assert.equal(ram[Flyer_ObjFlyingState + 2], 0);
});

test('Flyer_Chase: last turn goes to flying state 1', () => {
  reset();
  ram[Flyer_ObjTurns + 4] = 1;
  ram[Flyer_ObjFlyingState + 4] = 2;
  Flyer_Chase(4);
  assert.equal(ram[Flyer_ObjFlyingState + 4], 1);
});

test('InitWalker faces along the longer axis to the chase target (unsigned compare)', () => {
  reset();
  ram[ChaseTargetX] = 0x80; ram[ObjX + 1] = 0x40; // dx = $40
  ram[ChaseTargetY] = 0x50; ram[ObjY + 1] = 0x40; // dy = $10 < dx: keep the vertical direction
  InitWalker(1);
  assert.equal(ram[ObjDir + 1], 0x04);
  ram[ObjDir + 1] = 0;
  ram[ChaseTargetY] = 0x90; // dy = $50 >= dx: horizontal direction from [01]
  InitWalker(1);
  assert.equal(ram[ObjDir + 1], 0x02);
});

test('boss cries', () => {
  reset();
  ram[ObjInvincibilityTimer + 1] = 0x10;
  PlayBossHitCryIfNeeded(1);
  assert.equal(ram[SampleRequest], 2);
  ram[SampleRequest] = 0;
  PlayBossDeathCryIfNeeded(1);
  assert.equal(ram[SampleRequest], 0);
  ram[ObjMetastate + 1] = 0x10;
  PlayBossDeathCryIfNeeded(1);
  assert.deepEqual([ram[SampleRequest], ram[EffectRequest]], [2, 0x80]);
});

test('shooting: wants-to-shoot flag, 4-shot limit, Shoot copies the shooter', () => {
  reset();
  ram[CurObjIndex] = 3;
  ram[ObjType + 3] = 0x0a;
  ram[ObjDir + 3] = 8; ram[ObjX + 3] = 0x50; ram[ObjY + 3] = 0x60;
  for (let i = 1; i < 0x0c; i++) if (i !== 3) ram[ObjType + i] = 0;
  assert.equal(_ShootIfWanted(0x53, 3).c, 0); // does not want to shoot
  assert.equal(cpu.c, 0);
  ram[ObjWantsToShoot + 3] = 1;
  ram[ActiveMonsterShots] = 4;
  assert.equal(_ShootIfWanted(0x53, 3).c, 0); // at the limit
  ram[ActiveMonsterShots] = 1;
  const r = _ShootIfWanted(0x53, 3);
  assert.deepEqual([r.c, r.x, r.y], [1, 3, 0x0b]);
  assert.equal(ram[ActiveMonsterShots], 2);
  assert.deepEqual([ram[ObjType + 0x0b], ram[ObjState + 0x0b], ram[ObjDir + 0x0b], ram[ObjX + 0x0b], ram[ObjY + 0x0b]],
    [0x53, 0x10, 8, 0x50, 0x60]);
  ram[0x00] = 0x1b; // not a projectile: no limit, not counted
  ram[ActiveMonsterShots] = 4;
  assert.equal(ShootLimited(3).c, 1);
  assert.equal(ram[ActiveMonsterShots], 4);
  ram[EmptyMonsterSlot] = 7;
  assert.equal(Shoot().y, 7);
});
