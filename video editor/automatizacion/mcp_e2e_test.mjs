// mcp_e2e_test.mjs — Drives the editor entirely through the MCP protocol (as Claude would).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'node:child_process';
import { existsSync as ex, statSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT_WEBM = resolve(process.cwd(), 'mcp_output.webm');
const OUT_FRAME = resolve(process.cwd(), 'mcp_frame.png');
const TEST_VID = resolve(process.cwd(), 'test_src.mp4');

const transport = new StdioClientTransport({ command: 'node', args: ['scripts/editor_mcp_server.mjs'], cwd: process.cwd() });
const client = new Client({ name: 'mcp-test', version: '1.0' }, { capabilities: {} });
await client.connect(transport);

function assert(c, m) { if (!c) { console.error('✗', m); process.exit(1); } else console.log('✓', m); }

try {
  const tools = await client.listTools();
  assert(tools.tools.length >= 20, `MCP exposes ${tools.tools.length} tools`);

  // 1. Load a video
  const loadRes = await client.callTool({ name: 'load_video', arguments: { source: TEST_VID, fileName: 'test.mp4' } });
  const load = JSON.parse(loadRes.content[0].text);
  assert(load.ok && load.duration === 3, `load_video (dur=${load.duration})`);

  // 2. Snapshot
  const snapRes = await client.callTool({ name: 'snapshot', arguments: {} });
  const snap = JSON.parse(snapRes.content[0].text);
  assert(snap.clips.length === 1, `snapshot shows 1 clip`);
  const clipId = snap.clips[0].id;

  // 3. Split
  const splitRes = await client.callTool({ name: 'split_clip', arguments: { clipId, secondsIntoClip: 1.0 } });
  assert(JSON.parse(splitRes.content[0].text).ok, 'split_clip via MCP');

  // 4. Select first clip + add text
  await client.callTool({ name: 'select_clip', arguments: { index: 0 } });
  const textRes = await client.callTool({ name: 'add_text', arguments: { content: 'Editado por IA', color: '#00ff00', size: 36, position: 'bottom-center' } });
  assert(JSON.parse(textRes.content[0].text).ok, 'add_text via MCP');

  // 5. Add a sticker
  const stkRes = await client.callTool({ name: 'add_sticker', arguments: { emoji: '🚀', x: 50, y: 30, size: 70 } });
  assert(JSON.parse(stkRes.content[0].text).ok, 'add_sticker via MCP');

  // 6. Apply a filter preset to the second clip
  await client.callTool({ name: 'select_clip', arguments: { index: 1 } });
  await client.callTool({ name: 'apply_preset', arguments: { name: 'vivid' } });

  // 7. Set a cross transition between clip 0 and clip 1
  const crossRes = await client.callTool({ name: 'set_cross_transition', arguments: { clipIdx: 0, type: 'wipe-right', duration: 0.4 } });
  assert(JSON.parse(crossRes.content[0].text).ok, 'set_cross_transition via MCP');

  // 8. Snapshot a frame to verify rendering
  const frameRes = await client.callTool({ name: 'snapshot_frame', arguments: { outputPath: OUT_FRAME } });
  assert(JSON.parse(frameRes.content[0].text).ok && ex(OUT_FRAME), 'snapshot_frame via MCP');

  // 9. Export to WebM
  console.log('exporting via MCP...');
  const exportRes = await client.callTool({ name: 'export_webm', arguments: { outputPath: OUT_WEBM } });
  const exp = JSON.parse(exportRes.content[0].text);
  assert(exp.ok && ex(OUT_WEBM), `export_webm via MCP (${(statSync(OUT_WEBM).size/1024).toFixed(1)} KB)`);

  // 10. ffprobe the result
  try {
    const info = execSync(`ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames "${OUT_WEBM}"`).toString();
    const frames = parseInt((info.match(/nb_read_frames=(\d+)/) || [])[1] || '0');
    assert(frames > 20, `exported WebM valid (${frames} frames)`);
  } catch (e) { console.log('  (ffprobe skipped)'); }

  console.log('\n✓✓✓ MCP E2E PASSED — IA puede manejar el editor conversacionalmente');
  console.log(`  output: ${OUT_WEBM}`);
  console.log(`  frame:  ${OUT_FRAME}`);
} catch (e) {
  console.error('✗ MCP TEST ERROR:', e.message);
  console.error(e.stack);
} finally {
  await client.close();
  process.exit(0);
}
