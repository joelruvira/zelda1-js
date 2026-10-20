# Mapa del port — paquetes de trabajo y guía conceptual

Fuente: `reference/zelda1-disassembly/src` (sin modificar). El inventario completo y máquina‑legible está en
`docs/ROUTINES.json`, generado por `node scripts/analyze-asm.mjs [--report]` (scripts en `scripts/asm/`,
asignación de paquetes en `scripts/asm/packages.mjs`). Este documento es la guía para los porteadores.

**Cifras** (de `ROUTINES.json → meta.counts`): 1251 bloques de código (1009 puntos de entrada, el resto son
colas alcanzadas por rama/caída), ~19 000 instrucciones, 619 bloques de datos (~55 KB). Todo el JSON está
verificado (64 comprobaciones en `meta.verification`): direcciones de `.INCBIN` = offsets de `bins.xml`,
vectores (`IsrNmi` $E484, `IsrReset` $FF50, `RunGame` $E440), límites de segmentos de `Z.cfg`, y — si existe
`roms/zelda.nes` — 477/477 tablas `.BYTE` idénticas a la ROM en su `prgOffset` y 1319/1319 operandos `JSR`
iguales a la dirección calculada del destino. (El JSON no contiene ni un byte de la ROM.)

---

## 1. Cómo usar `ROUTINES.json`

| Sección | Contenido |
|---|---|
| `routines[]` | `id` (`banco:Nombre`), `bank`, `line`/`endLine`, `cpu`, `prgOffset`, `size`, `instrs`, `package`, `subsystem`, `entry`, `partOf` (si no es entrada: rutina a la que pertenece), `fallsInto`, `endsWith`, `calls[]` (`jsr`/`jmp`/`branch`/`fall`/`addr`/`table`, con `crossBank`), `calledBy[]`, `switchesBankTo`, `dispatch` (tabla de `TableJump` y destinos), `ram.read/write` (por nombre de variable o `$xx`), `io` (registros PPU/APU/mando), `dataRefs`, `inlineData` (datos embebidos tras el código), `runsFrom` (`fixed`/`banked`/`wram`), `unreferenced`, `unverified` (bloques marcados «Begin unverified code» en el asm). |
| `data[]` | `id`, `bank`, `cpu`, `prgOffset`, `size`, `directives` (`BYTE`/`ADDR`/`DBYT`/`LOBYTES`/`HIBYTES`/`INCBIN`), `incbin`, `jumpTable` (si es tabla de `TableJump`), `usedBy[]`, `pointsTo[]`, `padding`. |
| `modes[]` | Modo `$00..$13` → rutina Init y Update. |
| `objTypes[]` | `ObjType` `$00..$69` → Update e Init (+ `$6A-$7F` personas de cueva). |
| `packages[]` | Los 25 paquetes con rutinas, datos, dependencias (`dependsOn[].laterPhase` = hay que dejar *stub*). |
| `sharedRoutines[]` | Rutinas llamadas desde ≥3 paquetes distintos: API que hay que portar primero y no cambiar. |

Consultas típicas:
```sh
node -e 'const j=require("./docs/ROUTINES.json");console.log(j.packages.find(p=>p.id==="P18").routines)'
node -e 'const j=require("./docs/ROUTINES.json");console.log(j.routines.find(r=>r.name==="Walker_Move"))'
```

---

## 2. Guía conceptual del motor original

### 2.1 Arranque y frame: todo ocurre en la NMI
* `IsrReset` (banco 7, $FF50): espera 2 vblanks, resetea MMC1, control `$0F` (mirroring horizontal, PRG de
  16 KB en $8000, banco 7 fijo en $C000), `SwitchBank 7`, salta a `RunGame`.
* `RunGame`: `InitSaveRam` y `ClearRam` (banco 5), `ClearAllAudioAndVideo`, activa la NMI y se queda en
  `LoopForever: JMP LoopForever`. **No hay bucle principal: cada frame es una ejecución de `IsrNmi`.**
* `IsrNmi` (orden exacto, es el contrato de `stepFrame` del port):
  1. PPUCTRL (aplica `SwitchNameTablesReq`), desactiva NMI; PPUMASK (fuerza vídeo si sprite 0 activo o hay
     transferencia pendiente); DMA de OAM desde `$0200`.
  2. Banco 6 → `TransferCurTileBuf`: vuelca a VRAM el buffer elegido por `TileBufSelector` (§2.5) y
     vacía `DynTileBuf`.
  3. Si `IsSprite0CheckActive`: banco 5 → `WaitAndScrollToSplitBottom` (espera el hit del sprite 0 y
     cambia el scroll: HUD fijo arriba, campo desplazado abajo).
  4. Si `IsUpdatingMode` y el modo es 0/5/9/B/C/$13: escribe `CurHScroll`/`CurVScroll`/`CurPpuControl_2000`.
  5. Si no hay pausa ni menú (`Paused|MenuState == 0`): temporizadores. `StunCycle` ($26) cuenta 9..0;
     cada frame se decrementan (si ≠0) `$27..$3C` (`DoorTimer`, `ObjTimer[0..$13]`, `FluteTimer`); cuando
     `StunCycle` da la vuelta (1 de cada 10 frames) el rango es `$27..$4E` (incluye `ObjStunTimer[]` y los
     *long timers* `$4A-$4E`).
  6. `ReadInputs` (solo si no hay sprite 0 activo) → `ButtonsPressed` $F8 / `ButtonsDown` $FA.
  7. Mezcla `Random` ($18-$24, 13 bytes, LFSR por ROR).
  8. Banco 0 → `DriveAudio`. `INC FrameCounter`.
  9. Si `IsUpdatingMode == 0` → `InitializeGameOrMode`, si no → `UpdateMode`. Reactiva NMI, `RTI`.
* `InitializeGameOrMode`: la primera vez (`InitializedGame == 0`) copia el código común del banco 1 a WRAM
  (`CopyCommonCodeToRam` → `$6C90-$7EFF`) y los datos comunes del banco 6 (`CopyCommonDataToRam` →
  `$67F0-$687D`); en adelante salta a `InitMode`.

