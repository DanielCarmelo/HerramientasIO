// editor_driver.mjs — Headless driver for editor-video.html
// Launches Chromium via Playwright, loads the editor page, and exposes the page's
// window.editorAPI as async methods. This is the reusable core: both the demo script
// and the MCP server import this same driver.
//
// Usage as a module:
//   import { EditorDriver } from './editor_driver.mjs';
//   const d = new EditorDriver();
//   await d.launch();
//   await d.loadSource('file:///abs/path/clip.mp4');
//   await d.splitClipAt('c1', 2.0);
//   await d.exportWebM('/out/result.webm');
//   await d.close();

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const DEFAULT_EDITOR_PATH = resolve(process.cwd(), 'editor-video.html');

function toFileUrl(source) {
  // Accepts: absolute/relative filesystem path, file:// URL, or http(s):// URL.
  // Returns the URL string to pass to the page's fetch().
  if (/^https?:\/\//.test(source)) return source;
  if (/^file:\/\//.test(source)) return source;
  const abs = isAbsolute(source) ? source : resolve(process.cwd(), source);
  return pathToFileURL(abs).href;
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.ogg': 'video/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};

// A tiny static file server bound to localhost. Used to serve the editor HTML and the
// source videos over http:// so that the page's fetch() can load them (file:// fetch
// is blocked by the browser even with --no-sandbox). The root is configurable.
function startStaticServer(rootDir) {
  const root = resolve(rootDir);
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const fsPath = join(root, urlPath);
      // Prevent path traversal
      if (!fsPath.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
      if (!existsSync(fsPath) || statSync(fsPath).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      const buf = readFileSync(fsPath);
      const ct = MIME[extname(fsPath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ server, port: server.address().port, root }));
  });
}

export class EditorDriver {
  constructor({ editorUrl, headless = true, viewport = { width: 1280, height: 800 }, verbose = false, serverRoot } = {}) {
    this.verbose = verbose;
    this.headless = headless;
    this.viewport = viewport;
    this._requestedEditorUrl = editorUrl || DEFAULT_EDITOR_PATH;
    this.serverRoot = serverRoot || (isAbsolute(this._requestedEditorUrl) ? dirname(this._requestedEditorUrl) : dirname(resolve(process.cwd(), this._requestedEditorUrl)));
    this.server = null;
    this.baseHttpUrl = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this._log = (...a) => this.verbose && console.error('[driver]', ...a);
  }

  async launch() {
    // Start the static server so the page can fetch videos via http://.
    const { server, port, root } = await startStaticServer(this.serverRoot);
    this.server = server;
    this.baseHttpUrl = `http://127.0.0.1:${port}`;
    this._log('static server', this.baseHttpUrl, 'root:', root);

    this._log('launching chromium', { headless: this.headless });
    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--autoplay-policy=no-user-gesture-required', // allow audio/video to play without a click
        '--mute-audio', // keep the sandbox quiet during export
        '--no-sandbox',
      ],
    });
    this.context = await this.browser.newContext({ viewport: this.viewport });
    this.page = await this.context.newPage();
    this.page.on('console', (msg) => {
      const t = msg.type();
      if (t === 'error' || t === 'warning') this._log('page', t, msg.text());
    });
    this.page.on('pageerror', (err) => this._log('pageerror', err.message));

    // Resolve the editor URL: if it's a local path or file://, rewrite to the http server.
    let editorHttpUrl;
    if (/^https?:\/\//.test(this._requestedEditorUrl)) {
      editorHttpUrl = this._requestedEditorUrl;
    } else {
      const editorAbs = isAbsolute(this._requestedEditorUrl) ? this._requestedEditorUrl : resolve(process.cwd(), this._requestedEditorUrl);
      editorHttpUrl = this.baseHttpUrl + '/' + editorAbs.slice(root.length).replace(/^\/+/, '');
    }
    this.editorUrl = editorHttpUrl;
    this._log('loading editor', this.editorUrl);
    await this.page.goto(this.editorUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() => window.editorAPI && typeof window.editorAPI.ready === 'function' && window.editorAPI.ready(), null, { timeout: 20000 });
    this._log('editor ready');
    return this;
  }

  // Call any window.editorAPI method by name with args. Returns the (JSON-serializable) result.
  async _call(method, ...args) {
    if (!this.page) throw new Error('Driver not launched. Call launch() first.');
    // Pass args through. Functions (like onProgress) cannot cross the boundary, so we
    // strip them and rely on polling snapshot() if progress is needed.
    const serializableArgs = args.map(a => (typeof a === 'function' ? undefined : a));
    const res = await this.page.evaluate(({ m, a }) => {
      if (!window.editorAPI || !window.editorAPI[m]) return { ok: false, error: 'API method not found: ' + m };
      const r = window.editorAPI[m](...(a || []));
      return (r && typeof r.then === 'function') ? r : Promise.resolve(r);
    }, { m: method, a: serializableArgs });
    return res;
  }

  // --- High-level convenience wrappers (mirror the editorAPI surface) ---
  async snapshot() { return this._call('snapshot'); }
  async loadSource(source, fileName) {
    // Convert any local path to the http:// URL served by our static server.
    let url;
    if (/^https?:\/\//.test(source)) {
      url = source;
    } else {
      const abs = isAbsolute(source) ? source : resolve(process.cwd(), source);
      const rel = abs.startsWith(this.serverRoot) ? abs.slice(this.serverRoot.length).replace(/^\/+/, '') : abs.split('/').pop();
      url = this.baseHttpUrl + '/' + rel.split('/').map(encodeURIComponent).join('/');
    }
    const name = fileName || (source.split('/').pop() || 'source.mp4');
    return this._call('loadSource', url, name);
  }
  async selectClip(id) { return this._call('selectClip', id); }
  async selectClipByIndex(i) { return this._call('selectClipByIndex', i); }
  async splitClipAt(clipId, secondsIntoClip) { return this._call('splitClipAt', clipId, secondsIntoClip); }
  async splitAtPlayhead() { return this._call('splitAtPlayhead'); }
  async deleteClip(id) { return this._call('deleteClip', id); }
  async deleteSelectedClip() { return this._call('deleteSelectedClip'); }
  async duplicateSelected() { return this._call('duplicateSelected'); }
  async copySelected() { return this._call('copySelected'); }
  async cutSelected() { return this._call('cutSelected'); }
  async paste() { return this._call('paste'); }
  async moveClip(fromIdx, toIdx) { return this._call('moveClip', fromIdx, toIdx); }
  async trimClip(id, sourceStart, sourceEnd) { return this._call('trimClip', id, sourceStart, sourceEnd); }
  async setClipSpeed(id, speed) { return this._call('setClipSpeed', id, speed); }

  async selectLink(id) { return this._call('selectLink', id); }
  async selectLinkByIndex(clipIdx, kind) { return this._call('selectLinkByIndex', clipIdx, kind); }
  async setTransition(linkId, type, duration) { return this._call('setTransition', linkId, type, duration); }
  async setCrossTransition(clipIdx, type, duration) { return this._call('setCrossTransition', clipIdx, type, duration); }

  async setText(cfg) { return this._call('setText', cfg); }
  async addSticker(emoji, cfg) { return this._call('addSticker', emoji, cfg); }
  async updateSticker(idx, cfg) { return this._call('updateSticker', idx, cfg); }
  async removeSticker(idx) { return this._call('removeSticker', idx); }

  async setFilters(f) { return this._call('setFilters', f); }
  async applyPreset(name) { return this._call('applyPreset', name); }
  async setTransform(t) { return this._call('setTransform', t); }
  async setAudio(a) { return this._call('setAudio', a); }

  async seek(seconds) { return this._call('seek', seconds); }
  async play() { return this._call('play'); }
  async pause() { return this._call('pause'); }
  async setZoom(z) { return this._call('setZoom', z); }

  async getProject() { return this._call('getProject'); }
  async applyProject(project, opts) { return this._call('applyProject', project, opts); }

  // Export the timeline to a WebM file on disk. Writes to outFile.
  // Returns { ok, size, mime, cancelled }.
  async exportWebM(outFile, { onProgress } = {}) {
    const dir = dirname(resolve(outFile));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // The page's exportWebM accepts an onProgress callback, but functions can't cross
    // page.evaluate. We pass a sentinel and poll separately if onProgress is provided.
    let pollHandle = null;
    if (onProgress) {
      pollHandle = setInterval(async () => {
        try { const s = await this.snapshot(); onProgress(s.currentTime / Math.max(0.001, s.totalDuration)); } catch(e){}
      }, 300);
    }
    try {
      const res = await this.page.evaluate(async () => window.editorAPI.exportWebM({}));
      if (pollHandle) clearInterval(pollHandle);
      if (!res || !res.ok) return { ok: false, error: res?.error || 'export failed', cancelled: res?.cancelled };
      // Decode base64 -> file
      const buf = Buffer.from(res.base64, 'base64');
      writeFileSync(resolve(outFile), buf);
      return { ok: true, size: res.size, mime: res.mime, cancelled: res.cancelled, path: resolve(outFile) };
    } catch (e) {
      if (pollHandle) clearInterval(pollHandle);
      throw e;
    }
  }

  async cancelExport() { return this._call('cancelExport'); }

  // Save a PNG snapshot of the current canvas frame to disk. Useful for verification.
  async snapshotFrame(outFile) {
    const dir = dirname(resolve(outFile));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dataUrl = await this._call('snapshotFrame');
    if (!dataUrl || typeof dataUrl !== 'string') return { ok: false, error: 'no frame' };
    const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    writeFileSync(resolve(outFile), Buffer.from(b64, 'base64'));
    return { ok: true, path: resolve(outFile) };
  }

  async reset() { return this._call('reset'); }

  // Apply a full "recipe" (project JSON with optional source URLs) in one shot.
  async applyRecipe(recipe) {
    return this._call('applyProject', recipe, { replaceSources: true });
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }
}

// If invoked directly (node editor_driver.mjs ...), run a tiny smoke test.
// This makes the file both a library and a runnable sanity check.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.log('Usage: node editor_driver.mjs <video-path-or-url>');
    console.log('Runs a smoke test: loads the video, snapshots state, and prints it.');
    process.exit(0);
  }
  const d = new EditorDriver({ verbose: true });
  try {
    await d.launch();
    await d.loadSource(fileArg);
    const snap = await d.snapshot();
    console.log(JSON.stringify(snap, null, 2));
    await d.close();
  } catch (e) {
    console.error('SMOKE TEST FAILED:', e.message);
    await d.close();
    process.exit(1);
  }
}
