// Tiny two-pass 6502 assembler (subset) used to build synthetic test ROMs for the harness.
// Syntax per line: "label:", "OP", "OP #$nn", "OP $nn", "OP $nnnn", "OP $nnnn,X", "OP $nnnn,Y",
// "OP ($nn),Y", "OP label", ".byte $nn,...", ".word label", ".org $nnnn". Comments start with ';'.

const OPS = {
  ADC: { imm: 0x69, zp: 0x65, abs: 0x6d },
  AND: { imm: 0x29, zp: 0x25, abs: 0x2d },
  ASL: { acc: 0x0a, zp: 0x06, abs: 0x0e },
  BIT: { zp: 0x24, abs: 0x2c },
  CMP: { imm: 0xc9, zp: 0xc5, abs: 0xcd, absx: 0xdd },
  CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  DEC: { zp: 0xc6, abs: 0xce },
  EOR: { imm: 0x49, zp: 0x45, abs: 0x4d },
  INC: { zp: 0xe6, abs: 0xee },
  JMP: { abs: 0x4c },
  JSR: { abs: 0x20 },
  LDA: { imm: 0xa9, zp: 0xa5, abs: 0xad, absx: 0xbd, absy: 0xb9, indy: 0xb1 },
  LDX: { imm: 0xa2, zp: 0xa6, abs: 0xae },
  LDY: { imm: 0xa0, zp: 0xa4, abs: 0xac },
  LSR: { acc: 0x4a, zp: 0x46, abs: 0x4e },
  ORA: { imm: 0x09, zp: 0x05, abs: 0x0d },
  ROL: { acc: 0x2a, zp: 0x26, abs: 0x2e },
  ROR: { acc: 0x6a, zp: 0x66, abs: 0x6e },
  STA: { zp: 0x85, abs: 0x8d, absx: 0x9d, absy: 0x99, indy: 0x91 },
  STX: { zp: 0x86, abs: 0x8e },
  STY: { zp: 0x84, abs: 0x8c },
  BCC: { rel: 0x90 }, BCS: { rel: 0xb0 }, BEQ: { rel: 0xf0 }, BMI: { rel: 0x30 },
  BNE: { rel: 0xd0 }, BPL: { rel: 0x10 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
  CLC: { imp: 0x18 }, CLD: { imp: 0xd8 }, DEX: { imp: 0xca }, DEY: { imp: 0x88 },
  INX: { imp: 0xe8 }, INY: { imp: 0xc8 }, NOP: { imp: 0xea }, PHA: { imp: 0x48 },
  PLA: { imp: 0x68 }, RTI: { imp: 0x40 }, RTS: { imp: 0x60 }, SEC: { imp: 0x38 },
  SEI: { imp: 0x78 }, TAX: { imp: 0xaa }, TAY: { imp: 0xa8 }, TXA: { imp: 0x8a },
  TXS: { imp: 0x9a }, TYA: { imp: 0x98 },
};

const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, rel: 2, indy: 2, abs: 3, absx: 3, absy: 3 };

function parseNumber(s, labels, pass) {
  if (/^\$[0-9a-f]+$/i.test(s)) return parseInt(s.slice(1), 16);
  if (/^[0-9]+$/.test(s)) return Number(s);
  if (s in labels) return labels[s];
  if (pass === 1) return 0xffff; // forward reference: assume absolute
  throw new Error(`mini-asm: unknown symbol "${s}"`);
}

function decode(op, operand, labels, pass) {
  const modes = OPS[op];
  if (!modes) throw new Error(`mini-asm: unsupported opcode ${op}`);
  if (!operand) return { mode: modes.imp !== undefined ? 'imp' : 'acc', value: 0 };
  if (operand === 'A') return { mode: 'acc', value: 0 };
  if (operand.startsWith('#')) return { mode: 'imm', value: parseNumber(operand.slice(1), labels, pass) & 0xff };
  let m = /^\((.+)\),Y$/i.exec(operand);
  if (m) return { mode: 'indy', value: parseNumber(m[1], labels, pass) };
  m = /^(.+),([XY])$/i.exec(operand);
  if (m) return { mode: m[2].toUpperCase() === 'X' ? 'absx' : 'absy', value: parseNumber(m[1], labels, pass) };
  const value = parseNumber(operand, labels, pass);
  if (modes.rel !== undefined) return { mode: 'rel', value };
  const isLabel = !operand.startsWith('$') && !/^[0-9]+$/.test(operand);
  const shortZp = operand.startsWith('$') && operand.length <= 3;
  return { mode: !isLabel && shortZp && modes.zp !== undefined ? 'zp' : 'abs', value };
}

/** Assembles `source` and returns {bytes: Map<addr, byte>, labels}. */
export function assemble(source) {
  let labels = {};
  let out;
  for (const pass of [1, 2]) {
    out = new Map();
    let pc = 0;
    for (const raw of source.split('\n')) {
      let line = raw.replace(/;.*/, '').trim();
      if (!line) continue;
      const lm = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line);
      if (lm) {
        if (pass === 1) labels[lm[1]] = pc;
        line = lm[2];
        if (!line) continue;
      }
      const [op, ...rest] = line.split(/\s+/);
      const operand = rest.join('');
      if (op === '.org') { pc = parseNumber(operand, labels, pass); continue; }
      if (op === '.byte' || op === '.word') {
        for (const v of operand.split(',')) {
          const n = parseNumber(v, labels, pass);
          out.set(pc++, n & 0xff);
          if (op === '.word') out.set(pc++, (n >> 8) & 0xff);
        }
        continue;
      }
      const { mode, value } = decode(op.toUpperCase(), operand, labels, pass);
      const opcode = OPS[op.toUpperCase()][mode];
      if (opcode === undefined) throw new Error(`mini-asm: ${op} has no ${mode} mode`);
      out.set(pc, opcode);
      if (mode === 'rel') {
        const off = value - (pc + 2);
        if (pass === 2 && (off < -128 || off > 127)) throw new Error(`mini-asm: branch out of range at $${pc.toString(16)}`);
        out.set(pc + 1, off & 0xff);
      } else if (SIZE[mode] >= 2) {
        out.set(pc + 1, value & 0xff);
        if (SIZE[mode] === 3) out.set(pc + 2, (value >> 8) & 0xff);
      }
      pc += SIZE[mode];
    }
  }
  return { bytes: out, labels };
}
