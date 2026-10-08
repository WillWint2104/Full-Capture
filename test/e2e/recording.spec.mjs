// The recording subsystem in a real browser (Chromium, fake screen + mic,
// page on file://): TakeRecorder + sinks + journal + folder store + takes
// library. Every saved file is loaded into a <video> to prove it plays.
import { test, expect } from '@playwright/test';
import { openHarness, trackErrors } from './helpers.mjs';

const ENTRY = 'test/e2e/harness/recording.entry.js';

let errors;
test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await openHarness(page, ENTRY);
});
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await page.evaluate(() => kit.stopTracks()).catch(() => {});
  expect(errors).toEqual([]);
});

const near = (actual, expected, tolerance) => {
  expect(actual, `${actual} ≈ ${expected} ± ${tolerance}`).toBeGreaterThan(expected - tolerance);
  expect(actual, `${actual} ≈ ${expected} ± ${tolerance}`).toBeLessThan(expected + tolerance);
};

test('a 3 s WebM take saved in memory plays, with a finite duration close to 3 s', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { recorder, journal, events } = await kit.newTake();
    await recorder.start();
    const states = [recorder.state];
    await kit.sleep(3000);
    const res = await recorder.stop();
    return {
      states: [...states, recorder.state],
      result: { ...res, blob: undefined, blobType: res.blob.type, blobSize: res.blob.size },
      probe: await kit.probe(res.blob),
      header: await kit.headerDurationMs(res.blob),
      tail: await rec.webmEndMs(res.blob),
      kept: (await journal.listKept()).map(m => m.id),
      events,
    };
  });
  expect(r.states).toEqual(['recording', 'stopped']);
  expect(r.result.savedTo).toBe('memory');
  expect(r.result.container).toBe('webm');
  expect(r.result.mimeType).toMatch(/^video\/webm/);
  expect(r.result.size).toBe(r.result.blobSize);
  expect(r.result.size).toBeGreaterThan(10_000);
  near(r.result.durationMs, 3000, 400);
  expect(r.probe.error).toBeNull();
  expect(Number.isFinite(r.probe.duration)).toBe(true);
  near(r.probe.duration, 3, 0.5);
  expect(r.probe.played).toBe(true);
  near(r.header, r.result.durationMs, 1);
  near(r.tail, r.result.durationMs, 500);
  // A download can't be confirmed, so the journal keeps a safety copy.
  expect(r.kept).toEqual([r.result.id]);
  expect(r.events.filter(e => e.type === 'warning' || e.type === 'error')).toEqual([]);
});

test('a 1 s pause mid-take is excluded from the duration', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { recorder } = await kit.newTake();
    await recorder.start();
    await kit.sleep(1500);
    recorder.pause();
    const pausedState = recorder.state;
    const atPause = recorder.elapsedMs;
    await kit.sleep(1000);
    const afterWait = recorder.elapsedMs;
    recorder.resume();
    await kit.sleep(1500);
    const res = await recorder.stop();
    return { pausedState, atPause, afterWait, durationMs: res.durationMs, probe: await kit.probe(res.blob), tail: await rec.webmEndMs(res.blob) };
  });
  expect(r.pausedState).toBe('paused');
  expect(r.afterWait).toBe(r.atPause);
  near(r.durationMs, 3000, 400);
  near(r.probe.duration, 3, 0.5);
  // The media itself (not just our clock) has no gap.
  near(r.tail, 3000, 600);
  expect(r.probe.played).toBe(true);
});

test('stopping while paused saves up to the pause', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { recorder } = await kit.newTake();
    await recorder.start();
    await kit.sleep(2000);
    recorder.pause();
    await kit.sleep(1500);
    const res = await recorder.stop();
    return { durationMs: res.durationMs, elapsedAfter: recorder.elapsedMs, probe: await kit.probe(res.blob) };
  });
  near(r.durationMs, 2000, 400);
  expect(r.elapsedAfter).toBe(r.durationMs);
  near(r.probe.duration, 2, 0.5);
  expect(r.probe.error).toBeNull();
});

