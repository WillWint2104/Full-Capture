// Records short WebM clips in headless Chromium (fake screen + mic) and saves
// them under test/fixtures/ for the WebM unit tests. Run: node scripts/make-fixtures.mjs
import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './bundler.mjs';
import { BLANK_URL } from '../test/e2e/helpers.mjs';

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'] });
const page = await browser.newPage();
await page.goto(BLANK_URL);
for (const [name, mime, ms] of [['vp9-opus-2s', 'video/webm;codecs=vp9,opus', 2000], ['vp8-opus-1s', 'video/webm;codecs=vp8,opus', 1000]]) {
  const parts = await page.evaluate(async ({ mime, ms }) => {
    const scr = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(new MediaStream([...scr.getVideoTracks(), ...mic.getAudioTracks()]), { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.start(500);
    await new Promise(r => setTimeout(r, ms));
    rec.stop();
    await new Promise(r => (rec.onstop = r));
    [...scr.getTracks(), ...mic.getTracks()].forEach(t => t.stop());
    const toArr = async b => Array.from(new Uint8Array(await b.arrayBuffer()));
    return { first: await toArr(chunks[0]), all: await toArr(new Blob(chunks)) };
  }, { mime, ms });
  await writeFile(path.join(ROOT, 'test/fixtures', `${name}.webm`), Buffer.from(parts.all));
  await writeFile(path.join(ROOT, 'test/fixtures', `${name}.first-chunk.bin`), Buffer.from(parts.first));
  console.log(name, parts.all.length, 'bytes; first chunk', parts.first.length);
}
await browser.close();
