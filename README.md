# zelda1-js

Port rutina a rutina de **The Legend of Zelda** (NES, 1986) a JavaScript, para jugar en el navegador.
Cada rutina 6502 del original se traduce a una función JavaScript con el mismo nombre. El estado del juego
vive en las mismas direcciones de RAM que en la NES, así que el port se compara frame a frame con el
original ejecutándose en un emulador: la RAM, la RAM de guardado y la imagen tienen que coincidir.

> **En desarrollo.** El título, la historia, el menú de partidas y el registro de nombre están completos y
> coinciden con el original. El overworld, las mazmorras, Link, los enemigos y los jefes se están portando.
> El progreso está en [`docs/PLAN.md`](docs/PLAN.md) y [`docs/PORT_MAP.md`](docs/PORT_MAP.md).

## Este repositorio no contiene datos de Nintendo

Necesitas **tu propia** ROM del juego: *The Legend of Zelda (USA) (PRG0)*, iNES, 128 KB de PRG con CHR-RAM.
Los gráficos, mapas, textos y música se leen de ella al ejecutar. El repositorio no incluye la ROM, ni
gráficos, ni música, ni tablas de datos copiadas del juego.

## Jugar

```sh
npm start          # servidor local en http://localhost:8080 que abre el navegador
```

Pon tu ROM en `roms/zelda.nes` (ignorada por git) y se carga sola. También puedes arrastrarla a la página.

| Tecla | Botón NES |
|---|---|
| Flechas | Cruceta |
| X | A |
| Z | B |
| Enter | Start |
| Shift / Espacio / Tab | Select |
| W A S D, G, F, T, R | Mando 2 |

Las partidas se guardan en el navegador, igual que las guarda la memoria con pila del cartucho.

## Cómo está hecho

- `src/core/`: carga de la ROM, RAM con la distribución de la NES, renderizador de la PPU, MMC1, mandos, bucle a 60,0988 Hz.
- `src/audio/`: APU con precisión de ciclo (pulsos, triángulo, ruido, DMC) en un AudioWorklet.
- `src/game/`: el juego portado, una función JS por cada rutina original.
- `tools/oracle/`: ejecuta la ROM original en jsnes y compara el port con ella frame a frame.
- `tests/`: `npm test` (los tests que necesitan la ROM se saltan si no está).

La referencia del port es el desensamblado comentado de A. Nuñez
([aldonunez/zelda1-disassembly](https://github.com/aldonunez/zelda1-disassembly)), clonado en `reference/`
(no versionado).

*The Legend of Zelda* es una marca de Nintendo. Este es un proyecto de fans sin ánimo de lucro, sin
relación con Nintendo ni respaldado por ella.
