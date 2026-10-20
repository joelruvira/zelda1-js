# Zelda 1 (NES) — Port fiel a JavaScript

## Objetivo
Reimplementar The Legend of Zelda (NES, 1986) completo en JavaScript para navegador, idéntico al original
(lógica, timing a nivel de frame, gráficos y audio). El repositorio NO contiene ningún asset de Nintendo:
gráficos, mapas, textos y música se leen en tiempo de ejecución de la ROM `.nes` que aporta el usuario.

## Fuente de verdad
- `reference/zelda1-disassembly/` (desensamblado comentado de A. Nuñez, no se versiona).
  - `src/Z_00..Z_07.asm` = los 8 bancos PRG de 16 KB (MMC1). Z_07 es el banco fijo.
  - `src/Variables.inc`, `ObjVars.inc`, `CommonVars.inc`, `CaveVars.inc`, `BeginEndVars.inc` = mapa de RAM.
  - `src/bins.xml` = offsets de los bloques de datos dentro de la ROM.
- El juego original ejecutado en un emulador (jsnes, en Node) = **oráculo** para las revisiones.

## Estrategia: port rutina a rutina con RAM espejo
1. El estado del juego vive en un `Uint8Array` de 2 KB con **las mismas direcciones que la RAM de la NES**
   (más 8 KB de SRAM para las partidas guardadas). Cada variable tiene nombre (generado desde los `.inc`).
2. Cada rutina del ensamblador se traduce a una función JS con el mismo nombre, en un módulo por banco/subsistema.
   Como el estado está en las mismas direcciones, **en cada frame se puede comparar la RAM del port con la del juego original**.
3. Escrituras de vídeo: el juego escribe en buffers de transferencia y la NMI los vuelca en la VRAM. Portamos la NMI tal cual
   sobre un modelo de VRAM/OAM/paleta/CHR-RAM, y un renderizador de PPU dibuja el frame (incluida la división
   del HUD con el sprite 0). Esto permite comparar pantallas píxel a píxel con el emulador.
4. Audio: el motor de sonido (Z_00) se porta tal cual y escribe en un APU emulado (pulso ×2, triángulo, ruido y DMC) en un AudioWorklet.

## Fases (cada fase la ejecuta un pool de agentes y termina con una revisión contra el oráculo)
| Fase | Agentes | Entregable |
|---|---|---|
| 1. Base | Arquitecto, APU, Oráculo, Mapa del port | ROM loader, RAM, PPU, bucle principal, APU, harness de comparación y plan de paquetes de trabajo |
| 2. Núcleo | Programadores por subsistema + revisor | NMI, modos de juego, reset/título/menú de archivos |
| 3. Mundo | Programadores + agente de niveles | Overworld, mazmorras, scroll, cuevas, tiendas, textos, puertas y secretos |
| 4. Link y objetos | Programadores + revisor | Link, armas, objetos y colisiones |
| 5. Enemigos y jefes | Programadores (uno por familia) + revisor | Toda la IA, incluidos los jefes y Ganon |
| 6. Audio, final y 2ª misión | Programadores + revisor | Música, efectos, créditos, segunda misión y guardado |
| 7. Verificación total | Revisores | Partidas grabadas reproducidas en el original y en el port, diff de RAM por frame y diff de píxeles |

## Reglas
- Nada de Nintendo en el repo (`roms/` y `reference/` están en `.gitignore`).
- Toda rutina portada indica en un comentario el nombre de la rutina original.
- Una rutina no se da por terminada hasta que su diff de RAM contra el oráculo es 0 en las pruebas.
