#!/usr/bin/env node
// P13 "graft" oracle run (technique of tests/game/p08-graft.mjs / p12-graft.mjs): the ORIGINAL game runs
// in jsnes and every call to a P13 routine (modes 3, 4, 6, 7, 9, A, B, C, $10, next room, fading) is
// executed by the JS port instead. The trace is diffed with the pure oracle trace: a divergence can only
// come from the P13 ports (or the JS routines they call). It also prints how many times each routine
// ran, which is the coverage of a scenario.
//
// Usage (the hybrid hook makes routines still stubbed in JS run as original code):
//   node --import ./tests/game/p01-hybrid-register.mjs tests/game/p13-graft.mjs <movie> [--sram f] [--out dir]
//   node tools/oracle/diff.mjs out/oracle/<m>/trace.ztrace out/graft-p13/<m>/trace.ztrace --no-fb
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Oracle } from '../../tools/oracle/lib/nes-oracle.mjs';
import { TraceWriter } from '../../tools/oracle/lib/trace.mjs';
import { loadRomFile, DEFAULT_ROM_PATH, REPO_ROOT } from '../../tools/oracle/lib/rom-file.mjs';
import { parseArgs, resolveMovie, readOptionalSram, runCli } from '../../tools/oracle/lib/cli.mjs';
import { loadSymbols, loadRom } from '../../src/core/rom.js';
import { createMachine } from '../../src/core/machine.js';
import { installGrafts } from './p12-graft.mjs';

