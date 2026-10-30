# Oráculo: comparar el port con el juego original

El oráculo ejecuta la ROM original en un emulador NES (jsnes, en Node), le aplica un *movie* de
entradas y vuelca **una instantánea por frame lógico**: RAM 2 KB, SRAM 8 KB y, en los frames que se pidan,
el framebuffer. El port ejecuta el mismo movie a través de un *headless runner* y produce una traza con el
mismo formato. `diff.mjs` las compara frame a frame y nombra las variables que difieren.

Nada de esto incluye datos de la ROM: la ROM se lee de `roms/zelda.nes` (o `--rom`). Si no existe, los
comandos terminan con un mensaje claro (código 3) y los tests que la necesitan se saltan.

## Instalación

```sh
cd tools/oracle && npm install     # instala jsnes 2.1.0 (devDependency local del oráculo)
```

`jsnes` vive en `tools/oracle/package.json` para no tocar el `package.json` raíz (es del Arquitecto).
Si se añade `"jsnes": "2.1.0"` a las devDependencies raíz, todo sigue funcionando igual. Sin jsnes, los
tests de emulación se saltan y las herramientas que no emulan (movies, diff de trazas) siguen funcionando.

## Uso rápido

```sh
# 1) traza del original (PNG del último frame por defecto)
node tools/oracle/run-oracle.mjs tests/oracle/movies/walk-first-screens.zmv --png every:100
# 2) traza del port con exactamente las mismas entradas por frame
node tools/oracle/run-port.mjs --inputs-from out/oracle/walk-first-screens/trace.ztrace
# 3) diff (código 0 = idénticas, 1 = divergencia)
node tools/oracle/diff.mjs out/oracle/walk-first-screens/trace.ztrace out/port/walk-first-screens/trace.ztrace \
     --png-dir out/diff/walk-first-screens

# los tres pasos de una vez
node tools/oracle/compare.mjs tests/oracle/movies/title-start.zmv --png every:30

# línea temporal de variables (para calibrar movies) o volcado de RAM
node tools/oracle/trace-info.mjs out/oracle/register-name/trace.ztrace --watch GameMode,GameSubmode,RoomId
node tools/oracle/trace-info.mjs out/oracle/register-name/trace.ztrace --dump 300

# diff de dos PNG cualesquiera
node tools/oracle/diff.mjs a.png b.png --out diff.png

# tests (los de ROM se saltan si no hay roms/zelda.nes)
node --test tests/oracle/
```

Las salidas van a `out/` (ignorado por git): `out/oracle/<movie>/trace.ztrace`, `frame_NNNNNN.png`, y
`out/diff/<movie>/diff_NNNNNN.png` (original | port | diferencias en rojo).

### Opciones principales

| Herramienta | Opción | Significado |
|---|---|---|
| run-oracle | `--rom f` | ROM (por defecto `roms/zelda.nes`) |
| | `--frames N` | recorta/rellena el movie a N frames |
| | `--png sel` | frames con framebuffer + PNG: `0,60,600`, `every:60`, `10-20`, `last`, `all`, `none` |
| | `--sram f.sav` | SRAM inicial (8 KB); por defecto todo a 0 (sin partidas) |
| | `--power-on hex` | byte de relleno de la RAM al encender (defecto `00`); `jsnes` = patrón de jsnes |
| run-port | `--inputs-from t` | reproduce las entradas grabadas en la traza del oráculo (recomendado) |
| | `--port m` | módulo del runner (defecto `src/headless.js`) |
| diff | `--ignore r` | rango extra: `0x00-0x0F`, `$6000`, `ObjX:12` (12 bytes), `Random+2` (repetible) |
| | `--ignore-temps` | ignora también `$00-$0F` |
| | `--strict` | no aplica `tools/oracle/ignore.default.json` ni la máscara de la fila 0 |
| | `--no-sram`, `--no-fb`, `--ignore-left8` | omite SRAM / imagen / las 8 columnas izquierdas |
| | `--verbose`, `--json` | todos los frames divergentes / informe máquina |

## Definición exacta de "frame"

Del desensamblado (`Z_07.asm`):

* `IsrReset`: `SEI`, `CLD`, PPUCTRL=0 (sin NMI), pila en `$01FF`, espera **dos** vblanks leyendo
  `$2002`, resetea el MMC1, control `$0F` (mirroring horizontal, PRG de 16 KB en `$8000`, banco 7 fijo en
  `$C000`), CHR-RAM banco 0, `SwitchBank 7` y salta a `RunGame`.