test('discarding a take leaves no journal rows', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { recorder } = await kit.newTake();
    await recorder.start();
    await kit.sleep(2500);
    const during = await kit.journalRows();
    const p1 = recorder.cancel();
    const same = p1 === recorder.cancel();
    const out = await p1;
    const after = await kit.journalRows();
    return { during: { metas: during.metas.length, chunks: during.chunkKeys.length }, same, out, state: recorder.state, after: { metas: after.metas.length, chunks: after.chunkKeys.length } };
  });
  expect(r.during.metas).toBe(1);
  expect(r.during.chunks).toBeGreaterThan(0);
  expect(r.same).toBe(true);
  expect(r.out).toBeNull();
  expect(r.state).toBe('stopped');
  expect(r.after).toEqual({ metas: 0, chunks: 0 });
});

test('markers are timed in recorded time and kept in the journal while recording', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const { recorder, journal, id } = await kit.newTake();
    await recorder.start();
    await kit.sleep(1000);
    const m1 = recorder.addMarker();
    recorder.pause();
    const atPause = recorder.elapsedMs;
    await kit.sleep(800);
    const m2 = recorder.addMarker('Worked example');
    recorder.resume();
    await kit.sleep(700);
    const m3 = recorder.addMarker('Summary');
    await kit.sleep(100);
    const metaMarkers = (await journal.getMeta(id)).markers;
    const res = await recorder.stop();
    return { m: [m1, m2, m3], atPause, metaMarkers, result: res.markers, durationMs: res.durationMs };
  });
  near(r.m[0].atMs, 1000, 250);
  expect(r.m[1].atMs).toBe(r.atPause);         // paused: time stands still
  near(r.m[1].atMs, r.m[0].atMs, 20);
  near(r.m[2].atMs - r.m[1].atMs, 700, 250);
  expect(r.m.map(m => m.title)).toEqual(['Chapter 1', 'Worked example', 'Summary']);
  expect(r.metaMarkers.map(m => m.title)).toEqual(['Chapter 1', 'Worked example', 'Summary']);
  expect(r.result).toEqual(r.m);
});

test('a take survives the tab closing: a new page offers it and rebuilds a playable file', async ({ page, context }) => {
  const id = await page.evaluate(async () => {
    const { recorder, id } = await kit.newTake();
    await recorder.start();
    recorder.addMarker('Before the crash');
    await kit.sleep(3500);
    return id;
  });

  // While the first tab is still recording, another tab must not offer it.
  const other = await context.newPage();
  await openHarness(other, ENTRY);
  const whileLive = await other.evaluate(async () => {
    const j = await rec.Journal.open();
    return {
      locks: (await j.listPending()).map(p => p.meta.id),
      heartbeat: (await j.listPending({ useLocks: false })).map(p => p.meta.id),
    };
  });
  expect(whileLive.locks).toEqual([]);
  expect(whileLive.heartbeat).toEqual([]);

  await page.close(); // no stop(): like a crash or closing the window
  await other.close();

  const fresh = await context.newPage();
  const freshErrors = trackErrors(fresh);
  await openHarness(fresh, ENTRY);
  const r = await fresh.evaluate(async takeId => {
    const j = await rec.Journal.open();
    const pending = await j.listPending();
    const item = pending.find(p => p.meta.id === takeId);
    const info = await j.assembleInfo(takeId);
    const out = {
      ids: pending.map(p => p.meta.id), chunks: item?.chunks, bytes: item?.bytes, meta: item?.meta,
      size: info.blob.size, type: info.blob.type, durationMs: info.durationMs,
      probe: await kit.probe(info.blob), header: await kit.headerDurationMs(info.blob),
    };
    await j.discard(takeId);
    out.afterDiscard = (await j.listPending()).length;
    out.rows = await kit.journalRows();
    return out;
  }, id);
  expect(r.ids).toEqual([id]);
  expect(r.chunks).toBeGreaterThan(1);
  expect(r.bytes).toBe(r.size - 11); // + the Duration element
  expect(r.meta.lessonName).toBe('Fractions');
  expect(r.meta.status).toBe('recording');
  expect(r.meta.markers.map(m => m.title)).toEqual(['Before the crash']);
  expect(r.type).toMatch(/^video\/webm/);
  near(r.durationMs, 3000, 900);
  near(r.header, r.durationMs, 1);
  expect(r.probe.error).toBeNull();
  near(r.probe.duration, r.durationMs / 1000, 0.05);
  expect(r.probe.played).toBe(true);
  expect(r.afterDiscard).toBe(0);
  expect(r.rows.metas.length + r.rows.chunkKeys.length).toBe(0);
  expect(freshErrors).toEqual([]);
});