/** Every P13 entry routine: name -> (regs) => register outputs {a?, x?, y?, c?, nz?}. */
export async function p13Grafts() {
  const M3 = await import('../../src/game/modes/mode3-unfurl.js');
  const M46 = await import('../../src/game/modes/mode4-6-enterleave.js');
  const M7 = await import('../../src/game/modes/mode7-scroll.js');
  const M9 = await import('../../src/game/modes/mode9-cellar.js');
  const MA = await import('../../src/game/modes/modeA-B-C-cave.js');
  const M10 = await import('../../src/game/modes/mode10-stairs.js');
  const Nr = await import('../../src/game/world/nextroom.js');
  const Fd = await import('../../src/game/ppu/fade.js');
  const none = (f) => () => (f(), {});
  const withA = (f) => (r) => (f(r.a), {});
  return {
    // Z_01
    InitModeB_EnterCave_Bank5: none(MA.InitModeB_EnterCave_Bank5),
    UpdateWorldCurtainEffect_Bank2: none(M3.UpdateWorldCurtainEffect_Bank2),
    UpdateWorldCurtainEffect: none(M3.UpdateWorldCurtainEffect),
    AnimateWorldFading: () => { const a = Fd.AnimateWorldFading(); return { a, nz: a }; },
    // Z_05 mode 7
    InitMode7Submodes: none(M7.InitMode7Submodes),
    InitMode7_Sub0: none(M7.InitMode7_Sub0),
    InitMode7_Sub1: none(M7.InitMode7_Sub1),
    LayOutDoorsPrev: none(M7.LayOutDoorsPrev),
    InitMode7_Sub2: none(M7.InitMode7_Sub2),
    InitMode7_Sub3And4_TransferPlayAreaAttrsToNT2: none(M7.InitMode7_Sub3And4_TransferPlayAreaAttrsToNT2),
    InitMode7_Sub5: none(M7.InitMode7_Sub5),
    InitMode7_Sub6: none(M7.InitMode7_Sub6),
    WriteAndEnableSprite0: none(M7.WriteAndEnableSprite0),
    SetEnteringDoorwayAsCurOpenedDoors: () => ({ a: M7.SetEnteringDoorwayAsCurOpenedDoors() }),
    FillPlayAreaAttrs: withA(M7.FillPlayAreaAttrs),
    UpdateMode7SubmodeAndDrawLink: none(M7.UpdateMode7SubmodeAndDrawLink),
    UpdateMode7ScrollSubmode: none(M7.UpdateMode7ScrollSubmode),
    UpdateMode7Scroll_Sub0: none(M7.UpdateMode7Scroll_Sub0),
    Inc2Submodes: none(M7.Inc2Submodes),
    UpdateMode7Scroll_Sub1: none(M7.UpdateMode7Scroll_Sub1),
    ChooseAttrSourceAndDestForSubmode: () => M7.ChooseAttrSourceAndDestForSubmode(),
    GetPlayAreaAttrsBottomHalfInfo: (r) => M7.GetPlayAreaAttrsBottomHalfInfo(r.a),
    UpdateMode7Scroll_Sub2: none(M7.UpdateMode7Scroll_Sub2),
    UpdateMode7Scroll_Sub3: none(M7.UpdateMode7Scroll_Sub3),
    UpdateMode7Scroll_Sub6: none(M7.UpdateMode7Scroll_Sub6),
    UpdateMode7Scroll_Sub7: none(M7.UpdateMode7Scroll_Sub7),
    UpdateMode7Scroll_Sub4: none(M7.UpdateMode7Scroll_Sub4),
    UpdateMode7Scroll_Sub4And5_TransferNTAttrs: none(M7.UpdateMode7Scroll_Sub4And5_TransferNTAttrs),
    CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0: (r) => (M7.CueTransferPlayAreaAttrsHalfAndAdvanceSubmodeNT0(r.a, r.y), {}),
    CopyColumnOrRowToTileBuf: none(M7.CopyColumnOrRowToTileBuf),
    CopyPlayAreaAttrsHalfToDynTransferBuf: (r) => (M7.CopyPlayAreaAttrsHalfToDynTransferBuf(r.a, r.x, r.y), {}),
    // Z_05 modes 10, 4, 6
    InitMode10: none(M10.InitMode10),
    InitMode4: none(M46.InitMode4),
    SetFadeCycleAndAdvanceSubmode: withA(M46.SetFadeCycleAndAdvanceSubmode),
    InitMode_EnterRoom: none(M46.InitMode_EnterRoom),
    UpdateMode10Stairs_Full: none(M10.UpdateMode10Stairs_Full),
    AnimateAndDrawLinkBehindBackground: none(M10.AnimateAndDrawLinkBehindBackground),
    PutLinkBehindBackground: none(M10.PutLinkBehindBackground),
    CheckSubroom: none(Nr.CheckSubroom),
    GoToModeAFromCellar: withA(Nr.GoToModeAFromCellar),
    EndPrepareMode: () => ({ a: Nr.EndPrepareMode() }),
    InitModeB: none(MA.InitModeB),
    InitModeC: none(MA.InitModeC),
    InitMode9: none(M9.InitMode9),
    // Z_05 mode 3 submodes, mode 6, subrooms
    InitMode3_Sub2: none(M3.InitMode3_Sub2),
    InitMode3_Sub3_TransferTopHalfAttrs: none(M3.InitMode3_Sub3_TransferTopHalfAttrs),
    InitMode3_Sub4_TransferBottomHalfAttrs: none(M3.InitMode3_Sub4_TransferBottomHalfAttrs),
    InitMode3_Sub5: none(M3.InitMode3_Sub5),
    InitMode3_Sub6: none(M3.InitMode3_Sub6),
    InitMode3_Sub7: none(M3.InitMode3_Sub7),
    InitMode3_Sub8: none(M3.InitMode3_Sub8),
    InitMode6: none(M46.InitMode6),
    ResetInvObjState: () => ({ a: M46.ResetInvObjState() }),
    GetPassedDoorType: () => M46.GetPassedDoorType(),
    InitModeA: none(MA.InitModeA),
    InitModeSubroom_Sub0: none(MA.InitModeSubroom_Sub0),
    DrawSpritesBetweenRoomsAndAdvanceSubmode: none(MA.DrawSpritesBetweenRoomsAndAdvanceSubmode),
    InitMode9_TransferAttrs: none(M9.InitMode9_TransferAttrs),
    L1712E_SelectTransferBufAndAdvanceSubmode: withA(MA.L1712E_SelectTransferBufAndAdvanceSubmode),
    InitModeSubroom_AdvanceSubmode: none(MA.InitModeSubroom_AdvanceSubmode),
    InitMode9_FadeToDark: none(M9.InitMode9_FadeToDark),
    InitModeSubroom_AnimateFade: none(MA.InitModeSubroom_AnimateFade),
    InitMode9_FadeToLight: none(M9.InitMode9_FadeToLight),
    InitModeA_Sub2: none(MA.InitModeA_Sub2),
    InitModeA_Sub8: none(MA.InitModeA_Sub8),
    InitModeB_Sub1: none(MA.InitModeB_Sub1),
    InitModeA_Sub1: none(MA.InitModeA_Sub1),
    InitModeA_SubA_GoToMode4: none(MA.InitModeA_SubA_GoToMode4),
    InitModeA_Sub6_FillTileAttrsAndTransferTopHalf: none(MA.InitModeA_Sub6_FillTileAttrsAndTransferTopHalf),
    InitModeB_Sub5_FillTileAttrsAndTransferTopHalf: none(MA.InitModeB_Sub5_FillTileAttrsAndTransferTopHalf),
    InitModeAOrB_TransferBottomHalfAttrs: none(MA.InitModeAOrB_TransferBottomHalfAttrs),
    InitMode_WalkCave: none(MA.InitMode_WalkCave),
    InitMode9_EnterCellar: none(M9.InitMode9_EnterCellar),
    InitMode9_WalkCellar: none(M9.InitMode9_WalkCellar),
    // Z_05 next room
    CalculateNoNextRoom: () => ({ a: Nr.CalculateNoNextRoom() }),
    CalculateNextRoomForDoor: none(Nr.CalculateNextRoomForDoor),
    CalcNextRoomByDir: (r) => ({ a: Nr.CalcNextRoomByDir(r.a) }),
    // Z_07
    CalculateNextRoom: none(Nr.CalculateNextRoom),
    InitMode3: none(M3.InitMode3),
    InitMode3_Sub0: none(M3.InitMode3_Sub0),
    InitMode3_Sub1: none(M3.InitMode3_Sub1),
    PatchAndCueLevelPalettesTransferAndAdvanceSubmode: none(M3.PatchAndCueLevelPalettesTransferAndAdvanceSubmode),
    DrawSpritesBetweenRooms: none(M46.DrawSpritesBetweenRooms),
    ResetPlayerState: () => ({ a: M46.ResetPlayerState() }),
    UpdateMode3Unfurl: none(M3.UpdateMode3Unfurl),
    UpdateMode4and6EnterLeave: none(M46.UpdateMode4and6EnterLeave),
    GoToNextModePlayLevelSong: none(M46.GoToNextModePlayLevelSong),
    GoToNextModeResetGridOffset: none(M46.GoToNextModeResetGridOffset),
  };
}

