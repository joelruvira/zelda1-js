# Arquitectura del port

Guía para los agentes que portan rutinas. Léela entera antes de escribir código en `src/game/`.

## 1. Principios

1. **Rutina a rutina.** Cada etiqueta global del desensamblado que sea código se convierte en una función JS
   con **el mismo nombre** y un comentario de una línea con su origen: `// UpdateMode (Z_07)`.
2. **RAM espejo.** Todo el estado del juego vive en `ram` (`Uint8Array(0x800)`, direcciones `$0000-$07FF`) y
   `sram` (`Uint8Array(0x2000)`, `$6000-$7FFF`). Nada de estado del juego en variables JS que sobreviva a
   una rutina. Así `tools/oracle` puede comparar la RAM del port con la del juego original frame a frame.
3. **Cero datos de Nintendo en el repo.** Las tablas `.BYTE`/`.WORD`/`.ADDR` del asm, gráficos, mapas y
   música se leen **en tiempo de ejecución** de la ROM del usuario, por etiqueta. Nunca copies bytes de la
   ROM al código (ni siquiera una tabla de 4 bytes). Las constantes que en el asm son inmediatos
   (`LDA #$3C`) sí se escriben en el código: son código, no datos.
4. **Fuente de verdad:** `reference/zelda1-disassembly/src` (US **PRG0**). No se modifica nunca.

### ROM y revisión

- `roms/zelda.nes` (no versionado) es la ROM del usuario, US PRG0 (SHA-1 sin cabecera
  `a12d74c7…`, CRC32 `3fe272fb`). Coincide con el desensamblado en todos los bytes conocidos
  (`tests/core/symbols.test.mjs` lo comprueba).
- `checkRevision()` (rom.js) compara la ROM cargada con las huellas por banco generadas del desensamblado.
  Con otra revisión la página avisa, pero las etiquetas/direcciones sólo son fiables en los bancos que
  coinciden. **El port apunta a PRG0**; no se mantienen tablas de diferencias con otras revisiones.

## 2. Mapa de módulos

```
src/core/              (Arquitecto) infraestructura, sin lógica de juego
  rom.js               loadRom, Rom.prgByte/prgBytes/prgWord, label(), table(), checkRevision()
  symbols.js           GENERADO: etiqueta -> [banco, dirCPU, tamaño, tipo, dirCarga?] (+ SEGMENTS)
  vars.js              GENERADO: variable de RAM/SRAM/IO -> dirección (+ VAR_SIZE, VAR_REGION)
  ram.js               ram, sram, peek/poke/word/setWord, cpu (flags C/Z/N/V + pila)
  bus.js               read/write del espacio de direcciones del 6502 (RAM, PPU, APU, mandos, SRAM, MMC1, PRG)
  asm.js               switchBank (SwitchBank) y tableJump (TableJump) con sus efectos en RAM
  ppu.js               2C02: CHR-RAM, nametables, paleta, OAM, registros, render por puntos, sprite 0
  mapper.js            MMC1: registros serie, mirroring, banco PRG (para bus.read) y CHR
  input.js             teclado/gamepad -> byte de botones; protocolo serie $4016/$4017
  loop.js              bucle a 60.0988 Hz con acumulador; runFrame() (frame lógico), runVideoFrame(), runReset()
  timing.js            rastreador de ciclos ($br, $pxa, $px, pollStatus; ver §3.1)
  cfg.js, cfg.gen.js   grafo de instrucciones del asm (GENERADO por scripts/gen-cfg.mjs; opcodes de la ROM)
  apu-timing.js        calendario de lecturas del DMC (robos de ciclo) como jsnes / hardware
  opcodes.js           tabla de opcodes oficiales del 6502
  machine.js           ensambla ROM+MMC1+PPU+input sobre el bus
  savestore.js         SRAM <-> localStorage; romstore.js: ROM en IndexedDB
src/audio/             (APU) APU emulada + AudioWorklet
src/game/              (porteadores) lógica del juego, un directorio por subsistema
  index.js             createGameLogic() -> {reset: IsrReset, nmi: IsrNmi}; stubs hasta que P01 los porte
  stub.js              stub('Nombre'): rutina de un paquete posterior (lanza NotImplementedError)
src/headless.js        runner sin DOM para el oráculo (contrato en docs/ORACLE.md); usa src/game/index.js
src/tileviewer.js      visor de tiles provisional (sin DOM, probado con la ROM real)
src/main.js            página: carga ROM, canvas, audio (botón), bucle; visor hasta que el juego arranque
```

