# Temporización a nivel de ciclo (escrituras PPU a mitad de frame)

Objetivo: que la imagen del port sea idéntica a la del original también cuando el juego toca la PPU
(`$2000/$2001/$2005/$2006/$2007`, OAM DMA, paleta) mientras se está dibujando la imagen. Hoy RAM y SRAM
dan diff 0, pero el port ejecuta la lógica "en tiempo cero" y solo cuenta ciclos en los bucles
temporizados (`ppu.waitSprite0Clear/Hit`, `ppu.cpuCycles(n)` en `src/game/ppu/sprite0.js`).

Todo lo de este documento está en `tools/timing/` y `tests/timing/` (no toca `src/`).

## 1. Resumen

| | |
|---|---|
| **Alcance medido** | 45 movies, 202 077 frames. Con el modelo actual del port (lógica en tiempo cero, vblank y sprite 0 temporizados) **solo 43 frames** dan imagen distinta del original, todos del mismo tipo: Start en el título (`UpdateMode0Demo_Sub0` → `TurnOffAllVideo` en la línea 52, frame 121 de `title-start`). Pero a nivel de hardware hay más: el split del sprite 0 (modo 7, ~37 000 frames) queda desplazado −7…+19 puntos porque la fase del sondeo depende de los ciclos previos, y el port emite 1 imagen por NMI aunque la NMI dure varios frames (4 063 frames de vídeo de *lag* en las cargas). |
| **Precisión necesaria** | Contra jsnes (que dibuja por scanline): ±30/+83 ciclos en el caso del título, ≥26 en el split. Contra hardware: **1 ciclo** (3 píxeles) — las escrituras caen sobre píxeles visibles. Como la latencia de la NMI siguiente y la paridad del OAM DMA dependen de la duración exacta de la NMI anterior, el error se propaga: hace falta contar ciclos **de todo el código**, no solo de las rutinas que escriben. |
| **Diseño elegido** | Contabilidad exacta generada del asm, con un **rastreador de ciclos guiado por el grafo de control del asm** (`tools/timing/lib/tracker.mjs`): el port solo deja "migas" (*breadcrumbs*): entrada/salida de rutina y accesos de E/S **automáticos**, y una anotación `$br('Z_0b:línea', condición)` por cada salto condicional del asm que decide el JS (+ ~50 pistas de cruce de página). Entre migas el código del asm no tiene decisiones, así que el rastreador suma su coste estático. Cada miga se **verifica** contra el asm: una anotación mal puesta falla con la línea del asm. |
| **Prototipo** | Frame 121 de `title-start`: las 191 escrituras/lecturas PPU de la NMI en el **mismo ciclo** que el oráculo, duración de la NMI exacta (9 726 ciclos), imagen idéntica a la referencia con precisión de punto (0 px). Contra jsnes difieren 33 px de la fila 52 (jsnes aplica a la línea entera); con `--jsnes-compat` (aplicar las escrituras de PPUMASK a fin de línea, como jsnes) **0 px contra el oráculo**. Encadenado: frames 7-121 (115 NMIs) con una sola semilla del oráculo: todos los inicios de NMI, accesos PPU y duraciones exactos. |
| **Coste** | ~70 µs por NMI con el rastreador en el prototipo (920 migas + 1 893 instrucciones recorridas); la lógica del port sin él cuesta ~5 µs y el render ~1-2 ms → +3-7 % del tiempo de frame, <0,5 % del presupuesto de 16,7 ms. Con ids enteros y tablas generadas se estima 10-30 µs. Anotación: 122 saltos + 16 pistas de página en 92 parches de 8 ficheros para ~30 rutinas; para todo el juego, ~2 800 saltos. |
| **Riesgo principal** | jsnes no es exacto a nivel de punto: dibuja por scanline, **nunca quita el punto del frame impar** (frames siempre de 89 342 puntos; el hardware 89 341 con render activo), el DMA del DMC roba siempre 4 ciclos (1-4 en hardware) e ignora el bit de escala de grises. El port con precisión de hardware **no puede validarse a nivel de punto con jsnes**: hace falta un modo "compat jsnes" para el diff de CI y un segundo oráculo (Mesen2) para el modo hardware. |

## 2. Medición

### 2.1 Herramientas