* `RunGame`: `InitSaveRam` (banco 5), `ClearRam` (borra `$0000-$00EF` y `$0300-$07FE`, **no** toca `$07FF`,
  `$00F0-$00FF` ni la pila), `ClearAllAudioAndVideo`, y activa la NMI (PPUCTRL |= `$A0`). Después el
  programa principal se queda en `LoopForever: JMP LoopForever`.
* `IsrNmi` hace **todo** el trabajo del juego: desactiva la NMI, PPUMASK, DMA de OAM (`$0200`),
  `TransferCurTileBuf`, espera el fin del sprite‑0 anterior y, si `IsSprite0CheckActive`, espera el hit del
  sprite 0 (`WaitAndScrollToSplitBottom`, banco 5) para dividir HUD/campo; aplica scroll; decrementa
  temporizadores; `ReadInputs` (solo si no hay sprite 0 activo); revuelve `Random`; `DriveAudio`;
  `INC FrameCounter`; `InitializeGameOrMode` o `UpdateMode`; reactiva la NMI y `RTI` (único RTI de la ROM).

Por tanto:

* **Frame 0** = estado de la RAM en la entrada de la **primera NMI** (power‑on + `IsrReset` + `RunGame`
  completos). En el port: el estado justo después de `createGame()`.
* **Frame N (N ≥ 1)** = estado de la RAM cuando la **N‑ésima NMI** ejecuta su `RTI` final. El oráculo toma
  la instantánea justo antes de ejecutar el `RTI` (el RTI solo lee la pila, así que es idéntico). En el port:
  el estado tras la N‑ésima llamada a `stepFrame()`.
* La entrada del frame N es `movie[N-1]`. En el oráculo se presenta al mando en el momento en que entra la
  NMI N; `ReadInputs` la lee dentro de esa NMI. El port la recibe como argumento de `stepFrame`.
* **Framebuffer del frame N** = la imagen que la PPU dibuja *después* de la NMI N (el siguiente frame de
  vídeo completo). Es la imagen que el jugador ve con el estado N.
* **Frames de lag**: si la NMI tarda más de un frame de vídeo (cargas de modo con el vídeo apagado), la NMI
  siguiente se pierde. Los frames lógicos solo cuentan NMIs, así que el lag **no** desalinea la
  comparación. La traza guarda en `videoFrame` el frame de vídeo en que empezó cada NMI
  (`trace-info.mjs` lista dónde hubo lag; p. ej. frames 2‑4 al arrancar, y en cada transición de modo).
* **NMI anidada** (salas de juego con mucho lag, p. ej. nivel 8 sala `$5E` en `boss-gleeok4`): si una NMI
  larga reactiva la NMI *dentro* del vblank siguiente (flag de vblank aún puesto), la segunda NMI se ejecuta
  antes del `RTI` de la primera. El frame lógico k (primer `RTI`) contiene entonces dos NMIs de trabajo
  (`FrameCounter` +2) y el k+1 ninguna (+0). El port (una NMI por `stepFrame`, sin modelo de ciclos;
  `docs/TIMING.md`) va una NMI por detrás solo en el frame k y vuelve a coincidir en k+1.
  `tests/game/p22-oracle.test.mjs` tolera exactamente esos frames.

Ninguna lectura de registros hardware (`$2002`, `$2007`, `$4015`) del juego acaba en la RAM: la RAM
depende solo de las entradas por NMI. Por eso la comparación de RAM es exacta e independiente de la
precisión de temporización del emulador; solo la imagen (línea exacta del split) depende de ella.

### Movies con timing de vídeo (.fm2)

Un `.fm2` de FCEUX da una entrada por **frame de vídeo**. El oráculo lo reproduce así (`timing video`) y
graba en la traza la entrada que realmente vio cada NMI. El port no tiene frames de vídeo: se le pasa
`--inputs-from <traza del oráculo>`, que convierte la traza en entradas por NMI. Nota: FCEUX enciende con
la RAM a `$FF` y su temporización difiere de jsnes; un fm2 grabado en FCEUX puede desincronizarse en jsnes
si depende de frames de lag exactos (usa `--power-on ff` para acercarte).

## Formatos

### Movie `.zmv` (texto)

```
zmv 1
timing nmi            # nmi (una entrada por NMI) | video (una por frame de vídeo)
120 .                 # 120 frames sin botones
2 T                   # 2 frames con Start
5 RA L                # 5 frames: jugador 1 Derecha+A, jugador 2 Izquierda
```

