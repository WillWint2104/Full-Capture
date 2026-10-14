// Page init scripts shared by browser tests that check saved recordings.

/**
 * Screen = a canvas that flashes white; microphone = beeps at the same
 * instants; both driven by one AudioContext clock, so sound and picture are
 * in sync at the source. Use with page.addInitScript(syncStimulus, {period, beep}).
 */
export function syncStimulus({ period, beep }) {
  const ctx = new AudioContext();
  const osc = new OscillatorNode(ctx, { frequency: 1000 });
  const gain = new GainNode(ctx, { gain: 0 });
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  let t0 = null;
  const arm = () => {
    if (t0 !== null || ctx.state !== 'running') return;
    t0 = Math.ceil(ctx.currentTime) + 1;
    for (let i = 0; i < 120; i++) {
      const t = t0 + i * period;
      gain.gain.setValueAtTime(0.5, t);
      gain.gain.setValueAtTime(0, t + beep);
    }
  };
  ctx.resume().then(arm);
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const g = canvas.getContext('2d');
  const draw = () => {
    arm();
    const on = t0 !== null && ctx.currentTime >= t0 && ((ctx.currentTime - t0) % period) < beep;
    g.fillStyle = on ? '#fff' : '#000';
    g.fillRect(0, 0, canvas.width, canvas.height);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  const md = navigator.mediaDevices;
  const realUserMedia = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    if (c?.audio && !c.video) return new MediaStream(dest.stream.getAudioTracks().map(t => t.clone()));
    return realUserMedia(c);
  };
  md.getDisplayMedia = async () => canvas.captureStream(30);
}

/**
 * Let the app record MP4 in Playwright's Chromium. The app asks for H.264
 * MP4, which this Chromium can't encode (no proprietary codecs); it gets VP9
 * in MP4 instead, written by the same MP4 muxer as Chrome's and Edge's H.264
 * recordings (the container is what these tests check).
 */
export function mp4InChromium() {
  const Real = window.MediaRecorder;
  const supported = Real.isTypeSupported.bind(Real);
  const map = t => (/^video\/mp4/i.test(t || '') && /avc1/i.test(t) ? 'video/mp4;codecs=vp9,opus' : t);
  class Recorder extends Real {
    constructor(stream, options = {}) { super(stream, { ...options, mimeType: map(options.mimeType) }); }
  }
  Recorder.isTypeSupported = t => supported(map(t));
  window.MediaRecorder = Recorder;
}

/**
 * A folder the teacher "picked", kept in memory (file:// pages have no
 * origin-private file system). Writes support positions, like Chrome's
 * FileSystemWritableFileStream; files appear on close(). window.__files maps
 * names to Files.
 */
export function fakeFolder() {
  const files = new Map();
  window.__files = files;
  class Writable {
    constructor(name) { this.name = name; this.pos = 0; this.buf = new Uint8Array(0); }
    async write(data) {
      if (data && data.type === 'write' && 'position' in data) { this.pos = data.position; data = data.data; }
      const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength) : data);
      const end = this.pos + bytes.length;
      if (end > this.buf.length) { const n = new Uint8Array(Math.max(end, this.buf.length * 2)); n.set(this.buf); this.buf = n; }
      this.buf.set(bytes, this.pos);
      this.pos = end;
      this.len = Math.max(this.len || 0, end);
    }
    async seek(p) { this.pos = p; }
    async truncate(n) { this.len = n; }
    async close() { files.set(this.name, new File([this.buf.subarray(0, this.len || 0)], this.name)); }
    async abort() {}
  }
  const fileHandle = name => ({
    kind: 'file', name,
    async createWritable() { return new Writable(name); },
    async getFile() { const f = files.get(name); if (!f) throw new DOMException('gone', 'NotFoundError'); return f; },
    async move(newName) { files.set(newName, files.get(name)); files.delete(name); this.name = newName; },
  });
  const dir = {
    kind: 'directory', name: 'Lessons',
    async queryPermission() { return 'granted'; },
    async requestPermission() { return 'granted'; },
    async getFileHandle(name, opts = {}) {
      if (!files.has(name)) { if (!opts.create) throw new DOMException('missing', 'NotFoundError'); files.set(name, new File([], name)); }
      return fileHandle(name);
    },
    async removeEntry(name) { if (!files.delete(name)) throw new DOMException('missing', 'NotFoundError'); },
    async *entries() { for (const n of files.keys()) yield [n, fileHandle(n)]; },
    async *keys() { for (const n of files.keys()) yield n; },
    async isSameEntry(o) { return o === dir; },
  };
  window.showDirectoryPicker = async () => dir;
}
