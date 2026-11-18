# Prompt maestro para regenerar el editor de video

Pega el siguiente prompt en cualquier modelo de IA (GPT, Claude, Gemini, etc.) para que genere un editor de video equivalente al `editor-video.html`. El prompt captura la arquitectura, las decisiones de diseño no obvias y las trampas que costó detectar.

---

## Prompt a ejecutar

Construye un **editor de video no-lineal** que funcione enteramente en el navegador, en **un único archivo HTML autónomo** (todo el CSS y JS inline, sin build step, sin dependencias locales). El resultado debe abrirse con doble clic en cualquier navegador moderno y trabajar 100% en el cliente.

### Requisitos funcionales

El editor debe permitir, sobre videos que el usuario arrastra o selecciona desde su disco:

1. **Línea de tiempo multi-clip**: importa uno o varios videos; cada video genera un clip. Ordena, divide, duplica, copia/pega, corta y borra clips. Arrastra clips para reordenarlos. Redimensiona (trim) los bordes de cada clip con handles laterales.
2. **Preview en canvas**: un `<canvas>` muestra el frame actual en tiempo real, con play/pause/seek, línea de tiempo con ruler, y playhead arrastrable.
3. **Transiciones entre clips** (no solapadas): cada transición ocupa su **propio slot temporal** entre dos clips, no se solapan con el contenido.
   - **Entrada del proyecto** (`in`): transición antes del primer clip.
   - **Cross** entre clip i e i+1: un strip entre ambos.
   - **Salida del proyecto** (`out`): transición después del último clip.
   - Tipos disponibles (mismo set para in/out y cross): `none, crossfade, fade-black, fade-white, fade-in, wipe-left, wipe-right, wipe-up, wipe-down, slide-left, slide-right, slide-up, slide-down, zoom-in, zoom-out`.
   - Duración configurable de 0 a 5 s (step 0.1). `type=none` => corte seco (strip de ancho cero, marcador vertical).
4. **Overlay de texto** por clip: contenido, color, tamaño, opacidad, posición (`top-center`, `top-left`, etc.), fondo (none/shadow/solid), y ventana temporal opcional (`start` + `duration`; `duration=0` significa "todo el clip").
5. **Stickers** (emoji) por clip: lista fija de ~48 emojis; cada sticker tiene posición (x/y en %), tamaño, opacidad, rotación, y ventana temporal opcional (igual semántica que el texto).
6. **Filtros** por clip (CSS filter string): brightness, contrast, saturate, hue, blur, grayscale, sepia, invert — con sliders y presets (none, grayscale, sepia, invert, vintage, cool, warm, vivid).
7. **Transform** por clip: rotación, flipH, flipV, escala, posX, posY.
8. **Audio** por clip: volumen (0–200%), fadeIn, fadeOut (0–10 s).
9. **Velocidad** por clip (0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x) y velocidad global.
10. **Zoom** de la timeline (0.1x a 4x) con scroll horizontal y wheel-zoom (Ctrl/Cmd+rueda) **anclado al cursor**.
11. **Thumbnails**: cada clip muestra varios frames miniatura en la timeline, generados con seeking de un `<video>` oculto. Caché por clip, invalidada al cambiar trim/filtros/transform.
12. **Guardar/Cargar proyecto** a JSON, y **autoguardado** en `localStorage` con recuperación al reabrir. Versionado del formato (`PROJECT_VERSION`).
13. **Exportación** a video:
    - Renderiza el timeline frame a frame sobre un canvas + `captureStream()` + `MediaRecorder` => `.webm` (con audio mezclado vía `AudioContext` + `MediaStreamDestination`).
    - Conversión opcional a `.mp4` vía `ffmpeg.wasm` cargado desde CDN (unpkg `@ffmpeg/ffmpeg@0.10.1`).
    - Modal de progreso con botón **Cancelar** que cierra el modal y resetea la UI.

### Arquitectura técnica (CRÍTICO — no desviarse)

