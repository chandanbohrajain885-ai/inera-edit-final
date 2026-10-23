// Inera Edit Flow — image intelligence: scene recognition, automatic style selection,
// parameter planning, prompt interpretation and full-resolution rendering via the worker.
import { clamp, makeCanvas, fitSize, drawToCanvas, LIMITS } from './utils.js';

let worker = null;
let seq = 0;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data); else p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error('Image worker crashed: ' + (e.message || 'out of memory?')));
    pending.clear();
    worker = null;
  };
  return worker;
}
function call(msg, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer || []);
  });
}

export async function analyzeSource(source) {
  const sw = source.naturalWidth || source.videoWidth || source.width;
  const sh = source.naturalHeight || source.videoHeight || source.height;
  const s = fitSize(sw, sh, 512);
  const c = drawToCanvas(source, s.w, s.h);
  const data = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, s.w, s.h);
  const r = await call({ type: 'analyze', w: s.w, h: s.h, buffer: data.data.buffer }, [data.data.buffer]);
  const a = r.result;
  a.srcW = sw; a.srcH = sh;
  return a;
}

export const STYLES = {
  natural: 'Natural Professional',
  cinematic: 'Cinematic',
  travel: 'Travel',
  warm: 'Warm Aesthetic',
  cool: 'Cool Cinematic',
  social: 'Social-Media Ready',
  portrait: 'Portrait Enhancement',
  vibrant: 'Vibrant Lifestyle',
  product: 'Clean Product',
  mono: 'Classic Black & White',
};

export const SCENES = {
  portrait: 'Portrait / selfie', group: 'Group photo', landscape: 'Landscape / travel', food: 'Food',
  product: 'Product', night: 'Low-light / night', indoor: 'Indoor', event: 'Event', outdoor: 'Outdoor', general: 'General',
};

export function classifyScene(a) {
  const reasons = [];
  const faces = (a.faces || []).slice().sort((x, y) => y.size - x.size);
  const big = faces[0];
  let type = 'general', conf = 0.4;
  // a strong global blue cast is not sky
  const sky = a.skyRatio * (a.meanB - a.meanR > 0.06 ? 0.3 : 1);
  if (a.borderStd < 0.06 && a.borderSat < 0.12 && a.borderMean > 0.6 && !faces.length) {
    type = 'product'; conf = 0.75; reasons.push('plain, uniform bright background around the subject');
  } else if (faces.length >= 2) {
    type = 'group'; conf = 0.85; reasons.push(`${faces.length} faces detected`);
  } else if (big && big.size >= 0.12) {
    type = 'portrait'; conf = 0.9; reasons.push(big.size > 0.3 ? 'one large face (selfie / close portrait)' : 'one clear face in frame');
  } else if (a.mean < 0.22 && a.darkRatio > 0.35) {
    type = 'night'; conf = 0.7; reasons.push('mostly dark exposure');
  } else if (sky > 0.1 || (a.greenRatio > 0.25)) {
    type = 'landscape'; conf = 0.6 + Math.min(0.3, sky); reasons.push(sky > 0.1 ? 'sky detected in upper frame' : 'large areas of foliage');
    if (big) reasons.push('small person in the scene');
  } else if (big) {
    type = 'event'; conf = 0.55; reasons.push('a person within a wider scene');
  } else if (a.saturation > 0.35 && a.warmth > 0.12 && a.colorfulness > 0.18 && sky < 0.03) {
    type = 'food'; conf = 0.5; reasons.push('warm, saturated close-up colours, no people');
  } else if (a.warmth > 0.07 && a.mean < 0.45 && sky < 0.02) {
    type = 'indoor'; conf = 0.45; reasons.push('warm artificial-light colour cast, no sky');
  } else if (sky > 0.03 || a.mean > 0.5) {
    type = 'outdoor'; conf = 0.4; reasons.push('bright, daylight exposure');
  } else reasons.push('no people, sky or dominant subject detected');
  if (!faces.length && a.faceModel) reasons.push('no faces found');
  return { type, label: SCENES[type], confidence: conf, reasons };
}

