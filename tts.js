// Inera Edit Flow — script → natural voice (Kokoro, in the browser) with word timings for lip-sync.
import { checkAbort } from './utils.js';

export const VOICES = {
  af_heart: 'Heart — US female (warm)', af_bella: 'Bella — US female (bright)', am_michael: 'Michael — US male (clear)',
  am_fenrir: 'Fenrir — US male (deep)', bf_emma: 'Emma — UK female', bm_george: 'George — UK male',
};
function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export function ttsUrls() {
  const o = safeGet('inera-tts-base');
  const base = o ? o.replace(/\/?$/, '/') : 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/';
  return { model: base + 'onnx/model_quantized.onnx', voices: base + 'voices/' };
}

let worker = null, seq = 0; const pending = new Map(); let progressCb = null;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { progressCb && progressCb(m); return; }
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error('Voice engine crashed: ' + (e.message || 'out of memory'))); pending.clear(); worker = null; };
  return worker;
}
const call = (msg) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); getWorker().postMessage({ ...msg, id }); });

function splitSentences(script) {
  const out = [];
  for (const para of String(script).replace(/\r/g, '').split(/\n+/)) {
    const parts = para.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [];
    for (let p of parts) {
      p = p.trim(); if (!p) continue;
      // keep chunks short enough for the model (~400 phonemes)
      while (p.length > 220) { const cut = p.lastIndexOf(',', 200) > 60 ? p.lastIndexOf(',', 200) + 1 : p.lastIndexOf(' ', 200); out.push(p.slice(0, cut).trim()); p = p.slice(cut).trim(); }
      out.push(p);
    }
    if (out.length) out[out.length - 1] += '\n';
  }
  return out.filter((s) => s.trim());
}
function trimSilence(a, sr) {
  const thr = 0.004; let s = 0, e = a.length - 1;
  while (s < a.length && Math.abs(a[s]) < thr) s++;
  while (e > s && Math.abs(a[e]) < thr) e--;
  return a.subarray(Math.max(0, s - Math.round(0.02 * sr)), Math.min(a.length, e + Math.round(0.06 * sr)));
}
function syl(w) { const x = w.toLowerCase().replace(/[^a-z]/g, ''); if (!x) return Math.max(1, Math.round(w.length / 3)); const m = x.replace(/e$/, '').match(/[aeiouy]+/g); return Math.max(1, m ? m.length : 1); }
// word timings from where the speech energy is inside the chunk
function alignChunk(text, a, sr, offset) {
  const words = text.split(/\s+/).filter(Boolean);
  const hop = Math.round(sr * 0.01), n = Math.floor(a.length / hop);
  const mass = new Float32Array(n); let tot = 0;
  for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) s += a[i] * a[i]; const v = Math.sqrt(s / hop); tot += v > 0.01 ? v : 0; mass[f] = tot; }
  const W = words.reduce((x, w) => x + syl(w) + (/[,.!?;:]$/.test(w) ? 0.5 : 0), 0);
  const at = (m) => { let lo = 0, hi = n - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (mass[mid] <= m) lo = mid + 1; else hi = mid; } return lo * 0.01; };
  let acc = 0;
  return words.map((w) => {
    const s = tot > 0 ? at((acc / W) * tot) : (acc / W) * (a.length / sr);
    acc += syl(w) + (/[,.!?;:]$/.test(w) ? 0.5 : 0);
    const e = tot > 0 ? at((acc / W) * tot - 1e-6) + 0.01 : (acc / W) * (a.length / sr);
    return { w, s: +(offset + s).toFixed(3), e: +(offset + Math.max(s + 0.08, e)).toFixed(3) };
  });
}

// Pre-load the voice model in the background (when Avatar Studio opens) so "Create" starts instantly.
let initP = null;
function initTts() {
  if (!initP) { const urls = ttsUrls(); initP = call({ type: 'init', base: urls.model, voiceBase: urls.voices }); initP.catch(() => { initP = null; }); }
  return initP;
}
export function preloadTts() { initTts().catch(() => {}); }

export async function speakScript(script, { voice = 'af_heart', speed = 1, onProgress, onDownload, signal } = {}) {
  const sentences = splitSentences(script);
  if (!sentences.length) throw new Error('The script is empty.');
  progressCb = onDownload;
  const urls = ttsUrls();
  try { await initTts(); void urls; }
  catch (e) { throw new Error(`Could not load the voice model (${e.message}). It is downloaded once (~90 MB from huggingface.co) and then cached.`); }
  const SR = 24000;
  const chunks = []; const words = []; const sents = [];
  let t = 0.25; // lead-in
  chunks.push(new Float32Array(Math.round(0.25 * SR)));
  for (let i = 0; i < sentences.length; i++) {
    checkAbort(signal);
    const text = sentences[i].trim();
    const r = await call({ type: 'synth', text, voiceName: voice, speed });
    const a = trimSilence(r.audio, SR);
    const ws = alignChunk(text, a, SR, t);
    words.push(...ws); sents.push({ text, s: t, e: t + a.length / SR });
    chunks.push(a); t += a.length / SR;
    const pause = /\n$/.test(sentences[i]) ? 0.6 : /[!?]["')\]]*$/.test(text) ? 0.42 : /[.…]["')\]]*$/.test(text) ? 0.34 : 0.18;
    chunks.push(new Float32Array(Math.round(pause * SR))); t += pause;
    onProgress && onProgress((i + 1) / sentences.length);
  }
  const total = chunks.reduce((x, c) => x + c.length, 0);
  const audio = new Float32Array(total); let o = 0;
  for (const c of chunks) { audio.set(c, o); o += c.length; }
  // gentle peak normalisation
  let pk = 0; for (let i = 0; i < audio.length; i++) pk = Math.max(pk, Math.abs(audio[i]));
  if (pk > 0) { const g = Math.min(3, 0.9 / pk); for (let i = 0; i < audio.length; i++) audio[i] *= g; }
  return { audio, sampleRate: SR, words, sentences: sents, duration: total / SR };
}
