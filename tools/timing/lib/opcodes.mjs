// Official 6502 opcodes: mnemonic, addressing mode, size, base cycles, +1 on page cross (reads only).
// Branches: base 2, +1 taken, +1 more when the target is on another page (handled by the CFG).
// Modes: imp acc imm zp zpx zpy abs abx aby ind izx izy rel

const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, izx: 2, izy: 2, rel: 2 };

// [opcode, mnemonic, mode, cycles, pagePenalty]
const TABLE = [
  [0x69, 'ADC', 'imm', 2], [0x65, 'ADC', 'zp', 3], [0x75, 'ADC', 'zpx', 4], [0x6d, 'ADC', 'abs', 4],
  [0x7d, 'ADC', 'abx', 4, 1], [0x79, 'ADC', 'aby', 4, 1], [0x61, 'ADC', 'izx', 6], [0x71, 'ADC', 'izy', 5, 1],
  [0x29, 'AND', 'imm', 2], [0x25, 'AND', 'zp', 3], [0x35, 'AND', 'zpx', 4], [0x2d, 'AND', 'abs', 4],
  [0x3d, 'AND', 'abx', 4, 1], [0x39, 'AND', 'aby', 4, 1], [0x21, 'AND', 'izx', 6], [0x31, 'AND', 'izy', 5, 1],
  [0x0a, 'ASL', 'acc', 2], [0x06, 'ASL', 'zp', 5], [0x16, 'ASL', 'zpx', 6], [0x0e, 'ASL', 'abs', 6], [0x1e, 'ASL', 'abx', 7],
  [0x90, 'BCC', 'rel', 2], [0xb0, 'BCS', 'rel', 2], [0xf0, 'BEQ', 'rel', 2], [0x30, 'BMI', 'rel', 2],
  [0xd0, 'BNE', 'rel', 2], [0x10, 'BPL', 'rel', 2], [0x50, 'BVC', 'rel', 2], [0x70, 'BVS', 'rel', 2],
  [0x24, 'BIT', 'zp', 3], [0x2c, 'BIT', 'abs', 4], [0x00, 'BRK', 'imp', 7],
  [0x18, 'CLC', 'imp', 2], [0xd8, 'CLD', 'imp', 2], [0x58, 'CLI', 'imp', 2], [0xb8, 'CLV', 'imp', 2],
  [0xc9, 'CMP', 'imm', 2], [0xc5, 'CMP', 'zp', 3], [0xd5, 'CMP', 'zpx', 4], [0xcd, 'CMP', 'abs', 4],
  [0xdd, 'CMP', 'abx', 4, 1], [0xd9, 'CMP', 'aby', 4, 1], [0xc1, 'CMP', 'izx', 6], [0xd1, 'CMP', 'izy', 5, 1],
  [0xe0, 'CPX', 'imm', 2], [0xe4, 'CPX', 'zp', 3], [0xec, 'CPX', 'abs', 4],
  [0xc0, 'CPY', 'imm', 2], [0xc4, 'CPY', 'zp', 3], [0xcc, 'CPY', 'abs', 4],
  [0xc6, 'DEC', 'zp', 5], [0xd6, 'DEC', 'zpx', 6], [0xce, 'DEC', 'abs', 6], [0xde, 'DEC', 'abx', 7],
  [0xca, 'DEX', 'imp', 2], [0x88, 'DEY', 'imp', 2],
  [0x49, 'EOR', 'imm', 2], [0x45, 'EOR', 'zp', 3], [0x55, 'EOR', 'zpx', 4], [0x4d, 'EOR', 'abs', 4],
  [0x5d, 'EOR', 'abx', 4, 1], [0x59, 'EOR', 'aby', 4, 1], [0x41, 'EOR', 'izx', 6], [0x51, 'EOR', 'izy', 5, 1],
  [0xe6, 'INC', 'zp', 5], [0xf6, 'INC', 'zpx', 6], [0xee, 'INC', 'abs', 6], [0xfe, 'INC', 'abx', 7],
  [0xe8, 'INX', 'imp', 2], [0xc8, 'INY', 'imp', 2],
  [0x4c, 'JMP', 'abs', 3], [0x6c, 'JMP', 'ind', 5], [0x20, 'JSR', 'abs', 6],
  [0xa9, 'LDA', 'imm', 2], [0xa5, 'LDA', 'zp', 3], [0xb5, 'LDA', 'zpx', 4], [0xad, 'LDA', 'abs', 4],
  [0xbd, 'LDA', 'abx', 4, 1], [0xb9, 'LDA', 'aby', 4, 1], [0xa1, 'LDA', 'izx', 6], [0xb1, 'LDA', 'izy', 5, 1],
  [0xa2, 'LDX', 'imm', 2], [0xa6, 'LDX', 'zp', 3], [0xb6, 'LDX', 'zpy', 4], [0xae, 'LDX', 'abs', 4], [0xbe, 'LDX', 'aby', 4, 1],
  [0xa0, 'LDY', 'imm', 2], [0xa4, 'LDY', 'zp', 3], [0xb4, 'LDY', 'zpx', 4], [0xac, 'LDY', 'abs', 4], [0xbc, 'LDY', 'abx', 4, 1],
  [0x4a, 'LSR', 'acc', 2], [0x46, 'LSR', 'zp', 5], [0x56, 'LSR', 'zpx', 6], [0x4e, 'LSR', 'abs', 6], [0x5e, 'LSR', 'abx', 7],
  [0xea, 'NOP', 'imp', 2],
  [0x09, 'ORA', 'imm', 2], [0x05, 'ORA', 'zp', 3], [0x15, 'ORA', 'zpx', 4], [0x0d, 'ORA', 'abs', 4],
  [0x1d, 'ORA', 'abx', 4, 1], [0x19, 'ORA', 'aby', 4, 1], [0x01, 'ORA', 'izx', 6], [0x11, 'ORA', 'izy', 5, 1],
  [0x48, 'PHA', 'imp', 3], [0x08, 'PHP', 'imp', 3], [0x68, 'PLA', 'imp', 4], [0x28, 'PLP', 'imp', 4],
  [0x2a, 'ROL', 'acc', 2], [0x26, 'ROL', 'zp', 5], [0x36, 'ROL', 'zpx', 6], [0x2e, 'ROL', 'abs', 6], [0x3e, 'ROL', 'abx', 7],
  [0x6a, 'ROR', 'acc', 2], [0x66, 'ROR', 'zp', 5], [0x76, 'ROR', 'zpx', 6], [0x6e, 'ROR', 'abs', 6], [0x7e, 'ROR', 'abx', 7],
  [0x40, 'RTI', 'imp', 6], [0x60, 'RTS', 'imp', 6],
  [0xe9, 'SBC', 'imm', 2], [0xe5, 'SBC', 'zp', 3], [0xf5, 'SBC', 'zpx', 4], [0xed, 'SBC', 'abs', 4],
  [0xfd, 'SBC', 'abx', 4, 1], [0xf9, 'SBC', 'aby', 4, 1], [0xe1, 'SBC', 'izx', 6], [0xf1, 'SBC', 'izy', 5, 1],
  [0x38, 'SEC', 'imp', 2], [0xf8, 'SED', 'imp', 2], [0x78, 'SEI', 'imp', 2],
  [0x85, 'STA', 'zp', 3], [0x95, 'STA', 'zpx', 4], [0x8d, 'STA', 'abs', 4], [0x9d, 'STA', 'abx', 5],
  [0x99, 'STA', 'aby', 5], [0x81, 'STA', 'izx', 6], [0x91, 'STA', 'izy', 6],
  [0x86, 'STX', 'zp', 3], [0x96, 'STX', 'zpy', 4], [0x8e, 'STX', 'abs', 4],
  [0x84, 'STY', 'zp', 3], [0x94, 'STY', 'zpx', 4], [0x8c, 'STY', 'abs', 4],
  [0xaa, 'TAX', 'imp', 2], [0xa8, 'TAY', 'imp', 2], [0xba, 'TSX', 'imp', 2], [0x8a, 'TXA', 'imp', 2],
  [0x9a, 'TXS', 'imp', 2], [0x98, 'TYA', 'imp', 2],
];

export const OPCODES = new Array(256).fill(null);
for (const [op, mn, mode, cycles, penalty = 0] of TABLE) {
  OPCODES[op] = { op, mn, mode, size: SIZE[mode], cycles, penalty: !!penalty };
}

export const BRANCHES = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);
/** Instructions whose operand is only read (STA/STX/STY write; RMW read+write). */
export const WRITES = new Set(['STA', 'STX', 'STY']);
export const RMW = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC']);