Estructura de `src/game/` (la asignación exacta de rutinas está en `docs/ROUTINES.json` / `docs/PORT_MAP.md`):

```
src/game/
  nmi.js          IsrNmi, IsrReset, RunGame, TransferCurTileBuf, ReadInputs ...      (Z_07)
  modes/          UpdateMode*, InitMode*: un fichero por modo de juego              (Z_02, Z_05, Z_07)
  world/          overworld, mazmorras, scroll, cuevas, puertas, secretos          (Z_05, Z_06)
  link/           movimiento de Link, armas, objetos                                (Z_07, Z_01)
  objects/        motor de objetos, colisiones                                       (Z_07, Z_04)
  enemies/        IA por familia; bosses/                                           (Z_04, Z_01)
  menu/           título, selección de partida, registro, eliminación                (Z_02, Z_06)
  text/, ending/, sound/ (DriveAudio, Z_00) ...
```

Un módulo = un grupo coherente de rutinas (≤ ~400 líneas). El banco del asm sólo importa para leer datos;
el código JS de cualquier banco puede importar cualquier otro módulo.

## 3. Cómo encajan NMI y frame (y la temporización a nivel de ciclo)

Zelda hace **todo** dentro de la NMI: `RunGame` habilita la NMI y entra en `LoopForever: JMP LoopForever`.
Un frame lógico del port = una ejecución de `IsrNmi` hasta su `RTI` (definición del oráculo, `docs/ORACLE.md`).

- `game.reset()` = `IsrReset` + `RunGame` hasta `LoopForever`. Esa RAM es el "frame 0" del oráculo.
- `src/headless.js` (`createGame({rom, sram, powerOnFill, timing, strict, inputFor})`) monta la misma máquina
  que la página; `stepFrame(p1, p2)` ejecuta un frame lógico y deja en `framebuffer` la imagen que se ve
  después de ese `RTI`. RAM/SRAM/bus son singletons: un juego por proceso.
- **Audio**: `$4000-$4017` van por `write()` → `bus.apuWrite`; `audio.endFrame()` una vez por frame de vídeo.

### 3.1 Rastreador de ciclos (`src/core/timing.js`, diseño en `docs/TIMING.md`)

El port lleva la cuenta **exacta** de ciclos del 6502 original: el rastreador mantiene una posición en el
programa original (grafo de instrucciones de `src/core/cfg.js`, generado del asm por `scripts/gen-cfg.mjs` →
`cfg.gen.js`, opcodes leídos de la ROM al cargar) y el ciclo absoluto desde el encendido. Entre dos *migas*
del JS el asm no tiene decisiones, así que el rastreador lo recorre solo (sigue `JSR`/`RTS`/`JMP` con una pila
de retornos propia, `SwitchBank*` es opaco). Cada acceso de E/S cae en su ciclo; la PPU (`ppu.syncTo`) dibuja
hasta ese punto exacto, cruza fronteras de frame sola (frames de lag) y entrega cada imagen (`onFrame`).

Modos (`createGame({timing})`, `?timing=` en la página, env `ZELDA_TIMING`):
`jsnes` (por defecto: reglas del oráculo de CI: frame de 89 342 puntos, render de fondo por línea como jsnes,
PPUMASK desde la línea siguiente, hit del sprite 0 como jsnes, DMC/sample timer de jsnes), `hardware` (PPU por
puntos, punto impar; DMC aproximado) y `off` (modelo antiguo "tiempo cero"). `strict: true` (o
`ZELDA_TIMING_STRICT=1`) hace que una miga mal puesta o que falte lance `TimingError` con la línea del asm;
sin estricto, el rastreador deja de contar hasta la NMI siguiente y esa NMI sigue con el modelo antiguo (RAM
idéntica siempre: la temporización solo afecta a la imagen).

**Migas automáticas** (no hay que escribir nada):

