# Versión Android

La app Android es una sola Activity con un WebView a pantalla completa que ejecuta **el mismo juego web**
(`src/`, modo de temporización `hardware`) más una capa de plataforma para el móvil (`android/web/`). No usa
Capacitor ni Cordova: el proyecto Gradle es nativo y mínimo (Kotlin, AndroidX `core`, `activity` y `webkit`).

**El APK lleva la ROM del usuario dentro.** Se construye en el ordenador con tu ROM en `roms/zelda.nes`
(validada: USA PRG0) y en el móvil el juego arranca directamente, sin pedir nada. Por eso
`dist/zelda1-js.apk` es **solo para uso propio**: no se debe compartir ni subir a ningún sitio (contiene el
juego). La ROM nunca entra en git: se empaqueta desde una carpeta de build ignorada (ver *ROM*).

## Estructura

```
android/
  settings.gradle.kts, build.gradle.kts, gradle.properties   AGP 8.13.1, Kotlin 2.2.21, Gradle 8.14 (wrapper)
  gradlew, gradlew.bat, gradle/wrapper/                     wrapper estándar (con distributionSha256Sum)
  app/build.gradle.kts         applicationId io.github.joelruvira.zelda1js, minSdk 26, target/compile 36
  app/src/main/AndroidManifest.xml
  app/src/main/java/io/github/joelruvira/zelda1js/
    MainActivity.kt            WebView, WebViewAssetLoader, inmersivo, ciclo de vida, Atrás, selector de ROM (respaldo)
    NativeBridge.kt            window.ZeldaNative (@JavascriptInterface)
    AppStorage.kt              SRAM (y la ROM de respaldo) en el almacenamiento interno privado
    GamepadInput.kt            mandos físicos (KeyEvent/MotionEvent) -> byte de botones NES
  app/src/main/res/            icono adaptativo (vector, espada pixel art original), tema, reglas de backup
  web/                         la capa móvil del juego (HTML/JS/CSS), también ejecutable en un navegador
    index.html, app.css, app.js   arranque, pantallas (ROM, pausa), escalado, audio, pausa/reanudación
    touch.js                   controles táctiles (geometría y dedos -> bits, funciones puras + overlay)
    screen.js                  escalado entero en píxeles físicos
    native.js                  puente con Android (con alternativas de navegador para desarrollo)
    romcheck.js                validación de la ROM (loadRom + SHA-1 PRG0 + checkRevision)
    selftest.html, selftest.js prueba píxel a píxel (solo en el APK debug)
scripts/android/
  copy-web.mjs                 copia src/ y android/web/ a los assets (lo ejecuta Gradle en cada build)
  rom-asset.mjs                valida roms/zelda.nes (USA PRG0) y la deja en la carpeta de build de la ROM
  build.mjs, install.mjs       npm run android:build / android:install
  keystore.mjs                 crea la clave de firma local
  device-test.mjs, cdp.mjs     prueba de extremo a extremo (emulador/móvil por adb, o Chrome de escritorio)
tests/android/                 pruebas sin emulador (npm test) y la de dispositivo (ANDROID=1)
```

Los assets **no están en git**: `copy-web.mjs` genera `android/app/src/main/assets/www/` (el juego, 172
archivos, más `LICENSE.txt` y `files.json` con el SHA-256 de cada archivo) y `android/app/src/debug/assets/www/`
(la prueba y las películas de `tests/oracle/movies`). Mantienen la estructura del repo, así que
`android/web/app.js` importa `../../src/session.js` igual en el APK que con `npm run serve`. `copy-web.mjs`
nunca copia una ROM a esas carpetas (se niega). La ROM va aparte: `rom-asset.mjs` (tarea Gradle `packRom`,
antes de cada build) la escribe solo en `android/app/build/generated/zelda-rom/assets/rom/zelda.nes`, carpeta
de build ignorada por git que Gradle añade como assets; en el APK queda en `assets/rom/zelda.nes`.

## Comandos