Letras de FCEUX `RLDUTSBA` (T = Start, S = Select), `.` = nada, o `0xNN`. El byte usa el formato de
`ButtonsPressed`: A=`$80` B=`$40` Select=`$20` Start=`$10` Arriba=`$08` Abajo=`$04` Izq=`$02` Der=`$01`.
También se aceptan `.json` (`{"format":"zelda-movie","version":1,"p1":[...]}` o `"runs":[[n,"T"],...]`),
`.fm2` e `idle:N` en la línea de comandos.

### Traza `.ztrace` (binario, little‑endian)

```
cabecera : "ZTRC" | u16 versión(1) | u16 0 | u32 lenJSON | JSON (fuente, sha1 ROM, movie, timing, powerOnFill)
registro : u32 frame | u32 videoFrame | u8 p1 | u8 p2 | u8 flags | u8 0
           | RAM[0x800] | SRAM[0x2000] si flags&1 (solo cuando cambia) | FB[256*240] si flags&2
```

El framebuffer guarda **índices de color NES** (0‑63, sin bits de énfasis); todos los negros duplicados
(`$0D`, `$0E`, `$0F`, `$1D`, …) se canonicalizan a `$0F`. Así la comparación no depende de la paleta RGB.
Los PNG usan la paleta NTSC de jsnes.

## Contrato del headless runner del port

El port debe exponer `src/headless.js` (o el módulo que se pase con `--port`):

```js
export function createGame({ rom, sram, powerOnFill }) -> game
// rom:          Uint8Array con el fichero .nes completo (cabecera iNES incluida)
// sram:         Uint8Array(0x2000) inicial o null (todo a 0)
// powerOnFill:  byte con el que se llena la RAM antes de IsrReset (defecto 0x00, igual que el oráculo)

game.ram          // Uint8Array(0x800), vista viva de la RAM con las MISMAS direcciones que la NES.
                  // Tras createGame debe contener el frame 0 (IsrReset + RunGame hechos, sin ninguna NMI).
game.sram         // Uint8Array(0x2000), vista viva de $6000-$7FFF
game.stepFrame(p1, p2)   // ejecuta exactamente una IsrNmi; p1/p2 = bytes que leerá ReadInputs
game.framebuffer  // opcional: Uint8Array(256*240) de índices de color NES de la imagen dibujada
                  // tras la última stepFrame (split del sprite 0 incluido)
game.renderFrame()// alternativa opcional a framebuffer: devuelve ese Uint8Array bajo demanda
```

`tools/oracle/headless-stub.mjs` es una plantilla que cumple la forma del contrato y falla con
`NotImplementedError` al ejecutar; `run-port.mjs` sin `src/headless.js` falla con un mensaje explicando
qué falta (código 3). `tools/oracle/testrom/test-rom-port.mjs` es un ejemplo completo del contrato para la
ROM sintética de los tests.

## Rangos ignorados por defecto (`tools/oracle/ignore.default.json`)

* `$0110-$01FF`: pila hardware del 6502 (el port no usa la pila). `$010E/$010F`
  (`PositiveGridCellSize`/`NegativeGridCellSize`) están en la página 1 pero son variables reales y sí se
  comparan.
* `$6C90-$7EFF`: `RAM_01_CODE`, código del banco 1 copiado a la SRAM al arrancar (el port lo ejecuta como
  JS). `$67F0-$687D` (`RAM_06_DATA`) **sí** se compara: son datos.
* Preset `--ignore-temps`: `$00-$0F` (temporales de rutinas). Por defecto se comparan: un port fiel debe
  dejarlos igual; úsalo solo para aislar diferencias.
* Imagen: la fila 0 se ignora por defecto (jsnes nunca dibuja la línea 0, queda negra).

## Movies de prueba (`tests/oracle/movies/`)

| Movie | Contenido | Comprobación (`*.expect.json`) |
|---|---|---|
| `power-on-600` | 600 frames sin entrada (título y demo) | `GameMode` = 0 siempre |
| `title-start` | Start en el título → menú | alcanza `GameMode` 1 (frame 123) |
| `register-name` | menú → registrar nombre (`$E`) → End → menú → empezar | modos `$E,1,2,3,4,5` (juego en frame 558) |
| `walk-first-screens` | lo anterior + caminar salas `$77→$76→$77→$78→$68` | `RoomId` 118,119,120,104; modos 6/7 (scroll) |