| Qué | Dónde |
|---|---|
| E/S `$2000-$401F` y escrituras al mapper (`$8000+`) | `bus.read/write` |
| `TableJump` | `tableJump()` de `core/asm.js` |
| `SwitchBank` | `switchBank()` de `core/asm.js` (opaco; el banco se aplica al pasar el `JSR SwitchBank`) |
| entrada/salida de rutinas, `JMP`, caídas | el propio asm (no hace falta `enter/leave`) |
| NMI, bucle ocioso, OAM DMA 513/514, robos del DMC, NMI anidada | `timing.stepFrame` (bucle) |

**Migas manuales** (`import { $br, $pxa, $px, pollStatus } from '../core/timing.js'`):

| asm | JS |
|---|---|
| un salto condicional `Bxx` en la línea L de `Z_0b.asm` | envolver la condición: `if ($br('Z_0b:L', tomado)) ...` — `$br` devuelve `tomado`; la condición del JS debe ser "el salto se toma" (usar `!$br(...)` para el caso contrario) |
| bucle `for` / `while` | en la forma del asm: el cuerpo y luego `if (!$br('Z_0b:L', sigue)) break;` (una miga por vuelta) |
| lectura indexada que puede cruzar página (`LDA Tabla,Y`, `LDA ($00),Y`) | antes de leer: `$pxa('Z_0b:L', base, índice)` (base = dirección de la tabla o del puntero) o `$px('Z_0b:L', cruza)` |
| bucle `LDA $2002 / AND #m / Bxx` hacia atrás | `pollStatus(bus.ppu, m, hastaQueEsté)` |
| un helper JS que sirve a varios saltos del asm | pasarle la referencia: `bitIndex(a, 'Z_00:442')` |

Ejemplo (IsrNmi, `Z_07`):

```js
if (!$br('Z_07:391', ram[SwitchNameTablesReq] === 0)) a ^= 0x02;      // LDX ... / BEQ :+ / EOR #$02
for (let x = 0x18, y = 0x0d; ;) { cpu.rorMem(x); x++; y--; if (!$br('Z_07:531', y !== 0)) break; } // DEY / BNE
pollStatus(bus.ppu, 0x40, false);                                       // @WaitVBlankEnd
```

Las referencias son literales `'Z_0b:línea'` (el desensamblado no cambia). No hace falta seguir el orden de
rutinas del asm al pie de la letra, pero sí el **orden de las decisiones y accesos**: cada miga se comprueba
contra el asm. Coste: el rastreador cuesta menos que lo que ahorra el render por línea (`node
tools/timing/bench.mjs`: ~0,6 ms por frame en `jsnes` frente a ~1,1 ms del modelo antiguo).

Herramientas para anotar: `node tools/timing/coverage.mjs P05` (saltos sin `$br`, lecturas sin `$pxa`,
anotaciones erróneas o sobrantes, por rutina), `node tools/timing/cycle-diff.mjs <movie> [--resync]` (primer
desfase de ciclo con la rutina y la línea del asm; `--resync` da la lista de trabajo por NMI) y
`node tools/oracle/battery.mjs movies` (píxeles distintos, objetivo 0). Ver `docs/TIMING.md` §10.

### El HUD y el sprite 0

`WaitAndScrollToSplitBottom` (`src/game/ppu/sprite0.js`) es `pollStatus` + los bucles de retardo del asm con
`$br`: las escrituras del corte caen en el ciclo del original. Sin rastreador (`timing: 'off'`) las escrituras
ocurren justo tras el hit (los contadores a mano se quitaron; `ppu.waitStatus/cpuCycles` quedan solo como
respaldo del modo antiguo).

## 4. Acceso a memoria

```js
import { ram, sram, cpu, word } from '../core/ram.js';
import { read, write } from '../core/bus.js';
import { GameMode, ObjX, ObjDir, Sprites } from '../core/vars.js';
```

| asm | JS |
|---|---|
| `LDA GameMode` | `ram[GameMode]` |
| `STA ObjX, X` | `ram[ObjX + x] = a` (el `Uint8Array` trunca a 8 bits) |
| `INC FrameCounter` | `ram[FrameCounter]++` (el `Uint8Array` hace el wrap) |
| `LDA $00` / `STA $0F` (temporales) | `ram[0x00]`, `ram[0x0f]`: **también se escriben**, el diff los compara |
| `LDA ($00), Y` | `read(word(0x00) + y)` (si el puntero puede apuntar a ROM/SRAM) o `ram[...]` si sólo RAM |
| `LDA $6xxx` (SRAM) | `sram[addr - 0x6000]` o `read(addr)` |
| `STA PpuData_2007` | `write(0x2007, a)` |
| `STA SongRequest` | `ram[SongRequest] = a` |