```
npm run android:build              ROM + assets + assembleRelease -> dist/zelda1-js.apk
npm run android:build -- --debug | --debug-only   además (o solo) el APK debug, para las pruebas de dispositivo
npm run android:install            adb install -r dist/zelda1-js.apk   (-- --debug: el APK debug)
npm run android:assets             solo copiar los assets
npm run android:device-test        prueba de extremo a extremo en el emulador/móvil (APK debug)
node scripts/android/device-test.mjs --browser [--movies all]   la misma prueba en Chrome de escritorio
ANDROID=1 node --test tests/android/device.test.mjs              la prueba de dispositivo desde node --test
```

Salida: un único `dist/zelda1-js.apk` (release firmado con tu ROM dentro, ~0,6 MB). Con `--debug`, además
`dist/zelda1-js-debug.apk` (con `.debug` en el applicationId: se instala junto al release, con sus propios
datos; lleva la autoprueba y las DevTools del WebView activadas; también lleva la ROM). Si `roms/zelda.nes`
falta o no es la USA PRG0, el build se para con un mensaje en español antes de llamar a Gradle (y la tarea
`packRom` falla igual si se ejecuta Gradle directamente). El build es reproducible: las mismas fuentes y la misma clave dan el mismo
APK byte a byte (sin `vcsInfo`, sin bloque de dependencias, `files.json` sin fechas).

Requisitos: Node 22+, el SDK de Android (Android Studio o command-line tools; se busca en
`local.properties`, `$ANDROID_HOME`, `~/Library/Android/sdk`, `~/Android/Sdk` o `%LOCALAPPDATA%\Android\Sdk`
y se escribe `android/local.properties`) y un JDK 17+ (`JAVA_HOME`, `java` en el PATH o el JBR de Android
Studio). Gradle, AGP y las dependencias se descargan de services.gradle.org, Google Maven y Maven Central.

## Firma

`npm run android:build` crea la primera vez `android/keystore/release.jks` (PKCS12, RSA 4096, alias
`zelda1js`) y `android/keystore/keystore.properties` con una contraseña aleatoria. La carpeta está en
`.gitignore`. **Guarda una copia**: Android solo instala una actualización encima si está firmada con la misma
clave. Para regenerarla (clave nueva): borra `android/keystore/` y vuelve a ejecutar `npm run android:build`
(o `node scripts/android/keystore.mjs`); en el móvil habrá que desinstalar la versión anterior (se pierden las
partidas de esa instalación). Sin clave, Gradle genera el release sin firmar.

## Cómo funciona

### Carga

`MainActivity` carga `https://appassets.androidplatform.net/assets/www/android/web/index.html` con
`WebViewAssetLoader` (origen https: los módulos ES, `fetch`, `crypto.subtle` y el AudioWorklet funcionan como
en la web). La ROM empaquetada está en `/assets/rom/zelda.nes`; `/native/rom/zelda.nes` y
`/native/rom/candidate.nes` (solo el respaldo) se sirven desde el almacenamiento interno.
Cualquier otra petición o navegación se bloquea (404): la app no usa red ni pide permisos salvo `VIBRATE`.

### Juego

`src/session.js` (compartido con `src/main.js`, que solo se ha reorganizado para usarlo) arranca la máquina
igual que la página web: `checkRevision`, `createMachine`, SRAM, `createGameLogic`, rastreador de ciclos en
modo `hardware`, `IsrReset`. El bucle es `core/loop.js`: cuenta frames por tiempo real (60,0988 por segundo)
con un acumulador, así que una pantalla de 90/120 Hz no acelera el juego. La capa Android le pasa como reloj
la marca de vsync de `requestAnimationFrame` en lugar de `performance.now()`, para que la cadencia no tenga
saltos por el retraso de cada callback (`tests/android/loop-rate.test.mjs` lo comprueba a 60/90/120/144 Hz).

### Imagen

`screen.js` calcula el escalado en **píxeles físicos**: el mayor múltiplo entero que cabe (6x en
3120x1440: 1536x1440), centrado, fondo negro, `image-rendering: pixelated`, relación de aspecto de píxel 1:1
como la web. Como `innerWidth/innerHeight` vienen redondeados (411 en vez de 411,43 CSS px), Android envía
el tamaño exacto del WebView en píxeles. En el menú se puede cambiar a *pantalla completa* (escala no entera).