- **Modelo de transición no solapada**: el tiempo total del proyecto = suma de duraciones de clips + suma de duraciones de strips de transición. Un clip no se solapa con su vecino; el strip vive entre ambos. `clipAtTime(t)` debe resolver, dado un tiempo absoluto, qué entidad está activa: `{kind:'in'}`, `{kind:'clip', clip, offset}` (offset = segundos dentro del clip), `{kind:'cross', a, b, linkIdx}` (crossover activo), o `{kind:'out'}`. Durante un cross, se renderizan AMBOS clips simultáneamente con un `progress` 0→1 y se aplica el efecto de transición.
- **Frames de borde para crossfade**: captura el último frame del clip A y el primero del clip B al `sourceTime` exacto del corte, guárdalos en un canvas cacheado (`frameCache` por clip). Si los videos reales no decodifican a tiempo durante el export, usa esos frames cacheados como fallback para que el crossfade nunca se vea negro. La **clave de caché** debe incluir `sourceStart, sourceEnd, speed` pero NO filtros/transform (esos se aplican al draw, no se cuecean).
- **Selección de transición por índice**: los IDs de link se generan por **índice** del clip (`in-0`, `cross-i`, `out-<lastIdx>`). Cualquier operación que cambie el orden o el número de clips (delete, split, reorder, paste) **debe** resetear `selectedLinkId` y `activeClipId`, porque tras el cambio ese índice apunta a otra pareja.
- **Estado global**: un objeto `state` con `sources[]` (cada uno `{id, fileName, el: <video>, duration, fileHash}`), `clips[]` (con la forma de abajo), y los selectores (`selectedClipId, selectedLinkId, selectedStickerIdx, activeClipId`), más caches (`thumbCache, frameCache, thumbBusy`).
- **Forma de un clip** (default):
  ```js
  {
    id, sourceId, name,
    sourceStart, sourceEnd,     // en tiempo del video fuente
    filters: { brightness:100, contrast:100, saturate:100, hue:0, blur:0, grayscale:0, sepia:0, invert:0 },
    transform: { rotate:0, flipH:false, flipV:false, scale:100, posX:0, posY:0 },
    text: { content:'', color:'#ffffff', size:32, opacity:100, position:'top-center', bg:'none', start:0, duration:0 },
    stickers: [],              // [{emoji,x,y,size,opacity,rotation,start,duration}]
    transitions: { inType:'none', inDur:0.5, outType:'none', outDur:0.5 },
    crossTransition: { type:'none', duration:0 },  // solapamiento con el SIGUIENTE clip
    audio: { volume:100, fadeIn:0, fadeOut:0 },
    speed: 1
  }
  ```

### Bugs que costó detectar — IMPLEMENTA ESTAS REGLAS DESDE EL INICIO

1. **Zoom anchor**: al hacer zoom, el tiempo bajo el cursor (o bajo el borde izquierdo del scroll) debe quedarse fijo. El error típico es calcular `oldPps = clientWidth / total / oldZoom` cuando debería ser `clientWidth / total * oldZoom` (porque `pxPerSecond() = (clientWidth/total) * zoom`). Captura `oldPps` con la fórmula **multiplicando** antes de mutar `state.zoom`, y úsala para `(a) anchorX = oldScroll / oldPps` y `(b) newScroll = anchorX * newPps - (anchorX * oldPps - oldScroll)`. El bug es invisible a zoom=1 (1²=1) y salta a cualquier otro zoom.

2. **splitAtPlayhead** debe, al dividir un clip en left/right:
   - **left** conserva `transitions.in`, pierde `transitions.out` y pierde `crossTransition` (el split es un corte seco, no funde con el right).
   - **right** conserva `transitions.out` y `crossTransition` (es el que ahora es adyacente al siguiente clip real), pierde `transitions.in`.
   - Las ventanas temporales de `text` y `stickers[]` del right se desplazan por `-offset` (donde offset = tiempo dentro del clip original donde se cortó), clampeando `start` a `[0, rightDur]` y `duration` a `[0, rightDur - start]`. Stickers cuyo `start+duration <= offset` (caen totalmente antes del corte) se eliminan del right.
   - Bloquear el split si el playhead está sobre un strip de transición (no hay clip ahí).

