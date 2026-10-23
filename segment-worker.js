// Inera Edit Flow — subject segmentation (U^2-Net small "u2netp", Apache-2.0) via onnxruntime-web.
import * as ort from './ort.wasm.min.mjs';
import { setupOrt } from './ort-loader.js';
const ORT_BASE = new URL('./', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
ort.env.logLevel = 'error';
let session = null;
async function load() {
  if (session) return session;
  const r = await fetch(new URL('./u2netp.onnx', import.meta.url));
  if (!r.ok) throw new Error('segmentation model missing');
  await setupOrt(ort, ORT_BASE);
  session = await ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'] });
  return session;
}
// rgba: 320x320 RGBA. Returns Float32Array 320x320 foreground probability (0..1).
async function segment(rgba) {
  const s = await load();
  const N = 320 * 320, x = new Float32Array(3 * N);
  let mx = 1; for (let i = 0; i < rgba.length; i += 4) mx = Math.max(mx, rgba[i], rgba[i + 1], rgba[i + 2]);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) x[c * N + i] = (rgba[i * 4 + c] / mx - mean[c]) / std[c];
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, 320, 320]) });
  const d = out[s.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
  const m = new Float32Array(N); const r = hi - lo || 1;
  for (let i = 0; i < N; i++) m[i] = (d[i] - lo) / r;
  return m;
}
self.onmessage = async (e) => {
  const m = e.data;
  try { const r = await segment(new Uint8ClampedArray(m.buffer)); self.postMessage({ id: m.id, ok: true, mask: r }, [r.buffer]); }
  catch (err) { self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) }); }
};