### 2.2 Bancos (MMC1)
* `SwitchBank` (banco 7) mapea un banco de 16 KB en `$8000-$BFFF`; `$C000-$FFFF` es siempre el banco 7.
  El banco activo es **estado**: muchas rutinas llaman a otra de otro banco tras `LDA #n / JSR SwitchBank`
  y nunca restauran. En el port, las rutinas son JS y no necesitan bancos para ejecutarse, pero **las
  lecturas de tablas de la ROM sí** dependen del banco (las tablas de los bancos 0‑6 se leen con el banco
  correcto). Regla: cada función lee sus tablas con `table(rom, 'Nombre')` (`src/core/rom.js`), que ya
  sabe el banco por la etiqueta; y llama a `switchBank(n)` (`src/core/asm.js`) en los mismos puntos que el
  original, para que `TableJump`/lecturas por bus vean lo mismo.
* `runsFrom: "wram"`: el bloque `BANK_01_CODE` (banco 1, carga en $A500) se ejecuta en `$6C90-$7EFF`
  y `BANK_06_DATA` se lee en `$67F0`. El port debe copiar esos bytes a la SRAM igual que el original (el
  oráculo compara `$67F0-$687D`; ignora `$6C90-$7EFF`). Las 139 rutinas de `BANK_01_CODE` (p. ej.
  `BeginUpdateMode`, `World_ChangeRupees`, `FormatStatusBarText`, `PlaySample`, `PlayEffect`) son
  accesibles desde cualquier banco, como las del banco 7 (`calls[].crossBank` no se marca para ellas).
* `calls[].crossBank = true` marca llamadas a una rutina de otro banco conmutado: en el original van
  precedidas de `SwitchBank`; en JS son una importación normal.

### 2.3 Máquina de modos (`GameMode` $12, `GameSubmode` $13, `IsUpdatingMode` $11)
Protocolo: con `IsUpdatingMode = 0` cada NMI llama `InitMode` (banco 5 → `InitMode_JumpTable[GameMode]`);
la rutina Init avanza por `GameSubmode` a lo largo de varios frames (una tarea por frame, p. ej. cargar
filas de la sala en `DynTileBuf`) y al acabar hace `INC IsUpdatingMode`. Entonces cada NMI llama `UpdateMode`
(banco 2 → `UpdateMode_JumpTable[GameMode]`). Para cambiar de modo: `GameMode = n` + `EndGameMode`
(`IsUpdatingMode = 0`, `GameSubmode = 0`), o `GoToNextMode` (`INC GameMode` + `EndGameMode`).

| Modo | Init → Update | Qué es | Submodos (tabla) | Paquete |
|---|---|---|---|---|
| $00 | InitMode0 → UpdateMode0Demo | Título, historia, desfile de objetos | `InitDemo_RunTasks_Phase0/1`, `UpdateMode0Demo` (3), `AnimateDemo_Phase0` (2) / `_Phase1` (5) | P23 |
| $01 | InitMode1 → UpdateMode1Menu | Selección de partida | `InitMode1_Full` (7), `UpdateMode1Menu` (2) | P24 |
| $02 | InitMode2 → UpdateMode2Load | Carga CHR de nivel y bloque de nivel a SRAM `$687E-$6C8F` | `InitMode2_Submodes` (2) | P03 |
| $03 | InitMode3 → UpdateMode3Unfurl | Primera sala + cortina que se abre | `InitMode3` (9) | P13 |
| $04 | InitMode4 → UpdateMode4and6EnterLeave | Link entra en sala/sale de subsuelo | — (usa `UndergroundExitType`, `ObjGridOffset`) | P13 |
| $05 | InitMode5Play → UpdateMode5Play | **Juego** | menú: `UpdateMenuOW/UW` por `MenuState` | P05 (+P11) |
| $06 | InitMode6 → UpdateMode4and6EnterLeave | Salir de sala UW por puerta | — | P13 |
| $07 | InitMode7 → UpdateMode7Scroll | Scroll a la sala vecina | `InitMode7Submodes` (7), `UpdateMode7ScrollSubmode` (8) | P13 |
| $08 | InitMode8 → UpdateMode8ContinueQuestion | CONTINUE / SAVE / RETRY | — | P25 |
| $09 | InitMode9 → UpdateMode5Play | Bajar al sótano UW | `InitMode9` (10) | P13 |
| $0A | InitModeA → UpdateMode5Play | Salir de cueva/sótano | `InitModeA` (11) | P13 |
| $0B | InitModeB → UpdateMode5Play | Entrar en cueva OW | `InitModeB` (9) | P13 |
| $0C | InitModeC → UpdateMode5Play | Entrar en atajo (shortcut) OW | `InitModeC` (9) | P13 |
| $0D | InitModeD → UpdateModeDSave | Guardar | `UpdateModeDSave` (3) | P24 |
| $0E | InitModeEandF → UpdateModeERegister | Registrar nombre | — | P24 |
| $0F | InitModeEandF → UpdateModeFElimination | Borrar partida | — | P24 |
| $10 | InitMode10 → UpdateMode10Stairs | Escaleras / entrar a nivel / warp | — | P13 |
| $11 | InitMode11 → UpdateMode11Death | Muerte de Link | `UpdateMode11Death_Full` (13) | P25 |
| $12 | InitMode12 → UpdateMode12EndLevel | Triforce: fin de nivel | `UpdateMode12EndLevel_Full` (5) | P25 |
| $13 | InitMode13 → UpdateMode13WinGame | Final y créditos | `InitMode13_Full` (5), `UpdateMode13WinGame` (5) | P25 |

Flujo típico: 0 →(Start) 1 →(elegir) 2 → 3 → 5; en juego: 5 →(borde) 7 → 5; puerta UW 6 → 7 → 4 → 5;
cueva 5 → B → 5 →(salir) A → 4 → 5; escaleras de nivel 5 → $10 → 2 → 3; muerte 5 → $11 → 8 → (1|2);
triforce 5 → $12 → 2/3…; Zelda → $13. Los modos 9/A/B/C reutilizan `UpdateMode5Play`: la escena sigue
«jugando» mientras su Init hace el trabajo por submodos.