```sh
node tools/timing/measure.mjs                    # todas las escrituras PPU por frame (todos los movies, en paralelo)
node tools/timing/replay-scope.mjs --all         # impacto real en la imagen, tolerancia, fase del split
node tools/timing/port-scope.mjs --all           # el port real contra el oráculo, frame a frame (RAM + imagen)
node tools/timing/nmi-model.mjs                  # modelo de latencia de la NMI y paridad del OAM DMA
node tools/timing/pagecross.mjs                  # lecturas indexadas que cruzan página en la práctica
```

Salidas en `out/timing/` (`<movie>.json`, `summary.json`, `replay-summary.json`, `scope-summary.json`).
Cada movie usa su `.sav` según el campo `sram` de su `*.expect.json`.

* **Sonda** (`lib/ppu-probe.mjs`): envuelve jsnes (sin alterar la emulación) y registra cada escritura a
  `$2000-$3FFF`/`$4014` con su ciclo de CPU desde el inicio de la NMI, la posición del raster
  (línea/punto), la rutina que escribe y su cadena de llamadas (`lib/symbolize.mjs`, con
  `src/core/symbols.js`), el modo/submodo, y por NMI: duración, frames de *lag*, robos del DMC, 513/514 del
  OAM DMA. En jsnes 2.1.0 la PPU avanza en cada ciclo de bus, así que la posición es exacta al ciclo.
* **Clasificador** (`lib/classify.mjs`): región (`vblank` hasta el punto 257 de la línea previa al render,
  `prerender`, `visible`, `post`, `next` si la NMI se pasó del frame) e *impacto* (si la escritura cambia lo
  que se dibuja: render on/off, tablas de patrones, scroll/`v` con render activo, puntero a paleta con render
  apagado, OAM...). "Relevante" = con impacto y fuera de vblank: el port la aplicaría antes que el original.
* **Repetición de frame** (`lib/replay.mjs`): captura en el oráculo el estado completo de la PPU al empezar
  la NMI y todos sus accesos (escrituras, lecturas de `$2002/$2007`, OAM DMA con su página, cambios de
  *mirroring*, hit del sprite 0) y vuelve a dibujar el frame con **la PPU por puntos del port**
  (`src/core/ppu.js`) aplicando cada acceso en el instante que se quiera: el real (referencia con precisión
  de punto), el del modelo actual del port, o desplazado ±k ciclos (tolerancia).

### 2.2 Validación de la repetición

En 1 603 frames tomados al azar (uno de cada 97) la repetición en el instante real da **la misma imagen que
jsnes en 1 602**. La excepción (`items-all` frame 1067) no es de temporización: PPUMASK `$1F` (escala de
grises) — jsnes ignora el bit 0 y el port lo aplica. En los frames con escrituras relevantes, la repetición
coincide con jsnes solo en 1 932 de 41 886: en el resto la escritura cae a mitad de línea y jsnes la
aplica a la línea entera (ver §4).

### 2.3 Resultados (45 movies, 202 077 frames)

| Rutina que escribe | Registro / efecto | Escrituras | Dónde | Modos | Holgura hw (ciclos) | Holgura jsnes | ¿Cambia la imagen con el port actual? |
|---|---|---:|---|---|---|---|---|
| `WaitAndScrollToSplitBottom` | `$2005` scroll | 49 088 | línea 62, puntos ~200-250 | 7 (scroll entre pantallas) | 5-8 | ≥26 | Ya temporizada (sprite 0), pero ver fase |
| `WaitAndScrollToSplitBottom` | `$2006` (v) | 32 414 | línea 62 | 7 | **0** en 590 de 1 560 muestras; ≤8 el resto | ≥33 | idem |
| `WaitAndScrollToSplitBottom` | `$2000` (tabla t) | 11 817 | línea 62 | 7 | 6 / ≥92 | ≥39 | idem |
| `WaitAndScrollToSplitBottom` → `JMP TurnOffAllVideo` | `$2001`=0 | 467 | línea 56 | `$A/$B/$C` (cuevas, escaleras) | ≥96 / ≥840 | - | No |
| `TurnOffAllVideo` desde Init/Update de modos | `$2001`=0 | 978 (+310 en imágenes de *lag*) | líneas 3-56 | 0, 1, 2, 3, E, F, 8, D | **0** en el título; >128 casi siempre | −30/+83 en el título | **Sí: 43 frames** (Start en el título, 2 022 px cada uno). El resto cae sobre pantalla en negro |
| `IsrNmi@EnableNMI` | `$2000` (bits de tabla en t) | 822 | líneas 75-104 | 7, 4 | ≥8 / ≥3000 | 0 | No |
| `ResetPpuRegisters` | `$2005` | 2 | línea 15 | D (guardar) | 6 | 6 | No |

