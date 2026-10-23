// Inera Edit Flow — prompt understanding worker: all-MiniLM-L6-v2 sentence embeddings (Apache-2.0,
// ONNX int8, 23 MB, downloaded once and cached) → matches prompt phrases to the meaning library by similarity.
import * as ort from './ort.wasm.min.mjs';
import { setupOrt } from './ort-loader.js';
import { fetchText } from './gz.js';
import { WordPiece } from './nlu-tokenizer.js';
import { VIDEO_INTENTS, IMAGE_INTENTS } from './prompt-intents.js';

const ORT_BASE = new URL('./', import.meta.url).href;
ort.env.wasm.numThreads = 1; // tiny model: single thread is fastest to start
ort.env.logLevel = 'error';
const CACHE = 'inera-models-v1';
let session = null, tok = null, bank = null;

async function fetchCached(url) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { /* no cache storage */ }
  if (cache) { const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); }
  const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) throw new Error(`Language model download failed (${r.status})`);
  const b = await r.arrayBuffer();
  if (cache) { try { await cache.put(url, new Response(b.slice(0))); } catch (e) { /* quota */ } }
  return b;
}
async function embed(texts) {
  const enc = texts.map((t) => tok.encode(t, 64));
  const L = Math.max(...enc.map((e) => e.length)), B = enc.length;
  const ids = new BigInt64Array(B * L), mask = new BigInt64Array(B * L), types = new BigInt64Array(B * L);
  enc.forEach((e, b) => e.forEach((id, i) => { ids[b * L + i] = BigInt(id); mask[b * L + i] = 1n; }));
  const out = await session.run({ input_ids: new ort.Tensor('int64', ids, [B, L]), attention_mask: new ort.Tensor('int64', mask, [B, L]), token_type_ids: new ort.Tensor('int64', types, [B, L]) });
  const h = out[session.outputNames[0]].data; const D = 384;
  const res = [];
  for (let b = 0; b < B; b++) {
    const v = new Float32Array(D); const n = enc[b].length;
    for (let i = 0; i < n; i++) for (let d = 0; d < D; d++) v[d] += h[(b * L + i) * D + d];
    let norm = 0; for (let d = 0; d < D; d++) { v[d] /= n; norm += v[d] * v[d]; }
    norm = Math.sqrt(norm) || 1; for (let d = 0; d < D; d++) v[d] /= norm;
    res.push(v);
  }
  return res;
}
async function embedMany(texts, size = 32) { const out = []; for (let i = 0; i < texts.length; i += size) out.push(...await embed(texts.slice(i, i + size))); return out; }

async function init({ modelUrl }) {
  if (session) return true;
  const [model, vocab] = await Promise.all([fetchCached(modelUrl), fetchText(new URL('./nlu-vocab.dat', import.meta.url).href)]);
  await setupOrt(ort, ORT_BASE);
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
  tok = new WordPiece(vocab);
  bank = {};
  for (const [kind, list] of [['video', VIDEO_INTENTS], ['image', IMAGE_INTENTS]]) {
    const ex = [], lab = [];
    list.forEach((it, k) => it.ex.forEach((e) => { ex.push(e); lab.push(k); }));
    bank[kind] = { vecs: await embedMany(ex), lab, list };
  }
  return true;
}
// For each phrase: best intent index + similarity
async function match({ kind, phrases }) {
  const B = bank[kind]; if (!B || !phrases.length) return [];
  const vs = await embedMany(phrases);
  return vs.map((v) => {
    const best = new Map();
    B.vecs.forEach((e, j) => { let s = 0; for (let d = 0; d < 384; d++) s += e[d] * v[d]; const k = B.lab[j]; if (!best.has(k) || s > best.get(k)) best.set(k, s); });
    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
    return { top: ranked[0][0], sim: ranked[0][1], second: ranked[1] ? ranked[1][0] : null, sim2: ranked[1] ? ranked[1][1] : 0 };
  });
}
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') self.postMessage({ id: m.id, ok: true, result: await init(m) });
    else if (m.type === 'match') self.postMessage({ id: m.id, ok: true, result: await match(m) });
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) }); }
};
