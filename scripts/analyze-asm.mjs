// Analyzes the Zelda 1 disassembly and writes docs/ROUTINES.json (routine/data map + work packages).
// Usage: node scripts/analyze-asm.mjs [--src reference/zelda1-disassembly/src] [--out docs/ROUTINES.json] [--report]
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './asm/analyze.mjs';
import { binSizes } from './asm/parse.mjs';
import { PACKAGES, packageOf } from './asm/packages.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const srcDir = resolve(root, opt('--src', 'reference/zelda1-disassembly/src'));
const outPath = resolve(root, opt('--out', 'docs/ROUTINES.json'));
const hex = (n, w = 4) => `$${n.toString(16).toUpperCase().padStart(w, '0')}`;
const id = (bank, name) => `${bank}:${name}`;

const A = analyze(srcDir);
const pkgByKey = new Map(PACKAGES.map((p) => [p.key, p]));
const isWram = (bl) => bl.segment === 'BANK_01_CODE' || bl.segment === 'BANK_06_DATA';
const blockById = new Map(A.blocks.map((b) => [id(b.bank, b.name), b]));

// --- Verification of the address calculation ---------------------------------------------------
const verify = [];
const check = (what, ok, detail) => { verify.push({ check: what, ok, detail }); if (!ok) console.error(`VERIFY FAILED: ${what} ${detail}`); };
for (const b of A.blocks) for (const s of b.stmts) if (s.dir === 'INCBIN') {
  const exp = binSizes(srcDir).get(s.path);
  check(`incbin ${s.path}`, exp.offset === s.prg, `prg=${s.prg} bins.xml=${exp.offset}`);
}
const addrOf = (bank, name) => blockById.get(id(bank, name))?.addr ?? A.banks[bank].labels.get(name);
// The reset stubs in banks 0-6 jump to $E440 and the vectors point at $E484 / $FF50 (bytes in "Unknown block" of each bank).
check('RunGame at $E440 (target of reset stub JMP $E440)', addrOf(7, 'RunGame') === 0xE440, hex(addrOf(7, 'RunGame')));
check('IsrNmi at $E484 (NMI vector)', addrOf(7, 'IsrNmi') === 0xE484, hex(addrOf(7, 'IsrNmi')));
check('IsrReset at $FF50', addrOf(7, 'IsrReset') === 0xFF50, hex(addrOf(7, 'IsrReset')));
check('IsrVector at $FFFA', addrOf(7, 'IsrVector') === 0xFFFA, hex(addrOf(7, 'IsrVector')));
const segEnd = (bank, seg) => Math.max(...A.blocks.filter((b) => b.bank === bank && b.segment === seg).map((b) => b.addr + b.size));
check('BANK_01_CODE runs $6C90-$7EFF (size $1270 from Z.cfg)', segEnd(1, 'BANK_01_CODE') === 0x7F00, hex(segEnd(1, 'BANK_01_CODE')));
check('BANK_06_DATA runs $67F0-$687D (size $8E from Z.cfg)', segEnd(6, 'BANK_06_DATA') === 0x687E, hex(segEnd(6, 'BANK_06_DATA')));
for (let bank = 0; bank < 8; bank++) {
  const main = `BANK_0${bank}_00`;
  const end = segEnd(bank, main);
  const limit = bank === 7 ? 0xFF50 : bank === 6 ? 0xA000 : 0xBF50;
  if (bank === 6) check('BANK_06_00+DATA load end <= $A000', A.blocks.filter((b) => b.bank === 6 && b.segment === 'BANK_06_DATA').every((b) => b.prg + b.size <= 6 * 0x4000 + 0x2000), '');
  else check(`${main} ends before ISR ($${limit.toString(16)})`, end <= limit, hex(end));
}

