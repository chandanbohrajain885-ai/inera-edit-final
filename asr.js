// Inera Edit Flow — speech-to-text orchestration: voice-activity chunking, Whisper worker,
// segment refinement and word-level timing (energy-weighted syllable alignment).
import { clamp, checkAbort, AbortError } from './utils.js';

export const ASR_MODELS = {
  base: { name: 'base', label: 'Accurate (Whisper base, ~160 MB, one-time download)', sizeMB: 160 },
  tiny: { name: 'tiny', label: 'Fast (Whisper tiny, ~100 MB, one-time download)', sizeMB: 100 },
};
// Public, key-free model hosting (Hugging Face mirrors of the k2-fsa/sherpa-onnx Whisper export).
export function defaultModelBase(name) {
  const override = (typeof localStorage !== 'undefined' && safeGet('inera-model-base')) || '';
  if (override) return override.replace(/\/?$/, '/');
  return `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${name}/resolve/main/`;
}
function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

// ---------- parallel speech engines ----------
// Several Whisper engines (one worker each) transcribe different pieces of the audio at the same time.
// Measured: 2 engines x 1 thread are ~1.5x faster than 1 engine x 2 threads, because the decoder runs
// one small step per word and cannot keep many threads busy.
class Engine {
  constructor(onMsg) {
    this.seq = 0; this.pending = new Map(); this.dead = false;
    this.w = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { onMsg(m); return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    };
    this.w.onerror = (e) => { this.dead = true; this.fail(new Error('Speech engine crashed: ' + ((e && e.message) || 'out of memory'))); };
  }
  call(msg, transfer) { if (this.dead) return Promise.reject(new Error('Speech engine stopped')); return new Promise((resolve, reject) => { const id = ++this.seq; this.pending.set(id, { resolve, reject }); this.w.postMessage({ ...msg, id }, transfer || []); }); }
  fail(err) { for (const p of this.pending.values()) p.reject(err); this.pending.clear(); }
  terminate() { this.dead = true; try { this.w.terminate(); } catch (e) { /* ignore */ } this.fail(new AbortError()); }
}
// How many engines this computer can run. Each engine is ONE single-threaded worker: several single
// threads never spin-wait on each other, so they cannot starve the rest of the app (video decoding,
// the page itself) the way one big multi-threaded engine can on a busy laptop.
export function asrPlan(name = 'tiny') {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  // leave one core for the page + video decoding, one for the browser itself
  let n = clamp(hc - 2, 1, 4);
  const mem = typeof navigator !== 'undefined' ? navigator.deviceMemory : 0;
  if (mem && mem <= 2) n = 1; else if (mem && mem <= 4) n = Math.min(n, 2);
  if (name === 'base') n = Math.min(n, 3);
  const forced = Number(safeGet('inera-asr-engines')); if (forced >= 1 && forced <= 8) n = forced;
  return { engines: n, threads: 1 };
}
let pool = null; // { name, engines: [{ eng, ready }], first, plan, onDownload, jobs }
let jobSeq = 0;
function makePool(name) {
  const plan = asrPlan(name);
  const base = defaultModelBase(name);
  const P = { name, plan, engines: [], onDownload: null, jobs: new Map() };
  const onMsg = (i) => (m) => {
    if (m.phase === 'decode') { const j = P.jobs.get(m.job); if (j) j(m.frac); return; }
    if (i === 0 && P.onDownload) P.onDownload(m); // the first engine downloads; the others read the browser cache
  };
  const start = (i) => {
    const eng = new Engine(onMsg(i));
    const ready = eng.call({ type: 'init', base, name, threads: plan.threads });
    ready.catch(() => {});
    P.engines.push({ eng, ready });
    return ready;
  };
  P.first = start(0).catch((e) => {
    if (pool === P) pool = null;
    throw new Error(`Could not load the speech model (${e.message}). Check your internet connection for the one-time download (from huggingface.co). After the first download it is cached and works offline.`);
  });
  // more engines once the model is in the browser cache (so it is downloaded only once)
  P.first.then((info) => { if (pool !== P) return; const n = info.cached === false ? 1 : plan.engines; for (let i = 1; i < n; i++) start(i); }).catch(() => {});
  return P;
}
export async function loadAsr(modelName = 'tiny', onDownload) {
  if (!pool || pool.name !== modelName) { terminateAsr(); pool = makePool(modelName); }
  if (onDownload) pool.onDownload = onDownload;
  const info = await pool.first;
  return { ...info, engines: pool.plan.engines, threads: pool.plan.threads };
}
export function terminateAsr() { if (pool) { for (const e of pool.engines) e.eng.terminate(); pool = null; } }
// Start downloading/initialising the speech engines in the background (no UI, errors ignored).
export function preloadAsr(modelName = 'auto', language) { loadAsr(modelName === 'auto' ? (language && language !== 'en' ? 'base' : 'tiny') : modelName).catch(() => {}); }

