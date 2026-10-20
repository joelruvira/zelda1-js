// Constantes del hardware APU 2A03 (NTSC). No son datos de la ROM: son propiedades del chip.

// Reloj de CPU NTSC: 21.477272 MHz / 12.
export const CPU_HZ = 21477272.727272727 / 12;
// Ciclos de CPU por frame de vídeo NTSC (341*262 - 0.5 puntos PPU / 3, promedio).
export const FRAME_CYCLES = 29780.5;
// Frecuencia de frame resultante (~60.0988 Hz).
export const FRAME_HZ = CPU_HZ / FRAME_CYCLES;

// Tabla de carga del length counter (índice = bits 7-3 de $4003/$4007/$400B/$400F).
export const LENGTH_TABLE = Uint8Array.of(
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
);

// Secuencias de duty de los pulsos (leídas por un secuenciador que cuenta hacia abajo).
export const DUTY_TABLE = [
  Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0), // 12.5 %
  Uint8Array.of(0, 1, 1, 0, 0, 0, 0, 0), // 25 %
  Uint8Array.of(0, 1, 1, 1, 1, 0, 0, 0), // 50 %
  Uint8Array.of(1, 0, 0, 1, 1, 1, 1, 1), // 25 % negado
];

// Secuencia de 32 pasos del triángulo.
export const TRIANGLE_SEQUENCE = Uint8Array.of(
  15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
);

// Periodos del ruido NTSC, en ciclos de CPU.
export const NOISE_PERIODS = Uint16Array.of(
  4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068,
);

// Periodos del DMC NTSC, en ciclos de CPU.
export const DMC_PERIODS = Uint16Array.of(
  428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
);

// Mezclador no lineal (aproximación oficial por tablas de nesdev "APU Mixer").
// pulse_table[n] = 95.52 / (8128 / n + 100),   n = pulse1 + pulse2       (0..30)
// tnd_table[n]   = 163.67 / (24329 / n + 100), n = 3*tri + 2*noise + dmc (0..202)
export const PULSE_TABLE = new Float32Array(31);
export const TND_TABLE = new Float32Array(203);
for (let n = 1; n < 31; n++) PULSE_TABLE[n] = 95.52 / (8128 / n + 100);
for (let n = 1; n < 203; n++) TND_TABLE[n] = 163.67 / (24329 / n + 100);