// Optional cross-check against the user's ROM (never copied: only match counts are recorded).
const romPath = resolve(root, opt('--rom', 'roms/zelda.nes'));
if (existsSync(romPath) && !args.includes('--no-rom')) verifyAgainstRom(readFileSync(romPath).subarray(16));
function verifyAgainstRom(prg) {
  const lines = Object.fromEntries([...A.banks.keys()].map((b) => [b, readFileSync(resolve(srcDir, `Z_0${b}.asm`), 'utf8').split(/\r?\n/)]));
  let tables = 0, tableMismatch = 0, jsrs = 0, jsrMissing = 0;
  for (const bl of A.blocks) {
    if (bl.kind !== 'data' || bl.stmts.some((s) => s.kind === 'data' && s.dir !== 'BYTE')) continue;
    const bytes = [];
    for (let i = bl.line; i <= bl.endLine; i++) {
      const m = lines[bl.bank][i - 1].replace(/;.*/, '').match(/^\s*\.BYTE\s+(.*)$/i);
      if (m) for (const t of m[1].split(',')) { const v = t.trim(); bytes.push(/^\$[0-9A-F]+$/i.test(v) ? parseInt(v.slice(1), 16) : /^\d+$/.test(v) ? +v : null); }
    }
    if (bytes.length !== bl.size) continue;
    tables++;
    if (bytes.some((v, i) => v !== null && v !== prg[bl.prg + i])) tableMismatch++;
  }
  for (const bl of A.blocks) if (bl.kind === 'code' && !isWram(bl)) for (const c of bl.calls) {
    const t = blockById.get(id(c.bank, c.name));
    if (c.kind !== 'jsr' || !t) continue;
    jsrs++;
    let found = false;
    for (let i = bl.prg; i < bl.prg + bl.size - 2 && !found; i++) found = prg[i] === 0x20 && prg[i + 1] === (t.addr & 0xFF) && prg[i + 2] === t.addr >> 8;
    if (!found) jsrMissing++;
  }
  check('ROM: .BYTE tables match the ROM at prgOffset', tables > 0 && tableMismatch === 0, `${tables - tableMismatch}/${tables}`);
  check('ROM: JSR operands match target cpu addresses', jsrMissing === 0, `${jsrs - jsrMissing}/${jsrs}`);
}

// --- Routines and data --------------------------------------------------------------------------
const calledBy = new Map();
for (const b of A.blocks) for (const c of b.calls) {
  const k = id(c.bank, c.name);
  if (!calledBy.has(k)) calledBy.set(k, []);
  calledBy.get(k).push({ from: id(b.bank, b.name), kind: c.kind });
}
const usedBy = new Map();
for (const b of A.blocks) for (const r of b.refs) {
  const t = A.findBlock(r, b.bank);
  if (!t) continue;
  const k = id(t.bank, t.name);
  if (!usedBy.has(k)) usedBy.set(k, new Set());
  usedBy.get(k).add(id(b.bank, b.name));
}

const runsFrom = (bl) => (isWram(bl) ? 'wram' : bl.bank === 7 ? 'fixed' : 'banked');
const loc = (bl) => ({
  bank: bl.bank, line: bl.line, endLine: bl.endLine, segment: bl.segment, runsFrom: runsFrom(bl),
  cpu: hex(bl.addr), prgOffset: bl.prg, prgOffsetHex: `0x${bl.prg.toString(16).toUpperCase().padStart(5, '0')}`, size: bl.size,
});