Calibradas con la ROM en jsnes. Si se cambia una, revisar con `trace-info.mjs --watch GameMode,RoomId`.

## Evaluación de jsnes 2.1.0 para Zelda

**Veredicto: suficiente como oráculo de RAM y casi siempre de imagen.** Verificado con la ROM real y con
una ROM sintética propia (`tools/oracle/testrom/`, sin datos de Nintendo) que replica el hardware de Zelda:

| Característica | Estado |
|---|---|
| MMC1: escritura serie, PRG 16 KB en `$8000` + banco fijo en `$C000`, mirroring H/V (`$0F`/`$0E`) | OK |
| CHR‑RAM 8 KB (carga de patrones por `$2007`) | OK |
| WRAM `$6000-$7FFF`: lectura/escritura y **ejecución de código** (`RAM_01_CODE`) | OK |
| Sprite 0 hit (bucle de espera en la NMI y split HUD/campo) | OK, sin cuelgues en 1800+ frames; split visualmente correcto, también en scroll H y V |
| Lectura del mando estilo `ReadInputs` (lecturas repetidas, bit de expansión a 0) | OK |
| Determinismo (dos ejecuciones idénticas) | OK |
| Velocidad | ~1200‑1300 frames/s en Node |

Limitaciones conocidas (no afectan a la RAM):

* La fila 0 del framebuffer siempre es negra (jsnes no dibuja la línea 0) → enmascarada en el diff.
* Con el recorte izquierdo activo (PPUMASK bits 1‑2 a 0) jsnes pinta negro donde el hardware muestra el
  color de fondo. **Corregido** en el oráculo (ver abajo); `--ignore-left8` ya no hace falta para Zelda.
* El mirroring de una pantalla del MMC1 no distingue página baja/alta (Zelda no lo usa) y no se ignoran
  escrituras MMC1 en ciclos consecutivos (Zelda no las hace).
* La RAM de encendido de jsnes es `$FF` con un patrón; el oráculo la sobrescribe con `--power-on`
  (defecto `$00`) para que el port pueda reproducirla. `ClearRam` no borra `$00F0-$00FF` ni `$07FF`, así
  que este valor importa.
* La línea exacta del split del sprite 0 depende de la temporización de ciclos de jsnes; un error de ±1
  línea solo afectaría a la imagen.

**Correcciones de jsnes aplicadas por el oráculo** (`patchJsnesPpu` en `tools/oracle/lib/nes-oracle.mjs`;
solo cambian la imagen, nunca la RAM ni la temporización de CPU; si una versión nueva de jsnes cambia el
código parcheado, el oráculo lanza un error en vez de ignorarlo):

1. Sprites 8x16 con tile impar: jsnes usaba `tile-1` desde `$1000` como mitad superior (cursor corazón `$F3`,
   cursores del registro `$25`).
2. Las filas de fondo por encima del fine‑Y no se dibujaban (scroll vertical de la historia).
3. Color de fondo (`$3F00`): jsnes lo fijaba al empezar el vblank, antes de que la NMI escriba la paleta
   (se veía un frame tarde). Ahora se toma por banda renderizada.
4. `$2007` durante el render: jsnes perdía el bit 2 del fine‑Y (`& 3`) tras el incremento X/Y; el split
   del scroll vertical (modo 7) salía hasta 4 píxeles desplazado.
5. Scroll fino X: jsnes dibujaba 32 tiles y dejaba sin pintar los últimos `fineX` píxeles (modo 7
   horizontal); ahora se dibuja el tile 33.
6. Fila 1: jsnes ponía ahí el OAM secundario residual del frame anterior en vez de evaluar el OAM
   (los sprites con Y=0 perdían su primera línea).
7. Columna izquierda recortada: ahora muestra el color de fondo, no negro.
8. Escala de grises (PPUMASK bit 0, destello de la bomba `UpdateBombFlashEffect`): jsnes pintaba el fondo
   con un color elegido por los bits de énfasis (negro); el hardware muestra `$3F00 & $30` como cualquier
   otro píxel. Las correcciones 3 y 7 se aplican ahora también en escala de grises.

Diferencias de imagen que quedan, conocidas y aceptadas:

* El frame en que la escritura a PPUMASK/scroll del juego cae dentro del área visible porque la NMI del
  original dura más que el vblank (p. ej. frame 121 de `title-start`: Start en el título; la NMI tarda
  ~8300 ciclos antes de `TurnOffAllVideo` y el hardware llega a dibujar las líneas 0‑52). El port no
  cuenta ciclos de CPU fuera de los bucles temporizados (modelo *catch‑up* de `src/core/ppu.js`).
