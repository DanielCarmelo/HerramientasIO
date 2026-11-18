// editor_mcp_server.mjs — MCP server that exposes the video editor as tools.
// Any MCP-compatible client (Claude Desktop, Cursor, etc.) can drive the editor
// conversationally via these tools.
//
// Run:  node scripts/editor_mcp_server.mjs
// Or register in your MCP client config:
//   { "mcpServers": { "video-editor": { "command": "node", "args": ["<path>/scripts/editor_mcp_server.mjs"] } } }
//
// The server launches a headless browser on first use (lazy) and keeps it alive
// across tool calls so an editing session is stateful.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EditorDriver } from './editor_driver.mjs';
import { resolve } from 'node:path';

const driver = new EditorDriver({ verbose: false });
let launched = false;

async function ensureLaunched() {
  if (!launched) {
    await driver.launch();
    launched = true;
  }
  return driver;
}

// Helper: define a tool's input schema as a JSON-Schema object.
const s = (props, required = []) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

// Each tool: { name, description, inputSchema, handler(args) -> { content, isError } }
const TOOLS = [
  {
    name: 'load_video',
    description: 'Load a video file into the editor as a new clip. Accepts a local filesystem path or an http(s) URL.',
    inputSchema: s({ source: { type: 'string', description: 'Local path or http(s) URL of the video file.' }, fileName: { type: 'string', description: 'Display name for the source (optional).' } }, ['source']),
    handler: async (args) => { const d = await ensureLaunched(); return d.loadSource(args.source, args.fileName); },
  },
  {
    name: 'snapshot',
    description: 'Get the full current state of the editor: sources, clips, transitions (links), selection, timeline position, zoom. Read-only — use this to understand what the editor looks like before editing.',
    inputSchema: s({}),
    handler: async () => { const d = await ensureLaunched(); return d.snapshot(); },
  },
  {
    name: 'select_clip',
    description: 'Select a clip by its id or by index (0-based). Most editing tools (text, stickers, filters, transform) operate on the selected clip.',
    inputSchema: s({ id: { type: 'string', description: 'Clip id (from snapshot).' }, index: { type: 'integer', description: '0-based clip index (alternative to id).' } }),
    handler: async (args) => { const d = await ensureLaunched(); return args.id ? d.selectClip(args.id) : d.selectClipByIndex(args.index); },
  },
  {
    name: 'split_clip',
    description: 'Split a clip at a given number of seconds into it. The clip becomes two halves; transitions and sticker/text windows are redistributed correctly (left keeps entrance; right keeps exit + crossfade into the next clip).',
    inputSchema: s({ clipId: { type: 'string', description: 'Id of the clip to split.' }, secondsIntoClip: { type: 'number', description: 'Time within the clip (seconds) where to cut.' } }, ['clipId', 'secondsIntoClip']),
    handler: async (args) => { const d = await ensureLaunched(); return d.splitClipAt(args.clipId, args.secondsIntoClip); },
  },
  {
    name: 'trim_clip',
    description: 'Trim a clip\'s in/out points (in source-video time).',
    inputSchema: s({ id: { type: 'string' }, sourceStart: { type: 'number', description: 'New start in source seconds (optional).' }, sourceEnd: { type: 'number', description: 'New end in source seconds (optional).' } }, ['id']),
    handler: async (args) => { const d = await ensureLaunched(); return d.trimClip(args.id, args.sourceStart, args.sourceEnd); },
  },
  {
    name: 'delete_clip',
    description: 'Delete a clip by id. The editor keeps at least one clip.',
    inputSchema: s({ id: { type: 'string' } }, ['id']),
    handler: async (args) => { const d = await ensureLaunched(); return d.deleteClip(args.id); },
  },
  {
    name: 'duplicate_clip',
    description: 'Duplicate the currently-selected clip and select the copy.',
    inputSchema: s({}),
    handler: async () => { const d = await ensureLaunched(); return d.duplicateSelected(); },
  },
  {
    name: 'move_clip',
    description: 'Reorder a clip from one index to another on the timeline.',
    inputSchema: s({ fromIndex: { type: 'integer' }, toIndex: { type: 'integer' } }, ['fromIndex', 'toIndex']),
    handler: async (args) => { const d = await ensureLaunched(); return d.moveClip(args.fromIndex, args.toIndex); },
  },
  {
    name: 'set_cross_transition',
    description: 'Set the transition between clip at clipIdx and the next clip. Types: none, crossfade, fade-black, fade-white, fade-in, wipe-left, wipe-right, wipe-up, wipe-down, slide-left, slide-right, slide-up, slide-down, zoom-in, zoom-out.',
    inputSchema: s({ clipIdx: { type: 'integer', description: 'Index of the clip that transitions INTO the next.' }, type: { type: 'string' }, duration: { type: 'number', description: 'Seconds (0-5).' } }, ['clipIdx', 'type', 'duration']),
    handler: async (args) => { const d = await ensureLaunched(); return d.setCrossTransition(args.clipIdx, args.type, args.duration); },
  },
  {
    name: 'set_entrance_exit',
    description: 'Set the entrance (in) or exit (out) transition of a clip. Same transition types as set_cross_transition.',
    inputSchema: s({ clipId: { type: 'string' }, kind: { type: 'string', enum: ['in', 'out'] }, type: { type: 'string' }, duration: { type: 'number' } }, ['clipId', 'kind', 'type', 'duration']),
    handler: async (args) => { const d = await ensureLaunched(); const snap = await d.snapshot(); const idx = snap.clips.findIndex(c => c.id === args.clipId); const linkId = args.kind === 'in' ? 'in-0' : ('out-' + idx); return d.setTransition(linkId, args.type, args.duration); },
  },
  {
    name: 'add_text',
    description: 'Add or update a text overlay on the selected clip. Fields: content, color (#rrggbb), size, opacity (0-100), position (top-center|top-left|top-right|center|bottom-left|bottom-center|bottom-right), bg (none|shadow|solid), start (seconds), duration (0 = whole clip).',
    inputSchema: s({ content: { type: 'string' }, color: { type: 'string' }, size: { type: 'number' }, opacity: { type: 'number' }, position: { type: 'string' }, bg: { type: 'string' }, start: { type: 'number' }, duration: { type: 'number' } }),
    handler: async (args) => { const d = await ensureLaunched(); return d.setText(args); },
  },
  {
    name: 'add_sticker',
    description: 'Add an emoji sticker on the selected clip. Fields: emoji, x/y (0-100 percent), size, opacity, rotation (degrees), start (seconds), duration (0 = whole clip).',
    inputSchema: s({ emoji: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, opacity: { type: 'number' }, rotation: { type: 'number' }, start: { type: 'number' }, duration: { type: 'number' } }, ['emoji']),
    handler: async (args) => { const d = await ensureLaunched(); return d.addSticker(args.emoji, args); },
  },
  {
    name: 'set_filters',
    description: 'Set filter values on the selected clip. Fields: brightness, contrast, saturate (0-200, 100=normal), hue (0-360), blur (px), grayscale, sepia, invert (0-100).',
    inputSchema: s({ brightness: { type: 'number' }, contrast: { type: 'number' }, saturate: { type: 'number' }, hue: { type: 'number' }, blur: { type: 'number' }, grayscale: { type: 'number' }, sepia: { type: 'number' }, invert: { type: 'number' } }),
    handler: async (args) => { const d = await ensureLaunched(); return d.setFilters(args); },
  },
  {
    name: 'apply_preset',
    description: 'Apply a color preset to the selected clip. Options: none, grayscale, sepia, invert, vintage, cool, warm, vivid.',
    inputSchema: s({ name: { type: 'string' } }, ['name']),
    handler: async (args) => { const d = await ensureLaunched(); return d.applyPreset(args.name); },
  },
  {
    name: 'set_transform',
    description: 'Set transform on the selected clip. Fields: rotate (degrees), flipH (bool), flipV (bool), scale (100=normal), posX/posY (offset percent).',
    inputSchema: s({ rotate: { type: 'number' }, flipH: { type: 'boolean' }, flipV: { type: 'boolean' }, scale: { type: 'number' }, posX: { type: 'number' }, posY: { type: 'number' } }),
    handler: async (args) => { const d = await ensureLaunched(); return d.setTransform(args); },
  },
  {
    name: 'set_audio',
    description: 'Set audio properties on the selected clip. Fields: volume (0-200, 100=normal), fadeIn (seconds), fadeOut (seconds).',
    inputSchema: s({ volume: { type: 'number' }, fadeIn: { type: 'number' }, fadeOut: { type: 'number' } }),
    handler: async (args) => { const d = await ensureLaunched(); return d.setAudio(args); },
  },
  {
    name: 'seek',
    description: 'Move the playhead to a given time (seconds) in the project timeline.',
    inputSchema: s({ seconds: { type: 'number' } }, ['seconds']),
    handler: async (args) => { const d = await ensureLaunched(); return d.seek(args.seconds); },
  },
  {
    name: 'export_webm',
    description: 'Render the current timeline to a WebM video file. Returns the output path. This runs the real MediaRecorder pipeline headlessly and may take several seconds.',
    inputSchema: s({ outputPath: { type: 'string', description: 'Where to write the .webm file.' } }, ['outputPath']),
    handler: async (args) => { const d = await ensureLaunched(); return d.exportWebM(resolve(args.outputPath)); },
  },
  {
    name: 'snapshot_frame',
    description: 'Save a PNG image of the current canvas frame to disk. Useful to visually verify the edit before exporting.',
    inputSchema: s({ outputPath: { type: 'string' } }, ['outputPath']),
    handler: async (args) => { const d = await ensureLaunched(); return d.snapshotFrame(resolve(args.outputPath)); },
  },
  {
    name: 'apply_recipe',
    description: 'Apply a full project recipe (JSON) in one shot. The recipe is the same shape as the project save format (sources with url+fileName, clips with all fields). Faster than calling each tool individually for a known edit.',
    inputSchema: s({ recipe: { type: 'object', description: 'Project JSON: { sources:[{url,fileName}], clips:[{sourceId,sourceStart,sourceEnd,...}], ... }' } }, ['recipe']),
    handler: async (args) => { const d = await ensureLaunched(); return d.applyRecipe(args.recipe); },
  },
  {
    name: 'get_project',
    description: 'Return the current project as a JSON object (the save format). Use this to capture an edit for reuse.',
    inputSchema: s({}),
    handler: async () => { const d = await ensureLaunched(); return d.getProject(); },
  },
  {
    name: 'reset',
    description: 'Clear the editor: remove all clips and sources. Useful to start a new edit in the same session.',
    inputSchema: s({}),
    handler: async () => { const d = await ensureLaunched(); return d.reset(); },
  },
];

const toolMap = new Map(TOOLS.map(t => [t.name, t]));

const server = new Server(
  { name: 'video-editor-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const tool = toolMap.get(name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    const result = await tool.handler(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Tool error: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[editor-mcp] server running on stdio. Tools:', TOOLS.map(t => t.name).join(', '));

// Keep the browser alive across calls; close on shutdown.
process.on('SIGINT', async () => { await driver.close(); process.exit(0); });
process.on('SIGTERM', async () => { await driver.close(); process.exit(0); });
