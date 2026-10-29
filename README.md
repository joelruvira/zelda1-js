<p align="center">
  <img src="docs/assets/icon.svg" width="96" alt="">
</p>

<h1 align="center">zelda1-js</h1>

<p align="center">The Legend of Zelda (NES, 1986) reescrito en JavaScript para jugar en el navegador.</p>

---

Cada rutina del juego original se ha traducido una a una y se compara frame a frame con el juego real ejecutándose en un emulador. El objetivo es que sea idéntico: mismos gráficos, misma música, mismo comportamiento.

**Estado:** en desarrollo. Ya funcionan el título, el menú de partidas, todo el mundo exterior y los enemigos de las mazmorras. Los jefes, Ganon y el final están en camino.

## Cómo jugar

No hace falta saber programar. Son cinco pasos y solo se hacen una vez.

### 1. Instala Node.js

Entra en [nodejs.org](https://nodejs.org), descarga la versión que pone **LTS** e instálala como cualquier otro programa, aceptando las opciones que vienen marcadas.

### 2. Descarga el juego

En esta página, pulsa el botón verde **Code** y luego **Download ZIP**. Descomprime el archivo donde quieras, por ejemplo en el Escritorio. Te quedará una carpeta llamada `zelda1-js-main`.

### 3. Pon tu ROM

El juego necesita tu copia de *The Legend of Zelda* para la NES, versión **USA (PRG0)**, en formato `.nes`. Este proyecto no la incluye.

Renómbrala a `zelda.nes` y métela en la carpeta `roms` que hay dentro de `zelda1-js-main`.

En Windows, si el archivo ya se ve como `zelda.nes`, escribe solo `zelda` al renombrarlo. Windows oculta la extensión y, si la vuelves a poner, el archivo acaba llamándose `zelda.nes.nes`.

### 4. Abre una terminal en la carpeta

- **Mac:** abre la aplicación **Terminal** (búscala con Cmd + Espacio). Escribe `cd` seguido de un espacio, arrastra la carpeta `zelda1-js-main` a la ventana y pulsa Enter.
- **Windows:** abre la carpeta `zelda1-js-main`, haz clic en la barra de direcciones de arriba, escribe `cmd` y pulsa Enter.

### 5. Arranca el juego

Escribe esto en la terminal y pulsa Enter:

```
npm start
```

El navegador se abrirá solo con el juego. Pulsa cualquier tecla para que empiece a sonar la música.

Para cerrar el juego, cierra la terminal. Para volver a jugar otro día, repite solo los pasos 4 y 5.

## Controles

| Teclado | Mando de NES |
|---|---|
| Flechas | Cruceta |
| X | A |
| Z | B |
| Enter | Start |
| Espacio | Select |

También funciona con un mando conectado al ordenador.

**Para empezar una partida:** en el menú pulsa Espacio hasta llegar a *Register your name* y pulsa Enter. Elige las letras con las flechas y escríbelas con X. Pulsa Espacio hasta llegar a *End* y luego Enter. Ya puedes elegir tu partida y pulsar Start.

## Partidas guardadas

Se guardan solas en el navegador, igual que en el cartucho original. Juega siempre desde el mismo navegador para no perderlas.

---

<sub>The Legend of Zelda es una marca de Nintendo. Proyecto de fans sin ánimo de lucro y sin relación con Nintendo. Este repositorio no contiene ningún dato del juego original.</sub>