test('a stale heartbeat marks a take as abandoned when Web Locks are not used', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const j = await rec.Journal.open();
    await j.begin({ id: 'ghost', lessonName: 'Ghost', filename: 'g.webm', container: 'webm', mimeType: 'video/webm', startedAt: Date.now() });
    await j.append('ghost', 0, new Blob(['x']));
    // Without any chunks there is nothing to recover.
    await j.begin({ id: 'empty', startedAt: Date.now() });
    const fresh = (await j.listPending({ useLocks: false })).map(p => p.meta.id);
    const emptyKeptWhileFresh = (await j.getMeta('empty')) !== null;
    await kit.sleep(300);
    const stale = await j.listPending({ useLocks: false, staleMs: 100 });
    return { fresh, emptyKeptWhileFresh, stale: stale.map(p => [p.meta.id, p.chunks, p.bytes]), emptyGone: (await j.getMeta('empty')) === null };
  });
  expect(r.fresh).toEqual([]);
  expect(r.emptyKeptWhileFresh).toBe(true);
  expect(r.stale).toEqual([['ghost', 1, 1]]);
  expect(r.emptyGone).toBe(true);   // an abandoned entry with no data is cleaned up
});

test('downloaded takes keep a safety copy until the next take is saved (keep / prune / listKept)', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const a = await kit.newTake();
    await a.recorder.start();
    await kit.sleep(1500);
    const ra = await a.recorder.stop();
    const keptAfterA = (await a.journal.listKept()).map(m => m.id);
    const metaA = await a.journal.getMeta(ra.id);

    const b = await kit.newTake();
    await b.recorder.start();
    await kit.sleep(1500);
    const rb = await b.recorder.stop();
    const kept = await b.journal.listKept();
    const again = await b.journal.assemble(rb.id);
    const rows = await kit.journalRows();
    return {
      a: ra.id, b: rb.id, keptAfterA, metaA: { status: metaA.status, elapsedMs: metaA.elapsedMs, filename: metaA.filename },
      durationA: ra.durationMs, keptAfterB: kept.map(m => m.id),
      pending: (await b.journal.listPending()).length,
      againProbe: await kit.probe(again), durationB: rb.durationMs,
      rowIds: [...new Set(rows.chunkKeys.map(k => k[0]))],
    };
  });
  expect(r.keptAfterA).toEqual([r.a]);
  expect(r.metaA.status).toBe('downloaded');
  expect(r.metaA.elapsedMs).toBe(r.durationA);
  expect(r.keptAfterB).toEqual([r.b]);
  expect(r.rowIds).toEqual([r.b]);
  expect(r.pending).toBe(0);
  near(r.againProbe.duration, r.durationB / 1000, 0.6);
  expect(r.againProbe.error).toBeNull();
});