// ---------- Voice-activity detection on 16 kHz mono PCM (Int16 or Float32) ----------
const HOP = 0.02; // 20 ms frames
export function speechFrames(pcm) {
  const hop = 320, n = Math.floor(pcm.length / hop);
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  const e = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) { const v = pcm[i] * scale; s += v * v; } e[f] = Math.sqrt(s / hop); }
  const sorted = Float32Array.from(e).filter((x) => x > 1e-5).sort();
  const noise = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 1e-4;
  const thr = Math.max(noise * 3, 0.004);
  const act = new Uint8Array(n);
  for (let f = 0; f < n; f++) act[f] = e[f] > thr ? 1 : 0;
  // hangover 200 ms, fill gaps < 160 ms
  const fill = 8; let last = -1e9;
  for (let f = 0; f < n; f++) { if (act[f]) { if (f - last <= fill) for (let k = last + 1; k < f; k++) act[k] = 1; last = f; } }
  return { energy: e, active: act, hop: HOP, noise, thr };
}
export function speechRegions(vad, minGap = 0.35) {
  const out = []; const { active, hop } = vad; let f = 0;
  while (f < active.length) {
    if (!active[f]) { f++; continue; }
    let e = f; while (e < active.length && active[e]) e++;
    const s = f * hop, en = e * hop;
    const last = out[out.length - 1];
    if (last && s - last.e < minGap) last.e = en; else if (en - s >= 0.12) out.push({ s, e: en });
    f = e;
  }
  return out;
}
// Merge speech regions into Whisper-sized chunks (<= maxLen s), splitting at quiet points.
function buildChunks(regions, vad, total, maxLen = 26) {
  const chunks = [];
  let cur = null;
  for (const r of regions) {
    if (cur && r.e - cur.s <= maxLen && r.s - cur.e < 2.0) { cur.e = r.e; continue; }
    if (cur) chunks.push(cur);
    cur = { s: r.s, e: r.e };
  }
  if (cur) chunks.push(cur);
  const out = [];
  for (const c of chunks) {
    let s = c.s;
    while (c.e - s > maxLen) {
      // split at the lowest-energy frame between s+maxLen*0.6 and s+maxLen
      const a = Math.floor((s + maxLen * 0.6) / vad.hop), b = Math.floor((s + maxLen) / vad.hop);
      let bi = b, bv = Infinity; for (let f = a; f < b; f++) if (vad.energy[f] < bv) { bv = vad.energy[f]; bi = f; }
      out.push({ s, e: bi * vad.hop }); s = bi * vad.hop;
    }
    out.push({ s, e: c.e });
  }
  return out.map((c) => ({ s: Math.max(0, c.s - 0.25), e: Math.min(total, c.e + 0.3) }));
}

