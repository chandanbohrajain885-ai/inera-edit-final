// Inera Edit Flow — WebCodecs decoding with bounded memory (works for hour-long files).
// VideoFrameReader: frame-accurate access to any timestamp (keyframe-aware, B-frame safe).
// Audio: streaming decode to 16 kHz mono (analysis/ASR) or ranged decode to 48 kHz stereo (mixing).
import { FileReaderCache } from './media-demux.js';
import { checkAbort, AbortError } from './utils.js';

export const hasWebCodecs = () => typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';

function codecCandidates(codec) {
  const c = [codec];
  if (/^vp09/.test(codec)) c.push('vp09.00.10.08', 'vp09.00.41.08', 'vp09.00.51.08', 'vp09.02.10.10');
  if (/^vp8/.test(codec)) c.push('vp8');
  if (/^av01/.test(codec)) c.push('av01.0.08M.08', 'av01.0.12M.08', 'av01.0.05M.08');
  if (/^(avc1|avc3)/.test(codec)) c.push('avc1.640028', 'avc1.4d0028', 'avc1.42e01f');
  if (/^(hvc1|hev1)/.test(codec)) c.push('hvc1.1.6.L120.90', 'hev1.1.6.L120.90');
  return [...new Set(c)];
}

export async function videoDecoderConfig(v) {
  if (typeof VideoDecoder === 'undefined' || !v.codec) return null;
  for (const codec of codecCandidates(v.codec)) {
    for (const hw of ['no-preference', 'prefer-software']) {
      const cfg = { codec, codedWidth: v.codedWidth, codedHeight: v.codedHeight, hardwareAcceleration: hw };
      if (v.description) cfg.description = v.description;
      try { const r = await VideoDecoder.isConfigSupported(cfg); if (r.supported) return r.config || cfg; } catch (e) { /* try next */ }
    }
  }
  return null;
}
export async function audioDecoderConfig(a) {
  if (typeof AudioDecoder === 'undefined' || !a || !a.codec) return null;
  const cfg = { codec: a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels };
  if (a.description) cfg.description = a.description;
  try { const r = await AudioDecoder.isConfigSupported(cfg); if (r.supported) return cfg; } catch (e) { /* unsupported */ }
  if (a.description) { try { const c2 = { ...cfg }; delete c2.description; const r = await AudioDecoder.isConfigSupported(c2); if (r.supported) return c2; } catch (e) { /* unsupported */ } }
  return null;
}