Otros datos:

* **Port real** (`port-scope`): en los 21 997 frames que el port ejecuta hoy (llega hasta el inicio del
  juego; luego para en rutinas aún sin portar) RAM diff 0 y **43 frames con imagen distinta, exactamente los
  del título** que predice la repetición. El modelo y el port coinciden.
* **Fase del split** (`replay-scope`, `splitPhaseError`): el port sondea `$2002` cada 9 ciclos desde un reloj
  que no cuenta la lógica previa; detecta el hit del sprite 0 entre **−7 y +19 puntos** del original
  (distribución en `replay-summary.json`; casi uniforme). En una PPU por puntos el corte de la línea 62 se
  mueve hasta 19 px en cada frame del modo 7. jsnes no lo ve (aplica el corte a la línea entera).
* **Lag**: 1 223 NMIs se pasan del frame (cargas con vídeo apagado, hasta 504 128 ciclos = 17 frames):
  **4 063 frames de vídeo** en los que el original repite imagen sin NMI. El port no los emite: va más rápido
  que el original en esas transiciones (≈68 s acumulados en los movies) y dibuja 1 imagen por NMI.
* **NMI**: mediana por movie de 3 833 (menús) a 18 709 ciclos (juego); el 99,4 % de las NMIs termina con la
  imagen ya empezada (la lógica corre mientras se dibuja), así que cualquier escritura de la lógica es
  potencialmente "relevante".
* **OAM DMA**: 94 278 de 513 ciclos y 107 799 de 514 (paridad del ciclo): el reparto es ~50/50, así que el
  port debe conocer la paridad del ciclo absoluto.
* **DMC**: 12 049 NMIs con robos de ciclo del DMA de muestras (4 ciclos cada uno en jsnes).
* **IRQ**: ninguna.
* **Cruces de página dependientes de datos** (`pagecross`, 6 movies, 10,4 M lecturas indexadas): de 1 144
  instrucciones que podrían pagar +1, solo **53** cruzan en la práctica (1,8 % de las ejecuciones). Varias
  cruzan siempre (`LevelBlockAttrsD,Y`...) y `TableJump` cruza a menudo (el rastreador lo calcula solo).
* **Saltos condicionales del programa**: 2 806; con migas automáticas (entrada de rutina, E/S, llamadas) se
  resuelven solos ~800; **~2 000 necesitan una anotación** en el JS.

### 2.4 Tolerancia: cuántos ciclos de precisión hacen falta

`replay-scope` mueve cada escritura relevante ±k ciclos (manteniendo el orden con sus vecinas) hasta que la
imagen por puntos cambia:

* Escrituras sobre píxeles visibles (puntos 1-256): **0 ciclos** de holgura. Es el caso del título (L52:90)
  y de la mitad de las escrituras a `$2006` del split.
* Escrituras en hblank (puntos 257-340): 1-27 ciclos, hasta tocar el siguiente píxel.
* Para jsnes la frontera es la scanline: holgura = distancia al borde de la línea (≈0-113 ciclos).
* Las que caen sobre zonas sin contenido (pantalla negra en las transiciones) toleran cientos o miles de
  ciclos; por eso solo el título da diferencias visibles.

Conclusión: para pixel perfect **contra hardware** hace falta el ciclo exacto. Contra jsnes bastaría con
±30 ciclos en el título, pero un modelo aproximado no sirve para el split (fase) ni para la deriva entre
frames.

## 3. Lo que hay que modelar además del coste de cada instrucción

Verificado sobre el oráculo con `nmi-model.mjs`: en los 45 movies se predice exactamente el inicio de las
202 032 NMIs y la longitud de su OAM DMA a partir del ciclo del `RTI` anterior (ver §6):

1. **Inicio de la NMI.** Tras el `RTI` la CPU queda en `LoopForever: JMP LoopForever` (3 ciclos). La NMI se
   atiende al final de la instrucción en la que llega el flanco de vblank si quedan ≥5 puntos de esa
   instrucción; si no, tras la siguiente. Basta saber el ciclo exacto del `RTI` anterior y el punto absoluto
   del vblank (frames de 341×262 puntos en jsnes). La NMI empieza 6-11 puntos después del vblank según la
   fase, y los 7 ciclos de la secuencia de interrupción van antes de la primera instrucción.