// ---------- word timing ----------
function syllables(w) {
  const x = w.toLowerCase().replace(/[^a-zÀ-ɏ]/g, '');
  if (!x) return Math.max(1, Math.round(w.replace(/\s/g, '').length / 3)); // numbers / other scripts
  const m = x.replace(/e$/, '').match(/[aeiouyà-ÿ]+/g);
  return Math.max(1, m ? m.length : 1);
}
// Distribute words over [s,e] following where the speech energy actually is.
function alignWords(text, s, e, vad) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const f0 = Math.max(0, Math.floor(s / vad.hop)), f1 = Math.min(vad.energy.length, Math.ceil(e / vad.hop));
  const mass = []; let tot = 0;
  for (let f = f0; f < f1; f++) { const v = vad.active[f] ? Math.max(vad.energy[f], vad.thr) : 0; tot += v; mass.push(tot); }
  const weights = words.map((w) => syllables(w) + (/[,.!?;:]$/.test(w) ? 0.6 : 0));
  const W = weights.reduce((a, b) => a + b, 0);
  // strict=true: first frame where speech mass EXCEEDS m (a word starts where speech starts);
  // strict=false: first frame where mass reaches m (a word ends where its speech ends)
  const timeAtMass = (m, strict) => {
    let lo = 0, hi = mass.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (strict ? mass[mid] <= m : mass[mid] < m) lo = mid + 1; else hi = mid; }
    return (f0 + lo + (strict ? 0 : 1)) * vad.hop;
  };
  const out = []; let acc = 0;
  for (let i = 0; i < words.length; i++) {
    const a = tot > 0 ? timeAtMass((acc / W) * tot, true) : s + ((e - s) * acc) / W;
    acc += weights[i];
    const b = tot > 0 ? timeAtMass((acc / W) * tot - 1e-9, false) : s + ((e - s) * acc) / W;
    out.push({ w: words[i], s: +a.toFixed(3), e: +Math.max(a + 0.08, b).toFixed(3) });
  }
  return out;
}
// Snap a coarse Whisper segment to the actual speech boundaries nearby.
function refineSegment(seg, vad) {
  const near = (t, dir) => {
    const f = Math.round(t / vad.hop), R = Math.round(0.7 / vad.hop);
    if (dir > 0) { for (let k = 0; k <= R; k++) { const a = f + k, b = f - k; if (vad.active[a] && !vad.active[a - 1]) return a * vad.hop; if (b > 0 && vad.active[b] && !vad.active[b - 1]) return b * vad.hop; } }
    else { for (let k = 0; k <= R; k++) { const a = f - k, b = f + k; if (vad.active[a - 1] && !vad.active[a]) return a * vad.hop; if (vad.active[b - 1] && !vad.active[b]) return b * vad.hop; } }
    return t;
  };
  const s = near(seg.start, 1), e = near(seg.end, -1);
  return e - s > 0.15 ? { ...seg, start: s, end: e } : seg;
}