3. **applyProject** (carga de proyecto): el mapeo de fuentes debe keyed por el **sourceId string** del proyecto, NO por índice del array de fuentes. La versión bugueada usaba un índice para construir el map y OTRO índice distinto (orden de primera aparición en clips) para consultarlo, y al fallar caía en `state.sources[idx]` asignando el **video equivocado**. Además: limpiar `state.clipboard` y `state.activeClipId` al cargar, y construir el array de clips nuevo en una variable local antes de asignarlo a `state.clips` (aplicación atómica — si falla la validación, no queda estado a medias).

4. **deleteClipById** debe limpiar `selectedLinkId, activeClipId, selectedStickerIdx` (porque los link IDs son por índice y quedan colgando) y borrar las caches `thumbCache/frameCache/thumbBusy` del clip borrado (los IDs son monótonos, sin esto las Maps fugan memoria).

5. **Cancel de export** debe cerrar el modal y resetear la UI (progreso, status, botones), no solo parar el recorder. Sin esto el modal queda congelado en "Renderizando... X%" y solo se cierra recargando.

6. **Input handlers de stickers**: SIEMPRE bounds-check `c.stickers[state.selectedStickerIdx]` antes de acceder — el índice puede estar stale (tras duplicate/paste/split) y lanzar `TypeError`.

7. **drawStickers / drawTextOverlay**: clampear `end = Math.min(clipDur, start + duration)` al comprobar la ventana temporal (el parámetro `clipDur` se pasa para algo — úsalo).

8. **Tras eliminar un sticker**, llamar `renderTimeline()` además de `renderStickerList()` y `drawFrame()` (la barra de sticker en la timeline no se borra si no).

9. **bindRange** (sliders genéricos): redondear el valor mostrado a 2 decimales para evitar `0.30000000000000004`.

10. **Space bar**: no capturar si el target es `<button>`, `<select>`, o `contentEditable` (es el gesto nativo de "activar"). Los atajos Ctrl+ sí deben funcionar aunque un select esté focused.

11. **`.tl-track`**: `touch-action: none` para que el drag de clips no compita con el scroll táctil nativo en móvil.

12. **Caché de thumbnails con seeking**: `generateClipThumbs` es async; usa un flag `thumbBusy` por clip para no duplicar trabajo. Si el clip cambia (trim/filtro) mientras la generación está en curso, el resultado stale **no** debe escribirse — valida la clave antes de setear.

### Stack y compatibilidad

- Vanilla JS (sin frameworks). ES2020. Todo en un `<script>`.
- `MediaRecorder` para WebM; MIME order: `video/webm;codecs=vp9,opus`, `vp8,opus`, `vp9`, `vp8`, `video/webm` (elige el primero soportado). `videoBitsPerSecond: 5_000_000`.
- `ffmpeg.wasm` desde `https://unpkg.com/@ffmpeg/ffmpeg@0.10.1/dist/ffmpeg.min.js` para la conversión a MP4.
- UI en español, tema oscuro, responsive (mobile + desktop), `touch-action` y pointer events para táctil.
- Nada de build, nada de npm, nada de servidor. Doble clic y funciona.

### Entregable

Un único archivo `editor-video.html` autónomo. Antes de declararlo terminado, verifica:
- Sintaxis JS válida (`new Function(script)` sin errores).
- Que el zoom mantiene el anchor a 1.25x y 1.56x (no solo a 1x).
- Que un split reparte transiciones y desplaza ventanas de sticker correctamente.
- Que cancelar una exportación cierra el modal.
- Que borrar un clip no deja una transición seleccionada apuntando a otra pareja.

---

## Notas de uso

- El prompt está escrito para que un modelo **entienda las trampas** y no las reproduzca. Las secciones "Bugs que costó detectar" son lo más valioso: son las lecciones de esta auditoría, y sin ellas cualquier IA las volverá a cometer.
- Si el modelo genera un editor más simple (sin crossfade, sin export, sin stickers), pídele que itere citando la sección concreta que falta. El prompt es exigente a propósito.
- Para máxima fidelidad, puedes adjuntar el `editor-video.html` actual como referencia y pedir "ajústate a este prompt".
