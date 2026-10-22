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
