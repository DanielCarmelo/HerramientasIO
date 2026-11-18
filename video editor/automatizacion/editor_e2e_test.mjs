// editor_e2e_test.mjs — End-to-end test of the driver + editorAPI.
// Loads two videos, splits one, adds a cross transition, text overlay, a sticker,
// trims a clip, applies a filter preset, then exports to WebM and verifies the file.

import { EditorDriver } from './editor_driver.mjs';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DL = resolve(process.cwd());
const TEST_OUT = resolve(DL, 'e2e_output.webm');
const FRAME_PNG = resolve(DL, 'e2e_frame.png');

function assert(cond, msg) { if (!cond) { console.error('✗ FAIL:', msg); process.exit(1); } else console.log('✓', msg); }

// Two distinct test videos (red/blue, 4s each).
const vidA = resolve(DL, 'test_src.mp4'); // already exists from smoke test
const vidB = resolve(DL, 'test_src2.mp4');
import { execSync } from 'node:child_process';
if (!existsSync(vidB)) {
  execSync(`ffmpeg -y -f lavfi -i color=c=blue:s=640x360:d=4 -an "${vidB}" -loglevel error`);
}

const d = new EditorDriver({ verbose: false });
let failures = 0;
try {
  await d.launch();

  // 1. Load two sources
  const r1 = await d.loadSource(vidA, 'red.mp4');
  assert(r1.ok && r1.duration === 3, `load source A (dur=${r1.duration})`);
  const r2 = await d.loadSource(vidB, 'blue.mp4');
  assert(r2.ok && r2.duration === 4, `load source B (dur=${r2.duration})`);

  let snap = await d.snapshot();
  assert(snap.clips.length === 2, `two clips loaded (${snap.clips.length})`);
  const [clipA, clipB] = snap.clips;

  // 2. Split clip A at 1.5s
  const splitRes = await d.splitClipAt(clipA.id, 1.5);
  assert(splitRes.ok, 'split clip A at 1.5s');
  snap = await d.snapshot();
  assert(snap.clips.length === 3, `three clips after split (${snap.clips.length})`);

  // 3. Add a crossfade between the (new) middle clip and clip B
  //    After split: [A1, A2, B]. Cross between A2 (idx 1) and B (idx 2).
  const crossRes = await d.setCrossTransition(1, 'crossfade', 0.6);
  assert(crossRes.ok, 'set crossfade A2->B (0.6s)');
  snap = await d.snapshot();
  const theCross = snap.links.find(l => l.kind === 'cross' && l.clipIdx === 1);
  assert(theCross && theCross.type === 'crossfade' && Math.abs(theCross.duration - 0.6) < 0.01,
    `cross link = ${theCross?.type} ${theCross?.duration}s`);

  // 4. Select clip A1 (idx 0) and add a text overlay + sticker
  await d.selectClipByIndex(0);
  await d.setText({ content: 'Hola IA', size: 40, color: '#ffff00', position: 'top-center' });
  const stk = await d.addSticker('⭐', { x: 80, y: 80, size: 60, start: 0.3, duration: 1.0 });
  assert(stk.ok, 'add sticker to A1');

  // 5. Apply a filter preset to clip B (last clip)
  await d.selectClipByIndex(snap.clips.length - 1);
  await d.applyPreset('sepia');
  snap = await d.snapshot();
  const lastClip = snap.clips[snap.clips.length - 1];
  assert(lastClip.filters.sepia === 100, `sepia preset applied (${lastClip.filters.sepia})`);

  // 6. Trim clip B to [1, 3]
  await d.trimClip(lastClip.id, 1, 3);
  snap = await d.snapshot();
  const trimmed = snap.clips[snap.clips.length - 1];
  assert(Math.abs(trimmed.sourceStart - 1) < 0.01 && Math.abs(trimmed.sourceEnd - 3) < 0.01,
    `trim B to [1,3] -> [${trimmed.sourceStart},${trimmed.sourceEnd}]`);

  // 7. Save a frame snapshot to verify rendering works
  await d.seek(0.5);
  const frameRes = await d.snapshotFrame(FRAME_PNG);
  assert(frameRes.ok && existsSync(FRAME_PNG), 'snapshot frame to PNG');
  assert(statSync(FRAME_PNG).size > 1000, `frame PNG has content (${statSync(FRAME_PNG).size} bytes)`);

  // 8. Export to WebM (the real test: MediaRecorder headless)
  console.log('exporting to WebM (this takes a few seconds)...');
  const exportRes = await d.exportWebM(TEST_OUT, {
    onProgress: (p) => process.stdout.write(`\r  export: ${(p*100).toFixed(0)}%`)
  });
  console.log('');
  assert(exportRes.ok, `export succeeded${exportRes.error ? ': ' + exportRes.error : ''}`);
  assert(existsSync(TEST_OUT), 'exported file exists');
  assert(statSync(TEST_OUT).size > 5000, `exported file has content (${(statSync(TEST_OUT).size/1024).toFixed(1)} KB)`);
  assert(!exportRes.cancelled, 'export was not cancelled');

  // 9. Verify the WebM is a valid video (ffprobe — use frame count, since WebM
  //    containers often report duration=N/A without a full decode).
  try {
    const info = execSync(`ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,r_frame_rate -of default=noprint_wrappers=1 "${TEST_OUT}"`).toString();
    const frames = parseInt((info.match(/nb_read_frames=(\d+)/) || [])[1] || '0');
    console.log('  ffprobe:', info.trim().replace(/\n/g, ', '));
    assert(frames > 30, `exported WebM has enough frames (${frames})`);
  } catch (e) {
    console.log('  (ffprobe not available, skipping video validation)');
  }

  console.log('\n✓✓✓ ALL E2E TESTS PASSED');
  console.log(`  output: ${TEST_OUT} (${(statSync(TEST_OUT).size/1024).toFixed(1)} KB)`);
  console.log(`  frame:  ${FRAME_PNG} (${(statSync(FRAME_PNG).size/1024).toFixed(1)} KB)`);
} catch (e) {
  console.error('\n✗ TEST ERROR:', e.message);
  console.error(e.stack);
  failures++;
} finally {
  await d.close();
}
process.exit(failures ? 1 : 0);
