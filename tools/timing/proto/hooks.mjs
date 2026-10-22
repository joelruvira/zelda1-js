// Node module hooks (registered by proto/register.mjs): instrument the port's modules ON LOAD,
// without touching the files in src/:
//  * every function whose body starts with the convention comment "// Name (Z_0n)" is wrapped with
//    __cy.enter/leave (routine boundaries for the cycle tracker),
//  * src/core/bus.js read/write report I/O accesses ($2000-$401F, MMC1 writes) to __cy,
//  * src/core/asm.js switchBank/tableJump report bank switches and table jumps,
//  * proto/annotations.mjs adds the manual breadcrumbs (__cy.br / __cy.px) as text patches.
import { fileURLToPath } from 'node:url';
import { ANNOTATIONS } from './annotations.mjs';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));
const FUNC = /(^|\n)([ \t]*)(export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{[ \t]*\r?\n[ \t]*\/\/\s*([A-Za-z_][\w]*)\s*\(Z_0(\d)\)/g;

export function instrumentGame(source, rel) {
  let out = source;
  for (const [file, find, replace] of ANNOTATIONS) {
    if (file !== rel) continue;
    const n = out.split(find).length - 1;
    if (n !== 1) throw new Error(`annotation for ${rel} matches ${n} times: ${find.slice(0, 80)}`);
    out = out.replace(find, () => replace);
  }
  const wrappers = [];
  out = out.replace(FUNC, (m, lead, indent, exp, name, params, routine, bank) => {
    wrappers.push(`${exp ? 'export ' : ''}function ${name}(...a) { const c = globalThis.__cy; const t = c.enter('${routine}', ${bank}); ` +
      `try { return ${name}__impl(...a); } finally { c.leave(t); } }`);
    return m.replace(`function ${name}`, `function ${name}__impl`).replace(/^(\n?)[ \t]*export\s+/, '$1');
  });
  const helpers = 'const $br = (r, c) => globalThis.__cy.br(r, c), $px = (r, c) => globalThis.__cy.px(r, c), ' +
    '$pxa = (r, b, i) => globalThis.__cy.pxAddr(r, b, i);\n';
  return `${helpers}${out}\n// --- timing instrumentation (tools/timing/proto/hooks.mjs)\n${wrappers.join('\n')}\n`;
}

function instrumentBus(source) {
  let out = source.replace('export function read(addr) {', 'function read__impl(addr) {')
    .replace('export function write(addr, value) {', 'function write__impl(addr, value) {');
  out += `
// --- timing instrumentation (tools/timing/proto/hooks.mjs)
export function read(addr) {
  const a = addr & 0xffff;
  if (globalThis.__cy.on && a >= 0x2000 && a < 0x4020) globalThis.__cy.ioRead(a);
  return read__impl(addr);
}
export function write(addr, value) {
  const a = addr & 0xffff;
  if (globalThis.__cy.on && ((a >= 0x2000 && a < 0x4020) || a >= 0x8000)) globalThis.__cy.ioWrite(a);
  return write__impl(addr, value);
}
`;
  return out;
}

function instrumentAsm(source) {
  return source
    .replace('export function switchBank(bank) {', 'export function switchBank(bank) {\n  globalThis.__cy.switchBank(bank);')
    .replace('  return handler();', '  globalThis.__cy.tableJump(tableAddr, index, ram[0x02] | (ram[0x03] << 8));\n  return handler();');
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:')) return result;
  const path = fileURLToPath(url);
  if (!path.startsWith(SRC) || !path.endsWith('.js')) return result;
  const rel = path.slice(SRC.length);
  let source = String(result.source);
  if (rel.startsWith('game/')) source = instrumentGame(source, rel);
  else if (rel === 'core/bus.js') source = instrumentBus(source);
  else if (rel === 'core/asm.js') source = instrumentAsm(source);
  else return result;
  return { ...result, source, shortCircuit: true };
}
