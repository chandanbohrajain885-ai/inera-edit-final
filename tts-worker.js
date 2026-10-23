// Inera Edit Flow — neural text-to-speech worker: Kokoro-82M (Apache-2.0) via onnxruntime-web.
// Text → phonemes with the HeadTTS English G2P (MIT, CMUdict-based, no eSpeak) → Kokoro → 24 kHz audio.
import * as ort from './ort.wasm.min.mjs';
import { Language } from './headtts-language-en-us.mjs';

import { setupOrt } from './ort-loader.js';
import { fetchBytes } from './gz.js';
const ORT_BASE = new URL('./', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';

// Kokoro v1.0 phoneme vocabulary (from the model config)
const VOCAB = {";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177};

const CACHE = 'inera-models-v1';
let session = null, sessionKey = '', lang = null;
const voices = new Map();

async function fetchCached(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { /* no cache storage */ }
  if (cache) { const hit = await cache.match(url); if (hit) { const b = await hit.arrayBuffer(); onBytes && onBytes(b.byteLength, b.byteLength); return b; } }
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes && onBytes(got, total); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  if (cache) { try { await cache.put(url, new Response(buf.slice().buffer)); } catch (e) { /* quota */ } }
  return buf.buffer;
}

// ---- English number normalisation (G2P reads digits one by one otherwise) ----
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function intWords(n) {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + intWords(n % 100) : '');
  for (const [v, w] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) if (n >= v) return intWords(Math.floor(n / v)) + ' ' + w + (n % v ? ' ' + intWords(n % v) : '');
  return String(n);
}
export function normalizeNumbers(text) {
  return text
    .replace(/([$₹€£])\s?(\d[\d,]*(?:\.\d+)?)/g, (_, c, n) => `${n} ${({ $: 'dollars', '₹': 'rupees', '€': 'euros', '£': 'pounds' })[c]}`)
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, '$1 percent')
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\b/g, (m, a, b) => {
      const n = parseInt(a.replace(/,/g, ''), 10);
      if (!Number.isFinite(n) || n > 999999999999) return m;
      const yearLike = !b && n >= 1100 && n <= 2099 && !/,/.test(a);
      let w = yearLike && n % 100 !== 0 && Math.floor(n / 100) % 10 !== 0 ? intWords(Math.floor(n / 100)) + ' ' + (n % 100 < 10 ? 'oh ' + ONES[n % 100] : intWords(n % 100)) : intWords(n);
      if (b) w += ' point ' + b.split('').map((d) => ONES[+d]).join(' ');
      return w;
    });
}

async function init({ base, voiceBase }) {
  if (session && sessionKey === base) return true;
  const model = await fetchCached(base, (g, t) => self.postMessage({ type: 'progress', loaded: g, total: t }));
  await setupOrt(ort, ORT_BASE);
  session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'] });
  sessionKey = base;
  if (!lang) { lang = new Language({}); const dict = await fetchBytes(new URL('./headtts-dict-en-us.dat', import.meta.url).href); const u = URL.createObjectURL(new Blob([dict], { type: 'text/plain' })); try { await lang.loadDictionary(u); } finally { URL.revokeObjectURL(u); } }
  self.voiceBase = voiceBase;
  return true;
}
async function voice(name) {
  if (voices.has(name)) return voices.get(name);
  const buf = await fetchCached(self.voiceBase.replace(/\/?$/, '/') + name + '.bin');
  const v = new Float32Array(buf);
  voices.set(name, v);
  return v;
}
function phonemize(text) {
  const r = lang.generate(normalizeNumbers(text));
  return r.phonemes.join('').replace(/\s+/g, ' ').trim();
}
async function synth({ text, voiceName = 'af_heart', speed = 1 }) {
  const ph = phonemize(text);
  const ids = [];
  for (const ch of ph) { const id = VOCAB[ch]; if (id !== undefined) ids.push(id); }
  const toks = ids.slice(0, 510);
  const v = await voice(voiceName);
  const row = Math.min(toks.length, 509);
  const style = v.slice(row * 256, row * 256 + 256);
  const names = session.inputNames;
  const feeds = {};
  feeds[names.find((n) => /token|input_ids/.test(n)) || names[0]] = new ort.Tensor('int64', BigInt64Array.from([0, ...toks, 0].map(BigInt)), [1, toks.length + 2]);
  feeds[names.find((n) => /style/.test(n)) || names[1]] = new ort.Tensor('float32', style, [1, 256]);
  feeds[names.find((n) => /speed/.test(n)) || names[2]] = new ort.Tensor('float32', new Float32Array([speed]), [1]);
  const out = await session.run(feeds);
  const audio = out[session.outputNames.find((n) => /audio|waveform/.test(n)) || session.outputNames[0]].data;
  return { audio: Float32Array.from(audio), phonemes: ph, tokens: toks.length };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') self.postMessage({ id: m.id, ok: true, result: await init(m) });
    else if (m.type === 'synth') { const r = await synth(m); self.postMessage({ id: m.id, ok: true, result: r }, [r.audio.buffer]); }
    else if (m.type === 'phonemize') self.postMessage({ id: m.id, ok: true, result: phonemize(m.text) });
  } catch (err) { self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) }); }
};