export function autoStyleFor(sceneType) {
  return ({ portrait: 'portrait', group: 'natural', landscape: 'travel', food: 'warm', product: 'product', night: 'cool',
    indoor: 'warm', event: 'vibrant', outdoor: 'social', general: 'natural' })[sceneType] || 'natural';
}
export function alternateStyles(sceneType, primary) {
  const map = {
    portrait: ['warm', 'cinematic'], group: ['vibrant', 'warm'], landscape: ['cinematic', 'vibrant'],
    food: ['vibrant', 'natural'], product: ['natural', 'cool'], night: ['cinematic', 'natural'],
    indoor: ['natural', 'cinematic'], event: ['cinematic', 'natural'], outdoor: ['travel', 'cinematic'], general: ['social', 'cinematic'],
  };
  return (map[sceneType] || ['social', 'cinematic']).filter((s) => s !== primary).slice(0, 2);
}

// Parse the optional prompt into concrete, explainable adjustments (keyword interpreter).
export function parseImagePrompt(text) {
  const t = String(text || '').toLowerCase();
  const m = { notes: [] };
  if (!t.trim()) return m;
  const has = (...w) => w.some((x) => t.includes(x));
  if (has('black and white', 'b&w', 'monochrome', 'grayscale', 'greyscale')) { m.style = 'mono'; m.notes.push('Black & white'); }
  else if (has('cinematic', 'film', 'movie')) { m.style = 'cinematic'; m.notes.push('Cinematic look'); }
  else if (has('product', 'catalog', 'ecommerce', 'e-commerce')) { m.style = 'product'; m.notes.push('Product style'); }
  else if (has('travel')) { m.style = 'travel'; m.notes.push('Travel style'); }
  else if (has('portrait', 'skin')) { m.style = 'portrait'; m.notes.push('Portrait style'); }
  else if (has('instagram', 'social', 'reel', 'post')) { m.style = 'social'; m.notes.push('Social-media style'); }
  if (has('warm', 'golden', 'sunset', 'cozy', 'cosy')) { m.temp = 0.35; m.notes.push('Warmer tones'); }
  if (has('cool', 'cold', 'blue tone', 'icy')) { m.temp = -0.35; m.notes.push('Cooler tones'); }
  if (has('brighter', 'bright', 'lighter', 'more light')) { m.exposure = 0.18; m.notes.push('Brighter'); }
  if (has('darker', 'moody', 'dramatic')) { m.exposure = -0.12; m.contrast = 0.12; m.notes.push('Moodier, more contrast'); }
  if (has('vibrant', 'pop', 'colorful', 'colourful', 'saturated')) { m.vibrance = 0.2; m.notes.push('More vibrant colour'); }
  if (has('muted', 'desaturated', 'pastel')) { m.vibrance = -0.25; m.notes.push('Muted colour'); }
  if (has('subtle', 'natural', 'minimal', 'light touch', 'less edit')) { m.intensity = 0.6; m.notes.push('Lighter touch'); }
  if (has('strong', 'bold', 'heavy', 'more edit')) { m.intensity = 1.35; m.notes.push('Stronger edit'); }
  if (has('sharp', 'crisp', 'detail')) { m.sharpen = 0.25; m.notes.push('Extra sharpness'); }
  if (has('soft', 'dreamy', 'smooth')) { m.sharpen = -0.2; m.fade = 0.04; m.notes.push('Softer look'); }
  if (has('square', '1:1')) { m.aspect = '1:1'; m.notes.push('Square crop'); }
  else if (has('story', '9:16', 'vertical')) { m.aspect = '9:16'; m.notes.push('Vertical 9:16 crop'); }
  else if (has('4:5', 'portrait crop', 'instagram post')) { m.aspect = '4:5'; m.notes.push('4:5 crop'); }
  else if (has('16:9', 'widescreen', 'youtube')) { m.aspect = '16:9'; m.notes.push('16:9 crop'); }
  if (!m.notes.length) m.notes.push('No recognised keywords — automatic settings kept');
  return m;
}