* La línea exacta del split del scroll (modo 7 vertical y horizontal, y el primer frame del modo 4 que le
  sigue; solo la línea 63): jsnes renderiza por línea completa y el port por punto.
* Frames cuya NMI original dura más de un frame de vídeo (lag justo después), p. ej. `ow-bomb-secret` 1180
  (modo `$B`): el original ya ha apagado el vídeo cuando se dibuja la imagen.

Alternativas si hiciera falta más precisión de imagen: **Mesen2** (máxima precisión; tiene modo test
headless y scripting Lua para volcar RAM por frame, pero es nativo, no Node), **FCEUX** (`--loadlua`
con `emu.frameadvance()` y `memory.readbyterange`; formato `.fm2` ya soportado aquí), o compilar a
WebAssembly un núcleo libretro preciso (p. ej. Mesen o puNES) y cargarlo en Node. El formato de traza es
independiente del emulador: bastaría con escribir otro productor de `.ztrace`.

## Código

```
tools/oracle/
  run-oracle.mjs  run-port.mjs  diff.mjs  compare.mjs  trace-info.mjs
  headless-stub.mjs           plantilla del runner del port
  ignore.default.json         rangos ignorados por defecto
  lib/nes-oracle.mjs          jsnes + ganchos de NMI/RTI (definición de frame)
  lib/trace.mjs               formato .ztrace
  lib/movie.mjs               .zmv / .json / .fm2
  lib/diff-core.mjs           comparación RAM/SRAM/imagen
  lib/var-names.mjs           nombres de variables (src/core/vars.js o los .inc)
  lib/port-adapter.mjs        contrato del port
  lib/png.mjs                 codificador/decodificador PNG mínimo (node:zlib)
  lib/palette.mjs             índices de color NES <-> RGB de jsnes
  testrom/                    mini ensamblador 6502 + ROM sintética MMC1 + su "port"
tests/oracle/                 tests (node --test); los de ROM se saltan sin roms/zelda.nes
```

## Batería (`tools/oracle/battery.mjs`)

Pruebas intensivas del port completo (salida en `out/battery/`):

```sh
node tools/oracle/battery.mjs movies                 # lockstep de TODOS los movies, en paralelo (1 proceso por movie)
node tools/oracle/battery.mjs movie <f.zmv>          # uno solo (--sram f.sav para forzar una SRAM)
node tools/oracle/battery.mjs routines --n 5000 --scale 150 --seeds 0,1,2,3,4,5
node tools/oracle/battery.mjs fuzz-gen [--frames 24000] [--only fuzz-ow]
node tools/oracle/battery.mjs boot                   # arranque con SRAM vacía / basura / checksum o marcas rotas
BATTERY=1 node --test tests/oracle/battery.test.mjs  # movies (0 px exigido) + boot como test (lento)
```

* **movies**: oráculo y port puro en *lockstep*; en **cada** frame compara RAM y SRAM (rangos de
  `ignore.default.json`) y la **imagen completa** (filas 1-239, sin muestreo ni PNG). Cada frame distinto se
  clasifica con pruebas sacadas de la propia ejecución del oráculo (escrituras a `$2000-$2007/$4014` con su
  línea de raster, frames de vídeo que abarca cada NMI, `FrameCounter`):
  `nested-nmi` (dos NMIs antes del primer RTI), `lag` (la NMI acaba en un frame de vídeo posterior al que
  empezó), `split-63` (solo la fila 63; modo 7 con las escrituras del split en la fila 62-63, o modo 4 justo
  tras el 7), `late-write` (RAM igual y todas las filas distintas por encima de la escritura de PPUMASK hecha
  en zona visible, p. ej. frame 121 tras Start en el título) y `DEFECT` (cualquier otra cosa: código 1).
  Algunos frames no tienen imagen en el oráculo (la NMI siguiente empieza antes de que se complete otro
  frame de vídeo, p. ej. las NMIs anidadas): se listan en `noFb`.
  El port corre con el rastreador de ciclos (`--timing jsnes` por defecto, docs/TIMING.md §10). Además de
  la imagen tras cada NMI se compara **cada frame de vídeo** (hash de las filas 1-239 de cada imagen
  completada, también las de lag dentro de una NMI larga) y el número total de frames de vídeo: campo
  `video` del informe (`video D/N` en la línea de cada movie). `--require-zero` falla con cualquier px o
  frame de vídeo distinto.