### Controles táctiles

Un único elemento cubre la pantalla y recibe todos los punteros (`pointer events`, `touch-action: none`,
`passive: false`; sin retraso de 300 ms, zoom, selección ni menú contextual). Cada dedo se asigna a una zona
al tocar (cruceta si está en la mitad izquierda, botones en la derecha, Select, Start, menú) y sus botones se
recalculan en cada movimiento: deslizar cambia de dirección o pasa de B a A sin levantar el dedo. Cruceta de 8
direcciones en sectores de 45° con zona muerta del 22 % del radio; A y B tienen un radio de acierto 1,3 veces
el dibujado, que se solapa en el centro para pulsar los dos. El resultado se ORea con teclado y mandos en
`Input.virtual` (`src/core/input.js`, nueva fuente "virtual"). Vibración corta en cada pulsación nueva
(`EFFECT_CLICK`/`EFFECT_TICK`, respeta el ajuste de vibración táctil del sistema; se puede quitar en el menú).
Las zonas de la cruceta y los botones se excluyen del gesto de Atrás del sistema
(`systemGestureExclusionRects`). El recorte de cámara (display cutout) se envía a la página para no poner
controles debajo.

### Mandos

`GamepadInput.kt` intercepta los eventos de mando (fuente GAMEPAD/JOYSTICK/DPAD) antes que el WebView y envía
el byte de botones con `ZeldaApp.onPad(bits)`. Mapeo igual que el de la web: A/Y -> A, B/X -> B, Start,
Select, cruceta, hat y stick izquierdo (umbral 0,5); el botón Mode/Menú abre la pausa. Los controles táctiles
se ocultan al conectar o usar un mando o un teclado y reaparecen al tocar la pantalla. Un teclado físico
funciona con las mismas teclas que la web (Escape abre la pausa).

### Atrás, pausa y ciclo de vida

Atrás (`OnBackPressedDispatcher`, compatible con el gesto predictivo de Android 16) llama a
`ZeldaApp.onBack()`: abre o cierra el menú de pausa (Continuar / Vibración / Imagen / Salir; en Android no
hay *Cambiar ROM*: la ROM es la del APK). En la pantalla de ROM de respaldo, Atrás cierra la app. `onPause`/`visibilitychange` paran el bucle,
suspenden el `AudioContext` y guardan la SRAM; `onResume` lo reanuda (el acumulador se reinicia: no hay
ráfaga de frames). Pantalla siempre encendida mientras se juega (`FLAG_KEEP_SCREEN_ON`, se quita en el menú).
Al pasar a segundo plano se sueltan todos los botones (táctiles, mando y teclado), porque el "soltar" de una
tecla mantenida no llegaría nunca. Orientación `sensorLandscape`, inmersivo
(`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`), cutout `ALWAYS`; los cambios de configuración (incluidos idioma,
tamaño de fuente, modo oscuro y teclado) no recrean la Activity. Si el sistema mata el proceso del renderer
del WebView en segundo plano (memoria), `onRenderProcessGone` recrea la Activity con un WebView nuevo en vez
de cerrar la app (la SRAM ya se guardó al pausar).

### Audio

`src/audio` sin cambios (AudioWorklet). `mediaPlaybackRequiresUserGesture = false` y además se desbloquea
con el primer toque o tecla. Cola de 3 frames (máximo 8) en vez de los 2 de escritorio, porque los callbacks
de audio de los móviles son más gruesos.

### ROM

`npm run android:build` (y la tarea Gradle `packRom`) valida `roms/zelda.nes` con `romcheck.js` (cabecera
iNES, mapper 1, 8x16 KB PRG, CHR-RAM, SHA-1 del PRG = `a12d74c73a0481599a5d832361d168f4737bbcf6`; si no
coincide, las huellas por banco del desensamblado distinguen "otra versión de Zelda" de "otro juego") y la
mete en el APK (`assets/rom/zelda.nes`). Al arrancar, la página la vuelve a validar y empieza el juego sin
ninguna pantalla. **Ese APK contiene el juego: es solo para uso propio, no se comparte ni se sube a ningún
sitio.**