- Usa **siempre** los nombres de `vars.js`; nunca direcciones mágicas salvo los temporales `$00-$0F` que el
  asm tampoco nombra.
- Varias variables comparten dirección (la RAM se reutiliza por modo): usa el nombre que use el asm en esa
  línea.
- `vars.js` es generado (`npm run gen-vars`). Si falta un nombre, no lo añadas a mano: avisa al Arquitecto.

## 5. Datos de la ROM por nombre

`symbols.js` da, para cada etiqueta del desensamblado, banco y dirección. Las etiquetas duplicadas entre
bancos llevan sufijo `Nombre#banco`; las locales `Rutina@Local`.

```js
import { table, label } from '../core/rom.js';
import { bus } from '../core/bus.js';

const songs = table(bus.rom, 'LevelSongIds');
songs.byte(y);            // LDA LevelSongIds, Y
const cols = table(bus.rom, 'PlayAreaColumnAddrs');
cols.byte(y + 1);         // LDA PlayAreaColumnAddrs+1, Y  (aritmética en bytes, como el asm)
cols.word(i);             // las dos lecturas juntas cuando el asm lee lo/hi con el mismo índice
label('PlayAreaColumnAddrs').addr;   // LDA #<PlayAreaColumnAddrs  (dirección como dato)
```

- Crea los `table()` a nivel de módulo de forma perezosa o dentro de la rutina; son objetos baratos.
  `loadSymbols()` se llama una vez al arrancar (main.js / headless.js), antes de cualquier rutina.
- Un índice que se sale de la etiqueta (el asm lee "la tabla siguiente") **es válido**: `table()` no
  limita, igual que el 6502. No lo "arregles".
- **Segmentos copiados a SRAM**: `BANK_01_CODE` (ROM `$A500` banco 1 → SRAM `$6C90`) y `BANK_06_DATA`
  (`$9CD8` banco 6 → `$67F0`). `label()` devuelve `addr` (dirección en SRAM, la que usa el código) y `load`
  (dónde están los bytes en la ROM); `table()` lee de `load`. Como el juego lee estas tablas en SRAM y
  `BANK_06_DATA` está en la zona comparada por el oráculo, **porta `CopyCommonCodeToRam` y similares
  literalmente** (copiar bytes de ROM a `sram` con `read()`), y las lecturas de esos datos en el juego hazlas
  sobre `sram` como el original.
- Si el código lee ROM mediante un puntero (`($00),Y` hacia `$8000-$BFFF`) el resultado depende del banco
  mapeado: llama a `switchBank(n)` donde lo haga el original y usa `read()`.

## 6. Convenciones de traducción asm → JS

### Registros y flags

- `A`, `X`, `Y` son variables locales `let a, x, y`. Enmascara a 8 bits cuando la aritmética pueda
  desbordar (`x = (x + 1) & 0xff`) — los `Uint8Array` sólo truncan al guardar.
- **Carry explícito.** Si el asm encadena `ADC`/`SBC`/`ROL`/`ROR` o un llamador mira `C` tras un `JSR`, usa
  `cpu.c` y los helpers `cpu.adc/sbc/rol/ror/asl/lsr/cmp/bit`. Si el carry es trivial (`CLC; ADC #$10` sin
  desbordamiento que se use), escribe aritmética directa con `& 0xff`.
- `Z`/`N` tras un `JSR` (`JSR HasCompass / BEQ Exit`): la función devuelve `A` y el llamador evalúa
  `=== 0` / `& 0x80`.
- Valor de retorno: la función devuelve `A` si algún llamador lo usa. Si un llamador usa `X`/`Y`/`C`
  de salida, documenta el contrato con `@returns` y devuelve `{a, x, y}` o deja `cpu.c`.
- Parámetros: los registros de entrada son parámetros JS en orden `(a, x, y)` según use la rutina:
  `ClearNameTable(a, x, y)`.

### Control de flujo

- Etiquetas locales `@Loop` → bucles `for/while/do`. `:+`/`:-` → `if` / bucles.
- **Caída a la siguiente rutina** (sin `RTS`): la función llama a la siguiente al final
  (`return GoToNextModeResetGridOffset();`). Si una etiqueta intermedia también es punto de entrada, es su
  propia función.