// ---------------- Video ----------------
export class VideoFrameReader {
  constructor(file, video, config) {
    this.file = file; this.v = video; this.tab = video.samples; this.config = config;
    this.io = new FileReaderCache(file, 16 * 1024 * 1024);
    this.out = []; // decoded frames waiting, presentation order
    this.cur = null; // frame currently handed out
    this.feed = 0; this.dec = null; this.waiters = []; this.err = null; this.flushed = false;
    this.lastReturnedUs = -1;
    this.nOut = 0; this.stalls = 0;
    // once the hardware decoder froze on this video, every later reader of it starts in software
    if (video.swConfig) this.config = video.swConfig;
    this.swTried = /software/.test(this.config.hardwareAcceleration || '');
  }
  _make() {
    if (this.dec) { try { this.dec.close(); } catch (e) { /* closed */ } }
    for (const f of this.out) f.close(); this.out = [];
    this.err = null; this.flushed = false;
    this.dec = new VideoDecoder({
      output: (f) => { this.nOut++; this.out.push(f); this._wake(); },
      error: (e) => { this.err = e; this._wake(); },
    });
    this.dec.configure(this.config);
  }
  // A hardware decoder that stops producing frames (driver hiccup, full frame pool) must never freeze the
  // app: switch this reader to the software decoder once; if that stalls too, report it so callers move on.
  async _recover(target) {
    this.stalls++;
    if (!this.swTried) {
      this.swTried = true;
      const cfg = { ...this.config, hardwareAcceleration: 'prefer-software' };
      try { const r = await VideoDecoder.isConfigSupported(cfg); if (r.supported) { this.config = r.config || cfg; this.v.swConfig = this.config; } } catch (e) { /* keep config */ }
      this._seek(target);
      return true;
    }
    return false;
  }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach((r) => r()); }
  _wait(ms = 4000) { return new Promise((res) => { const t = setTimeout(res, ms); this.waiters.push(() => { clearTimeout(t); res(); }); }); }
  async _feedOne() {
    const i = this.feed++;
    const data = await this.io.read(this.tab.off[i], this.tab.size[i]);
    this.dec.decode(new EncodedVideoChunk({ type: this.tab.key[i] ? 'key' : 'delta', timestamp: Math.round(this.tab.pts[i] * 1e6), duration: Math.round(this.tab.dur[i] * 1e6), data }));
  }
  _seek(decodeIdx) {
    this._make();
    this.feed = this.tab.keyBefore(decodeIdx);
  }
  // Jump to the keyframe at/before time t without decoding the frames in between (fast scanning).
  jump(t) {
    const target = this.tab.indexAt(t);
    if (!this.dec || this.err) { this._seek(target); return; }
    for (const f of this.out) f.close();
    this.out = [];
    if (this.cur) { this.cur.close(); this.cur = null; }
    this.feed = this.tab.keyBefore(target);
    this.flushed = false;
  }
  // Returns the frame presented at time t (seconds). The frame stays valid until the next call.
  async frameAt(t) {
    const tab = this.tab;
    const target = tab.indexAt(t);
    const tUs = Math.round(tab.pts[target] * 1e6);
    if (this.cur && this.cur.timestamp === tUs) return this.cur;
    const behind = this.cur && tUs < this.cur.timestamp;
    const farAhead = target > this.feed + 120;
    if (!this.dec || behind || farAhead || this.err) this._seek(target);
    let guard = 0;
    const t0 = performance.now();
    let seenOut = this.nOut, lastOutAt = t0;
    for (;;) {
      // stall watchdog: input is queued but no frame has come out for a while
      const now = performance.now();
      if (this.nOut !== seenOut) { seenOut = this.nOut; lastOutAt = now; }
      if (now - lastOutAt > 4000 || now - t0 > 30000) {
        if (await this._recover(target)) { seenOut = this.nOut; lastOutAt = performance.now(); continue; }
        const e = new Error('Video decoder stalled at ' + t.toFixed(2) + 's'); e.stalled = true; throw e;
      }
      if (this.err) { const e = this.err; this.err = null; throw new Error('Video decode error: ' + (e.message || e)); }
      // drop frames older than the target, keep the best candidate
      while (this.out.length >= 2 && this.out[1].timestamp <= tUs) this.out.shift().close();
      const f0 = this.out[0];
      if (f0 && (f0.timestamp === tUs || (f0.timestamp < tUs && this.out[1]) || (f0.timestamp > tUs))) {
        if (f0.timestamp > tUs && this.cur) return this.cur; // no exact frame: hold the previous one
        if (this.cur && this.cur !== f0) this.cur.close();
        this.cur = this.out.shift();
        return this.cur;
      }
      if (this.feed < tab.n) {
        let n = 0;
        // keep only a few decoded frames alive: hardware decoders have small frame pools
        while (this.feed < tab.n && this.dec.decodeQueueSize < 8 && this.out.length < 6 && n < 16) { await this._feedOne(); n++; }
        await this._wait(n ? 1000 : 40);
      } else if (!this.flushed) {
        this.flushed = true;
        // a flush that never resolves (driver bug) must not freeze the app
        try { await Promise.race([this.dec.flush(), new Promise((r) => setTimeout(r, 5000))]); } catch (e) { /* reset during flush */ }
      } else {
        if (f0) { if (this.cur && this.cur !== f0) this.cur.close(); this.cur = this.out.shift(); return this.cur; }
        if (this.cur) return this.cur;
        throw new Error('No decodable frame near ' + t.toFixed(2) + 's');
      }
      if (++guard > 20000) { const e = new Error('Decoder stalled at ' + t.toFixed(2) + 's'); e.stalled = true; throw e; }
    }
  }
  close() {
    if (this.cur) { try { this.cur.close(); } catch (e) { /* closed */ } this.cur = null; }
    for (const f of this.out) f.close(); this.out = [];
    if (this.dec) { try { this.dec.close(); } catch (e) { /* closed */ } this.dec = null; }
  }
}

