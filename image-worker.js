/* Inera Edit Flow — image analysis & enhancement worker (module worker, runs off the main thread).
   Classical computer-vision measurements + face detection + a tone/colour pipeline. No network access
   except loading the bundled face model (facefinder.bin) from this same site. */
import { loadFaceDetector, detectFacesSync, toGray } from './face-detect.js';

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function isSkin(r, g, b) {
  // YCbCr skin rule (works across a broad range of skin tones in normal light)
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && r > g && r > b - 10;
}

function analyze(w, h, d) {
  const n = w * h;
  const L = new Float32Array(n);
  const hist = new Uint32Array(256);
  let sr = 0, sg = 0, sb = 0, satSum = 0;
  let skin = 0, skinX = 0, skinY = 0, skinCenter = 0;
  let sky = 0, green = 0, dark = 0, clip = 0, rg = 0, yb = 0, rg2 = 0, yb2 = 0, warm = 0;
  const skinCols = new Float32Array(16);
  let skinMinX = 1, skinMaxX = 0, skinMinY = 1, skinMaxY = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    L[i] = l;
    hist[Math.min(255, Math.round(l * 255))]++;
    sr += r; sg += g; sb += b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    satSum += mx ? (mx - mn) / mx : 0;
    const x = (i % w) / w, y = Math.floor(i / w) / h;
    if (isSkin(r, g, b)) {
      skin++; skinX += x; skinY += y;
      if (x > 0.2 && x < 0.8 && y > 0.1 && y < 0.8) skinCenter++;
      skinCols[Math.min(15, Math.floor(x * 16))]++;
      if (x < skinMinX) skinMinX = x; if (x > skinMaxX) skinMaxX = x;
      if (y < skinMinY) skinMinY = y; if (y > skinMaxY) skinMaxY = y;
    }
    if (y < 0.45 && b > r + 12 && b >= g - 5 && l > 0.35) sky++;
    if (g > r + 8 && g > b + 8) green++;
    if (l < 0.12) dark++;
    if (l > 0.97) clip++;
    const a = r - g, bb = 0.5 * (r + g) - b;
    rg += a; yb += bb; rg2 += a * a; yb2 += bb * bb;
    warm += (r - b);
  }
  const cum = (q) => { let c = 0, target = q * n; for (let i = 0; i < 256; i++) { c += hist[i]; if (c >= target) return i / 255; } return 1; };
  // Laplacian (sharpness & noise estimate) + local contrast saliency
  let lapSum = 0, lapSq = 0, cnt = 0;
  const flatNoise = [];
  let salX = 0, salY = 0, salW = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w];
      lapSum += lap; lapSq += lap * lap; cnt++;
      const grad = Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]);
      if (grad < 0.02 && (x + y) % 3 === 0) flatNoise.push(Math.abs(lap));
      // saliency weight: local contrast, slightly centre-biased
      const cx = x / w - 0.5, cy = y / h - 0.5;
      const wgt = grad * (1.2 - Math.min(1, Math.sqrt(cx * cx + cy * cy) * 1.4));
      if (wgt > 0) { salX += wgt * x / w; salY += wgt * y / h; salW += wgt; }
    }
  }
  const lapMean = lapSum / Math.max(1, cnt);
  const sharpness = lapSq / Math.max(1, cnt) - lapMean * lapMean;
  flatNoise.sort((a, b) => a - b);
  const noise = flatNoise.length > 50 ? flatNoise[Math.floor(flatNoise.length * 0.5)] : 0;
  // Border uniformity (product / studio shots)
  let bS = 0, bS2 = 0, bSat = 0, bn = 0, bR = 0, bG = 0, bB = 0;
  const addB = (x, y) => {
    const p = (y * w + x) * 4; const r = d[p], g = d[p + 1], b = d[p + 2];
    bR += r; bG += g; bB += b;
    const l = L[y * w + x]; bS += l; bS2 += l * l; const mx = Math.max(r, g, b);
    bSat += mx ? (mx - Math.min(r, g, b)) / mx : 0; bn++;
  };
  for (let x = 0; x < w; x += 2) { addB(x, 0); addB(x, h - 1); addB(x, Math.floor(h * 0.03)); }
  for (let y = 0; y < h; y += 2) { addB(0, y); addB(w - 1, y); addB(Math.floor(w * 0.97), y); }
  const bMean = bS / bn, bStd = Math.sqrt(Math.max(0, bS2 / bn - bMean * bMean));
  // skin clusters (column peaks) to tell single person from a group
  let peaks = 0; const colMax = Math.max(...skinCols);
  for (let k = 0; k < 16; k++) {
    const v = skinCols[k];
    if (v > colMax * 0.35 && v >= (skinCols[k - 1] || 0) && v >= (skinCols[k + 1] || 0)) peaks++;
  }
  const rgm = rg / n, ybm = yb / n;
  const colorfulness = Math.sqrt(Math.max(0, rg2 / n - rgm * rgm) + Math.max(0, yb2 / n - ybm * ybm)) + 0.3 * Math.sqrt(rgm * rgm + ybm * ybm);
  return {
    w, h,
    mean: (sr * 0.2126 + sg * 0.7152 + sb * 0.0722) / n / 255,
    p005: cum(0.005), p01: cum(0.01), p05: cum(0.05), p50: cum(0.5), p95: cum(0.95), p99: cum(0.99), p995: cum(0.995),
    meanR: sr / n / 255, meanG: sg / n / 255, meanB: sb / n / 255,
    saturation: satSum / n,
    colorfulness: colorfulness / 255,
    skinRatio: skin / n, skinCenterRatio: skinCenter / n,
    skinX: skin ? skinX / skin : 0.5, skinY: skin ? skinY / skin : 0.4,
    skinSpread: skin ? skinMaxX - skinMinX : 0, skinPeaks: peaks,
    skyRatio: sky / n, greenRatio: green / n, darkRatio: dark / n, clipRatio: clip / n,
    warmth: warm / n / 255,
    sharpness, noise,
    borderMean: bMean, borderStd: bStd, borderSat: bSat / bn, borderR: bR / bn / 255, borderG: bG / bn / 255, borderB: bB / bn / 255,
    salX: salW ? salX / salW : 0.5, salY: salW ? salY / salW : 0.5,
  };
}