- `JMP Otra` al final = `return Otra(...)`.
- `JSR TableJump` + `.ADDR` → `tableJump(label('X_JumpTable').addr, a, [f0, f1, ...])` de `core/asm.js`
  (deja `$00-$03` igual que el original y despacha). La tabla de funciones JS va en el mismo orden que
  los `.ADDR`; entradas repetidas repiten la función.
- `SwitchBank` → `switchBank(n)` (core/asm.js). Mantén las llamadas donde estén en el asm: no cambia la RAM,
  pero sí lo que `read()` ve en `$8000-$BFFF`.
- Pila: el port **no** emula `JSR/RTS`. `PHA/PLA` emparejados dentro de una rutina → variable local.
  Si una rutina manipula direcciones de retorno (`PLA; PLA` para "salir dos niveles", como `TableJump`),
  tradúcelo como control de flujo (un `return` con un valor centinela que el llamador comprueba) y comenta
  por qué. La página `$0110-$01FF` se ignora en el diff.
- Código "Unknown block"/"unverified" del desensamblado: pórtalo igual, aunque parezca muerto.

### Estilo

- ES modules nativos, sin dependencias. Funciones pequeñas, una por rutina, exportadas con `export function`.
- Primera línea de cada función: `// NombreRutina (Z_0n)` (+ un comentario breve si el porqué no es obvio).
- No cambies el orden de las escrituras a RAM ni elimines escrituras "inútiles": el diff las ve.
- Nada de `Math.random`, `Date` ni estado fuera de `ram`/`sram`.

## 7. Ejemplos reales

### 7.1 `GoToNextModePlayLevelSong` (Z_07): tabla de la ROM + caída

```asm
GoToNextModePlayLevelSong:
    LDY CurLevel
    LDA LevelSongIds, Y
    STA SongRequest             ; Play the song for the level.
GoToNextModeResetGridOffset:
    JSR GoToNextMode
    STA ObjGridOffset
L1EBF8_Exit:
    RTS
...
GoToNextMode:
    INC GameMode
EndGameMode:
    LDA #$00
    STA IsUpdatingMode
    STA GameSubmode
    RTS
```

```js
import { ram } from '../core/ram.js';
import { bus } from '../core/bus.js';
import { table } from '../core/rom.js';
import { CurLevel, SongRequest, ObjGridOffset, GameMode, IsUpdatingMode, GameSubmode } from '../core/vars.js';

export function GoToNextModePlayLevelSong() {
  // GoToNextModePlayLevelSong (Z_07)
  const y = ram[CurLevel];
  ram[SongRequest] = table(bus.rom, 'LevelSongIds').byte(y);
  return GoToNextModeResetGridOffset(); // falls through
}

export function GoToNextModeResetGridOffset() {
  // GoToNextModeResetGridOffset (Z_07)
  ram[ObjGridOffset] = GoToNextMode();
}

export function GoToNextMode() {
  // GoToNextMode (Z_07)
  ram[GameMode]++;
  return EndGameMode();
}

export function EndGameMode() {
  // EndGameMode (Z_07): returns A = 0
  ram[IsUpdatingMode] = 0;
  ram[GameSubmode] = 0;
  return 0;
}
```

### 7.2 `UpdateMode` (Z_07): tabla de saltos

```asm
UpdateMode:
    LDA #$02
    JSR SwitchBank
    LDA GameMode
    JSR TableJump
UpdateMode_JumpTable:
    .ADDR UpdateMode0Demo
    .ADDR UpdateMode1Menu
    ...                          ; 20 entradas; 5Play aparece en 5, 9, $A, $B, $C
```

```js
import { switchBank, tableJump } from '../core/asm.js';
import { label } from '../core/rom.js';

let handlers; // built lazily: the mode modules import each other
export function UpdateMode() {
  // UpdateMode (Z_07)
  switchBank(2);
  handlers ??= [UpdateMode0Demo, UpdateMode1Menu, UpdateMode2Load, UpdateMode3Unfurl,
    UpdateMode4and6EnterLeave, UpdateMode5Play, UpdateMode4and6EnterLeave, UpdateMode7Scroll,
    UpdateMode8ContinueQuestion, UpdateMode5Play, UpdateMode5Play, UpdateMode5Play, UpdateMode5Play,
    UpdateModeDSave, UpdateModeERegister, UpdateModeFElimination, UpdateMode10Stairs,
    UpdateMode11Death, UpdateMode12EndLevel, UpdateMode13WinGame];
  return tableJump(label('UpdateMode_JumpTable').addr, ram[GameMode], handlers);
}
```