// Build pixel-pipeline parameters from measurements + style + intensity + prompt modifiers
export function buildParams(a, style, intensity = 1, mod = {}) {
  const k = clamp(mod.intensity ?? intensity, 0.2, 1.6);
  const steps = [];
  // White balance. Product / studio shots: the plain background is the neutral reference.
  // Otherwise gray-world, partial and clamped; weaker for sunsets where warmth is intentional.
  const avg = (a.meanR + a.meanG + a.meanB) / 3 || 0.5;
  let wb;
  const plainBg = a.borderStd < 0.08 && a.borderMean > 0.55;
  if (plainBg) {
    const bavg = (a.borderR + a.borderG + a.borderB) / 3;
    wb = [a.borderR, a.borderG, a.borderB].map((m) => clamp(bavg / Math.max(0.05, m), 0.85, 1.18));
  } else {
    let wbStrength = 0.55;
    if (a.skyRatio > 0.12 && a.warmth > 0.1) wbStrength *= 0.45; // golden hour / sunset skies
    const gain = (m) => clamp(1 + (avg / Math.max(0.05, m) - 1) * wbStrength, 0.86, 1.18);
    wb = [gain(a.meanR), gain(a.meanG), gain(a.meanB)];
  }
  const wbShift = Math.max(...wb.map((g) => Math.abs(g - 1)));
  if (wbShift > 0.02) steps.push(plainBg ? 'Neutralised the background colour (white balance)' : 'Corrected white balance / colour cast');
  // Levels
  const black = clamp(a.p005 * 0.85, 0, 0.08);
  const white = clamp(1 - (1 - a.p995) * 0.85, 0.88, 1);
  if (black > 0.01 || white < 0.985) steps.push('Expanded dynamic range (levels)');
  // Exposure
  const meanAfter = clamp((a.mean - black) / (white - black), 0.02, 0.98);
  const target = style === 'cinematic' || style === 'cool' ? 0.42 : style === 'product' ? 0.55 : 0.47;
  let gamma = Math.log(target) / Math.log(meanAfter);
  // never darken a bright (high-key) photo unless highlights are actually clipping
  if (gamma > 1 && a.clipRatio < 0.02) gamma = 1;
  gamma = clamp(1 + (gamma - 1) * 0.75, 0.62, 1.35);
  if (mod.exposure) gamma = clamp(gamma * (1 - mod.exposure), 0.5, 1.5);
  if (Math.abs(gamma - 1) > 0.04) steps.push(gamma < 1 ? 'Brightened exposure' : 'Reduced overexposure');
  const shadows = clamp(0.12 + a.darkRatio * 1.2, 0.08, 0.55);
  const highlights = clamp(0.1 + a.clipRatio * 8 + (a.p99 > 0.95 ? 0.15 : 0), 0.05, 0.6);
  steps.push('Recovered shadows and highlights');
  // Noise / sharpening from measurements
  const softness = a.sharpness < 0.0015 ? 1 : a.sharpness < 0.004 ? 0.6 : 0.3;
  let sharpen = 0.35 + 0.5 * softness;
  let denoise = clamp((a.noise - 0.006) * 30, 0, 0.6);
  if (denoise > 0.05) steps.push('Reduced luminance noise');
  const base = {
    wb, black, white, gamma, shadows, highlights,
    clarity: 0.12, contrast: 0.12, vibrance: 0.15, saturation: 0, temp: 0, tint: 0,
    splitShadow: [0, 0, 0], splitHigh: [0, 0, 0], splitAmount: 0, fade: 0, vignette: 0, sky: 0,
    sharpen, denoise, edgeGain: 28, skinProtect: (a.faces && a.faces.length) ? 1 : 0, mono: false,
  };
  const S = {
    natural: { contrast: 0.12, vibrance: 0.15, clarity: 0.12 },
    cinematic: { contrast: 0.26, vibrance: 0.05, saturation: -0.06, clarity: 0.15, splitShadow: [-0.25, 0.05, 0.25], splitHigh: [0.25, 0.1, -0.2], splitAmount: 0.09, vignette: 0.22, fade: 0.015 },
    travel: { contrast: 0.2, vibrance: 0.32, clarity: 0.22, sky: 0.28, vignette: 0.08 },
    warm: { contrast: 0.12, vibrance: 0.2, temp: 0.32, splitHigh: [0.2, 0.1, -0.1], splitAmount: 0.05, vignette: 0.06 },
    cool: { contrast: 0.22, vibrance: 0.06, saturation: -0.05, temp: -0.28, splitShadow: [-0.15, 0, 0.3], splitAmount: 0.07, vignette: 0.16 },
    social: { contrast: 0.2, vibrance: 0.28, clarity: 0.16, sharpen: sharpen + 0.1 },
    portrait: { contrast: 0.1, vibrance: 0.12, clarity: 0.03, temp: 0.08, vignette: 0.12, sharpen: sharpen * 0.6, shadows: shadows + 0.08 },
    vibrant: { contrast: 0.2, vibrance: 0.38, saturation: 0.06, clarity: 0.14 },
    product: { contrast: 0.15, vibrance: 0.1, clarity: 0.06, sharpen: sharpen + 0.15, highlights: Math.min(highlights, 0.25) },
    mono: { contrast: 0.3, clarity: 0.2, vibrance: 0, mono: true, vignette: 0.12 },
  }[style] || {};
  const P = { ...base, ...S };
  // Scale creative parts by intensity (corrections stay fixed)
  for (const key of ['contrast', 'vibrance', 'saturation', 'clarity', 'temp', 'splitAmount', 'vignette', 'sky', 'fade']) P[key] *= k;
  if (mod.temp) P.temp += mod.temp;
  if (mod.vibrance) P.vibrance += mod.vibrance;
  if (mod.contrast) P.contrast += mod.contrast;
  if (mod.sharpen) P.sharpen = clamp(P.sharpen + mod.sharpen, 0, 1.2);
  if (mod.fade) P.fade += mod.fade;
  if (P.vibrance > 0.05) steps.push('Natural vibrance boost (skin tones protected)');
  if (P.contrast > 0.05) steps.push('Contrast and tone curve');
  if (P.clarity > 0.1) steps.push('Clarity (local contrast)');
  if (P.sky > 0) steps.push('Sky depth enhancement');
  if (P.splitAmount > 0) steps.push('Colour grading (split toning)');
  if (Math.abs(P.temp) > 0.05) steps.push(P.temp > 0 ? 'Warm colour grade' : 'Cool colour grade');
  if (P.vignette > 0.05) steps.push('Subtle vignette');
  if (P.sharpen > 0.2) steps.push('Edge-aware sharpening (reduced on skin)');
  if (P.mono) steps.push('Black & white conversion');
  return { params: P, steps: [...new Set(steps)] };
}