2. **OAM DMA**: 513 ciclos, **514 si el ciclo de la escritura a `$4014` es par** (ciclo absoluto desde el
   encendido). En hardware es la paridad *get/put* del APU: el mismo concepto.
3. **DMA del DMC**: cuando suena una muestra, cada lectura del DMC detiene la CPU (4 ciclos en jsnes, 1-4 en
   hardware según el ciclo) justo después de la instrucción en curso. Afecta a la NMI y al bucle ocioso
   (11 574 NMIs de los movies). Si el flanco de vblank cae durante la parada, la NMI llega una instrucción
   más tarde. El port tiene que pedir al APU el calendario de lecturas del DMC en ciclos de CPU.
4. **Frames de lag**: si la NMI dura más de un frame, la PPU completa imágenes mientras tanto. El port debe
   seguir el reloj absoluto de la PPU a través de los límites de frame y emitir esas imágenes.
5. **Punto del frame impar**: en hardware el frame impar con render activo dura 89 341 puntos. jsnes no lo
   implementa. El port tendrá un modo para cada referencia (§4).
6. **IRQ**: Zelda no usa IRQ (0 en todos los movies).

## 4. Fidelidad del oráculo (jsnes 2.1.0) frente al hardware

jsnes 2.1.0 es bueno a nivel de CPU (avanza la PPU en cada ciclo de bus, DMA de OAM 513/514, retardos de la
NMI de un ciclo, lecturas fantasma...). Lo que **no** reproduce, comparado con lo documentado en nesdev y lo
que implementa Mesen2:

| Aspecto | jsnes | Hardware / Mesen | Efecto |
|---|---|---|---|
| Render | por scanline: el fondo de la línea se dibuja al final (`endScanline`); una escritura a mitad de línea afecta a la línea entera (o a la siguiente) | por punto | Frame 121: 33 px de la fila 52. Split del modo 7: la línea 62 entera. El port (por puntos) no puede coincidir con jsnes ahí salvo en modo compat |
| Frame impar | siempre 89 342 puntos (`dummyCycleToggle` nunca se activa) | 89 341 con render activo | La fase CPU/PPU deriva 1 punto cada 2 frames: latencia de la NMI y paridad del DMA distintas de las del hardware frame a frame |
| DMA del DMC | 4 ciclos fijos | 1-4 según el ciclo | Desfase de hasta 3 ciclos tras cada lectura del DMC |
| PPUMASK bit 0 (gris) | ignorado | aplicado | `items-all` frame 1067 (no es de timing; avisar al agente del oráculo) |
| Alineación CPU/PPU al encender | fija | aleatoria (varias fases posibles) | "El original" a nivel de punto no es único: hay que fijar una fase de referencia |
| Latencias de PPUMASK, evaluación de sprites a mitad de línea | aproximadas | exactas | Solo afectaría a escrituras sobre píxeles |

Consecuencias para la verificación:

* **Modo `jsnes-compat`** para el diff de CI contra el oráculo actual: frames de 89 342 puntos, DMC de 4
  ciclos, escrituras de render a mitad de línea aplicadas al final de la línea (lo hace el prototipo con
  `--jsnes-compat`: 0 px en el frame 121).
* **Modo hardware** para el juego real: PPU por puntos, frame impar corto. Validarlo a nivel de punto pide
  otro oráculo: Mesen2 (modo test headless + Lua, o su núcleo libretro compilado a WebAssembly) produciendo
  `.ztrace` con el mismo formato. Alternativa más barata y parcial: parchear jsnes en `tools/oracle` (frame
  impar y DMC exactos son cambios pequeños; el render por puntos no).

## 5. Diseño

### 5.1 Requisitos

* Exacto al ciclo (también en la fase de los sondeos y entre frames).
* Que no ensucie el port ni duplique su lógica; que una anotación errónea se detecte sola.
* Coste despreciable y desactivable.
* Sin datos de Nintendo en el repo (como `symbols.js`: se generan direcciones y fronteras, los bytes se leen
  de la ROM del usuario).

### 5.2 Opciones evaluadas

