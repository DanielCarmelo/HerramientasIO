# Automatización del editor de video para IA

El `editor-video.html` se puede controlar automáticamente mediante una IA. Hay **tres capas** que funcionan sobre el mismo núcleo (`window.editorAPI`), construidas incrementalmente:

| Capa | Qué es | Cuándo usarla |
|---|---|---|
| **1. API in-page** (`window.editorAPI`) | Métodos expuestos en el editor cargado | Si quieres controlar el editor desde la consola del navegador o desde un script que ya tiene una página abierta |
| **2. Driver headless** (`scripts/editor_driver.mjs`) | Clase `EditorDriver` que lanza Chromium con Playwright y expone la API como métodos async | Uso programático desde Node: scripts, pipelines, batch |
| **3. Servidor MCP** (`scripts/editor_mcp_server.mjs`) | Servidor que expone 22 herramientas MCP | Para que Claude Desktop, Cursor u otros clientes MCP manejen el editor conversacionalmente |

Las tres comparten el mismo `window.editorAPI`, así que lo que funciona en una funciona en todas.

---

## Instalación

```bash
cd /ruta/al/editor
npm install                    # instala playwright + @modelcontextprotocol/sdk
npx playwright install chromium-headless-shell   # solo la primera vez
```

Requiere Node 18+ y ffmpeg (para validar el output, opcional).

---

## Capa 2: uso programático (Node)

```js
import { EditorDriver } from './scripts/editor_driver.mjs';

const d = new EditorDriver({ verbose: true });
await d.launch();

await d.loadSource('/path/clipA.mp4', 'intro.mp4');
await d.loadSource('https://ejemplo.com/clipB.mp4', 'main.mp4');

let snap = await d.snapshot();              // estado completo del editor
await d.splitClipAt(snap.clips[0].id, 2.0); // dividir a 2s
await d.setCrossTransition(1, 'crossfade', 0.5);
await d.selectClipByIndex(0);
await d.setText({ content: 'Hola', size: 44, position: 'top-center' });
await d.addSticker('⭐', { x: 80, y: 20 });

await d.exportWebM('./salida.webm');        // render real, devuelve el path
await d.snapshotFrame('./preview.png');     // captura un frame
await d.close();
```

**Demo listo para ejecutar:**

```bash
node scripts/editor_demo.mjs   # genera 2 videos de prueba y los edita+exporta
# o con tus propios videos:
node scripts/editor_demo.mjs ruta/a/videoA.mp4 ruta/a/videoB.mp4
```

**API completa** (todos async, devuelven JSON):

| Método | Descripción |
|---|---|
| `snapshot()` | Estado completo: sources, clips, links, selección, tiempo |
| `loadSource(pathOUrl, nombre?)` | Carga un video (acepta path local o http(s) URL) |
| `selectClip(id)` / `selectClipByIndex(i)` | Selecciona un clip |
| `splitClipAt(clipId, seg)` | Divide un clip en un punto |
| `splitAtPlayhead()` | Divide en el playhead actual |
| `trimClip(id, sourceStart?, sourceEnd?)` | Recorta in/out |
| `deleteClip(id)` / `duplicateSelected()` / `moveClip(from, to)` | Operaciones de clip |
| `setCrossTransition(clipIdx, tipo, dur)` | Transición entre clip i e i+1 |
| `setTransition(linkId, tipo, dur)` | Transición arbitraria (in/out/cross) |
| `setText(cfg)` | Overlay de texto en clip seleccionado |
| `addSticker(emoji, cfg)` / `updateSticker(idx, cfg)` / `removeSticker(idx)` | Stickers |
| `setFilters(f)` / `applyPreset(nombre)` | Filtros |
| `setTransform(t)` / `setAudio(a)` | Transform / audio |
| `seek(seg)` / `play()` / `pause()` / `setZoom(z)` | Transporte |
| `exportWebM(outPath, {onProgress?})` | Exporta a WebM (devuelve `{path,size}`) |
| `snapshotFrame(outPath)` | PNG del frame actual |
| `getProject()` / `applyProject(json)` / `applyRecipe(json)` | Guardar/cargar proyecto |
| `reset()` | Limpia el editor |

**Tipos de transición:** `none, crossfade, fade-black, fade-white, fade-in, wipe-left, wipe-right, wipe-up, wipe-down, slide-left, slide-right, slide-up, slide-down, zoom-in, zoom-out`

---

## Atajo: receta JSON (camino B)