// ---------------- Audio ----------------
function audioDataToPlanar(ad) {
  const ch = ad.numberOfChannels, n = ad.numberOfFrames;
  const out = [];
  for (let c = 0; c < ch; c++) {
    const a = new Float32Array(n);
    try { ad.copyTo(a, { planeIndex: c, format: 'f32-planar' }); }
    catch (e) {
      // interleaved fallback
      const all = new Float32Array(n * ch); ad.copyTo(all, { planeIndex: 0, format: 'f32' });
      for (let i = 0; i < n; i++) a[i] = all[i * ch + c];
    }
    out.push(a);
  }
  return out;
}

// Stream-decode a whole audio track. onPcm(planar Float32Array[], startTimeSec, sampleRate)
export async function streamAudio(file, audio, config, onPcm, { signal, onProgress } = {}) {
  const tab = audio.samples, io = new FileReaderCache(file, 8 * 1024 * 1024);
  let err = null;
  const queue = [];
  const dec = new AudioDecoder({ output: (ad) => queue.push(ad), error: (e) => { err = e; } });
  dec.configure(config);
  const drain = async () => {
    while (queue.length) { const ad = queue.shift(); const pl = audioDataToPlanar(ad); const t = ad.timestamp / 1e6; const sr = ad.sampleRate; ad.close(); await onPcm(pl, t, sr); }
  };
  try {
    for (let i = 0; i < tab.n; i++) {
      checkAbort(signal);
      if (err) throw new Error('Audio decode error: ' + (err.message || err));
      const data = await io.read(tab.off[i], tab.size[i]);
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(tab.pts[i] * 1e6), duration: Math.round(tab.dur[i] * 1e6), data }));
      if (dec.decodeQueueSize > 32) await new Promise((r) => setTimeout(r, 0));
      if (queue.length > 64 || i % 64 === 0) await drain();
      if (onProgress && i % 200 === 0) onProgress(i / tab.n);
    }
    await dec.flush();
    await drain();
    if (err) throw new Error('Audio decode error: ' + (err.message || err));
  } finally { try { dec.close(); } catch (e) { /* closed */ } }
}