// pcm: Int16Array or Float32Array at 16 kHz mono. Returns {language, segments:[{start,end,text,words}]}
// model: 'auto' (fast "tiny" for English, accurate "base" for other languages), 'base' or 'tiny'.
export async function transcribe(pcm, { model = 'auto', language, onProgress, signal, onDownload } = {}) {
  const total = pcm.length / 16000;
  const vad = speechFrames(pcm);
  const regions = speechRegions(vad);
  if (!regions.length) return { language: language || null, segments: [], speechSeconds: 0, vad };
  let name = model === 'auto' ? (language && language !== 'en' ? 'base' : 'tiny') : model;
  const onAbort = () => terminateAsr();
  if (signal) { checkAbort(signal); signal.addEventListener('abort', onAbort); }
  try {
    let info = await loadAsr(name, onDownload);
    checkAbort(signal);
    // chunk length: short enough that every engine gets work, long enough to keep Whisper's context
    const rawSpeech = regions.reduce((a, r) => a + (r.e - r.s), 0);
    const maxLen = clamp(Math.ceil(rawSpeech / pool.plan.engines) + 1, 10, 26);
    const chunks = buildChunks(regions, vad, total, maxLen);
    const speechSeconds = chunks.reduce((a, c) => a + (c.e - c.s), 0);
    const slice = (c) => { const a = Math.floor(c.s * 16000), b = Math.floor(c.e * 16000); const f = new Float32Array(b - a); if (pcm instanceof Int16Array) for (let i = 0; i < f.length; i++) f[i] = pcm[a + i] / 32768; else f.set(pcm.subarray(a, b)); return f; };
    // 1. language: one quick look at the first speech (encoder + one step), then every engine uses it
    let lang = language || null;
    if (!lang) {
      const c0 = chunks[0]; const f = slice({ s: c0.s, e: Math.min(c0.e, c0.s + 10) }); // 10 s is plenty to tell the language
      let tm; // language check normally takes ~1 s; never wait more than 30 s for it
      lang = (await Promise.race([pool.engines[0].eng.call({ type: 'detect', pcm: f }, [f.buffer]), new Promise((r) => { tm = setTimeout(() => r({}), 30000); })]).finally(() => clearTimeout(tm))).language || 'en';
      checkAbort(signal);
      if (model === 'auto' && name === 'tiny' && lang !== 'en') { // not English: the accurate model handles it far better
        name = 'base'; info = await loadAsr(name, onDownload); checkAbort(signal);
      }
    }
    // 2. all engines pull pieces from one queue
    const P = pool;
    const segments = [], timings = [];
    const queue = chunks.map((c, i) => i);
    const partial = new Map(); let doneSec = 0, lastP = -1;
    const report = () => {
      let p = doneSec; for (const [i, fr] of partial) p += fr * (chunks[i].e - chunks[i].s);
      const v = clamp(p / speechSeconds, 0, 1);
      if (onProgress && v - lastP >= 0.005) { lastP = v; onProgress(v); }
    };
    const handle = (c, r) => {
      if (r.timing) timings.push({ ...r.timing, ep: 'wasm', model: name });
      const hallucinated = r.noSpeech > 0.6 && r.avgLogprob < -1;
      if (hallucinated) return;
      for (const sg of r.segments) {
        const seg = refineSegment({ start: c.s + sg.start, end: Math.min(c.e, c.s + Math.max(sg.end, sg.start + 0.3)), text: sg.text }, vad);
        if (!seg.text || /^\[.*\]$|^\(.*\)$/.test(seg.text)) continue; // [music], (applause) etc.
        seg.words = alignWords(seg.text, seg.start, seg.end, vad);
        if (seg.words.length) { seg.start = seg.words[0].s; seg.end = Math.max(seg.start + 0.2, seg.words[seg.words.length - 1].e); }
        segments.push(seg);
      }
    };
    let lastErr = null, used = 0;
    const tries = new Map(), skipped = [];
    const runEngine = async (slot) => {
      try { await slot.ready; } catch (e) { lastErr = e; return; }
      used++;
      while (queue.length) {
        if (signal && signal.aborted) return;
        const i = queue.shift(); const c = chunks[i];
        const job = ++jobSeq; partial.set(i, 0);
        P.jobs.set(job, (fr) => { partial.set(i, fr); report(); });
        // hard time limit per piece: a stuck or extremely slow engine is stopped and the piece goes back
        // to the queue for the other engines, so speech-to-text can never hang the edit
        const limitMs = Number(safeGet('inera-asr-limit-ms')) || 45000 + (c.e - c.s) * 6000; // (override for testing)
        let timer = null;
        const run = (f) => Promise.race([
          slot.eng.call({ type: 'transcribe', pcm: f, language: lang, job }, [f.buffer]),
          new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Speech engine too slow on this computer'), { slow: true })), limitMs); }),
        ]).finally(() => clearTimeout(timer));
        try {
          let r;
          try { r = await run(slice(c)); }
          catch (e) { if (e.slow || slot.eng.dead || (signal && signal.aborted)) throw e; r = await run(slice(c)); } // one retry
          handle(c, r);
          doneSec += c.e - c.s;
        } catch (e) {
          if (signal && signal.aborted) return;
          if (e.slow) { slot.eng.terminate(); tries.set(i, (tries.get(i) || 0) + 1); if (tries.get(i) >= 2) { skipped.push(c); return; } }
          queue.unshift(i); lastErr = e; return; // this engine failed: the others take the piece
        } finally { partial.delete(i); P.jobs.delete(job); report(); }
      }
    };
    // every engine works through the queue; engines still starting join as soon as they are ready
    await Promise.all(P.engines.map(runEngine));
    checkAbort(signal);
    if (P.engines.some((e) => e.eng.dead)) { if (pool === P) pool = null; for (const e of P.engines) if (!e.eng.dead) e.eng.terminate(); } // fresh engines next time
    // whatever could not be transcribed in time is left without captions instead of blocking the edit
    for (const i of queue) skipped.push(chunks[i]);
    if (!segments.length && skipped.length === chunks.length && lastErr && !lastErr.slow) throw lastErr;
    const missing = skipped.reduce((a, c) => a + (c.e - c.s), 0);
    // de-overlap consecutive segments
    segments.sort((x, y) => x.start - y.start);
    for (let i = 1; i < segments.length; i++) if (segments[i].start < segments[i - 1].end) segments[i - 1].end = Math.max(segments[i - 1].start + 0.2, segments[i].start);
    return { language: lang, segments, speechSeconds, vad, timings, missingSeconds: missing, engine: { model: name, ep: 'wasm', engines: Math.max(1, used), threads: P.plan.threads } };
  } finally { signal && signal.removeEventListener('abort', onAbort); }
}

// ---------- caption file exports ----------
const ts = (t, sep) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), ms = Math.round((t % 1) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`; };
export function toSRT(segments) { return segments.map((s, i) => `${i + 1}\n${ts(s.start, ',')} --> ${ts(s.end, ',')}\n${s.text}\n`).join('\n'); }
export function toVTT(segments) { return 'WEBVTT\n\n' + segments.map((s) => `${ts(s.start, '.')} --> ${ts(s.end, '.')}\n${s.text}\n`).join('\n'); }