**(a) Coste por bloque básico generado del asm, con una llamada del JS en cada bloque.** Un script calcula
el coste de cada bloque (base + 1 por salto tomado + 1 si el salto cruza página, estático; + 1 por cruce de
página en lecturas indexadas, dinámico) y el JS llama `cy(BLOQUE)` al entrar en cada uno. Exacto, pero el
JS no tiene los mismos bloques que el asm (el port reestructura: `if (a && b)`, bucles `for`, colas
compartidas como `changeSample`), así que hay que anotar ~todos los bloques a mano (~5 000 puntos), sin red:
una anotación olvidada o duplicada solo se ve como un desfase de ciclos frames después. La generación
automática de anotaciones no es viable: no hay correspondencia sintáctica fiable JS↔asm (probado: el 70 %
de los saltos no se puede deducir de las migas automáticas, §2.3).

**(b) Coste por rutina dependiente del camino.** Fórmulas por rutina (`base + k·iteraciones + Σ ramas`)
generadas del asm. Menos llamadas, pero las fórmulas necesitan exactamente la misma información (qué rama
se tomó, cuántas vueltas, cruces de página), así que el JS acaba anotando lo mismo con una API peor y más
frágil. Los saltos que dependen de datos (bucles de búsqueda, `TableJump`) no tienen fórmula cerrada.

**(c) Coprocesador de temporización: un 6502 "sombra" que ejecuta el código original.** Exacto por
construcción y sin anotar nada (~600 líneas, <2 % de CPU). Pero el port pasaría a depender de emular la ROM
para algo visible: el código portado deja de ser la fuente de verdad, se duplica la ejecución y el proyecto
deja de ser un port. Rechazado para el juego; es exactamente lo que ya hace el oráculo, que sí se usa para
verificar.

**(d) Coste medio por rutina (aproximado).** Barato y bastaría para la tolerancia de jsnes en el título
(±30 ciclos), pero no para hardware, ni para la fase del split, ni para la latencia de la NMI siguiente
(depende del ciclo exacto del `RTI` módulo 3 y de la paridad).

**(e) Anotación automática por alineación dinámica**: instrumentar todas las condiciones del JS y alinear
su secuencia con la de saltos del oráculo para aprender la correspondencia. Las condiciones del JS no son
1:1 con los saltos (condiciones fusionadas, aritmética sin salto); sería investigación, no ingeniería.

**(f) Elegida: (a) con un rastreador guiado por el grafo del asm y migas verificadas.**

### 5.3 Diseño elegido

```
             asm (Z_0*.asm) + symbols.js ──► generador ──► fronteras de instrucción, etiquetas, saltos
                                                              │ (+ ROM del usuario en tiempo de carga:
                                                              ▼   opcodes → modo, tamaño, ciclos, destino)
  JS portado ──migas──► Rastreador (posición en el asm, ciclo) ──► reloj de la PPU (accesos a su ciclo)
   ├─ entrada/salida de rutina      (automático: comentario "// Nombre (Z_0n)")
   ├─ E/S $2000-$401F, MMC1         (automático: bus.read/write)
   ├─ TableJump, SwitchBank         (automático: core/asm.js)
   ├─ $br('Z_0b:línea', tomado)     (manual: un salto condicional del asm decidido por el JS)
   └─ $pxa('Z_0b:línea', base, i)   (manual: lectura indexada que puede cruzar página)
```

**Grafo** (`lib/cfg.mjs`, ya implementado): recorre los 8 ficheros del desensamblado (segmentos, etiquetas
globales/locales/anónimas, datos), resincroniza direcciones con `symbols.js` y lee de la ROM opcode, modo,
tamaño, ciclos base y operando. Comprueba cada mnemónico contra la ROM: **18 997 instrucciones, 0 errores**
(39 ms).

**Rastreador** (`lib/tracker.mjs`): estado = instrucción actual del asm, ciclo desde el inicio de la NMI,
pila de retornos y banco. Entre dos migas el asm no tiene decisiones (ni saltos condicionales, ni llamadas,
ni E/S): el rastreador recorre esas instrucciones y suma su coste (segmentos memorizados). Cada miga
comprueba que el asm está donde dice el JS:

* `enter(rutina)`: el asm debe estar en un `JSR` a esa rutina (apila), un `JMP`/caída a ella, o ya en ella.
* `leave()`: si la rutina entró por `JSR`, el asm debe llegar a un `RTS` sin decisiones.
* `io(dir)`: la siguiente instrucción con decisión debe ser un acceso a ese registro; el acceso ocurre en el
  **último ciclo** de la instrucción y ese es el instante que se da a la PPU. `$4014` añade 513/514.