test('FolderSink writes a playable WebM with the right Duration; a second take with the same name gets "(2)"', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const dir = rec.createFakeDirectory({ name: 'Lessons' });
    window.showDirectoryPicker = async () => dir;
    const store = new rec.FolderStore();
    await store.init();
    await store.choose();
    const status = store.status;

    const a = await kit.newTake({ sink: 'folder', store, filename: 'Fractions – Week 3.webm' });
    await a.recorder.start();
    const savingTo = a.recorder.savingTo;
    await kit.sleep(3000);
    const ra = await a.recorder.stop();
    const bytesA = dir.bytes(ra.filename);

    const b = await kit.newTake({ sink: 'folder', store, filename: 'Fractions – Week 3.webm' });
    await b.recorder.start();
    await kit.sleep(1200);
    const rb = await b.recorder.stop();

    const rows = await kit.journalRows();
    return {
      status, savingTo,
      a: { ...ra, blob: !!ra.blob }, b: { ...rb, blob: !!rb.blob },
      files: dir.fileNames(),
      sizeA: bytesA.length,
      header: await kit.headerDurationMs(bytesA),
      positioned: dir.writes.filter(w => w.position !== null && w.name === ra.filename),
      probeA: await kit.probe(bytesA),
      probeB: await kit.probe(dir.bytes(rb.filename)),
      rows: rows.metas.length + rows.chunkKeys.length,
      events: [...a.events, ...b.events].filter(e => e.type !== 'state'),
    };
  });
  expect(r.status).toBe('ready');
  expect(r.savingTo).toBe('folder');
  expect(r.a).toMatchObject({ savedTo: 'folder', filename: 'Fractions – Week 3.webm', folderName: 'Lessons', blob: false, warning: '' });
  expect(r.b).toMatchObject({ savedTo: 'folder', filename: 'Fractions – Week 3 (2).webm' });
  expect(r.files).toEqual(['Fractions – Week 3.webm', 'Fractions – Week 3 (2).webm']);
  expect(r.a.size).toBe(r.sizeA);
  near(r.header, r.a.durationMs, 1);
  near(r.a.durationMs, 3000, 400);
  expect(r.positioned).toHaveLength(1);
  expect(r.positioned[0].size).toBe(8);
  expect(r.probeA.error).toBeNull();
  near(r.probeA.duration, 3, 0.5);
  expect(r.probeA.played).toBe(true);
  near(r.probeB.duration, r.b.durationMs / 1000, 0.01);
  // Saved into the folder: no safety copy is needed.
  expect(r.rows).toBe(0);
  expect(r.events).toEqual([]);
});

test('if the folder fails mid-take the take is still saved, from the journal, as a download', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const dir = rec.createFakeDirectory({ name: 'USB stick' });
    window.showDirectoryPicker = async () => dir;
    const store = new rec.FolderStore();
    await store.choose();
    const t = await kit.newTake({ sink: 'folder', store, filename: 'Lesson.webm' });
    await t.recorder.start();
    await kit.sleep(1200);
    dir.failAfterBytes = dir.bytesWritten + 1000; // the disk fills up
    await kit.sleep(1000);
    const savingToMid = t.recorder.savingTo;
    const stateMid = t.recorder.state;
    await kit.sleep(1000);
    const res = await t.recorder.stop();
    return {
      savingToMid, stateMid,
      result: { ...res, blob: undefined }, hasBlob: res.blob instanceof Blob,
      probe: await kit.probe(res.blob),
      files: dir.fileNames(),
      kept: (await t.journal.listKept()).map(m => m.id),
      events: t.events.filter(e => e.type !== 'state'),
    };
  });
  expect(r.stateMid).toBe('recording');
  expect(r.savingToMid).toBe('memory');
  const err = r.events.find(e => e.type === 'error');
  expect(err).toMatchObject({ fatal: false, code: 'folder-failed' });
  expect(err.message).toMatch(/USB stick.*full/);
  expect(r.result.savedTo).toBe('memory');
  expect(r.hasBlob).toBe(true);
  expect(r.result.warning).toMatch(/Downloads folder/);
  expect(r.result.filename).toBe('Lesson.webm');
  near(r.result.durationMs, 3200, 450);
  expect(r.probe.error).toBeNull();
  near(r.probe.duration, r.result.durationMs / 1000, 0.01);
  expect(r.probe.played).toBe(true);
  expect(r.files).toEqual([]);                  // the half-written file is removed
  expect(r.kept).toEqual([r.result.id]);        // and the journal keeps the safety copy
});

test('screen sharing ending stops the take and keeps what was recorded', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const t = await kit.newTake();
    await t.recorder.start();
    await kit.sleep(2000);
    t.tracks.video.dispatchEvent(new Event('ended')); // what Chrome's "Stop sharing" bar does
    const res = await t.recorder.stop();
    return { endedBy: res.endedBy, durationMs: res.durationMs, probe: await kit.probe(res.blob), events: t.events.filter(e => e.type !== 'state') };
  });
  expect(r.endedBy).toBe('share-ended');
  expect(r.events[0]).toMatchObject({ type: 'error', fatal: true, code: 'share-ended' });
  near(r.durationMs, 2000, 400);
  near(r.probe.duration, 2, 0.5);
});