### 2.4 El frame de juego (`UpdateMode5Play` → `BeginUpdateWorld`, banco 7)
1. `FluteTimer ≠ 0` → nada. `BrighteningRoom` → `UpdateCandle` (banco 4).
2. Select alterna `Paused`; pausado → gris + `UpdateHeartsAndRupees`. Start → `MenuState = 1`; en menú →
   `UpdateMenuAndMeters` (banco 5, tablas `UpdateMenuOW/UW_JumpTable` por `MenuState`).
3. `HideObjectSprites`, `ObjInputDir[0] = ButtonsDown & $0F`.
4. Con reloj, invencibilidad forzada. `UpdatePlayer` (Link, slot 0). Si cambió de modo, termina.
5. Objetivo de persecución (`ChaseTargetX/Y`, alterna con `ChaseLongTimer` y `ChaseOtherTarget`).
6. Armas por slot fijo: `$0D` UpdateSwordOrRod, `$0E` UpdateSwordShotOrMagicShot, `$0F` UpdateBoomerangOrFood,
   `$10`/`$11` UpdateBombOrFire, `$12` UpdateRodOrArrow.
7. **Bucle de objetos** `CurObjIndex` = `$0B` → `$01`: `DecrementInvincibilityTimer`; si `ObjType ≠ 0`,
   `UpdateObject`; después, si `ObjMetastate == 0` y `ObjAttr & $01 == 0`: dibuja con
   `AnimateAndDrawObjectWalking` (salvo `ObjAttr & $04`) y `CheckMonsterCollisions`.
8. Aviso de corazón bajo (`Tune0Request |= $40`).
9. UW: `UpdateStatues`, `UpdateTriforcePositionMarker`, `CheckUnderworldSecrets`, `CheckShutters`,
   `UpdateDoors`, `CheckPowerTriforceFanfare`. OW: sonido del mar según `LevelBlockAttrsA[RoomId]`,
   `CheckZora`.
10. Si `DynTileBuf` vacío y `StatusBarMapTrigger`: `TileBufSelector = $44` (mapa del HUD).
11. Siempre: `CheckLiftItem`, `MoveAndDrawRoomItem`, `TryTakeRoomItem`, `DrawStatusBarItemsAndEnsureItemSelected`,
    `World_FillHearts`, `World_ChangeRupees`.

### 2.5 Sistema de objetos
* **Arrays paralelos indexados por slot (X)**, mismas direcciones que la NES: `ObjX` $70, `ObjY` $84,
  `ObjDir` $98, `ObjState` $AC, `ObjShoveDir` $C0, `ObjShoveDistance` $D3 (stride `$14` = 20 slots),
  `ObjTimer` $28, `ObjStunTimer` $3D, `ObjType` $34F, `ObjMovingLimit` $380, `ObjGridOffset` $394,
  `ObjPosFrac` $3A8, `ObjQSpeedFrac` $3BC, `ObjAnimCounter` $3D0, `ObjAnimFrame` $3E4, `ObjInputDir` $3F8,
  `ObjMetastate` $405, `ObjHP` $485, `ObjUninitialized` $492, `ObjCollidedTile` $49E,
  `ObjInvincibilityMask` $4B2, `ObjAttr` $4BF, `ObjInvincibilityTimer` $4F0 … (`Variables.inc`).
  `ObjVars.inc` define **alias por familia** sobre los mismos bytes (`Flyer_ObjSpeed` = $41F,
  `Gleeok_NeckXs0` = $438…): el port debe usar las mismas direcciones (`src/core/vars.js`), nunca campos JS.
* **Slots**: `0` Link · `1..$0B` monstruos, objetos de sala y de tile (asignación dinámica,
  `FindEmptyMonsterSlot` busca de `$0B` a `1`) · `$0C` usado por la cortina/efectos · `$0D` espada/vara ·
  `$0E` rayo de espada/magia · `$0F` bumerán/comida · `$10`,`$11` bombas/fuego · `$12` flecha/rayo de vara ·
  `$13` item de la sala (`ObjState+$13`, `RoomItemId`).
* **Tipos** (`ObjType`): `$01-$52` enemigos, jefes y personas UW; `$53-$5C` proyectiles de monstruo
  (rocas, bolas de fuego, flechas, bumeranes); `$5D` dummy de muerte; `$5E` secreto de flauta; `$5F-$69`
  objetos de tile/ítem (`$60` item, `$61` muelle, `$62/$65/$66` roca/tumba, `$63/$67` muro de rocas,
  `$64` árbol, `$68` bloque empujable); `$6A-$7F` personas de cueva (banco 1, `UpdateCavePerson`).
  Tabla completa en `ROUTINES.json → objTypes`.
* **`UpdateObject`** (banco 7, cambia a banco 4): si `ObjUninitialized`, lo limpia y llama `InitObject`
  (`InitObject_JumpTable`, 95 entradas; `>= $5F` → `InitTileObjOrItem`; maneja «enemigos desde los bordes»
  con `MonstersFromEdgesLongTimer`). Si `ObjMetastate ≠ 0` → `UpdateMetaObject`. Si tipo `>= $6A` → banco 1
  `UpdateCavePerson`. Si no, `UpdateObject_JumpTable[ObjType]` (106 entradas).
* **Metaestados**: `1..4` nube de aparición (cada fase dura un `ObjTimer`), `$10..$14` chispa de muerte;
  al llegar a 4 se pone a 0 (el objeto empieza a vivir) y a `$14` el objeto se convierte en `$60` (drop),
  avanza `WorldKillCycle` y `RoomKillCount` (`UpdateMetaObjectEnd`).
* **Atributos** (`ObjectTypeToAttributes`, leído de ROM por tipo → `ObjAttr`): bit0 «el objeto comprueba
  colisiones y se dibuja él mismo», bit2 «se dibuja él mismo», bit7 «se da la vuelta al tocar a Link»;
  `ObjectTypeToHpPairs` da la vida (nibbles).