* **Estado (2026-10-30)**: 72 movies, 799 997 frames: **0 frames distintos, 0 px, RAM/SRAM diff 0**, 0 de
  809 870 frames de vídeo distintos; todas las clases de temporización (`split-63`, `late-write`, `lag`,
  `nested-nmi`) a 0. `BATTERY=1 node --test tests/oracle/battery.test.mjs` exige 0 px y 0 frames de vídeo
  distintos (unos 4 min en 12 núcleos).
* **routines**: todos los tests rutina-contra-6502 de `tests/game` con `Pxx_N`/`W3_N`/`WAVE4_N`/`P04_N` = N,
  `ROUTINES_SCALE` (multiplica los estados de los tests por semillas: P01, P03, P11, P23-P25) y
  `ROUTINES_SEED` (desplaza todos los generadores aleatorios; 0 = los estados de siempre); los ficheros con
  registro híbrido se ejecutan además integrados (`Pxx_REAL=1`).
* **fuzz-gen**: `tests/oracle/movies/fuzz-*.zmv` = prefijo de un movie existente hasta un estado elegido
  (overworld, mazmorras, segunda vuelta, Gleeok de 4 cabezas, Ganon, Aquamentus) + 24 000 frames de juego
  semialeatorio (direcciones mantenidas, A/B, Start/Select ocasionales). Usan las `.sav` existentes.

## Segundo oráculo: Mesen2 (`tools/oracle-mesen/`)

Mesen2 (2.1.1, precisión de hardware: PPU por punto, frame impar corto, DMA del DMC de 1-4 ciclos) se usa
**solo para pruebas**, como referencia a nivel de punto que jsnes no puede dar (`docs/TIMING.md` §4). Es
nativo (no Node): se ejecuta en modo `--testrunner` (sin ventana, a máxima velocidad) con un script Lua que
envía un registro por frame lógico a Node por una FIFO. No se sube al repo: vive en `reference/` (ignorado).

### Instalación (una vez)

1. Mesen2 2.1.1 macOS ARM64 de la release oficial (`SourMesen/Mesen2`), descomprimido en
   `reference/mesen2-dl/app/Mesen.app` (otra ruta: variable `MESEN_APP`).
2. SDL2: `MesenCore.dylib` enlaza `/opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib` (el SDL2 de Homebrew).
   Para no instalar nada en el sistema se usa el `SDL2.framework` de la release oficial **SDL2 2.32.8**
   (`libsdl-org/SDL`, `SDL2-2.32.8.dmg`, sha256 `de07f71c…6fa0` verificado contra GitHub; la misma versión
   con la que se compiló MesenCore), extraído en `reference/sdl2-dl/SDL2.framework`.
3. `node tools/oracle-mesen/setup.mjs` (idempotente; `--check` solo comprueba):
   * escribe `settings.json` **junto al ejecutable** (`Mesen.app/Contents/MacOS/`) → modo portable: toda la
     configuración y los ficheros de Mesen quedan dentro de `reference/mesen2-dl`;
   * copia `SDL2.framework` junto al ejecutable y reescribe en `MesenCore.dylib` la ruta de SDL2 a
     `@loader_path/SDL2.framework/Versions/A/SDL2` (`install_name_tool` + firma ad hoc `codesign -s -`; la app
     tiene `disable-library-validation`). El fichero queda de solo lectura para que Mesen, que reextrae sus
     dependencias si cambian tamaño/fecha, no lo restaure. `DYLD_LIBRARY_PATH` no sirve: el ejecutable usa
     *hardened runtime* sin `allow-dyld-environment-variables`.

**Por qué se colgaba** `Mesen --testrunner rom script.lua`: sin ningún `settings.json` (ni portable ni en
`~/Library/Application Support/Mesen2`), `Program.Main` abre el asistente de primera configuración (una
ventana Avalonia) **antes** de mirar `--testrunner`, y espera para siempre. Esa primera ejecución dejó
`~/Library/Application Support/Mesen2/` con las dylibs extraídas (sin `settings.json`); ya no se usa (la
configuración portable tiene prioridad) y se puede borrar. Arreglado eso, faltaba SDL2 (punto 2). Otras
notas del modo test (código de `UI/Utilities/TestRunner.cs`): `--timeout=<s>` (defecto 100 s),
`--enablestdout` manda el log (y `print` de Lua) a stdout, `emu.stop(code)` fija el código de salida, la
configuración no se guarda nunca (`DisableSaveSettings`). Lua necesita `Debug.ScriptWindow.AllowIoOsAccess`
para `io.open`. El log de stdout incluye avisos `[CPU] Uninitialized memory read` del depurador: inofensivos.