const routines = [];
const data = [];
for (const bl of A.blocks) {
  const key = id(bl.bank, bl.name);
  const pkg = pkgByKey.get(packageOf(bl));
  if (bl.kind === 'code') {
    const target = (c) => blockById.get(id(c.bank, c.name));
    routines.push({
      id: key, name: bl.name, ...loc(bl), instrs: bl.instrCount,
      package: pkg.id, subsystem: pkg.subsystem,
      entry: bl.entry, unreferenced: (!bl.entry && !bl.partOf && !(calledBy.get(key) || []).length) || undefined,
      unverified: bl.unverified || undefined, partOf: bl.partOf ? id(bl.bank, bl.partOf) : undefined,
      aliases: bl.aliases.length ? bl.aliases : undefined,
      exported: A.banks[bl.bank].exports.has(bl.name) || undefined,
      endsWith: bl.endsWith, fallsInto: bl.fallsInto ? id(bl.bank, bl.fallsInto) : undefined,
      switchesBankTo: bl.switchBank.length ? [...new Set(bl.switchBank)] : undefined,
      indirectJump: bl.indirectJump || undefined,
      dispatch: bl.dispatch ? { table: id(bl.bank, bl.dispatch.table), targets: bl.dispatch.targets } : undefined,
      dispatch2: bl.dispatch2 ? { table: id(bl.bank, bl.dispatch2.table), targets: bl.dispatch2.targets } : undefined,
      calls: dedupe(bl.calls.filter((c) => c.kind !== 'dispatch').map((c) => {
        const t = target(c);
        return { to: id(c.bank, c.name), kind: c.kind, crossBank: t && c.bank !== bl.bank && runsFrom(t) === 'banked' ? true : undefined, via: c.via };
      })),
      calledBy: dedupe(calledBy.get(key) || []),
      ram: { read: [...bl.ram.read].sort(), write: [...bl.ram.write].sort() },
      io: bl.io.size ? [...bl.io].sort() : undefined,
      codeAsData: bl.codeAsData?.length ? bl.codeAsData.map((n) => id(A.findBlock(n, bl.bank).bank, n)) : undefined,
      dataRefs: [...bl.refs].map((r) => A.findBlock(r, bl.bank)).filter((t) => t && t.kind === 'data').map((t) => id(t.bank, t.name)),
      inlineData: bl.inlineData.length ? bl.inlineData.map((d) => ({ label: d.label, cpu: hex(d.addr), prgOffset: d.prg, size: d.size })) : undefined,
    });
  } else {
    const dirs = [...new Set(bl.stmts.filter((s) => s.kind === 'data').map((s) => s.dir))];
    data.push({
      id: key, name: bl.name, ...loc(bl), package: pkg.id, subsystem: pkg.subsystem,
      directives: dirs, incbin: bl.stmts.find((s) => s.dir === 'INCBIN')?.path,
      padding: bl.padding || undefined, unlabeled: bl.unlabeled || undefined,
      jumpTable: bl.isJumpTable ? bl.codeTargets : undefined,
      dispatchedBy: bl.dispatchedBy ? id(bl.bank, bl.dispatchedBy) : undefined,
      addrTableTargets: !bl.isJumpTable && bl.codeTargets?.length ? bl.codeTargets : undefined,
      pointsTo: [...bl.refs].filter((r) => { const t = A.findBlock(r, bl.bank); return t && t.kind === 'data'; }),
      usedBy: [...(usedBy.get(key) || [])].sort(),
      embeddedCodeInstrs: bl.embeddedCodeInstrs,
    });
  }
}
function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Blocks that are only the tail of another routine belong to that routine's package.
const routineById = new Map(routines.map((r) => [r.id, r]));
for (const r of routines) if (r.partOf) { r.package = routineById.get(r.partOf).package; r.subsystem = routineById.get(r.partOf).subsystem; }