* Creación de la sala: `CreateRoomObjects`, `AssignObjSpawnPositions`, `ModifyObjCountByHistoryOW/UW`
  (`RoomHistory`, `LevelKillCounts`) en P05.

### 2.6 Vídeo: buffers de transferencia, OAM y sprite 0
* El juego **nunca** escribe VRAM fuera de la NMI salvo con el vídeo apagado (modo 2, `ClearNameTable`…).
  Durante el juego deja datos en un *transfer buffer* y elige cuál con `TileBufSelector` ($14) = offset par
  en `TransferBufAddrs` (banco 6, 65 entradas: `$00` = `DynTileBuf` $0302, `$44` = `LevelInfo_StatusBarMapTransferBuf`,
  etc.). La mayoría son tablas estáticas del banco 6 (se leen de la ROM), otras están en RAM/SRAM.
* Formato de registro (`TransferTileBuf`/`ContinueTransferTileBuf`): `hiVRAM, loVRAM, ctl, datos…`;
  `ctl` bit7 = incremento de 32 (vertical), bit6 = repetir un byte, bits0‑5 = cuenta (0 ⇒ 64); termina con
  un byte con bit7 (normalmente `$FF`). Escribir en `$3Fxx` (paleta) resetea PPUADDR a `$3F00/$0000`.
  `DynTileBufLen` ($301) es la longitud ocupada del buffer dinámico (máx. ~$3D); tras transferir se pone a 0
  y `DynTileBuf[0] = $FF`. Port: `TransferCurTileBuf` lee el buffer **a través del bus** (RAM, SRAM o ROM
  según la dirección) y escribe en el modelo de VRAM de `src/core/ppu.js`.
* Sprites: el juego compone OAM en `$0200-$02FF` (`Sprites`); la NMI hace DMA. P04 contiene los
  escritores (`Anim_*`, `DrawObject*`), con rotación de prioridad (`RollingSpriteIndex`).
* Sprite 0 / split del HUD: `IsSprite0CheckActive` (modos 5, 7, menú). `WaitAndScrollToSplitBottom` hace
  *busy‑wait* sobre `$2002`; en el port se traduce a «registrar el scroll del campo a partir de la línea del
  split» para el renderizador, sin bucles.

### 2.7 Audio
`DriveAudio` (banco 0, P02) se ejecuta una vez por NMI. El juego pide sonidos escribiendo `SongRequest`
$600, `SampleRequest` $601, `Tune1Request` $602, `EffectRequest` $603, `Tune0Request` $604 (los helpers
`PlayEffect`, `PlaySample` están en P02). Las partituras (`.INCBIN dat/SongScript*.dat`) y las tablas de
notas se leen de la ROM. El driver escribe registros `$4000-$4017` → APU emulada (`src/audio/**`, del agente
APU); el port del driver va en `src/game/audio/`.

### 2.8 Memoria persistente (SRAM $6000-$7FFF)
`$6000…`: ficheros de partida A/B (`CopyFileBToFileA`, checksums en P24), `PlayAreaTiles` $6530-$67EF
(mapa de tiles de la sala), `RAM_06_DATA` $67F0, bloque de nivel `$687E-$6C8F` (`LevelBlockAttrsA-F`,
`LevelInfo_*`, copiado por el modo 2 desde los bancos 1/2/6 según nivel y misión), código común $6C90-$7EFF.

---

## 3. Reglas para los porteadores

1. **Una función JS por rutina con entrada** (`entry: true`), mismo nombre exacto que la etiqueta del asm (sin camelCase), con un
   comentario de una línea `// NombreAsm (Z_0b)`. Los bloques `entry: false` (`partOf`) son etiquetas
   internas: van dentro de la función a la que pertenecen. Si una rutina cae (`fallsInto`) en otra, la
   función llama a la siguiente al final.
2. **Valores de retorno en flags**: muchas rutinas devuelven en Z/C/N (p. ej. `FindEmptyMonsterSlot`
   devuelve Z; las de colisión, C). En JS devuélvelos explícitamente o deja `cpu.c` (convenciones de
   `docs/ARCHITECTURE.md` §6) y documenta qué flag original representa. Igual con `A`, `X`, `Y` cuando el llamador los usa.
3. **Temporales `$00-$0F` y registros**: si la rutina escribe `$00-$0F`, el port debe dejarlos igual (el
   oráculo los compara). Escribe a `ram[...]`, no a variables locales, cuando el original usa RAM.
4. **Datos**: ninguna tabla se copia al código. `table(rom, 'Etiqueta').byte(i)` para `LDA Etiqueta, X`;
   las tablas `.ADDR` de `TableJump` se representan como **arrays de funciones JS** en el mismo orden
   (`tableJump(addr, index, handlers)` de `src/core/asm.js` reproduce además `$00-$03`).
   Los datos `inlineData` que el asm intercala tras el código también se leen por etiqueta/dirección.
5. **Stubs**: si llamas a una rutina de un paquete posterior (`dependsOn[].laterPhase`), importa un stub
   desde el fichero destino de ese paquete creado con `stub('Nombre')` de `src/game/stub.js` (lanza `NotImplementedError`); el porteador del otro
   paquete lo sustituye. No portes rutinas de otros paquetes.
6. **Hecho = diff 0**: una rutina está terminada cuando su escenario de oráculo da diff de RAM 0
   (`node tools/oracle/compare.mjs …`), incluyendo SRAM y, cuando aplica, imagen.

---

## 4. Paquetes de trabajo

`i` = instrucciones 6502 aprox., `r/e` = bloques/entradas, `B` = bytes de datos de ROM que se leen.
Ficheros destino bajo `src/game/`. Lista exacta de rutinas y datos en `ROUTINES.json → packages[].routines`.

