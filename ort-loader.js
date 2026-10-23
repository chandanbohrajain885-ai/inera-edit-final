// Inera Edit Flow — loads the ONNX Runtime WebAssembly binary, stored gzip-compressed (3.7 MB instead of
// 14.2 MB, so the repo uploads easily), checks its size, and keeps it in Cache Storage for instant reloads.
import { fetchBytes as fetchPacked } from './gz.js';
const PACKED = 'ort-runtime.wasm.dat';
const TOTAL = 14239897; // bytes of ort-wasm-simd-threaded.wasm (onnxruntime-web 1.30, CPU build: 22% faster than the GPU-capable build)
const CACHE = 'inera-runtime-v1';
let binP = null;

async function load(base) {
  const key = new URL('ort-wasm-runtime-' + TOTAL + '.wasm', base).href;
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { /* Cache Storage unavailable */ }
  if (cache) {
    try { const hit = await cache.match(key); if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (b.byteLength === TOTAL) return b; } } catch (e) { /* re-download */ }
  }
  const bin = await fetchPacked(new URL(PACKED, base).href);
  if (bin.byteLength !== TOTAL) throw new Error(`AI runtime file is damaged (${bin.byteLength} of ${TOTAL} bytes). Re-upload ${PACKED}.`);
  if (cache) {
    try { await cache.put(key, new Response(bin.slice(), { headers: { 'content-type': 'application/wasm' } })); } catch (e) { /* quota */ }
    try { for (const r of await cache.keys()) if (r.url !== key) await cache.delete(r); } catch (e) { /* old runtimes stay until the browser evicts them */ }
  }
  return bin;
}
// Call once in a worker before creating any InferenceSession.
export async function setupOrt(ort, base) {
  if (!binP) { binP = load(base); binP.catch(() => { binP = null; }); }
  const bin = await binP;
  ort.env.wasm.wasmPaths = base; // the small JS glue file still loads from the site
  ort.env.wasm.wasmBinary = bin;
}
