// Inera Edit Flow — fetch a file that is stored gzip-compressed in the repo (keeps the upload small).
// Works whether or not the host already decompressed it (checks the gzip magic bytes).
export async function fetchBytes(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`App file missing: ${String(url).split('/').pop()} (HTTP ${r.status}). Upload all files of the app.`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to unpack the app files. Please update Chrome, Edge, Firefox or Safari.');
    const out = new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip')));
    return new Uint8Array(await out.arrayBuffer());
  }
  return b;
}
export async function fetchText(url) { return new TextDecoder().decode(await fetchBytes(url)); }
