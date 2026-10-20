# Audio: APU 2A03 (NTSC)

Emulación del chip de sonido de la NES en `src/audio/`. No contiene datos de la ROM: las tablas de
`tables.js` son constantes del hardware (length counter, duty, periodos de ruido/DMC, mezclador).
El motor de música/efectos de Zelda (Z_00 `DriveAudio`…) se porta en otra fase y escribirá aquí.

## Módulos
| Fichero | Contenido |
|---|---|
| `tables.js` | `CPU_HZ` (1789772.73), `FRAME_CYCLES` (29780.5), `FRAME_HZ` (60.0988), tablas del hardware y mezclador `PULSE_TABLE`/`TND_TABLE`. |
| `envelope.js` | Envolvente (pulsos y ruido). |
| `pulse.js` | Pulso: duty, envelope, sweep (negación en complemento a uno en pulso 1, a dos en pulso 2; mute por periodo < 8 u objetivo > $7FF), length counter. |
| `triangle.js` | Triángulo con linear counter; mantiene el nivel al pararse; periodos ultrasónicos sin silenciar (como el hardware). |
| `noise.js` | Ruido: LFSR 15 bits, modo largo/corto, periodos NTSC. |
| `dmc.js` | DMC: lector de memoria (`readMemory(addr)`), buffer, unidad de salida, loop, IRQ, `$4011` directo. No modela el robo de ciclos a la CPU. |
| `frame-counter.js` | Secuenciador 4/5 pasos (7457/14913/22371/29829[/37281] ciclos), IRQ, retardo de 3/4 ciclos al escribir `$4017`, clock inmediato en modo 5 pasos. |
| `apu.js` | `Apu`: une los canales, `writeRegister`, `readStatus` (`$4015`), `mix()`, `clock(ciclos, sink)`. |
| `filters.js` | Paso-alto 90 Hz, paso-alto 440 Hz, paso-bajo 14 kHz (primer orden). |
| `resampler.js` | Ciclos de CPU → frecuencia de salida (promedio por caja con borde fraccionario) + filtros + buffer circular. |
| `stream.js` | `ApuStream`: cola de frames con escrituras con timestamp, control de latencia. |
| `worklet.js` | `AudioWorkletProcessor` `'nes-apu'`. |
| `audio.js` | `NesAudio`: fachada para el juego; fallback a `ScriptProcessorNode`. |

## Uso desde el juego
```js
import { NesAudio } from './audio/audio.js';
const audio = new NesAudio();               // { targetFrames: 2, maxFrames: 6 }
audio.setReadMemory((addr) => read(addr)); // read de src/core/bus.js; DMC; en worklet se copia $8000-$FFFF
startButton.onclick = () => audio.init();   // AudioContext tras gesto del usuario
// cada frame (en el orden en que el juego escribe):
audio.writeRegister(0x4017, 0xff);          // ciclo opcional: writeRegister(addr, v, ciclo)
audio.endFrame();                           // envía el lote; duración 29780/29781 alternada
```
- Sin ciclo explícito, cada escritura se sitúa 4 ciclos después de la anterior (≈ `LDA`+`STA`), a
  partir del ciclo 0 del frame. Un ciclo explícito menor que el cursor se sube al cursor (orden estable).
- `$4014` (OAM DMA) y `$4016` (mandos) se ignoran: no son de la APU.
- Antes de `init()` las escrituras se descartan.
- Uso sin navegador (tests, oráculo): `new Apu({ readMemory })`, `apu.writeRegister(a, v)`,
  `apu.clock(n, resampler)`, `resampler.take()`. Así se puede comparar la salida con un emulador.

## Sincronización y latencia
El bucle del juego produce frames a 60.0988 Hz y la tarjeta de sonido consume a su reloj. `ApuStream`
mantiene `targetFrames` (2 ≈ 33 ms) de audio en cola:
- ajuste proporcional de velocidad, como máximo ±0.5 % (inaudible), para absorber la deriva;
- si la cola supera `maxFrames`, ejecuta los frames sobrantes sin generar audio (estado correcto, sin latencia acumulada);
- si se vacía (pestaña oculta, tirón), congela la APU y mantiene el nivel; el paso-alto lo lleva a silencio. Se vuelve a cebar con `targetFrames`.
- `audio.bufferedFrames` y `stats.underruns` permiten al bucle medir la latencia.

Mensajes del worklet: `{type:'frame', writes:Uint32Array, cycles}`, `{type:'memory', bytes, base}`,
`{type:'config', targetFrames, maxFrames}`, `{type:'reset'}`; responde `{type:'stats', buffered, underruns}`.
Cada escritura va empaquetada en un `Uint32`: `ciclo<<13 | (addr-$4000)<<8 | valor` (`packWrite`/`unpackWrite`).

## Lo que usa Zelda (Z_00 / Z_07)
- `DriveAudio` escribe `$4017 = $FF` en cada frame: modo 5 pasos, IRQ inhibida y reset del secuenciador,
  con clock inmediato de quarter+half. Resultado: 2 half frames por frame de vídeo (reset + paso 14913) y
  4 quarter frames (reset, 7457, 14913, 22371); el paso 37281 nunca llega. Cubierto por test.
- Pausa: `$4015 = $00` y luego `$0F` (silencia y reactiva sin DMC).
- Sweeps en `$4001/$4005` (efectos), escrituras completas de periodo/length en ambos pulsos, triángulo
  (`$4008/$400A/$400B`), ruido (`$400C/$400E/$400F`).
- Samples (`DriveSample`): `$4011` ($00 o $7F), `$4010`, `$4012`, `$4013` desde tablas en Z_00, después
  `$4015 = $0F` (para el DMC) y `$4015 = $1F` (lo reinicia). `PcmSamples` está al principio del banco fijo
  (Z_07, `$C000`, offset PRG $1C000 según `bins.xml`), por eso `$4012 = $00` apunta a él. `ClearAllAudioAndVideo`
  escribe `$4011 = 0` y `$4015 = $0F`.
- El juego no lee `$4015` ni usa IRQs de la APU; aun así están implementados.

## Simplificaciones conocidas
- Robo de ciclos del DMC a la CPU y lectura retardada tras `$4015`: no modelados (no afectan a la RAM del port).
- Carreras de 1 ciclo (recarga del length counter coincidente con su clock, escritura de halt durante el clock).
- Los filtros son de primer orden a la frecuencia de salida (como recomienda nesdev).

## Tests
`node --test tests/audio/`: periodos de pulso/triángulo/ruido/DMC, duty, sweep (diferencias de negación),
envelope, length counter, frame counter (IRQ, modo 5 pasos, `$4017` por frame), mezclador, filtros,
frecuencia de salida por cruces por cero y Goertzel a 48 kHz y 44.1 kHz, `ApuStream` y fachada.
`rom-dmc.test.mjs` usa `roms/zelda.nes` y se salta si no existe.