export async function main(argv) {
  const args = parseArgs(argv, { flags: ['quiet'] });
  if (!args._[0]) {
    console.error('usage: p13-graft.mjs <movie> [--sram f] [--out dir]');
    return 2;
  }
  const movie = resolveMovie(args._[0]);
  const rom = loadRomFile(args.rom ? resolve(args.rom) : DEFAULT_ROM_PATH);
  await loadSymbols();
  createMachine(loadRom(rom.bytes));
  const outDir = resolve(args.out ?? join(REPO_ROOT, 'out/graft-p13', movie.name));
  mkdirSync(outDir, { recursive: true });
  const sramInit = readOptionalSram(args.sram);
  const oracle = await Oracle.create({ rom: rom.bytes, sram: sramInit, powerOnFill: 0 });
  const counts = installGrafts(oracle, await p13Grafts());
  const writer = new TraceWriter(join(outDir, 'trace.ztrace'), {
    source: 'p13-graft', emulator: 'jsnes', romSha1: rom.info.sha1, movie: movie.name,
    timing: movie.timing, frames: movie.length, powerOnFill: 0, sram: args.sram ?? null,
  });
  try {
    oracle.run(movie, { write: (rec) => writer.write(rec) });
  } finally {
    writer.close();
  }
  if (!args.quiet) console.log(`grafted calls: ${JSON.stringify(counts)}`);
  return 0;
}

if (import.meta.main) runCli(main);
