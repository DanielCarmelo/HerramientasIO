// editor_demo.mjs — Minimal programmatic demo of the driver.
// Shows the simplest "describe → render" path: a Node script that loads a video,
// adds a title + sticker + crossfade, and exports. Run:
//   node scripts/editor_demo.mjs path/to/videoA.mp4 path/to/videoB.mp4
// If no args, it generates two test videos with ffmpeg and uses those.

import { EditorDriver } from './editor_driver.mjs';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

let [vidA, vidB] = process.argv.slice(2);
const cwd = process.cwd();
const DL = resolve(cwd);

if (!vidA || !vidB) {
  vidA = resolve(DL, '_demo_a.mp4');
  vidB = resolve(DL, '_demo_b.mp4');
  if (!existsSync(vidA)) execSync(`ffmpeg -y -f lavfi -i testsrc=duration=4:size=640x360:rate=30 -an "${vidA}" -loglevel error`);
  if (!existsSync(vidB)) execSync(`ffmpeg -y -f lavfi -i color=c=blue:s=640x360:d=4 -an "${vidB}" -loglevel error`);
}

const OUT = resolve(DL, 'demo_output.webm');
const FRAME = resolve(DL, 'demo_frame.png');

const d = new EditorDriver({ verbose: true });
console.log('=== Video Editor Automation Demo ===\n');
try {
  await d.launch();

  console.log('1) Loading two videos...');
  await d.loadSource(vidA, 'clip-a.mp4');
  await d.loadSource(vidB, 'clip-b.mp4');
  let snap = await d.snapshot();
  console.log(`   -> ${snap.clips.length} clips loaded\n`);

  console.log('2) Splitting clip A at 2.0s...');
  await d.splitClipAt(snap.clips[0].id, 2.0);
  snap = await d.snapshot();
  console.log(`   -> ${snap.clips.length} clips now\n`);

  console.log('3) Adding a crossfade between A2 and B...');
  await d.setCrossTransition(1, 'crossfade', 0.5);

  console.log('4) Adding a title and a sticker on the first clip...');
  await d.selectClipByIndex(0);
  await d.setText({ content: 'Hecho por IA 🤖', color: '#ffffff', size: 44, position: 'top-center', bg: 'shadow' });
  await d.addSticker('⭐', { x: 15, y: 80, size: 60 });

  console.log('5) Applying a "vivid" preset to clip B...');
  await d.selectClipByIndex(snap.clips.length - 1);
  await d.applyPreset('vivid');

  console.log('6) Snapping a preview frame...');
  await d.seek(1.0);
  await d.snapshotFrame(FRAME);
  console.log(`   -> ${FRAME}\n`);

  console.log('7) Exporting to WebM (real-time render, ~timeline duration)...');
  const res = await d.exportWebM(OUT, { onProgress: p => process.stdout.write(`\r   ${Math.round(p*100)}%`) });
  console.log(`\n   -> ${res.path} (${(res.size/1024).toFixed(1)} KB)\n`);

  console.log('✓ Done. Files:');
  console.log(`   ${OUT}`);
  console.log(`   ${FRAME}`);
} catch (e) {
  console.error('Demo failed:', e.message);
  console.error(e.stack);
} finally {
  await d.close();
}
