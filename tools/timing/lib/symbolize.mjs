// PC -> routine name, from the generated label table (src/core/symbols.js, read-only).
// $C000-$FFFF is bank 7; $8000-$BFFF is the bank mapped at that moment; $6000-$7FFF is the
// BANK_01_CODE copy in SRAM ($6C90..), whose labels carry the SRAM run address.
import { SYMBOLS } from '../../../src/core/symbols.js';

let index = null;

function build() {
  const regions = new Map(); // key: bank number or 'sram' -> sorted [{addr, name, global}]
  for (const [key, [bank, addr, , kind]] of Object.entries(SYMBOLS)) {
    if (kind !== 'c') continue;
    const name = key.replace(/#\d+$/, '').replace(/#\d+@/, '@');
    const region = addr < 0x8000 ? 'sram' : addr >= 0xc000 ? 7 : bank;
    if (!regions.has(region)) regions.set(region, []);
    regions.get(region).push({ addr, name, global: !name.includes('@') });
  }
  for (const list of regions.values()) list.sort((a, b) => a.addr - b.addr || (b.global - a.global));
  return regions;
}

function findLast(list, addr, pred = () => true) {
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].addr <= addr) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = best; i >= 0; i--) if (pred(list[i])) return list[i];
  return null;
}

/** { routine, local } for a CPU address with `bank` mapped at $8000. */
export function symbolize(pc, bank) {
  index ??= build();
  const region = pc < 0x8000 ? 'sram' : pc >= 0xc000 ? 7 : bank;
  const list = index.get(region);
  if (!list) return { routine: `$${hex4(pc)}`, local: null };
  const g = findLast(list, pc, (e) => e.global);
  const l = findLast(list, pc);
  return {
    routine: g ? g.name : `$${hex4(pc)}`,
    local: l && !l.global && (!g || l.addr >= g.addr) ? l.name : null,
  };
}

export function routineName(pc, bank) {
  return symbolize(pc, bank).routine;
}

export const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');
export const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');