| Id | Paquete | Bancos | Tamaño | Depende de (antes) | Stubs hacia |
|---|---|---|---|---|---|
| P01 | Núcleo: reset, NMI, bancos, despacho de modos, transferencias PPU | 1,2,5,6,7 | 755i 57r/51e | P02, P03 | P05, P13, P23, P24, P25 |
| P02 | Driver de sonido y peticiones | 0,1 | 654i 45r/25e, 12.6 KB | — | — |
| P03 | Carga de CHR y bloque de nivel (modo 2) | 1,2,3,6 | 320i 20r/19e, 26 KB | P01 | — |
| P04 | Sprites: animación, descriptores, OAM | 1,4,5,7 | 344i 39r/34e | — | P08, P09 |
| P05 | Bucle del modo 5, objetos (slots, Init/Update, metaestados), creación de sala | 1,4,5,7 | 835i 49r/46e | P01,P04,P06,P08,P11,P12,P13,P02 | todos los de entidades |
| P06 | Movimiento genérico, colisión con tiles, shove, límites | 1,5,7 | 672i 47r/36e | P01, P08, P13 | P14, P15, P16 |
| P07 | Colisiones objeto‑objeto, daño, escudo | 1 | 560i 30r/22e | P01,P02,P05,P06,P09 | P21 |
| P08 | Link: entrada, rejilla, escalera, animación | 5,7 | 532i 25r/20e | P01,P04,P05,P06,P13 | P09, P14 |
| P09 | Armas e items usables | 1,4,5,7 | 1025i 69r/48e | P01,P02,P04,P06,P07,P13,P14,P16 | P17 |
| P10 | Items del suelo, drops, recoger, hada, triforce | 1,4,7 | 488i 41r/27e | P01,P04,P05,P06,P11,P13,P14 | P17, P22 |
| P11 | HUD, submenú, mapas, corazones/rupias | 1,5,7 | 954i 72r/52e | P01,P04,P05,P06 | P10, P14, P25 |
| P12 | Composición de salas OW/UW, tilemap, puertas (dibujo), atributos | 1,5,7 | 789i 36r/29e, 4.4 KB | P01 | P10, P14 |
| P13 | Transiciones: modos 3,4,6,7,9,A,B,C,$10; siguiente sala; fundidos | 1,5,7 | 1035i 105r/88e | P01,P04,P05,P06,P08,P11,P12 | P14,P15,P16,P25 |
| P14 | Puertas (lógica), shutters, secretos, flags de sala, warps, laberintos | 1,4,5,7 | 582i 46r/38e | P01,P02,P05,P06,P10,P12,P13 | — |
| P15 | Cuevas, tiendas, textos, juego de dinero, personas UW, Grumble | 1,4 | 765i 57r/51e | P01,P04,P05,P06,P07,P08,P10,P11 | — |
| P16 | Objetos de mundo: rocas, tumbas, árboles, muelle, bloque, remolino, estanque, alijo | 1,4,5,7 | 756i 44r/36e | P01,P04-P08,P10-P12,P14 | P17 |
| P17 | Base de enemigos: disparos, proyectiles, bolas de fuego, voladores | 1,4 | 656i 57r/41e | P04-P07, P09 | — |
| P18 | Enemigos OW (octorok, moblin, lynel, tektite, leever, peahat, ghini, armos, zora, rocas) | 4 | 709i 43r/40e | P17 y anteriores | — |
| P19 | Enemigos UW A (goriya, darknut, stalfos, gibdo, rope, keese, bubble, zol/gel, pols voice, like like, vire) | 4 | 769i 42r/42e | P17 y anteriores | — |
| P20 | Enemigos UW B (wallmaster, wizzrobes, estatuas, trampas, lamnola) | 1,4 | 886i 47r/38e | P17, P14-P16 | — |
| P21 | Jefes A: Aquamentus, Dodongo, Manhandla, Gohma, Digdogger | 4,5 | 1040i 58r/50e | P17, P09, P14 | — |
| P22 | Jefes B: Gleeok, Moldorm, Patra, Ganon, Zelda, fuegos guardianes | 1,4 | 1276i 86r/59e | P17, P19-P21, P15 | — |
| P23 | Modo 0: título, historia, desfile | 2 | 618i 34r/29e, 3.9 KB | P01,P02,P04,P24 | P10 |
| P24 | Modos 1, D, E, F: ficheros, registro, borrado, guardado, checksums, 2ª misión | 1,2,5 | 1249i 45r/42e | P01, P04 | P11, P16 |
| P25 | Modos 8, $11, $12, $13: continuar, muerte, fin de nivel, final y créditos | 2,5 | 727i 57r/46e | P01,P02,P04,P05,P08,P10-P15,P24 | — |

### Ficheros, rutinas principales y escenarios de oráculo por paquete

Movies existentes (`tests/oracle/movies/`): `power-on-600`, `title-start`, `register-name`,
`walk-first-screens`. Los demás hay que grabarlos (formato `.zmv`, ver `docs/ORACLE.md`); para escenarios
avanzados se parte de una SRAM preparada (`createGame({sram})`) con una partida guardada en el punto
adecuado, generada jugando en el oráculo (no se versiona si contiene datos derivados de la ROM; solo SRAM
del jugador, que es seguro).

**P01 core** — sustituye los stubs `IsrReset`/`IsrNmi` de `src/game/index.js` (punto de entrada de
`src/headless.js` y de la página); `nmi.js`, `boot.js`, `modes/dispatch.js`, `ppu/tilebuf.js`, `ppu/sprite0.js`, `util/int16.js`.
Rutinas: `IsrReset`, `RunGame`, `IsrNmi`, `ReadInputs`/`ReadOneController`, `InitializeGameOrMode`,
`InitMode`, `UpdateMode`, `EndGameMode`/`GoToNextMode`, `SetMMC1Control` (`TableJump` y `SwitchBank` ya
están en `src/core/asm.js`: úsalos, no los dupliques),
`ClearRam`, `InitSaveRam`, `CopyCommonCodeToRam`, `CopyCommonDataToRam`, `TransferCurTileBuf`,
`TransferTileBuf`, `WaitAndScrollToSplitBottom`, `ClearNameTable`, `TurnOffAllVideo`, `HideAllSprites`,
`ResetPpuRegisters`, `ClearAllAudioAndVideo`, `InitMode0/1/2/7` (envoltorios). Oráculo: `power-on-600`
(frames 0‑120 primero: arranque exacto, SRAM, `Random`, timers), `title-start`.