### Configuración (`mesenSettings()` en `lib/mesen.mjs`)

| Ajuste | Valor | Motivo |
|---|---|---|
| `Nes.Region` | `Ntsc` | (la base de datos de Mesen también dice NesNtsc para esta ROM) |
| `Nes.RamPowerOnState` | `AllZeros` | además el script escribe la RAM con el byte de `--power-on` (defecto `$00`, como jsnes) |
| `Nes.RandomizeCpuPpuAlignment`, `RandomizeMapperPowerOnState` | `false` | determinismo: alineación CPU/PPU fija por defecto de Mesen (al cargar el script: ciclo de CPU 7, PPU línea 0 punto 25, tras la secuencia de reset) |
| `Nes.PpuExtraScanlinesBeforeNmi/AfterNmi` | 0 | sin overclock |
| `Nes.ConsoleType` | `Nes001` | NES frontal (Famicom/top-loader cambian detalles de la PPU/mando) |
| Glitches opcionales (`EnableOamDecay`, `EnablePpuOamRowCorruption`, `EnablePpu2000/2006ScrollGlitch`, `EnablePpuSpriteEvalBug`, `EnableDmcSampleDuplicationGlitch`, `RestrictPpuAccessOnFirstFrame`) | `false` (defecto) | dependen de la revisión de la consola; el port no los modela |
| `Nes.NtscOverscan` | 0 en los 4 lados | imagen completa 256x240 |
| `Video.VideoFilter` / brillo, contraste, matiz, saturación | `None` / 0 | sin filtros |
| `Nes.UserPalette` | 512 entradas, entrada `p` = RGB `p` | `emu.getScreenBuffer()` devuelve la salida cruda de la PPU (índice + énfasis << 6; la escala de grises ya aplicada por la PPU); se guarda `índice & $3F`, canonicalizado con la tabla de jsnes (negros → `$0F`), igual que el port |
| `Debug.ScriptWindow` | `AllowIoOsAccess` true, `ScriptTimeout` 3600 | FIFO y callbacks largos |
| `Nes.InputScanline` | 241 (defecto) | sondeo del mando de Mesen al empezar el vblank |

### Equivalencia con el oráculo jsnes

* **Frame 0**: callback de ejecución en la primera instrucción del manejador de NMI (`$E484`, vector `$FFFA`).
  A diferencia de jsnes (instantánea antes de apilar), la pila ya tiene PC/P apilados: solo cambia
  `$01FD-$01FF`, ignorado.
* **Frame N**: callback de ejecución en el `RTI` de `IsrNmi` (`$E57F`, buscado en la ROM con un barrido lineal
  desde el vector; el mismo que ve el gancho de jsnes). Se dispara al buscar el opcode, antes de ejecutarlo.
* **Entrada**: al entrar la NMI n se pone `movie[n-1]` en el mando 1 y se vuelve a aplicar tras cada sondeo
  de Mesen (línea 241) hasta la NMI siguiente; equivale a jsnes (estado mantenido de NMI a NMI).
  Limitación: `emu.setInput(t, 1)` de Mesen 2.1.1 sobrescribe también el puerto 0, así que **no se admite
  entrada del jugador 2** (ningún movie la usa). Los movies `timing video` (.fm2) cambian la entrada en cada
  sondeo (línea 241), no en el `frame()` de jsnes: aproximado.
* **Imagen del frame N**: el primer frame de vídeo completado (evento `endFrame`, línea 240) tras la
  instantánea; si llega otra instantánea antes, el frame no tiene imagen (como en jsnes).
* **SRAM inicial**: el script escribe los 8 KB (`.sav` del movie o ceros) en la carga, antes de la primera
  instrucción; el `Saves/zelda.sav` que Mesen carga y guarda por su cuenta se ignora.
* **Encendido**: Mesen arranca la RAM de paleta con el patrón del hardware (`$3F00=$09`…), jsnes y el port con
  ceros: hasta que el juego escribe la paleta (frames 0-5) el fondo uniforme difiere (clase `backdrop`).
