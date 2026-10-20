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
  loop.js              bucle a 60.0988 Hz con acumulador; runFrame()
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

## 3. Cómo encajan NMI y frame

Zelda hace **todo** dentro de la NMI: `RunGame` habilita la NMI y entra en `LoopForever: JMP LoopForever`.
Por tanto un frame del port = una ejecución de `IsrNmi`:

```js
// src/core/loop.js
export function runFrame(machine, game) {
  machine.ppu.beginFrame();   // scanline 241, flag de vblank activo
  game.nmi();                 // IsrNmi portada: vuelca buffers, espera sprite 0, lógica del modo
  machine.ppu.endFrame();     // renderiza lo que queda del frame
}
```

- `game.reset()` = `IsrReset` + `RunGame` hasta `LoopForever` (sin ninguna NMI). Esa RAM es el "frame 0"
  del oráculo.
- El oráculo define frame igual (snapshot en el `RTI` de `IsrNmi`), por eso las trazas son comparables.
- `src/headless.js` (`createGame({rom, sram, powerOnFill})`) monta la misma máquina que la página, llena la RAM
  con `powerOnFill`, llama a `reset()` y en cada `stepFrame(p1, p2)` fija los mandos (`input.setOverride`) y
  ejecuta `runFrame`. `framebuffer` es `ppu.indexBuffer`. RAM/SRAM/bus son singletons: un juego por proceso.
- **Audio**: las escrituras `$4000-$4017` del port van por `write()` → `bus.apuWrite` → `NesAudio.writeRegister`
  (main.js lo conecta tras el botón «Activar audio»); el bucle llama a `audio.endFrame()` tras cada `runFrame`.
  En headless `bus.apuWrite` es `null` y se descartan.

### El HUD y el sprite 0

`IsrNmi` escribe `$2000/$2001`, hace OAM DMA, pone el scroll a 0 y vuelca el buffer de tiles; luego:

```asm
@WaitVBlankEnd:            ; espera a que el flag de sprite 0 se borre (fin de vblank)
    LDA PpuStatus_2002
    AND #$40
    BNE @WaitVBlankEnd
    ...
    LDA IsSprite0CheckActive
    BEQ @CheckScroll
    LDA #$05
    JSR SwitchBank
    JSR WaitAndScrollToSplitBottom   ; Z_05: espera el hit, quema ciclos y escribe scroll/PPUADDR
```

La PPU es "catch-up": tiene un reloj en puntos. El código portado corre instantáneo; los accesos a registros
se aplican en el punto actual del reloj, y **las esperas activas del original se traducen en avances de
reloj**:

| asm | JS |
|---|---|
| bucle `LDA $2002 / AND #$40 / BNE` | `ppu.waitSprite0Clear()` |
| bucle `LDA $2002 / AND #$40 / BEQ` | `ppu.waitSprite0Hit()` (devuelve `false` si no hay hit este frame) |
| bucles de retardo (`DEX/BPL`, `NOP`s) | `ppu.cpuCycles(n)` con los ciclos exactos del bucle |
| `STA $4014` | `write(0x4014, 2)` (suma 513 ciclos solo) |

Los ciclos de los retardos se cuentan del asm (p. ej. el doble bucle `LDY #$03 / LDX #$30 / DEX / BPL / DEY / BPL`
de `WaitAndScrollToSplitBottom`, más sus `NOP`s). Calcúlalos con cuidado (saltos tomados +1 ciclo, cruce de página +1) y deja la cuenta en un comentario. Tras el retardo, las escrituras a
`$2005/$2006/$2000` cambian el scroll en mitad del frame exactamente como en hardware (registros loopy v/t/x/w).

Fuera de la NMI no se avanza el reloj: el resto de la lógica no depende del raster.

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