**P02 audio** — `audio/driver.js`, `song.js`, `effects.js`, `samples.js`, `requests.js`. `DriveAudio`,
`DriveSong`, `PlayNextPhrase`, `DriveTune0/1`, `DriveEffect`, `DriveSample`, `Emit*Note`, `VibratePitch`,
`ShapeSongVolume`, `PlayEffect`, `PlaySample`, `SilenceAllSound`. Oráculo: `power-on-600` (canción del
título) + comparar `$600-$61F`, `$66-$6F`, `$5F0-$5F6` y la secuencia de escrituras `$4000-$4017`.
Independiente: puede empezar ya.

**P03 loaders** — `loaders/patterns.js`, `loaders/levelblocks.js`, `modes/mode2-load.js`.
`UpdateMode2Load_Full`, `InitMode2_Sub0/1`, `TransferCommonPatterns`, `TransferDemoPatterns`,
`TransferLevelPatternBlocks`, `TransferPatternBlock_Bank1/2/3`, `FetchPatternBlock*`, `CopyBlock`.
Oráculo: `register-name` (paso por modo 2: CHR‑RAM completa y SRAM `$687E-$6C8F`); después
`enter-level-N` (1..9) y una partida de 2ª misión.

**P04 draw** — `draw/sprites.js`, `draw/anim.js`, `draw/items.js`. `Anim_*`, `DrawObjectMirrored/NotMirrored`,
`DrawObjectWithAnim*`, `AnimateAndDrawMetaObject`, `AnimateObjectWalking`, `HideObjectSprites`,
`WriteBlankPrioritySprites`. Oráculo: OAM `$0200-$02FF` en `walk-first-screens` y salas con enemigos.

**P05 objects** — `modes/mode5-play.js`, `modes/crossroom.js`, `objects/dispatch.js`, `slots.js`,
`metaobject.js`, `roomobjects.js`, `spawnpos.js`, `killcounts.js`. `InitMode5Play`, `UpdateMode5Play`,
`BeginUpdateWorld`, `UpdatePlayer`, `UpdateObject`, `InitObject`, `UpdateMetaObject`, `FindEmptyMonsterSlot`,
`DestroyMonster`, `ResetObjMetastate(AndTimer)`, `CreateRoomObjects`, `AssignObjSpawnPositions`,
`FindNextEdgeSpawnCell`, `ModifyObjCountByHistoryOW/UW`, `SaveKillCountOW/UW`,
`RunCrossRoomTasksAndBeginUpdateMode`. Oráculo: `walk-first-screens` (salas con octoroks), `ow-enemies-spawn`,
`pause-and-menu`, `room-revisit`. Implementar el despacho con todos los tipos en stub y rellenar por familias.

**P06 movement** — `movement/walker.js`, `tiles.js`, `shove.js`, `bounds.js`, `math.js`. `MoveObject`,
`Walker_Move`, `GetCollidableTile`, `GetCollidingTileMoving`, `GetCollidableTileStill`,
`BoundDirectionHorizontally/Vertically`, `Obj_Shove`, `ResetShoveInfo`, `Add/SubQSpeedToPositionFraction`,
`GetDirectionsAndDistancesToTarget`, `CheckScreenEdge`, `SetupObjRoomBounds`, `Abs`, `Negate`,
`GetOppositeDir`, `BoundByRoom`. Oráculo: `walk-first-screens`, `link-knockback`.

**P07 combat** — `combat/collisions.js`, `damage.js`, `link-harm.js`. `CheckMonsterCollisions`,
`CheckLinkCollision(Preinit)`, `Link_BeHarmed`, `BeginShove`, `CheckMonster*Collision`,
`HandleMonsterWeaponCollision`, `DoObjectsCollideWithThresholds`, `GetObjectMiddle`. Oráculo:
`ow-enemies-spawn` (matar con espada, recibir daño), `shield-parry`, `link-knockback`.

**P08 link** — `link/input.js`, `move.js`, `ladder.js`, `anim.js`. `Link_HandleInput`, `Link_FilterInput`,
`SetLinkInputDir`, `MaskInputInBorder`, `Link_ModifyDirOnGridLine`, `Link_ModifyDirInDoorway`,
`Link_EndMoveAndAnimate`, `CheckLadder`, `InitLinkSpeed`, `AnimateLinkObjState`, `AnimateLinkBase`,
`DrawLinkBetweenRooms`. Oráculo: `walk-first-screens`, `ladder-crossing`, `uw-doorways`.

**P09 weapons** — `weapons/sword.js`, `shots.js`, `boomerang.js`, `arrow.js`, `bomb.js`, `fire.js`, `rod.js`,
`flute.js`, `wield.js`. `UpdateSwordOrRod`, `UpdateSwordShotOrMagicShot`, `SpreadShot`,
`UpdateBoomerangOrFood`, `UpdateArrowOrBoomerang`, `UpdateBombOrFire`, `UpdateFire`, `UpdateRodOrArrow`,
`WieldItem` (tabla de 9), `WieldBomb/Candle/Boomerang/Flute/…`, `HandleShotBlocked`. Oráculo: `ow-walk-sword`,
`items-all` (SRAM con todos los objetos), `dark-room-candle`.

**P10 items** — `items/roomitem.js`, `drops.js`, `take.js`, `fairy.js`. `SetUpDroppedItem`, `UpdateItem`,
`TakeItem`, `TryTakeItem`, `TryTakeRoomItem`, `MoveAndDrawRoomItem`, `CheckLiftItem`, `DrawLinkLiftingItem`,
`AnimateItemObject`, `SetUpFairyObject`, `CheckPowerTriforceFanfare`, `GetRoomFlagUWItemState`.
Oráculo: drops en `ow-enemies-spawn`, `take-heart-container`, `triforce-level1`.

