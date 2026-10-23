// Inera Edit Flow — in-browser speech recognition worker (OpenAI Whisper, ONNX export by
// k2-fsa/sherpa-onnx, run with onnxruntime-web). Model files are downloaded once and cached
// in the browser (Cache Storage). No API keys, no audio ever leaves the device.
import * as ort from './ort.wasm.min.mjs';

import { setupOrt } from './ort-loader.js';
const ORT_BASE = new URL('./', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';

const CACHE = 'inera-models-v1';
let model = null; // { enc, dec, meta, tokens, ... }

// ---------------- model download with progress + cache ----------------
async function fetchCached(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { cacheOk = false; /* Cache Storage unavailable (private mode) */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) { const b = await hit.arrayBuffer(); onBytes(b.byteLength, b.byteLength, true); return b; }
  }
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`Model download failed (${res.status}) for ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length; onBytes(got, total, false);
  }
  const buf = new Uint8Array(got); let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(url, new Response(buf.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { cacheOk = false; /* quota: still works this session */ } }
  return buf.buffer;
}

let cacheOk = true;
async function init({ base, name, threads }) {
  if (model && model.key === base + name) return model.info;
  // thread count must be fixed before the first session is created (the pool splits the cores between engines)
  if (threads && !model) ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, threads)) : 1;
  const files = { enc: `${name}-encoder.int8.onnx`, dec: `${name}-decoder.int8.onnx`, tok: `${name}-tokens.txt` };
  const progress = {}; const totals = {};
  const report = (k) => (got, total, cached) => {
    progress[k] = got; totals[k] = total || got;
    const g = Object.values(progress).reduce((a, b) => a + b, 0), t = Object.values(totals).reduce((a, b) => a + b, 0);
    self.postMessage({ type: 'progress', phase: 'download', loaded: g, total: t, cached });
  };
  const [encBuf, decBuf, tokBuf] = await Promise.all([
    fetchCached(base + files.enc, report('enc')), fetchCached(base + files.dec, report('dec')), fetchCached(base + files.tok, report('tok')),
  ]);
  self.postMessage({ type: 'progress', phase: 'load' });
  await setupOrt(ort, ORT_BASE);
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const meta = readMeta(encBuf);
  const enc = await ort.InferenceSession.create(new Uint8Array(encBuf), opts);
  const dec = await ort.InferenceSession.create(new Uint8Array(decBuf), opts);
  const tokens = new Map();
  for (const line of new TextDecoder().decode(tokBuf).split('\n')) {
    const sp = line.trim().split(/\s+/);
    if (sp.length === 2) tokens.set(Number(sp[1]), sp[0]);
  }
  model = { key: base + name, enc, dec, meta, tokens };
  model.info = { multilingual: meta.is_multilingual === 1, layers: meta.n_text_layer, threads: ort.env.wasm.numThreads, ep: 'wasm', cached: cacheOk };
  return model.info;
}

// onnxruntime-web does not expose custom metadata, so read it from the protobuf directly.
// ModelProto.metadata_props (field 14) = StringStringEntryProto {key(1), value(2)}.
function readMeta(buf) {
  const u8 = new Uint8Array(buf);
  const td = new TextDecoder();
  let p = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = u8[p++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80); return r; };
  const out = {};
  while (p < u8.length) {
    const tag = varint(); const field = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 0) { varint(); continue; }
    if (wt === 1) { p += 8; continue; }
    if (wt === 5) { p += 4; continue; }
    if (wt !== 2) break;
    const len = varint(); const start = p; p += len;
    if (field === 14) {
      let q = start, key = '', val = '';
      while (q < start + len) {
        let t = 0, s = 0, b; do { b = u8[q++]; t += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
        let l = 0; s = 0; do { b = u8[q++]; l += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80);
        const str = td.decode(u8.subarray(q, q + l)); q += l;
        if ((t >> 3) === 1) key = str; else if ((t >> 3) === 2) val = str;
      }
      out[key] = val;
    }
  }
  const num = (k) => Number(out[k]);
  const meta = {};
  for (const k of ['n_text_layer', 'n_text_ctx', 'n_text_state', 'n_mels', 'sot', 'eot', 'translate', 'transcribe', 'no_timestamps', 'no_speech', 'blank_id', 'is_multilingual']) meta[k] = num(k);
  meta.sot_sequence = (out.sot_sequence || '').split(',').map(Number);
  meta.lang_tokens = (out.all_language_tokens || '').split(',').map(Number);
  meta.lang_codes = (out.all_language_codes || '').split(',');
  if (!meta.n_text_layer || !meta.sot) throw new Error('Unexpected Whisper model format (metadata missing).');
  return meta;
}

// ---------------- Whisper log-mel features (verified against kaldi-native-fbank) ----------------
let MEL = null, WIN = null;
function melFilters() {
  if (MEL) return MEL;
  const sr = 16000, nfft = 400, nm = 80, nb = nfft / 2 + 1;
  const fsp = 200 / 3, minLog = 1000, minLogMel = minLog / fsp, logstep = Math.log(6.4) / 27;
  const hz2mel = (f) => (f >= minLog ? minLogMel + Math.log(f / minLog) / logstep : f / fsp);
  const mel2hz = (m) => (m >= minLogMel ? minLog * Math.exp(logstep * (m - minLogMel)) : m * fsp);
  const mmax = hz2mel(sr / 2);
  const mpts = []; for (let i = 0; i < nm + 2; i++) mpts.push(mel2hz((mmax * i) / (nm + 1)));
  MEL = [];
  for (let i = 0; i < nm; i++) {
    const w = new Float32Array(nb);
    const enorm = 2 / (mpts[i + 2] - mpts[i]);
    for (let k = 0; k < nb; k++) {
      const f = (k * sr) / nfft;
      const lo = (f - mpts[i]) / (mpts[i + 1] - mpts[i]);
      const hi = (mpts[i + 2] - f) / (mpts[i + 2] - mpts[i + 1]);
      w[k] = Math.max(0, Math.min(lo, hi)) * enorm;
    }
    MEL.push(w);
  }
  WIN = new Float32Array(400);
  for (let n = 0; n < 400; n++) WIN[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / 400);
  return MEL;
}
// Whisper uses a 400-point DFT (not a power of two): compute the 201 bins with a precomputed table.
let COS = null, SIN = null;
function dftTables() {
  if (COS) return;
  COS = new Float32Array(201 * 400); SIN = new Float32Array(201 * 400);
  for (let k = 0; k < 201; k++) for (let n = 0; n < 400; n++) { const a = (-2 * Math.PI * k * n) / 400; COS[k * 400 + n] = Math.cos(a); SIN[k * 400 + n] = Math.sin(a); }
}
export function logMel(pcm) {
  const fb = melFilters(); dftTables();
  const N = pcm.length;
  const T = Math.floor((N + 80) / 160);
  const mel = new Float32Array(T * 80);
  const frame = new Float32Array(400);
  const pw = new Float32Array(201);
  let gmax = -Infinity;
  for (let t = 0; t < T; t++) {
    const off = t * 160 - 120;
    for (let n = 0; n < 400; n++) {
      let i = off + n;
      if (i < 0) i = -i - 1; else if (i >= N) i = 2 * N - 1 - i;
      if (i < 0) i = 0; if (i >= N) i = N - 1;
      frame[n] = pcm[i] * WIN[n];
    }
    for (let k = 0; k < 201; k++) {
      let re = 0, im = 0; const b = k * 400;
      for (let n = 0; n < 400; n++) { re += frame[n] * COS[b + n]; im += frame[n] * SIN[b + n]; }
      pw[k] = re * re + im * im;
    }
    for (let m = 0; m < 80; m++) {
      const w = fb[m]; let s = 0;
      for (let k = 0; k < 201; k++) s += w[k] * pw[k];
      const v = Math.log10(Math.max(s, 1e-10));
      mel[t * 80 + m] = v; if (v > gmax) gmax = v;
    }
  }
  for (let i = 0; i < mel.length; i++) mel[i] = (Math.max(mel[i], gmax - 8) + 4) / 4;
  return { mel, T };
}

// ---------------- decoding ----------------
function argmaxRange(a, lo, hi) { let b = lo, v = -Infinity; for (let i = lo; i < hi; i++) if (a[i] > v) { v = a[i]; b = i; } return b; }

// Token choice with Whisper's timestamp rules (per sequence).
function pickToken(logits, out, step, meta, withTimestamps, tsBegin, V0) {
  const lg = Float32Array.from(logits);
  const vocab = lg.length;
  lg[meta.no_timestamps] = -Infinity; lg[meta.sot] = -Infinity; lg[meta.no_speech] = -Infinity; lg[meta.translate] = -Infinity; lg[meta.transcribe] = -Infinity;
  if (!Number.isNaN(meta.blank_id) && step === 0) lg[meta.blank_id] = -Infinity;
  for (const id of meta.lang_tokens) lg[id] = -Infinity;
  if (step === 0) lg[meta.eot] = -Infinity;
  if (withTimestamps) {
    const last = out[out.length - 1], prev = out[out.length - 2];
    const lastTs = last !== undefined && last >= tsBegin;
    const prevTs = prev === undefined || prev >= tsBegin;
    if (step === 0) {
      for (let i = 0; i < tsBegin && i < vocab; i++) if (i !== meta.eot) lg[i] = -Infinity; // must start with a timestamp
      lg[meta.eot] = -Infinity;
      for (let i = tsBegin + 51; i < Math.min(V0, vocab); i++) lg[i] = -Infinity; // first timestamp <= 1.0 s
    } else if (lastTs) {
      if (prevTs) for (let i = tsBegin; i < Math.min(V0, vocab); i++) lg[i] = -Infinity; // after a pair: text
      else for (let i = 0; i < meta.eot; i++) lg[i] = -Infinity; // after text+ts: ts or eot
    }
    let lastT = -1; for (let k = out.length - 1; k >= 0; k--) if (out[k] >= tsBegin) { lastT = out[k]; break; }
    if (lastT >= 0) for (let i = tsBegin; i < (lastTs && !prevTs ? lastT : lastT + 1) && i < vocab; i++) lg[i] = -Infinity;
    let mx = -Infinity; for (let i = 0; i < vocab; i++) if (lg[i] > mx) mx = lg[i];
    if (mx > -Infinity) {
      let tsSum = 0, maxText = -Infinity;
      for (let i = tsBegin; i < Math.min(V0, vocab); i++) if (lg[i] > -Infinity) tsSum += Math.exp(lg[i] - mx);
      for (let i = 0; i < tsBegin; i++) if (lg[i] > maxText) maxText = lg[i];
      if (Math.log(tsSum + 1e-30) + mx > maxText) for (let i = 0; i < tsBegin; i++) lg[i] = -Infinity;
    }
  } else {
    for (let i = tsBegin; i < vocab; i++) lg[i] = -Infinity;
  }
  const tok = argmaxRange(lg, 0, vocab);
  let mx = -Infinity; for (let i = 0; i < logits.length; i++) if (logits[i] > mx) mx = logits[i];
  let sum = 0; for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - mx);
  return { tok, valid: lg[tok] !== -Infinity, logprob: logits[tok] - mx - Math.log(sum) };
}

// Transcription of one (or several, batched) speech chunks.
async function transcribeBatch({ pcms, language, task = 'transcribe', withTimestamps = true, job }) {
  const { enc, dec, meta, tokens } = model;
  const B = pcms.length;
  const mels = pcms.map((p) => logMel(p));
  let frames = 0;
  const uses = mels.map(({ T }) => { let f = T + 1500, u = T; if (f > 3000) { u = Math.min(T, 2950); f = 3000; } frames = Math.max(frames, f); return u; });
  const input = new Float32Array(B * 80 * frames);
  mels.forEach(({ mel }, b) => { const u = uses[b]; for (let t = 0; t < u; t++) for (let m = 0; m < 80; m++) input[b * 80 * frames + m * frames + t] = mel[t * 80 + m]; });
  const tE0 = performance.now();
  const eo = await enc.run({ [enc.inputNames[0]]: new ort.Tensor('float32', input, [B, 80, frames]) });
  const tEnc = performance.now() - tE0; const tD0 = performance.now();
  const ck = eo[enc.outputNames[0]], cv = eo[enc.outputNames[1]];
  const L = meta.n_text_layer, C = meta.n_text_ctx, S = meta.n_text_state;
  const fresh = () => [new ort.Tensor('float32', new Float32Array(L * B * C * S), [L, B, C, S]), new ort.Tensor('float32', new Float32Array(L * B * C * S), [L, B, C, S])];
  let [sk, sv] = fresh();
  const run = async (rows, offset) => { // rows: B arrays of equal length
    const n = rows[0].length;
    const tk = new BigInt64Array(B * n); rows.forEach((r, b) => r.forEach((t, i) => { tk[b * n + i] = BigInt(t); }));
    const o = await dec.run({
      [dec.inputNames[0]]: new ort.Tensor('int64', tk, [B, n]),
      [dec.inputNames[1]]: sk, [dec.inputNames[2]]: sv,
      [dec.inputNames[3]]: ck, [dec.inputNames[4]]: cv,
      [dec.inputNames[5]]: new ort.Tensor('int64', BigInt64Array.from([BigInt(offset)]), [1]),
    });
    sk = o[dec.outputNames[1]]; sv = o[dec.outputNames[2]];
    const lg = o[dec.outputNames[0]]; const V = lg.dims[2], nn = lg.dims[1];
    return Array.from({ length: B }, (_, b) => lg.data.subarray((b * nn + nn - 1) * V, (b * nn + nn) * V));
  };
  const multilingual = meta.is_multilingual === 1;
  const langs = new Array(B).fill(multilingual ? language : 'en');
  if (multilingual && !language) {
    const lg0 = await run(Array.from({ length: B }, () => [meta.sot]), 0);
    lg0.forEach((l, b) => { let best = -Infinity, bi = 0; meta.lang_tokens.forEach((id, i) => { if (l[id] > best) { best = l[id]; bi = i; } }); langs[b] = meta.lang_codes[bi]; });
    [sk, sv] = fresh();
  }
  const sots = langs.map((lang) => {
    const sot = [...meta.sot_sequence];
    if (multilingual) { const li = meta.lang_codes.indexOf(lang); if (li >= 0) sot[1] = meta.lang_tokens[li]; sot[2] = task === 'translate' ? meta.translate : meta.transcribe; }
    if (!withTimestamps) sot.push(meta.no_timestamps);
    return sot;
  });
  const tsBegin = meta.no_timestamps + 1, V0 = tsBegin + 1501;
  let offset = 0;
  let logits = await run(sots, offset);
  offset += sots[0].length;
  const noSpeech = logits.map((lgt) => { let mx = -Infinity; for (let i = 0; i < lgt.length; i++) if (lgt[i] > mx) mx = lgt[i]; let sum = 0; for (let i = 0; i < lgt.length; i++) sum += Math.exp(lgt[i] - mx); return Math.exp(lgt[meta.no_speech] - mx) / sum; });
  const outs = Array.from({ length: B }, () => []), done = new Array(B).fill(false), lp = new Array(B).fill(0);
  const maxLen = C - sots[0].length - 2;
  for (let step = 0; step < maxLen && done.some((d) => !d); step++) {
    const next = new Array(B);
    for (let b = 0; b < B; b++) {
      if (done[b]) { next[b] = meta.eot; continue; }
      const out = outs[b];
      const { tok, valid, logprob } = pickToken(logits[b], out, step, meta, withTimestamps, tsBegin, V0);
      lp[b] += logprob;
      if (tok === meta.eot || !valid) { done[b] = true; next[b] = meta.eot; continue; }
      out.push(tok); next[b] = tok;
      if (out.length > 24) { // repetition guard (hallucination loop)
        const a6 = out.slice(-12, -6).join(','), b6 = out.slice(-6).join(',');
        if (a6 === b6 && out.slice(-18, -12).join(',') === a6) { out.length -= 12; done[b] = true; }
      }
    }
    if (done.every((d) => d)) break;
    // live progress inside the chunk: the latest timestamp token tells how far into the audio we are
    if (job !== undefined && (step & 3) === 3) {
      const o0 = outs[0]; let tl = -1; for (let k = o0.length - 1; k >= 0; k--) if (o0[k] >= tsBegin) { tl = (o0[k] - tsBegin) * 0.02; break; }
      if (tl >= 0) self.postMessage({ type: 'progress', phase: 'decode', job, frac: Math.min(0.98, tl / (pcms[0].length / 16000)) });
    }
    logits = await run(next.map((t) => [t]), offset);
    offset += 1;
  }
  const tDec = performance.now() - tD0;
  return pcms.map((pcm, b) => {
    const segs = []; let open = null; let bytes = [];
    const close = (t1) => { const text = new TextDecoder().decode(new Uint8Array(bytes)).trim(); if (text) segs.push({ start: open, end: Math.max(open, t1), text }); bytes = []; open = null; };
    for (const t of outs[b]) {
      if (t >= tsBegin) { const time = (t - tsBegin) * 0.02; if (open === null) open = time; else if (bytes.length) close(time); else open = time; }
      else if (t < meta.eot) { if (open === null) open = 0; const b64 = tokens.get(t); if (b64) { const s2 = atob(b64); for (let i = 0; i < s2.length; i++) bytes.push(s2.charCodeAt(i)); } }
    }
    if (open !== null && bytes.length) close(pcm.length / 16000);
    return { language: langs[b], segments: segs, noSpeech: noSpeech[b], avgLogprob: lp[b] / Math.max(1, outs[b].length + 1), nTokens: outs[b].length, timing: { enc: Math.round(tEnc / B), dec: Math.round(tDec / B), steps: outs[b].length, batch: B } };
  });
}
// Language detection only: encoder + one decoder step on a short piece of speech.
async function detect({ pcm }) {
  const { enc, dec, meta } = model;
  if (meta.is_multilingual !== 1) return { language: 'en' };
  const { mel, T } = logMel(pcm);
  const u = Math.min(T, 1000), frames = u + 300; // short look: language only
  const input = new Float32Array(80 * frames);
  for (let t = 0; t < u; t++) for (let m = 0; m < 80; m++) input[m * frames + t] = mel[t * 80 + m];
  const eo = await enc.run({ [enc.inputNames[0]]: new ort.Tensor('float32', input, [1, 80, frames]) });
  const L = meta.n_text_layer, C = meta.n_text_ctx, S = meta.n_text_state;
  const z = () => new ort.Tensor('float32', new Float32Array(L * C * S), [L, 1, C, S]);
  const o = await dec.run({
    [dec.inputNames[0]]: new ort.Tensor('int64', BigInt64Array.from([BigInt(meta.sot)]), [1, 1]),
    [dec.inputNames[1]]: z(), [dec.inputNames[2]]: z(),
    [dec.inputNames[3]]: eo[enc.outputNames[0]], [dec.inputNames[4]]: eo[enc.outputNames[1]],
    [dec.inputNames[5]]: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
  });
  const l = o[dec.outputNames[0]].data;
  let best = -Infinity, bi = 0; meta.lang_tokens.forEach((id, i) => { if (l[id] > best) { best = l[id]; bi = i; } });
  return { language: meta.lang_codes[bi] };
}
async function transcribe(m) { return (await transcribeBatch({ ...m, pcms: [m.pcm] }))[0]; }

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') self.postMessage({ id: m.id, ok: true, result: await init(m) });
    else if (m.type === 'transcribe') self.postMessage({ id: m.id, ok: true, result: await transcribe(m) });
    else if (m.type === 'transcribeBatch') self.postMessage({ id: m.id, ok: true, result: await transcribeBatch(m) });
    else if (m.type === 'detect') self.postMessage({ id: m.id, ok: true, result: await detect(m) });
    else if (m.type === 'mel') self.postMessage({ id: m.id, ok: true, result: logMel(m.pcm) });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