* `$br(ref, tomado)`: el asm debe estar en ese salto; suma 2, +1 si se toma, +1 más si cruza página.
* `tableJump` suma el `JSR`, el cuerpo de `TableJump` (con sus dos `LDA ($00),Y` y su cruce de página
  calculado) y el `JMP ($0002)`.
* Sondeos (`@WaitVBlankEnd`, `WaitAndScrollToSplitBottom`): `pollStatus` itera `LDA $2002 / AND / Bxx`
  leyendo el estado de la PPU en el ciclo exacto de cada lectura. Reemplaza `ppu.waitStatus` y los
  `cpuCycles` contados a mano de `sprite0.js`.

Si falta una anotación, el error dice dónde: `io(write $4017): the asm is at a branch at Z_00:112 BEQ @Play
[DriveAudio]`. En producción las comprobaciones se pueden quitar; en desarrollo y en los tests están.

**Entre frames**: al `RTI` el rastreador conoce el ciclo absoluto; el modelo de §3 da el inicio de la NMI
siguiente (`nmi-model.mjs predictStart`) y la paridad para el DMA. Con frames de lag, el reloj de la PPU
cruza el final del frame y el bucle emite la imagen completada.

**Por qué así**: las migas automáticas cubren rutinas, E/S y saltos de tabla sin tocar el código; lo manual
es una anotación por salto condicional, con nombre del asm (`'Z_07:391'` es la línea del `BEQ` en el
desensamblado, que es fijo) y verificada en cada ejecución. El JS conserva su forma: el prototipo cambió
condiciones como `if (ram[X] !== 0)` por `if (!$br('Z_07:391', ram[X] === 0))` y convirtió bucles `for` en
la forma del asm (salto al final). El coste en JS es una llamada por decisión.

## 6. Prototipo

```sh
# frame 121 (semilla del oráculo para esa NMI)
node --import ./tools/timing/proto/register.mjs tools/timing/proto/frame121.mjs
# frames 7-121 encadenados: solo el frame 7 toma su inicio del oráculo; el resto lo predice el modelo
node --import ./tools/timing/proto/register.mjs tools/timing/proto/frame121.mjs --from 7
# reglas de jsnes (escritura de PPUMASK a mitad de línea → fin de línea)
node --import ./tools/timing/proto/register.mjs tools/timing/proto/frame121.mjs --jsnes-compat
# rendimiento (3 procesos: port sin tocar, instrumentado sin rastreador, con rastreador)
node tools/timing/proto/bench.mjs --logic-only --n 3000
node --import ./tools/timing/proto/register.mjs tools/timing/proto/bench.mjs --logic-only --n 3000
node --import ./tools/timing/proto/register.mjs tools/timing/proto/bench.mjs --tracker --logic-only --n 3000
```

* `proto/hooks.mjs` (cargado con `--import proto/register.mjs`) instrumenta los módulos **al cargarlos**, sin
  tocar `src/`: envuelve cada función con el comentario `// Nombre (Z_0n)` con `enter/leave`, intercepta
  `read/write` de `src/core/bus.js` y `switchBank/tableJump` de `src/core/asm.js`, y aplica las anotaciones
  de `proto/annotations.mjs` como parches de texto exactos (si un fichero cambia y el parche no casa, falla
  diciéndolo).
* Anotaciones del prototipo: **122 saltos + 16 pistas de página** en 92 parches de 8 ficheros
  (`nmi.js`, `ppu/tilebuf.js`, `audio/{driver,effects,samples,song}.js`, `modes/mode0-title.js`, `boot.js`):
  `IsrNmi`, `TransferCurTileBuf`, `ReadInputs`, todo el `DriveAudio` usado por el título (tunes, efectos,
  muestras, canción con cambio de frase), `UpdateMode0Demo`, la animación del título y `UpdateMode0Demo_Sub0`.

Resultados:

| Prueba | Resultado |
|---|---|
| Accesos PPU de la NMI del frame 121 | 191/191 en el mismo ciclo que el oráculo (incluido el sondeo de 171 vueltas de `@WaitVBlankEnd` y el OAM DMA de 514) |
| Duración de la NMI | 9 726 ciclos, igual que el oráculo |
| Imagen frente a la referencia por puntos (repetición en el instante real) | **0 px** |
| Imagen frente a jsnes | 33 px (fila 52: jsnes aplica PPUMASK a la línea entera) |
| Imagen frente a jsnes con `--jsnes-compat` | **0 px** |
| Sin rastreador (port actual) | 2 055 px (filas 16-52) |
| Encadenado 7-121 (115 NMIs, una semilla) | inicio de NMI 115/115, accesos PPU y duración exactos en todos |
| Modelo de NMI sobre los 45 movies (`nmi-model.mjs`) | inicio de la NMI predicho exactamente en **202 032/202 032** NMIs (11 574 con lecturas del DMC en el bucle ocioso) y longitud del OAM DMA en 202 032/202 032, a partir solo del ciclo del `RTI` anterior, el vblank y el calendario del DMC |
| Tests | `node --test tests/timing/` (13 tests; los que necesitan ROM/jsnes se saltan sin ellos) |