**P11 hud** — `hud/statusbar.js`, `submenu.js`, `map.js`, `meters.js`, `text/format.js`. `UpdateMenuAndMeters`,
`UpdateMenu*` (tablas OW/UW), `UpdateSubmenuSelection`, `DrawSubmenuItems`, `UpdatePositionMarker`,
`World_FillHearts`, `World_ChangeRupees`, `FormatHeartsInTextBuf`, `FormatStatusBarText`,
`DrawStatusBarItemsAndEnsureItemSelected`, `ScrollWorld`. Oráculo: `pause-and-menu`, `shop-buy`,
`uw-level1-full` (mapa/brújula).

**P12 layout** — `world/layout.js`, `overworld.js`, `underworld.js`, `doors-draw.js`, `tilemap.js`.
`LayoutRoomOW`, `LayoutRoomOrCaveOW`, `LayoutUWFloor`, `WriteSquareOW/UW`, `FillWalls`, `ChangeTileObjTiles`,
`ChangePlayMapSquareOW`, `CopyColumnToTileBuf`, `CopyRowToTileBuf`, `CheckTileObject`, `CheckShortcut`,
`MapScreenPosToPpuAddr`. Oráculo: `ow-tour` (`PlayAreaTiles` $6530-$67EF y nametables), `uw-level1-full`,
`cave-and-cellar`.

**P13 transitions** — `modes/mode3-unfurl.js`, `mode4-6-enterleave.js`, `mode7-scroll.js`, `mode9-cellar.js`,
`modeA-B-C-cave.js`, `mode10-stairs.js`, `world/nextroom.js`, `ppu/fade.js`. `InitMode3`…`InitMode10`,
`InitMode_EnterRoom`, `InitMode7Submodes`, `UpdateMode7ScrollSubmode`, `UpdateWorldCurtainEffect`,
`CalculateNextRoom*`, `CheckSubroom`, `AnimateWorldFading`, `FillPlayAreaAttrs`, `GetPassedDoorType`.
Oráculo: `register-name` (modo 3), `walk-first-screens` (modos 6/7), `cave-and-cellar`, `uw-level1-full`.

**P14 doors** — `world/doors.js`, `secrets.js`, `roomflags.js`, `warps.js`. `UpdateDoors`, `CheckDoorway`,
`TouchDoor` (tabla de 8), `CheckShutters`, `CheckUnderworldSecrets`, `CheckSecretTrigger*` (tabla de 8),
`CheckWarps`, `CheckMazes`, `GetRoomFlags`, `GetUniqueRoomId`, `FindDoorTypeByDoorBit`,
`PrepareWriteHorizontalDoorTransferRecords`. Oráculo: `uw-level1-full`, `ow-bomb-secret`, `lost-woods-maze`,
`recorder-warp`.

**P15 npc** — `npc/cave.js`, `shop.js`, `textbox.js`, `uwperson.js`, `grumble.js`. `InitCave`,
`UpdateCavePerson` (tabla de 9), `UpdatePersonState_Textbox`, `WritePricesToDynamicTransferBuf`,
`DrawCaveItems`, `UpdateCavePersonState_HintOrMoneyGame`, `InitUnderworldPerson*`, `UpdateUnderworldPerson*`,
`UpdateGrumble`. Oráculo: `cave-and-cellar` (cueva de la espada), `shop-buy`, `money-game`, `uw-old-man-hint`,
`grumble-food`.

**P16 worldobj** — `worldobj/tileobjects.js`, `block.js`, `whirlwind.js`, `pond.js`, `rupeestash.js`.
`CheckPassiveTileObjects`, `CheckTileObjectsBlocking`, `UpdateRockOrGravestone`, `UpdateRockWall`,
`UpdateTree`, `UpdateDock`, `UpdateBlock` (tabla de 3), `FindAndCreatePushBlockObject`, `SummonWhirlwind`,
`UpdateWhirlwind`, `UpdatePondFairy`, `UpdateRupeeStash`. Oráculo: `ow-bracelet-rock`, `recorder-warp`,
`ow-candle-tree`, `raft-dock`, `uw-push-block`.

**P17 enemycore** — `enemies/common.js`, `shots.js`, `flyer.js`. `InitWalker`, `Wanderer_TargetPlayer`,
`_TryShooting`, `Shoot`, `ShootFireball`, `UpdateFireball`, `UpdateMonsterShot`, `UpdateMonsterArrow`,
`MoveShot`, `BounceShot`, `MoveFlyer`, `Flyer_*` (SpeedUp, Chase, Wander, SlowDown, Delay), `TurnTowardsPlayer8`,
`RotateObjectLocation`. Oráculo: octorok disparando en `walk-first-screens`/`ow-enemies-spawn`, `shield-parry`,
`uw-keese-room`.

**P18 enemyow** — `enemies/octorok.js`, `moblin-lynel.js`, `tektite-boulder.js`, `leever.js`, `peahat.js`,
`ghini.js`, `armos.js`, `zora.js`. Oráculo: `ow-enemies-tour` (una sala por tipo).

**P19 enemyuwa** — `enemies/goriya.js`, `darknut.js`, `stalfos-gibdo-rope.js`, `keese-bubble.js`, `zol-gel.js`,
`polsvoice.js`, `likelike.js`, `vire.js`. Oráculo: `uw-level1-full`, `uw-enemies-tour`.

**P20 enemyuwb** — `enemies/wallmaster.js`, `wizzrobe.js`, `statues.js` (`UpdateStatues` se llama desde el bucle
del modo 5), `trap.js`, `lamnola.js`. Oráculo: `uw-enemies-tour`, trampas en `uw-level1-full`.

**P21 bossesa** — `bosses/aquamentus.js`, `dodongo.js`, `manhandla.js`, `gohma.js`, `digdogger.js`.
Oráculo: `boss-aquamentus` (N1), `boss-dodongo` (N2), `boss-manhandla` (N3), `boss-digdogger` (N5, flauta),
`boss-gohma` (N6).