* **Evidencia extra por frame**: NMIs entre dos RTI (anidadas), frame de vídeo y línea de la NMI y del RTI, y
  las escrituras a `$2000/$2001/$2005/$2006` hechas en una línea visible con la posición (línea:punto) de
  Mesen. Protocolo del flujo: cabecera de `lua/trace.lua`.

### Uso

```sh
node tools/oracle-mesen/setup.mjs                                   # una vez
node tools/oracle-mesen/run.mjs tests/oracle/movies/title-start.zmv --png every:60   # .ztrace como run-oracle
node tools/oracle/diff.mjs out/oracle/title-start/trace.ztrace out/oracle-mesen/title-start/trace.ztrace
node tools/oracle-mesen/vs-jsnes.mjs [movies...] [--png-dir d]      # validación Mesen vs jsnes (lockstep)
node tools/oracle-mesen/vs-port.mjs [movies...] [--timing hardware|jsnes|off] [--png-dir d] [--require-zero]
MESEN=1 node --test tests/oracle-mesen/                             # tests (MESEN_FULL=1: + movies largos)
```

`run.mjs` acepta las mismas opciones que `run-oracle.mjs` (`--rom --out --frames --png --sram --power-on`;
sin `--sram` usa la `.sav` del `.expect.json` del movie, como la batería). `vs-jsnes`/`vs-port` sin movies usan
`power-on-600, title-start, walk-first-screens, uw-level1-full, boss-gleeok4`, comparan RAM, SRAM e imagen en
**todos** los frames en lockstep (Mesen se ejecuta cada vez; no leen `out/`), escriben
`out/oracle-mesen/<vs-jsnes|vs-port>/<movie>.json` + `summary.json` y clasifican cada frame distinto
(`lib/classify.mjs`): `ram`, `backdrop`, `nested-nmi`, `lag`, `split-63`, `split-scroll`, `late-write`,
`greyscale`, `other`. `vs-port` compara las filas 0-239 (los dos dibujan la fila 0) y por defecto pone el
tracker del port en modo `hardware`; código 1 si difiere la RAM/SRAM (o, con `--require-zero`, cualquier
píxel). Velocidad: ~250-300 frames/s (Mesen + volcado Lua de 10 KB por frame), ~110 s para un movie de 12 000.

### Validación Mesen2 vs jsnes (2026-10-30)

| Movie | Frames | RAM/SRAM distintos | Frames con imagen distinta (clase: frames) |
|---|---|---|---|
| power-on-600 | 600 | 0 | backdrop 6 |
| title-start | 300 | 0 | backdrop 6, late-write 1 (frame 121: 32 px de la fila 52) |
| walk-first-screens | 1868 | 0 | backdrop 6, split-63 49, late-write 1 |
| uw-level1-full | 12038 | 0 | backdrop 6, split-63 3432, lag 2, late-write 1 |
| boss-gleeok4 | 11827 | 0 | backdrop 6, split-63 683, split-scroll 19, lag 1, late-write 1 |

* **RAM/SRAM idénticas en los 26 633 frames**, incluida la NMI anidada de `boss-gleeok4` (frame 6653 en los
  dos emuladores). Confirma que la RAM no depende de la temporización.
* `split-63` (4164 frames): solo la fila 63 (a veces 63-64) en el scroll del modo 7: las escrituras
  `$2006/$2007` del split caen hacia el punto 200-240 de la línea 63; jsnes aplica el cambio a la línea entera.
* `split-scroll` (19 frames, scroll vertical del modo 7 en el nivel 8): todo el campo por debajo de la fila 63
  sale desplazado 1 línea. La segunda escritura `$2006` del split cae en la línea 63 cerca del punto 256 (el
  incremento de Y de la PPU) en los dos emuladores (p. ej. jsnes 63:258, Mesen 63:260); jsnes, que dibuja por
  líneas, no aplica el incremento igual que el hardware. Es la limitación de render por scanline de §4.
* `late-write`: solo el frame 121 (PPUMASK escrito en la línea 52/53 visible), 32 px.
* `lag` (3 frames): NMIs que en uno de los dos acaban justo al borde de un frame de vídeo (Mesen acaba en la
  línea 240): la imagen "siguiente" es de otro frame de vídeo. Mesen cuenta 95 NMIs de más de un frame en
  `boss-gleeok4` y jsnes 87 (62/59 en `uw-level1-full`): efecto de la deriva CPU/PPU de jsnes (frame impar,
  DMC de 4 ciclos).
* `backdrop`: frames 0-5, paleta de encendido (ver arriba). `greyscale` y `other`: 0.