test('findLegacyRecording never creates v1’s database, and recovers a v1 recording', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const before = await rec.findLegacyRecording();
    const created = await kit.legacyExists();
    const parts = await kit.rawChunks(2000);
    await kit.makeLegacy({ parts, meta: { name: 'Old lesson', mime: 'video/webm;codecs=vp8,opus', container: 'webm', status: 'recording', startTime: Date.now() - 60_000, elapsedMs: 1900 } });
    const found = await rec.findLegacyRecording();
    const info = await found.assembleInfo();
    const probe = await kit.probe(info.blob);
    const header = await kit.headerDurationMs(info.blob);
    await found.discard();
    const afterDiscard = await rec.findLegacyRecording();
    // A finished v1 session (no 'recording' status) is not offered.
    await kit.makeLegacy({ parts, meta: { name: 'Done', status: 'done' } });
    const done = await rec.findLegacyRecording();
    return { before, created, meta: found.meta, chunks: found.chunks, parts: parts.length, bytes: found.bytes, durationMs: info.durationMs, header, probe, afterDiscard, done };
  });
  expect(r.before).toBeNull();
  expect(r.created).toBe(false);
  expect(r.meta.name).toBe('Old lesson');
  expect(r.chunks).toBe(r.parts);
  expect(r.bytes).toBeGreaterThan(1000);
  near(r.durationMs, 2000, 600);
  near(r.header, r.durationMs, 1);
  expect(r.probe.error).toBeNull();
  near(r.probe.duration, r.durationMs / 1000, 0.01);
  expect(r.afterDiscard).toBeNull();
  expect(r.done).toBeNull();
});

test('TakesLibrary stores takes in IndexedDB: CRUD, newest first, change events, survives reopening', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const lib = await rec.TakesLibrary.open();
    const changes = [];
    lib.on('change', rows => changes.push(rows.map(t => t.id)));
    const base = { lessonName: 'Fractions', container: 'webm', mimeType: 'video/webm', durationMs: 1000, size: 10, markers: [], savedTo: 'download', folderName: '', thumbnail: '' };
    await lib.add({ ...base, id: 'one', filename: 'one.webm', createdAt: 1000 });
    await lib.add({ ...base, id: 'two', filename: 'two.webm', createdAt: 3000 });
    await lib.add({ ...base, id: 'mid', filename: 'mid.webm', createdAt: 2000, markers: [{ id: 'm1', atMs: 500, title: 'Start' }] });
    const listed = (await lib.list()).map(t => t.id);
    const updated = await lib.update('mid', { lessonName: 'Renamed', markers: [] });
    await lib.remove('one');
    const reopened = await rec.TakesLibrary.open();
    const fromDisk = await reopened.list();
    return { persistent: lib.persistent, listed, updated, changes, fromDisk: fromDisk.map(t => [t.id, t.lessonName, t.markers.length]) };
  });
  expect(r.persistent).toBe(true);
  expect(r.listed).toEqual(['two', 'mid', 'one']);
  expect(r.updated.lessonName).toBe('Renamed');
  expect(r.changes).toEqual([['one'], ['two', 'one'], ['two', 'mid', 'one'], ['two', 'mid', 'one'], ['two', 'mid']]);
  expect(r.fromDisk).toEqual([['two', 'Fractions', 0], ['mid', 'Renamed', 0]]);
});

test('FolderStore rename and sidecar files work against a folder handle', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const dir = rec.createFakeDirectory({ name: 'Lessons', supportsMove: false });
    window.showDirectoryPicker = async () => dir;
    const store = new rec.FolderStore();
    await store.choose();
    dir.seed('Week 3.webm', 'video');
    await store.writeText('Week 3.chapters.txt', '0:00 Intro\n');
    const renamed = await store.rename('Week 3.webm', 'Fractions – Week 3.webm');
    const text = await (await store.getFile('Week 3.chapters.txt')).text();
    await store.remove('Week 3.chapters.txt');
    return { renamed, files: dir.fileNames(), text, moved: await (await store.getFile(renamed)).text() };
  });
  expect(r.renamed).toBe('Fractions – Week 3.webm');
  expect(r.files).toEqual(['Fractions – Week 3.webm']);
  expect(r.text).toBe('0:00 Intro\n');
  expect(r.moved).toBe('video');
});