// --- Package graph ------------------------------------------------------------------------------
const pkgOfRoutine = new Map(routines.map((r) => [r.id, r.package]));
for (const d of data) pkgOfRoutine.set(d.id, d.package);
const pkgInfo = PACKAGES.map((p) => ({ ...p, routines: [], data: [], instrs: 0, entries: 0, deps: new Map() }));
const pInfo = new Map(pkgInfo.map((p) => [p.id, p]));
for (const r of routines) {
  const p = pInfo.get(r.package);
  p.routines.push(r.id); p.instrs += r.instrs; if (r.entry) p.entries++;
  for (const c of r.calls) {
    const tp = pkgOfRoutine.get(c.to);
    const tb = blockById.get(c.to);
    const trivialExit = c.kind === 'branch' && tb && tb.instrCount <= 2 && ['RTS', 'JMP'].includes(tb.endsWith) && !tb.calls.some((x) => x.kind === 'jmp' || x.kind === 'jsr');
    if (tp && tp !== r.package && c.kind !== 'fall' && !trivialExit) p.deps.set(tp, (p.deps.get(tp) || 0) + 1);
  }
  if (r.dispatch) for (const t of [...r.dispatch.targets, ...(r.dispatch2?.targets || [])]) {
    const tr = A.findBlock(t, r.bank);
    const tp = tr && pkgOfRoutine.get(id(tr.bank, tr.name));
    if (tp && tp !== r.package) p.deps.set(tp, (p.deps.get(tp) || 0) + 1);
  }
}
for (const d of data) pInfo.get(d.package).data.push(d.id);

// Implementation order (phases). Calls that point to a later phase must be stubbed until that package lands.
const ORDER = [
  ['P01', 'P02', 'P03', 'P04'],
  ['P23', 'P24'],
  ['P06', 'P05', 'P08', 'P12', 'P13', 'P11'],
  ['P07', 'P09', 'P10', 'P14', 'P16', 'P15'],
  ['P17', 'P18', 'P19', 'P20'],
  ['P21', 'P22', 'P25'],
];
const phaseOf = new Map();
ORDER.forEach((ph, i) => ph.forEach((p) => phaseOf.set(p, i + 1)));
const packages = pkgInfo.map((p) => {
  const deps = [...p.deps.entries()].sort((a, b) => b[1] - a[1]);
  return {
    id: p.id, key: p.key, title: p.title, subsystem: p.subsystem, phase: phaseOf.get(p.id), files: p.files, oracle: p.oracle,
    instrs: p.instrs, routineCount: p.routines.length, entryCount: p.entries, dataCount: p.data.length,
    dataBytes: data.filter((d) => d.package === p.id && !d.padding).reduce((a, d) => a + d.size, 0),
    dependsOn: deps.map(([t, n]) => ({ package: t, calls: n, laterPhase: phaseOf.get(t) > phaseOf.get(p.id) || undefined })),
    routines: p.routines, data: p.data,
  };
});
for (const p of packages) if (!p.phase) throw new Error(`package ${p.id} missing from ORDER`);

// --- Mode / object tables (names only: no ROM bytes) -------------------------------------------
const tableTargets = (name) => data.find((d) => d.name === name)?.jumpTable || [];
const modeNames = ['Título, historia y demo', 'Menú de selección de partida', 'Carga de nivel (CHR + bloques de nivel)', 'Cortina al empezar nivel (unfurl)',
  'Entrar en sala (Link camina hacia dentro)', 'Juego', 'Salir de sala por puerta UW', 'Scroll a la sala vecina',
  'Pregunta CONTINUE/SAVE/RETRY', 'Entrar en sótano UW (cellar)', 'Salir de cueva/sótano', 'Entrar en cueva OW',
  'Entrar en pasadizo/atajo OW', 'Guardar partida', 'Registrar nombre', 'Eliminar partida', 'Escaleras (entrar a nivel o warp)',
  'Muerte de Link', 'Fin de nivel (triforce)', 'Final del juego y créditos'];
const modes = tableTargets('InitMode_JumpTable').map((init, i) => ({
  mode: hex(i, 2), name: modeNames[i], init, update: tableTargets('UpdateMode_JumpTable')[i],
}));
const upd = tableTargets('UpdateObject_JumpTable');
const ini = tableTargets('InitObject_JumpTable');
const objTypes = upd.map((u, i) => ({ type: hex(i, 2), update: u, init: ini[i] ?? (i >= 0x5F ? 'InitTileObjOrItem' : undefined) }));
objTypes.push({ type: '$6A-$7F', update: 'UpdateCavePerson (banco 1)', init: 'InitCave (banco 1)' });