Rendimiento (Node 26, M-series, mediana de 3 000 repeticiones del frame 121 desde una instantánea):

| | Lógica de la NMI (sin render) | Frame completo con render |
|---|---:|---:|
| Port sin tocar | 4-5 µs | ~0,8-1,0 ms |
| Instrumentado, rastreador apagado | 6-9 µs | ~0,75-0,95 ms (ruido) |
| Rastreador encendido | ~70 µs | ~1,2 ms (incluye dibujar 52 líneas más) |

El rastreador cuesta ~70 µs por NMI en el prototipo (0,4 % de 16,7 ms; +3-7 % del tiempo total de frame).
La mayor parte es despacho de migas (búsqueda por cadena `'Z_07:391'`, envoltorios con `try/finally`);
con ids enteros generados y una tabla "siguiente decisión + coste" por instrucción se estima 10-30 µs.

## 7. Plan de implementación para todo el juego

**Paso 0 — Decisiones** (Arquitecto): adoptar el diseño; fijar la referencia (modo `hardware` para el
juego, `jsnes-compat` para el diff de CI); nombre de la API (`$br`/`$px` o `cyc.br`).

**Paso 1 — Generador e infraestructura en `src/core`** (Arquitecto):
1. `scripts/gen-cfg.mjs` → `src/core/cfg.gen.js`: por banco, fronteras de instrucción (desplazamientos
   delta), etiquetas anónimas y la tabla `línea del asm → instrucción` (sin bytes de la ROM; los opcodes se
   leen al cargar, como `table()`). Base: `tools/timing/lib/cfg.mjs`. Test: 0 discrepancias con la ROM.
2. `src/core/timing.js`: el rastreador (`tools/timing/lib/tracker.mjs`) con ids enteros, tabla precalculada
   de segmentos sin decisiones y modo estricto conmutable.
3. `bus.read/write`, `asm.switchBank/tableJump` y el envoltorio de rutinas: en vez del *loader*, una
   transformación en el generador o llamadas explícitas `enter/leave` (el comentario `// Nombre (Z_0n)` ya
   está en todas las funciones; un test comprueba que cada función con comentario tiene su `enter`).
4. PPU: reloj absoluto (no reiniciar en `beginFrame`), cruce de frame dentro de la NMI con emisión de la
   imagen (frames de lag), `waitStatus` sustituido por `pollStatus`, `cpuCycles` eliminado (lo da el
   rastreador), modo `jsnes-compat` (frame de 89 342, escrituras de render a fin de línea).
5. Bucle (`src/core/loop.js`, `headless.js`): el reloj de 60,0988 Hz pasa a contar frames de vídeo, no NMIs;
   el modelo de §3 decide cuándo empieza cada NMI (reset incluido: `IsrReset` espera dos vblanks y `RunGame`
   tiene bucles largos que también hay que anotar). `headless` sigue dando una imagen por NMI para el
   oráculo (la del frame de vídeo en que acaba, como `run-oracle`).
6. APU: exponer el calendario de lecturas del DMC en ciclos de CPU para que el rastreador sume los robos.

**Paso 2 — Anotación por paquetes** (porteadores, como el diff de RAM): por prioridad:
1. Prólogo de la NMI, `TransferCurTileBuf`, `WaitAndScrollToSplitBottom` (fase del split).
2. `DriveAudio` completo y `ReadInputs` (corren cada frame; sin ellos no hay frame siguiente exacto).
3. Transiciones de modo que llaman a `TurnOffAllVideo` (título → menú es la única visible hoy).
4. Todo lo demás (la duración exacta de cada NMI es necesaria para la latencia de la siguiente).