**P22 bossesb** — `bosses/gleeok.js`, `moldorm.js`, `patra.js`, `ganon.js`, `zelda.js` (+ `UpdateGuardFire`,
`UpdateStandingFire`). Oráculo: `boss-moldorm`, `boss-gleeok`, `boss-patra`, `boss-ganon`, `rescue-zelda`.

**P23 title** — `modes/mode0-title.js`, `mode0-story.js`. `InitDemo_*`, `UpdateMode0Demo_*`, `AnimateDemo*`,
`ProcessDemoLineItems/Attrs`, `UpdateWaterfallAnimation`, `UpdateSpritesForWaterfall*`. Oráculo:
`power-on-600` (+ un `title-idle` de 3000 frames para la historia completa), `title-start`.

**P24 files** — `modes/mode1-fileselect.js`, `modeE-register.js`, `modeF-eliminate.js`, `modeD-save.js`,
`save/files.js`. `InitMode1_Full` (tabla de 7), `UpdateMode1Menu`, `InitModeEandF_Full`, `UpdateModeERegister`,
`ModeE_HandleAOrB`, `UpdateModeFElimination`, `UpdateModeDSave_*`, `FormatFileA/B`, `CopyFileBToFileA`,
`CalculateFileAChecksum`. Oráculo: `title-start`, `register-name`, `file-eliminate`, `save-and-continue`
(SRAM completa), `second-quest-name` (ZELDA).

**P25 endings** — `modes/mode8-continue.js`, `mode11-death.js`, `mode12-endlevel.js`, `mode13-ending.js`,
`credits.js`. `InitMode8`, `UpdateMode8ContinueQuestion_Full`, `InitMode11`, `UpdateMode11Death_*` (13),
`InitMode12`, `UpdateMode12EndLevel_*` (5), `InitMode13_*`, `UpdateMode13WinGame_*`, `UpdateZeldaTextbox`,
`UpdatePeaceTextbox`, `DrawCredits`. Oráculo: `death-continue`, `triforce-level1`, `ending-from-ganon`.

---

## 5. Orden de implementación

Grafo de dependencias reducido (A → B = A llama a B; se porta B antes). Las flechas hacia oleadas
posteriores se resuelven con stubs.

```
Oleada 1 (base, en paralelo):  P02 audio   P04 draw   P01 core ──► P03 loaders
                                   │          │          │
Oleada 2 (frontend):           P24 files ◄── P23 title ──┘        → objetivo: title-start, register-name hasta modo 2/3
                                   │
Oleada 3 (mundo jugable):      P12 layout ─► P06 movement ─► P08 link ─► P13 transitions ─► P11 hud ─► P05 objects
                                                                     → objetivo: walk-first-screens con diff 0 (stubs de enemigos)
Oleada 4 (interacción):        P07 combat, P09 weapons, P10 items, P14 doors, P16 worldobj, P15 npc
Oleada 5 (enemigos):           P17 enemycore ─► P18 enemyow, P19 enemyuwa, P20 enemyuwb
Oleada 6 (jefes y final):      P21 bossesa ─► P22 bossesb ;  P25 endings
```

Orden topológico recomendado (con paralelismo dentro de cada oleada):
1. **P01, P02, P04** en paralelo; **P03** en cuanto P01 tenga `TransferTileBuf`/`SwitchBank`.
2. **P23, P24** (con stubs a P10/P11/P16 para los iconos del menú).
3. **P12 → P06 → P08 → P13 → P11 → P05** (P12 y P06 pueden ir en paralelo; P05 integra la oleada).
4. **P07, P14, P10** primero (las usan las demás), luego **P09, P16, P15**.
5. **P17**, luego **P18, P19, P20** en paralelo.
6. **P21 → P22**, **P25** en paralelo.

### Rutinas compartidas que deben portarse primero (API estable)
Por número de paquetes que las llaman (`ROUTINES.json → sharedRoutines`):
`TableJump` (18 paquetes), `Anim_FetchObjPosForSpriteDescriptor` (13), `Abs` (11),
`Anim_SetSpriteDescriptorAttributes` (10), `DrawObjectNotMirrored` (9), `GetOppositeDir` (8),
`CheckLinkCollision` (8), `SwitchBank` (7), `CheckMonsterCollisions` (7), `DrawObjectMirrored` (7),
`MoveObject` (7), `Anim_AdvanceAnimCounterAndSetObjPosForSpriteDescriptor` (7), `GetRoomFlags` (6),
`EndGameMode` (6), `ResetShoveInfo` (6), `DestroyMonster` (6), `FindEmptyMonsterSlot` (6),
`TurnOffAllVideo`, `GetCollidingTileMoving`, `GetRoomFlagUWItemState`, `BeginUpdateMode`, `Negate`,
`GetUniqueRoomId`, `GetCollidableTileStill`, `HideAllSprites`, `ResetObjMetastate`, `PlaySample`,
`PlayEffect`, `ShootFireball`, `Flyer_*`, `MoveFlyer`, `InitWalker`, `Obj_Shove`, `GetObjectMiddle`.
Las de P04/P06/P07 se adelantan en su oleada aunque el resto del paquete vaya después: el porteador de P07
publica primero `CheckLinkCollision`/`CheckMonsterCollisions`, etc.

### Riesgos y notas
* **Rutinas sin referencias** (`unreferenced`, p. ej. `Unused_*`, `SplitRoomId`,
  `EmitSquareNoteWithDutyAndSweep0/1`): no hace falta portarlas salvo que una tabla las use.
* **Bloques `unverified`** (41, marcados en el asm): portarlos con especial cuidado y escenario propio.
* **Código como dato** (`codeAsData`) y tablas `.ADDR` no despachadas por `TableJump` (`addrTableTargets`):
  revisar en `data[]` antes de portar.
* **Dos copias de rutinas** (`_Bank1`, `_Bank4`, `_Local1`…): el original duplica utilidades por banco; en
  JS se puede compartir la implementación si el efecto en RAM es idéntico, conservando ambos nombres.
* La ROM de referencia es **PRG0** (coincide con el desensamblado). No se asume otra revisión.
