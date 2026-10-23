// Inera Edit Flow — classical face detection (no neural network, runs locally).
// Adapted from picojs (https://github.com/nenadmarkus/picojs) and the pico "facefinder" cascade
// (https://github.com/nenadmarkus/pico). Both MIT License, Copyright (c) 2013 Nenad Markus.
// See THIRD_PARTY_NOTICES.md for the full licence text.

function unpackCascade(bytes) {
  const dview = new DataView(new ArrayBuffer(4));
  const i32 = (p) => { for (let k = 0; k < 4; k++) dview.setUint8(k, bytes[p + k]); return dview.getInt32(0, true); };
  const f32 = (p) => { for (let k = 0; k < 4; k++) dview.setUint8(k, bytes[p + k]); return dview.getFloat32(0, true); };
  let p = 8;
  const tdepth = i32(p); p += 4;
  const ntrees = i32(p); p += 4;
  const pow2 = Math.pow(2, tdepth) >> 0;
  const tcodes = new Int8Array(ntrees * 4 * pow2);
  const tpreds = new Float32Array(ntrees * pow2);
  const thresh = new Float32Array(ntrees);
  for (let t = 0; t < ntrees; t++) {
    const base = t * 4 * pow2;
    const n = 4 * pow2 - 4;
    for (let k = 0; k < n; k++) tcodes[base + 4 + k] = (bytes[p + k] << 24) >> 24;
    p += n;
    for (let i = 0; i < pow2; i++) { tpreds[t * pow2 + i] = f32(p); p += 4; }
    thresh[t] = f32(p); p += 4;
  }
  return function classify(r, c, s, pixels, ldim) {
    r = 256 * r; c = 256 * c;
    let root = 0, o = 0.0;
    for (let i = 0; i < ntrees; i++) {
      let idx = 1;
      for (let j = 0; j < tdepth; j++) {
        idx = 2 * idx + (pixels[((r + tcodes[root + 4 * idx] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 1] * s) >> 8)]
          <= pixels[((r + tcodes[root + 4 * idx + 2] * s) >> 8) * ldim + ((c + tcodes[root + 4 * idx + 3] * s) >> 8)]);
      }
      o += tpreds[pow2 * i + idx - pow2];
      if (o <= thresh[i]) return -1;
      root += 4 * pow2;
    }
    return o - thresh[ntrees - 1];
  };
}

function runCascade(pixels, nrows, ncols, classify, { shiftfactor = 0.1, minsize = 20, maxsize = 1000, scalefactor = 1.1 }) {
  const dets = [];
  let scale = minsize;
  while (scale <= maxsize) {
    const step = Math.max(shiftfactor * scale, 1) >> 0;
    const offset = (scale / 2 + 1) >> 0;
    for (let r = offset; r <= nrows - offset; r += step) {
      for (let c = offset; c <= ncols - offset; c += step) {
        const q = classify(r, c, scale, pixels, ncols);
        if (q > 0) dets.push([r, c, scale, q]);
      }
    }
    scale *= scalefactor;
  }
  return dets;
}

function cluster(dets, iou) {
  dets = dets.sort((a, b) => b[3] - a[3]);
  const calc = (a, b) => {
    const overr = Math.max(0, Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2));
    const overc = Math.max(0, Math.min(a[1] + a[2] / 2, b[1] + b[2] / 2) - Math.max(a[1] - a[2] / 2, b[1] - b[2] / 2));
    return (overr * overc) / (a[2] * a[2] + b[2] * b[2] - overr * overc);
  };
  const assigned = new Uint8Array(dets.length);
  const out = [];
  for (let i = 0; i < dets.length; i++) {
    if (assigned[i]) continue;
    let r = 0, c = 0, s = 0, q = 0, n = 0;
    for (let j = i; j < dets.length; j++) {
      if (!assigned[j] && calc(dets[i], dets[j]) > iou) { assigned[j] = 1; r += dets[j][0]; c += dets[j][1]; s += dets[j][2]; q += dets[j][3]; n++; }
    }
    out.push([r / n, c / n, s / n, q]);
  }
  return out;
}

let classifierPromise = null;
export function loadFaceDetector() {
  if (!classifierPromise) {
    classifierPromise = fetch(new URL('./facefinder.bin', import.meta.url))
      .then((r) => { if (!r.ok) throw new Error('face model missing'); return r.arrayBuffer(); })
      .then((b) => unpackCascade(new Int8Array(b)))
      .catch(() => null); // detection simply disabled if unavailable
  }
  return classifierPromise;
}

// gray: Uint8Array luminance (row-major), w x h. Returns faces with normalised centre & size.
export function detectFacesSync(classify, gray, w, h, minQ = 6) {
  if (!classify) return [];
  const minsize = Math.max(16, Math.round(Math.min(w, h) * 0.06));
  const dets = cluster(runCascade(gray, h, w, classify, { shiftfactor: 0.1, minsize, maxsize: Math.min(w, h), scalefactor: 1.1 }), 0.2);
  return dets.filter((d) => d[3] >= minQ).map(([r, c, s, q]) => ({ x: c / w, y: r / h, size: s / Math.min(w, h), q }));
}

export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 2 + rgba[p + 1] * 7 + rgba[p + 2]) / 10;
  return g;
}
