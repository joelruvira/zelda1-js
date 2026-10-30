// Classes of differences between the Mesen2 reference and another trace (jsnes or the port).
// A class is only granted with evidence from the runs themselves (see docs/ORACLE.md, "Mesen2"):
//  - ram:             RAM/SRAM differ (should never happen; reported with nested/lag evidence)
//  - backdrop:        both pictures are a single colour (rendering off): the backdrop comes from palette RAM
//                     never written yet (power-on palette: Mesen $3F00=$09 as the hardware, jsnes $00)
//  - nested-nmi:      one emulator ran two NMIs before the first RTI at this frame or the previous one
//  - lag:             the NMI of this frame (in either emulator) ended in a later video frame than it began
//  - split-63:        scroll modes (7, or 4 right after 7) and only rows 62-64 differ: the split line of
//                     WaitAndScrollToSplitBottom, whose $2006/$2007 writes land mid-line 63 (jsnes renders
//                     the whole line at its end)
//  - split-scroll:    scroll modes, every differing row >= 62 and the split writes were on rows 62-64: the
//                     playfield below the split is shifted (the split's v/fine-Y update lands on the other
//                     side of the line's Y increment)
//  - late-write:      every differing row is at or above the last PPU register write that the original NMI
//                     made on a visible scanline (the write lands mid-picture: frame 121 of title-start)
//  - greyscale:       this NMI or the previous one wrote PPUMASK with the greyscale bit (bomb flash)
//  - other:           anything else
export const CLASSES = ['ram', 'backdrop', 'nested-nmi', 'lag', 'split-63', 'split-scroll', 'late-write', 'greyscale', 'other'];

function uniform(fb) {
  const c = fb[0];
  for (let i = 1; i < fb.length; i++) if (fb[i] !== c) return false;
  return true;
}

/**
 * d:   {frame, ramCount, sramCount, rows, count}
 * ctx: {mesen, mesenPrev, other, otherPrev (records with .nmis/.nmiVideo/.rtiVideo or .info), fbA, fbB,
 *       mode, prevMode (GameMode), writes (PPU writes of the jsnes NMI with their row, if known), mask2001 (PPUMASK values written in this
 *       and the previous NMI)}
 */
export function classify(d, ctx) {
  const { mesen, mesenPrev, other, otherPrev } = ctx;
  const nested = (r) => (r?.nmis ?? r?.info?.nmis ?? 1) > 1;
  const spans = (r) => (r?.rtiVideo !== undefined ? r.rtiVideo > r.nmiVideo : r?.info ? r.info.endVideo > r.info.startVideo : false);
  const ramEq = d.ramCount === 0 && d.sramCount === 0;
  if (!ramEq) {
    const ev = [];
    if (nested(mesen) || nested(other)) ev.push('nested NMI');
    if (nested(mesenPrev) || nested(otherPrev)) ev.push('nested NMI on previous frame');
    return { cls: 'ram', why: ev.join(', ') || 'no timing evidence' };
  }
  if (ctx.fbA && ctx.fbB && uniform(ctx.fbA) && uniform(ctx.fbB)) {
    return { cls: 'backdrop', why: `uniform $${ctx.fbA[0].toString(16)} vs $${ctx.fbB[0].toString(16)}` };
  }
  if (nested(mesen) || nested(other) || nested(mesenPrev) || nested(otherPrev)) {
    return { cls: 'nested-nmi', why: `nmis mesen ${mesenPrev?.nmis}/${mesen?.nmis}, other ${otherPrev?.nmis ?? otherPrev?.info?.nmis}/${other?.nmis ?? other?.info?.nmis}` };
  }
  if (spans(mesen) || spans(other)) {
    return { cls: 'lag', why: `mesen NMI video ${mesen?.nmiVideo}-${mesen?.rtiVideo} (RTI on scanline ${mesen?.rtiScan})` };
  }
  // visible writes: the other emulator's when known (jsnes), else Mesen's own
  const vis = (ctx.writes ?? mesen?.writes ?? []).filter((w) => w.row >= 0 && w.row < 240);
  const scrollMode = ctx.mode === 7 || (ctx.mode === 4 && ctx.prevMode === 7);
  const splitWrites = vis.filter((w) => w.row >= 62 && w.row <= 64);
  const fmt = (ws) => ws.slice(0, 4).map((w) => `$${w.reg.toString(16)}=${w.val.toString(16)}@${w.row}:${w.dot}`).join(' ');
  const mesenSplit = (mesen?.writes ?? []).filter((w) => w.row >= 62 && w.row <= 64);
  const ev = ctx.writes ? `split writes ${ctx.otherName ?? 'other'} ${fmt(splitWrites) || '-'} / mesen ${fmt(mesenSplit) || '-'}`
    : `split writes (mesen) ${fmt(mesenSplit) || '-'}`;
  if (scrollMode && d.rows.length && d.rows.every((y) => y >= 62 && y <= 64)) {
    return { cls: 'split-63', why: `rows ${d.rows.join(',')}; ${ev}` };
  }
  if (scrollMode && d.rows.length && d.rows[0] >= 62 && (splitWrites.length || mesenSplit.length || ctx.mode === 4)) {
    return { cls: 'split-scroll', why: ev };
  }
  if (vis.length && d.rows[d.rows.length - 1] <= Math.max(...vis.map((w) => w.row)) + 1) {
    return { cls: 'late-write', why: `rows ${d.rows[0]}-${d.rows[d.rows.length - 1]}; visible writes ${vis.slice(0, 4).map((w) => `$${w.reg.toString(16)}=${w.val.toString(16)}@${w.row}:${w.dot}`).join(' ')}` };
  }
  if ((ctx.mask2001 ?? []).some((v) => v & 1)) return { cls: 'greyscale', why: 'PPUMASK greyscale bit written' };
  return { cls: 'other', why: `visible writes ${fmt(vis)}` };
}