`tableJump` escribe `$00/$01 = UpdateMode_JumpTable - 1` y `$02/$03 =` la dirección leída de la ROM, como
el original, y luego llama al handler.

### 7.3 `ReadInputs` / `ReadOneController` (Z_07): carry, ROL y temporales

```asm
ReadInputs:
    LDA #$01 / STA Ctrl1_4016 / LDA #$00 / STA Ctrl1_4016
    STA $03 / STA $04 / TAX
    JSR ReadOneController
    INX
ReadOneController:
    STA $02
    LDA #$01 / STA Ctrl1_4016 / LDA #$00 / STA Ctrl1_4016
    LDY #$08
@Read:
    LDA Ctrl1_4016, X
    LSR
    ROL ButtonsPressed, X
    LSR
    ROL $00
    DEY
    BNE @Read
    LDA ButtonsPressed, X
    CMP $02
    BNE ReadOneController
    INC $03, X
    LDY $03, X
    CPY #$02
    BCC ReadOneController
    LDA $00
    ORA ButtonsPressed, X
    STA ButtonsPressed, X
    PHA
    EOR ButtonsDown, X
    AND ButtonsPressed, X
    STA ButtonsPressed, X
    PLA
    STA ButtonsDown, X
    RTS
```

```js
import { ram, cpu } from '../core/ram.js';
import { read, write } from '../core/bus.js';
import { ButtonsPressed, ButtonsDown } from '../core/vars.js';

export function ReadInputs() {
  // ReadInputs (Z_07)
  write(0x4016, 1);
  write(0x4016, 0);
  ram[0x03] = 0;
  ram[0x04] = 0;
  let a = ReadOneController(0, 0);
  ReadOneController(a, 1); // INX, falls through
}

export function ReadOneController(a, x) {
  // ReadOneController (Z_07): re-reads until two equal readings in a row; returns A
  for (;;) {
    ram[0x02] = a;
    write(0x4016, 1);
    write(0x4016, 0);
    for (let y = 8; y > 0; y--) {
      a = read(0x4016 + x);
      a = cpu.lsr(a);
      cpu.rolMem(ButtonsPressed + x);
      a = cpu.lsr(a);
      cpu.rolMem(0x00);
    }
    a = ram[ButtonsPressed + x];
    if (a !== ram[0x02]) continue;
    ram[0x03 + x]++;
    if (ram[0x03 + x] < 2) continue;
    break;
  }
  a = ram[0x00] | ram[ButtonsPressed + x];
  ram[ButtonsPressed + x] = a;
  const pushed = a; // PHA
  ram[ButtonsPressed + x] = (a ^ ram[ButtonsDown + x]) & ram[ButtonsPressed + x];
  ram[ButtonsDown + x] = pushed; // PLA
  return pushed;
}
```

Fíjate en que `$00`, `$02` y `$03/$04` se escriben igual que en el original, el `ROL` usa el carry real
(`cpu`) y `PHA/PLA` es una variable local.

## 8. Pruebas

- **Unitarias** (`tests/game/<subsistema>/*.test.mjs`, `node --test`): prepara `ram` a mano, llama a la
  rutina, comprueba la RAM. Los tests que necesitan la ROM o el desensamblado se saltan sin ellos
  (`tests/core/helpers.mjs`: `hasRom`, `hasDisasm`, `syntheticRom()`).
- **Contra el oráculo** (`docs/ORACLE.md`): una rutina está terminada cuando el diff de RAM de los movies
  de prueba es 0. `npm test` debe pasar siempre.
- Generadores: `npm run gen` regenera `vars.js` y `symbols.js`; los tests fallan si quedan desfasados.

## 9. Propiedad de ficheros

Edita sólo los ficheros de tu paquete. `src/core/**` es del Arquitecto: si necesitas un helper nuevo en el
núcleo (p. ej. otra rutina de `Z_07` usada por todos), pídelo en vez de crearlo en tu módulo.