// Box blur (in place, separable), used on a downscaled luminance map
function boxBlur(src, w, h, r, passes) {
  const tmp = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        src[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
}

function srgbLum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

function process(w, h, d, P) {
  const n = w * h;
  const [gr, gg, gb] = P.wb;
  const black = P.black, white = Math.max(P.black + 0.2, P.white), range = white - black;
  // ---- Pass 1: low-resolution luminance map for local tone mapping ----
  const ds = Math.max(1, Math.round(Math.max(w, h) / 256));
  const lw = Math.ceil(w / ds), lh = Math.ceil(h / ds);
  const Lb = new Float32Array(lw * lh);
  const Lc = new Float32Array(lw * lh);
  for (let y = 0; y < h; y += 1) {
    const ly = Math.floor(y / ds);
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      const r = clamp01((d[p] / 255 * gr - black) / range);
      const g = clamp01((d[p + 1] / 255 * gg - black) / range);
      const b = clamp01((d[p + 2] / 255 * gb - black) / range);
      const k = ly * lw + Math.floor(x / ds);
      Lb[k] += srgbLum(r, g, b); Lc[k]++;
    }
  }
  for (let k = 0; k < Lb.length; k++) Lb[k] /= Math.max(1, Lc[k]);
  boxBlur(Lb, lw, lh, Math.max(2, Math.round(Math.max(lw, lh) / 24)), 3);
  const sampleLb = (x, y) => {
    const fx = Math.min(lw - 1.001, Math.max(0, x / ds - 0.5)), fy = Math.min(lh - 1.001, Math.max(0, y / ds - 0.5));
    const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
    const i = y0 * lw + x0;
    const a = Lb[i], b = Lb[i + 1 < Lb.length ? i + 1 : i], c = Lb[i + lw < Lb.length ? i + lw : i], e = Lb[i + lw + 1 < Lb.length ? i + lw + 1 : i];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  };

  const Lout = new Float32Array(n); // final luminance for detail pass
  const cx = w / 2, cy = h / 2, maxR = Math.sqrt(cx * cx + cy * cy);
  const splitS = P.splitShadow, splitH = P.splitHigh;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, p = i * 4;
      const r0 = d[p], g0 = d[p + 1], b0 = d[p + 2];
      const skinW = P.skinProtect > 0 && isSkin(r0, g0, b0) ? 1 : 0;
      let r = clamp01((r0 / 255 * gr - black) / range);
      let g = clamp01((g0 / 255 * gg - black) / range);
      let b = clamp01((b0 / 255 * gb - black) / range);
      const L = srgbLum(r, g, b);
      const lb = sampleLb(x, y);
      // local shadows / highlights
      let L1 = L;
      const sm = (1 - lb) * (1 - lb);
      L1 = L1 + P.shadows * sm * (Math.sqrt(L1) - L1);
      const hm = lb * lb;
      L1 = L1 - P.highlights * hm * (L1 - L1 * L1) * 0.9;
      // clarity (local contrast) — reduced on skin to keep natural texture
      const mid = 4 * L * (1 - L);
      L1 = L1 + P.clarity * (1 - 0.7 * skinW) * (L - lb) * mid * 1.2;
      // exposure (gamma)
      L1 = Math.pow(clamp01(L1), P.gamma);
      // contrast S-curve
      const s = L1 * L1 * (3 - 2 * L1);
      L1 = clamp01(L1 + P.contrast * (s - L1) * 1.6);
      // apply luminance change with hue preservation
      const ratio = L > 1e-4 ? L1 / L : 1;
      r = L > 1e-4 ? r * ratio : L1; g = L > 1e-4 ? g * ratio : L1; b = L > 1e-4 ? b * ratio : L1;
      if (ratio > 1) { const cd = Math.pow(ratio, -0.5); r = L1 + (r - L1) * cd; g = L1 + (g - L1) * cd; b = L1 + (b - L1) * cd; }
      let mx = Math.max(r, g, b);
      if (mx > 1) { const k = (1 - L1) / Math.max(1e-4, mx - L1); r = L1 + (r - L1) * k; g = L1 + (g - L1) * k; b = L1 + (b - L1) * k; }
      // vibrance / saturation (skin protected)
      mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      let f = 1 + P.saturation + P.vibrance * (1 - sat) * (1 - 0.6 * skinW);
      // sky
      if (P.sky > 0 && y < h * 0.6 && b > r + 0.05 && b >= g - 0.02 && L1 > 0.3) f += P.sky * (1 - y / (h * 0.6));
      const Lc2 = srgbLum(r, g, b);
      r = Lc2 + (r - Lc2) * f; g = Lc2 + (g - Lc2) * f; b = Lc2 + (b - Lc2) * f;
      // temperature / tint
      r += P.temp * 0.045; b -= P.temp * 0.045; g += P.tint * 0.03;
      // split toning
      const Ln = clamp01(srgbLum(r, g, b));
      const ws = (1 - Ln) * (1 - Ln) * P.splitAmount, wh = Ln * Ln * P.splitAmount;
      r += splitS[0] * ws + splitH[0] * wh; g += splitS[1] * ws + splitH[1] * wh; b += splitS[2] * ws + splitH[2] * wh;
      // fade (lifted blacks)
      if (P.fade > 0) { r = r * (1 - P.fade) + P.fade * 0.6; g = g * (1 - P.fade) + P.fade * 0.6; b = b * (1 - P.fade) + P.fade * 0.6; }
      // vignette
      if (P.vignette > 0) {
        const dx = x - cx, dy = y - cy; const rr = Math.sqrt(dx * dx + dy * dy) / maxR;
        const v = 1 - P.vignette * Math.pow(Math.max(0, rr - 0.35) / 0.65, 2);
        r *= v; g *= v; b *= v;
      }
      if (P.mono) { const m = srgbLum(r, g, b); r = g = b = m; }
      r = clamp01(r); g = clamp01(g); b = clamp01(b);
      d[p] = r * 255 + 0.5; d[p + 1] = g * 255 + 0.5; d[p + 2] = b * 255 + 0.5;
      Lout[i] = srgbLum(r, g, b) + skinW * 2; // encode skin flag (+2) for the detail pass
    }
  }
  // ---- Detail pass: edge-aware sharpening + luminance noise reduction ----
  if (P.sharpen > 0 || P.denoise > 0) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let c = Lout[i]; const skinW = c >= 2 ? 1 : 0; if (skinW) c -= 2;
        let acc = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { let v = Lout[i + oy * w + ox]; if (v >= 2) v -= 2; acc += v; }
        const blur = acc / 9;
        const detail = c - blur;
        const edge = Math.min(1, Math.abs(detail) * P.edgeGain);
        const amount = P.sharpen * edge * (1 - 0.65 * skinW) - P.denoise * (1 - edge);
        const delta = detail * amount * 255;
        if (delta !== 0) { const p = i * 4; d[p] += delta; d[p + 1] += delta; d[p + 2] += delta; }
      }
    }
  }
  return d;
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'analyze') {
      const d = new Uint8ClampedArray(m.buffer);
      const result = analyze(m.w, m.h, d);
      const classify = await loadFaceDetector();
      result.faces = detectFacesSync(classify, toGray(d, m.w, m.h), m.w, m.h, 10);
      result.faceModel = !!classify;
      self.postMessage({ id: m.id, ok: true, result });
    } else if (m.type === 'process') {
      const d = new Uint8ClampedArray(m.buffer);
      process(m.w, m.h, d, m.params);
      self.postMessage({ id: m.id, ok: true, buffer: d.buffer, w: m.w, h: m.h }, [d.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