En vez de llamar método por método, la IA puede emitir un proyecto entero en JSON y aplicarlo de golpe. Ver [recipe_example.json](recipe_example.json) para un ejemplo completo de 3 clips con transiciones, texto, sticker y filtros.

```js
import { readFileSync } from 'node:fs';
const recipe = JSON.parse(readFileSync('./recipe_example.json'));
// Reemplaza los URLs por tus videos reales
recipe.sources.forEach((s, i) => s.url = `file:///abs/path/${s.fileName}`);
await d.applyRecipe(recipe);
await d.exportWebM('./salida.webm');
```

Usa `getProject()` para capturar una edición interactiva y reutilizarla.

---

## Capa 3: servidor MCP (Claude Desktop, etc.)

El servidor expone las 22 herramientas del editor mediante el protocolo MCP sobre stdio. La IA lo maneja conversacionalmente.

### Configuración en Claude Desktop

Edita `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "video-editor": {
      "command": "node",
      "args": ["/ruta/absoluta/al/editor/scripts/editor_mcp_server.mjs"],
      "cwd": "/ruta/absoluta/al/editor"
    }
  }
}
```

Reinicia Claude Desktop. A partir de ahí, puedes decirle cosas como:

> "Carga el video intro.mp4, divídelo a los 3 segundos, ponle un crossfade de medio segundo con main.mp4, añade el texto 'Hola' arriba, y expórtalo a salida.webm"

Y Claude invocará las herramientas MCP (`load_video`, `split_clip`, `set_cross_transition`, `add_text`, `export_webm`) automáticamente.

### Herramientas MCP (22)

`load_video`, `snapshot`, `select_clip`, `split_clip`, `trim_clip`, `delete_clip`, `duplicate_clip`, `move_clip`, `set_cross_transition`, `set_entrance_exit`, `add_text`, `add_sticker`, `set_filters`, `apply_preset`, `set_transform`, `set_audio`, `seek`, `export_webm`, `snapshot_frame`, `apply_recipe`, `get_project`, `reset`

El navegador se lanza perezosamente en la primera llamada y se mantiene vivo entre turnos, así que una sesión de edición es con estado.

---

## Tests

```bash
# Test end-to-end del driver (genera videos, edita, exporta, valida con ffprobe)
node scripts/editor_e2e_test.mjs

# Test end-to-end del servidor MCP (via cliente MCP oficial)
node scripts/mcp_e2e_test.mjs
```

Ambos tests: cargan videos, dividen, aplican transiciones, añaden texto/stickers/filtros, exportan a WebM y verifican el archivo con ffprobe.

---

## Cómo funciona por dentro

1. **`window.editorAPI`** (en `editor-video.html`): el editor es un IIFE; al final del script expone un objeto `window.editorAPI` con métodos que envuelven las funciones internas (`loadVideo`, `splitAtPlayhead`, `setLinkValues`, `renderToWebM`, etc.). Cada método devuelve JSON serializable (o una Promise que resuelve a JSON), para poder cruzar el límite de `page.evaluate`.

2. **Driver**: lanza Chromium headless con `--autoplay-policy=no-user-gesture-required` (para que el audio/video funcione sin interacción) y `--mute-audio` (silencio en el sandbox). Sirve el HTML y los videos vía un mini-servidor HTTP en localhost (porque `fetch('file://...')` está bloqueado desde una página). Cada método del driver serializa args, llama a `page.evaluate`, y deserializa el resultado. El export devuelve el WebM en base64 (en chunks de 32KB para no reventar el stack) que el driver decodifica a Buffer y escribe a disco.

3. **MCP**: envuelve el driver en un servidor stdio. Cada herramienta llama al método correspondiente del driver y devuelve el resultado como texto JSON. El navegador se lanza perezosamente y persiste entre llamadas.

---

## Limitaciones conocidas

- **Export solo a WebM** vía esta vía (MP4 requiere ffmpeg.wasm dentro de la página, que es más lento). Para MP4, postprocesar el WebM con ffmpeg-cli:
  ```bash
  ffmpeg -i salida.webm -c:v libx264 -preset fast salida.mp4
  ```
- **El export corre en tiempo real** (~duración del timeline) porque usa `MediaRecorder` sobre `canvas.captureStream`. No es más rápido que reproducirlo.
- **Audio**: se mezcla vía `AudioContext` respetando volumen/fadeIn/fadeOut por clip. El flag `--mute-audio` silencia los altavoces del sandbox, no el stream grabado.