La ROM no puede acabar en git: `copy-web.mjs` se niega a copiar ROMs a `src/main/assets`, la ROM empaquetada
vive en `android/app/build/` (ignorada) y `tests/android/rom-packaging.test.mjs` comprueba que ningún archivo
versionado (o que se pudiera añadir) es una ROM o contiene la cabecera iNES, que `.gitignore` cubre la ROM, los
assets generados, los APK y la clave, y que el `dist/zelda1-js.apk` construido sí lleva la ROM válida.

Respaldo (no debería verse): si la ROM del APK faltara o no pasara la validación, la página usa una ROM guardada
de una instalación anterior (`files/rom/zelda.nes`) o muestra la pantalla *Elige tu ROM de The Legend of Zelda
(USA, PRG0)*, que abre el selector del sistema (`ACTION_OPEN_DOCUMENT`, sin permisos); Kotlin copia el
documento a `files/rom/candidate.nes` (máx. 1 MiB), la página lo valida y solo entonces se renombra a
`files/rom/zelda.nes`. En un navegador de escritorio (`npm run serve`) esa pantalla es la forma de cargar la ROM.

### Partidas

La SRAM (8 KB) se guarda en `files/save/sram.bin` con `AtomicFile` (escritura a temporal, `fsync`, rename):
la página la compara cada 500 ms y la escribe solo si cambió (en una partida normal cambia cada pocos
segundos, al cambiar de pantalla), y además al pausar, al ir a segundo plano y al salir. Las copias de
seguridad de Android incluyen `save/` pero nunca `rom/`.

## Pruebas

- `npm test` incluye `tests/android/`: geometría y mapeo táctil, escalado, assets (todo lo que importa la
  página está, la autoprueba solo en debug, ninguna ROM en `www/`, huella reproducible), parser de películas,
  validación de ROM, empaquetado de la ROM y git sin ROMs (`rom-packaging.test.mjs`) y velocidad del bucle a
  distintas frecuencias de pantalla (y que pausar/reanudar no duplica la cadena de `requestAnimationFrame`).
- `scripts/android/device-test.mjs` (APK debug, `npm run android:build -- --debug`, emulador o móvil por adb;
  o `--browser` en Chrome de escritorio emulando el móvil): en el móvil, el juego arranca con la ROM del APK
  sin pantalla de ROM; en el navegador, pantalla de ROM, archivo erróneo rechazado y ROM elegida; título, escalado entero y nitidez (cada píxel NES es un bloque exacto en la captura), Start /
  A / Select táctiles para registrar un nombre y empezar, cruceta y deslizamiento, multitouch (diagonal + B,
  deslizar entre B y A), menú de Atrás, segundo plano, partida tras matar la app, velocidad real, y la
  autoprueba: las películas de `tests/oracle/movies` reproducidas dentro del WebView deben dar el mismo hash
  que Node en cada frame (imagen en índices de color, RAM y SRAM por frame lógico, e imagen RGBA de cada frame
  de vídeo por el mismo camino que la app). Capturas y `results.json` en `out/android-test/`.
- En el APK debug, `adb shell am start -n io.github.joelruvira.zelda1js.debug/io.github.joelruvira.zelda1js.MainActivity --es selftest all`
  ejecuta la autoprueba; los resultados quedan en `files/selftest/` (`adb shell run-as … cat`).

Emulador recomendado: system image `android-36.1` arm64, 1440x3120 a 560 dpi (como un S26 Ultra):

```
avdmanager create avd -n zelda_s26 -k "system-images;android-36.1;google_apis_playstore;arm64-v8a" -d pixel_7_pro
# en ~/.android/avd/zelda_s26.avd/config.ini: hw.lcd.width=1440, hw.lcd.height=3120, hw.lcd.density=560
emulator -avd zelda_s26 -no-window -no-audio -gpu swiftshader_indirect
```