// Shared routines: called from 3+ other packages. They are the API the porters must agree on first.
const sharedRoutines = routines.filter((r) => r.entry).map((r) => {
  const from = new Set((r.calledBy || []).map((c) => pkgOfRoutine.get(c.from)).filter((p) => p && p !== r.package));
  return { id: r.id, package: r.package, fromPackages: [...from].sort(), callers: (r.calledBy || []).length };
}).filter((x) => x.fromPackages.length >= 3).sort((a, b) => b.fromPackages.length - a.fromPackages.length || b.callers - a.callers);

const counts = {
  routines: routines.length, entryRoutines: routines.filter((r) => r.entry).length, instructions: routines.reduce((a, r) => a + r.instrs, 0),
  dataBlocks: data.length, dataBytes: data.filter((d) => !d.padding).reduce((a, d) => a + d.size, 0),
  perBank: [0, 1, 2, 3, 4, 5, 6, 7].map((b) => ({ bank: b, routines: routines.filter((r) => r.bank === b).length,
    instrs: routines.filter((r) => r.bank === b).reduce((a, r) => a + r.instrs, 0), data: data.filter((d) => d.bank === b).length })),
};
const out = {
  meta: {
    generatedBy: 'node scripts/analyze-asm.mjs', source: 'reference/zelda1-disassembly/src (Z_00..Z_07.asm)',
    notes: [
      'cpu = dirección CPU de ejecución; prgOffset = offset dentro de los 128 KB de PRG (sin cabecera iNES: sumar 16 para el fichero .nes).',
      'runsFrom: fixed = banco 7 ($C000-$FFFF), banked = $8000-$BFFF con ese banco mapeado, wram = copiado a $6000-$7FFF (BANK_01_CODE carga en $A500 del banco 1 y corre en $6C90; BANK_06_DATA corre en $67F0).',
      'entry=false: bloque solo alcanzado por rama/caída desde la rutina anterior (partOf); se porta dentro de esa función.',
      'calls.kind: jsr | jmp (llamada de cola) | branch (rama a otra etiqueta con nombre) | fall (cae en la siguiente) | addr (dirección cargada como dato) | table (destino de una tabla .ADDR leída por código); dispatch = TableJump.',
      'Ningún byte de la ROM se incluye aquí: solo nombres, direcciones y tamaños. Las tablas se leen en runtime por (banco, cpu) o prgOffset.',
    ],
    verification: verify, counts,
  },
  modes, objTypes, packages, sharedRoutines, routines, data,
};
// One record per line: readable diffs and a compact file.
const section = (arr) => `[\n${arr.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n ]`;
const body = Object.entries(out).map(([k, v]) => ` ${JSON.stringify(k)}: ${Array.isArray(v) ? section(v) : JSON.stringify(v, null, 1).replace(/\n/g, '\n ')}`);
writeFileSync(outPath, `{\n${body.join(',\n')}\n}\n`);
JSON.parse(readFileSync(outPath, 'utf8'));
console.log(`wrote ${outPath}: ${counts.routines} routines (${counts.entryRoutines} entries, ${counts.instructions} instrs), ${counts.dataBlocks} data blocks; verification ${verify.every((v) => v.ok) ? 'OK' : 'FAILED'} (${verify.length} checks)`);
if (args.includes('--report')) {
  for (const p of packages) console.log(`${p.id} ph${p.phase} ${p.key.padEnd(12)} ${String(p.instrs).padStart(5)}i ${String(p.routineCount).padStart(4)}r ${String(p.dataBytes).padStart(6)}B  deps: ${p.dependsOn.map((d) => `${d.package}${d.laterPhase ? '*' : ''}(${d.calls})`).join(' ')}`);
}
if (!verify.every((v) => v.ok)) process.exit(1);