// ---------- PCM store: whole track at 48 kHz stereo Int16, kept on disk (OPFS) when possible ----------
export class PcmStore {
  constructor() { this.rate = 48000; this.mem = null; this.handle = null; this.writer = null; this.file = null; this.frames = 0; this.name = null; }
  static async create(duration) {
    const st = new PcmStore();
    const frames = Math.ceil((duration + 1) * 48000);
    st.frames = frames;
    try {
      const dir = await navigator.storage.getDirectory();
      st.name = 'pcm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.raw';
      st.handle = await dir.getFileHandle(st.name, { create: true });
      st.writer = await st.handle.createWritable();
    } catch (e) {
      st.handle = null; st.writer = null;
      if (frames * 4 > 900 * 1024 * 1024) throw new Error('This browser cannot store the audio of such a long video. Please use desktop Chrome or Edge for very long videos.');
      st.mem = new Int16Array(frames * 2);
    }
    return st;
  }
  async write(frameOffset, interleaved) {
    if (frameOffset < 0) { const skip = -frameOffset * 2; if (skip >= interleaved.length) return; interleaved = interleaved.subarray(skip); frameOffset = 0; }
    if (frameOffset + interleaved.length / 2 > this.frames) interleaved = interleaved.subarray(0, Math.max(0, (this.frames - frameOffset) * 2));
    if (!interleaved.length) return;
    if (this.mem) { this.mem.set(interleaved, frameOffset * 2); return; }
    await this.writer.write({ type: 'write', position: frameOffset * 4, data: interleaved.slice() });
  }
  async finish() {
    if (this.writer) { await this.writer.close(); this.writer = null; this.file = await this.handle.getFile(); }
  }
  // Read [t0, t1) as planar Float32 stereo. Out-of-range parts are silence.
  async read(t0, t1) {
    const n = Math.max(0, Math.round((t1 - t0) * this.rate));
    const L = new Float32Array(n), R = new Float32Array(n);
    let f0 = Math.round(t0 * this.rate);
    let o = 0;
    if (f0 < 0) { o = -f0; f0 = 0; }
    const f1 = Math.min(this.frames, f0 + (n - o));
    if (f1 <= f0) return [L, R];
    let data;
    if (this.mem) data = this.mem.subarray(f0 * 2, f1 * 2);
    else {
      const file = this.file || (this.handle && await this.handle.getFile());
      data = new Int16Array(await file.slice(f0 * 4, f1 * 4).arrayBuffer());
    }
    for (let i = 0; i < data.length / 2; i++) { L[o + i] = data[2 * i] / 32768; R[o + i] = data[2 * i + 1] / 32768; }
    return [L, R];
  }
  async dispose() {
    this.mem = null;
    try { if (this.writer) await this.writer.close(); } catch (e) { /* closed */ }
    try { if (this.name) { const dir = await navigator.storage.getDirectory(); await dir.removeEntry(this.name); } } catch (e) { /* already gone */ }
  }
}

// One sequential pass over the audio track produces both:
//  - pcm16: 16 kHz mono Int16 (speech recognition & analysis, ~115 MB per hour in memory)
//  - store: 48 kHz stereo Int16 on disk (mixing; random access by time)
export async function decodeAudioTrack(file, audio, config, duration, { signal, onProgress } = {}) {
  const total16 = Math.ceil((duration + 1) * 16000);
  const pcm16 = new Int16Array(total16);
  const store = await PcmStore.create(duration);
  let filled = 0;
  let pending = Promise.resolve(); let chunks = 0;
  try {
    await streamAudio(file, audio, config, async (pl, t, sr) => {
      const n = pl[0].length, ch = pl.length;
      // 16 kHz mono
      const ratio16 = sr / 16000, box = Math.max(1, Math.round(ratio16));
      const s16 = Math.round(t * 16000), n16 = Math.floor(n / ratio16);
      for (let i = 0; i < n16; i++) {
        const s0 = Math.floor(i * ratio16); let acc = 0, cnt = 0;
        for (let k = 0; k < box && s0 + k < n; k++) { for (let c = 0; c < ch; c++) acc += pl[c][s0 + k]; cnt += ch; }
        const o = s16 + i;
        if (o >= 0 && o < total16) { pcm16[o] = Math.max(-32768, Math.min(32767, Math.round((acc / Math.max(1, cnt)) * 32767))); if (o > filled) filled = o; }
      }
      // 48 kHz stereo interleaved
      const ratio = sr / 48000, n48 = Math.floor(n / ratio);
      const out = new Int16Array(n48 * 2);
      for (let i = 0; i < n48; i++) {
        const src = i * ratio, s = Math.floor(src), fr = src - s, s1 = Math.min(n - 1, s + 1);
        const l = pl[0][s] * (1 - fr) + pl[0][s1] * fr;
        const r = ch > 1 ? pl[1][s] * (1 - fr) + pl[1][s1] * fr : l;
        out[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l * 32767)));
        out[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r * 32767)));
      }
      pending = pending.then(() => store.write(Math.round(t * 48000), out));
      if (++chunks % 50 === 0) await pending; // keep the disk-write queue short
    }, { signal, onProgress });
    await pending;
    await store.finish();
  } catch (e) { await store.dispose(); throw e; }
  return { pcm16: pcm16.subarray(0, Math.min(total16, filled + 1)), store };
}
export { AbortError };