// Size-weighted centre of detected faces (null when there are none)
export function faceFocus(a) {
  const fs = a.faces || [];
  if (!fs.length) return null;
  let x = 0, y = 0, w = 0;
  for (const f of fs) { const k = f.size * f.size; x += f.x * k; y += f.y * k; w += k; }
  return { x: x / w, y: y / w, size: fs.reduce((m, f) => Math.max(m, f.size), 0) };
}

// Smart crop rectangle for a target aspect, centred on people (skin) or salient detail
export function smartCropRect(a, aspectKey, w, h) {
  if (!aspectKey || aspectKey === 'original') return { x: 0, y: 0, w, h };
  const [aw, ah] = aspectKey.split(':').map(Number);
  const target = aw / ah;
  let cw = w, ch = h;
  if (w / h > target) cw = Math.round(h * target); else ch = Math.round(w / target);
  const f = faceFocus(a);
  const fx = f ? f.x : a.salX;
  const fy = f ? f.y : a.salY;
  const x = clamp(Math.round(fx * w - cw / 2), 0, w - cw);
  const y = clamp(Math.round(fy * h - ch / 2), 0, h - ch);
  return { x, y, w: cw, h: ch };
}

// Render a version at a given max size. Returns a canvas.
export async function renderVersion(source, analysis, params, { maxLong = 0, aspect = 'original', maxMP = LIMITS.imageProcessMegapixels } = {}) {
  const sw = analysis.srcW, sh = analysis.srcH;
  const crop = smartCropRect(analysis, aspect, sw, sh);
  const s = fitSize(crop.w, crop.h, maxLong, maxMP);
  const c = makeCanvas(s.w, s.h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, s.w, s.h);
  const img = ctx.getImageData(0, 0, s.w, s.h);
  const r = await call({ type: 'process', w: s.w, h: s.h, buffer: img.data.buffer, params }, [img.data.buffer]);
  const out = new ImageData(new Uint8ClampedArray(r.buffer), r.w, r.h);
  ctx.putImageData(out, 0, 0);
  return c;
}