Herramienta de cobertura: el generador lista los saltos de cada rutina; un test cuenta los `$br('Z_0b:l')`
del JS de esa rutina y reporta los que faltan (y los que sobran o no existen). Las lecturas indexadas que
pueden cruzar página se clasifican en "imposible" (índice acotado: `LDY #0`, base con byte bajo 0...),
"siempre" (tablas que empiezan cerca del final de página) y "datos" (pista `$pxa`); `pagecross.mjs` da la
lista empírica (53 instrucciones).

**Paso 3 — Verificación con el oráculo en todos los movies**:
1. `cycle-diff` (generalización de `proto/frame121.mjs`): reproduce cada movie con el rastreador encendido
   desde el encendido, compara **cada acceso PPU/APU y cada duración de NMI** con la sonda del oráculo y
   para en el primer desfase con la rutina y la línea del asm. Criterio: 0 desfases en todos los movies
   (como hoy el diff de RAM). Integrable en `tools/oracle/compare.mjs` como una columna más.
2. Diff de imagen en modo `jsnes-compat`: 0 px en todos los frames (hoy fallan 43 + el split del modo 7
   salvo por la regla de fin de línea).
3. `replay-scope` como red de seguridad: la repetición por puntos en el instante real es la referencia del
   modo hardware hasta que haya un oráculo Mesen.
4. Oráculo de hardware (Mesen2) para unos pocos movies, para validar el modo hardware a nivel de punto.

**Paso 4 — Limpieza**: quitar los contadores a mano de `sprite0.js` y `ppu.waitStatus`; documentar la API en
`ARCHITECTURE.md` §3 (sustituye a "Fuera de la NMI no se avanza el reloj").

Estimación: el prototipo necesitó ~140 anotaciones para ~30 rutinas (≈9 700 ciclos de código). El juego
tiene 2 806 saltos condicionales y ~1 250 rutinas: del orden de 2 500-3 000 anotaciones, mecánicas y
verificadas una a una por el rastreador.

## 8. Riesgos

* **Volumen y deriva de las anotaciones.** ~3 000 puntos; si alguien cambia una rutina sin actualizar sus
  `$br`, el modo estricto lo detecta en la primera ejecución que pase por ahí, pero solo si un movie pasa por
  ese camino: hace falta cobertura de movies (como para la RAM).
* **Reestructuraciones del port** que no siguen el asm (colas compartidas, helpers que sirven a varios
  sitios del asm, como `bitIndex`): hay que pasar la referencia del salto al helper. Coste de lectura menor.
* **Oráculo**: jsnes no valida el modo hardware a nivel de punto (§4). Sin un segundo oráculo, el modo
  hardware se valida con la repetición por puntos, que usa la misma PPU del port: un error de la PPU del port
  no se detectaría.
* **Fase CPU/PPU al encender** y **DMC de 1-4 ciclos** en hardware: el "original" no es único a nivel de
  punto. Hay que fijar una referencia (la de jsnes o la de Mesen) y aceptarlo.
* **Rendimiento**: medido +3-7 % del frame; despreciable, pero el rastreador debe poder apagarse (modo sin
  timing = comportamiento actual).
* **Movies**: la medición cubre título, menús, registro, overworld, mazmorras 1, cuevas, tiendas y objetos.
  No cubre el final, la muerte, Ganon ni la segunda misión: puede haber más escrituras a mitad de frame
  (repetir `measure.mjs` cuando haya movies).

## 9. Ficheros

```
tools/timing/
  measure.mjs, measure-movie.mjs   medición de escrituras PPU por frame y agregados
  replay-scope.mjs                 impacto real (repetición por puntos), tolerancia, fase del split
  port-scope.mjs                   port real vs oráculo, todos los frames (hashes + diff)
  nmi-model.mjs                    latencia de la NMI y paridad del OAM DMA
  pagecross.mjs                    cruces de página dependientes de datos
  lib/ppu-probe.mjs                sonda sobre jsnes
  lib/classify.mjs                 región, impacto, holgura
  lib/replay.mjs                   captura y repetición de un frame con src/core/ppu.js
  lib/symbolize.mjs                PC → rutina
  lib/opcodes.mjs, lib/cfg.mjs     tabla de opcodes y grafo del asm verificado con la ROM
  lib/tracker.mjs                  rastreador de ciclos
  proto/register.mjs, hooks.mjs    instrumentación del port al cargar (sin tocar src/)
  proto/annotations.mjs            migas manuales del prototipo
  proto/frame121.mjs, bench.mjs    prototipo y medida de rendimiento
tests/timing/                      classify, nmi-model, cfg-tracker, replay, prototype
```
