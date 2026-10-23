// Inera Edit Flow — video & audio analysis (scene detection, motion, sharpness, faces/skin,
// exposure, speech activity, loudness). Classical signal processing; runs locally.
import { createVideoEl, waitEvent, seekVideo, makeCanvas, clamp, checkAbort, AbortError } from './utils.js';
import { loadFaceDetector, detectFacesSync, toGray } from './face-detect.js';

function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 && r > g && r > b - 10;
}

export function frameMetrics(img, prevGray) {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const gray = new Float32Array(n);
  const hist = new Float32Array(64);
  let sum = 0, sum2 = 0, cr = 0, cg = 0, cbl = 0, skin = 0, sx = 0, sy = 0, rg = 0, yb = 0, rg2 = 0, yb2 = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    gray[i] = l; sum += l; sum2 += l * l; cr += r; cg += g; cbl += b;
    hist[(r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)]++;
    if (isSkin(r, g, b)) { skin++; sx += (i % w) / w; sy += Math.floor(i / w) / h; }
    const a = r - g, c = 0.5 * (r + g) - b;
    rg += a; yb += c; rg2 += a * a; yb2 += c * c;
  }
  for (let k = 0; k < 64; k++) hist[k] /= n;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  let lap2 = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    lap2 += lap * lap; cnt++;
  }
  let motion = 0;
  if (prevGray && prevGray.length === n) { for (let i = 0; i < n; i++) motion += Math.abs(gray[i] - prevGray[i]); motion /= n; }
  const rgm = rg / n, ybm = yb / n;
  const colorful = (Math.sqrt(Math.max(0, rg2 / n - rgm * rgm) + Math.max(0, yb2 / n - ybm * ybm)) + 0.3 * Math.sqrt(rgm * rgm + ybm * ybm)) / 255;
  // difference hash (9x8) for near-duplicate detection
  const hash = [];
  for (let y = 0; y < 8; y++) {
    const yy = Math.floor((y + 0.5) * h / 8);
    for (let x = 0; x < 8; x++) {
      const x1 = Math.floor(x * w / 9), x2 = Math.floor((x + 1) * w / 9);
      hash.push(gray[yy * w + x1] > gray[yy * w + x2] ? 1 : 0);
    }
  }
  return {
    lum: mean, std, mR: cr / n / 255, mG: cg / n / 255, mB: cbl / n / 255, sharp: lap2 / Math.max(1, cnt), colorful, motion,
    skin: skin / n, skinX: skin ? sx / skin : 0.5, skinY: skin ? sy / skin : 0.4,
    black: mean < 0.045 && std < 0.03, washed: mean > 0.96 && std < 0.04,
    gray, hist, hash,
  };
}

// Global translation between two gray frames (block matching, ±6 px search).
export function estimateShift(a, b, w, h) {
  let best = Infinity, bx = 0, by = 0;
  const R = 6;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    let sum = 0, n = 0;
    for (let y = R + 2; y < h - R - 2; y += 3) for (let x = R + 2; x < w - R - 2; x += 3) { sum += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx]); n++; }
    sum /= Math.max(1, n);
    if (sum < best) { best = sum; bx = dx; by = dy; }
  }
  return [bx, by];
}

export function histDist(a, b) { let s = 0; for (let k = 0; k < 64; k++) s += Math.abs(a[k] - b[k]); return s / 2; }
export function hamming(a, b) { let s = 0; for (let k = 0; k < 64; k++) s += a[k] !== b[k] ? 1 : 0; return s; }

// Scan a video by playing it fast (muted) and sampling frames; gaps are filled by seeking.
export async function scanVideo(url, duration, { interval, sampleW = 96, onProgress, signal }) {
  const v = createVideoEl(url);
  await waitEvent(v, 'loadedmetadata', 20000);
  const vw = v.videoWidth, vh = v.videoHeight;
  const sw = sampleW, sh = Math.max(16, Math.round(sampleW * vh / vw));
  const c = makeCanvas(sw, sh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const samples = [];
  let prevGray = null;
  const classify = await loadFaceDetector();
  const take = (t) => {
    ctx.drawImage(v, 0, 0, sw, sh);
    const img = ctx.getImageData(0, 0, sw, sh);
    const m = frameMetrics(img, prevGray);
    prevGray = m.gray;
    m.t = t;
    m.faces = classify ? detectFacesSync(classify, toGray(img.data, sw, sh), sw, sh, 8) : [];
    m.face = m.faces.length ? m.faces.reduce((a, b) => (b.size > a.size ? b : a)) : null;
    samples.push(m);
  };
  const rate = clamp(duration / 40, 1, 4);
  try { v.playbackRate = rate; } catch (e) { try { v.playbackRate = 2; } catch (e2) {} }
  let next = 0;
  let lastAdvance = performance.now(), lastT = -1;
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => { if (done) return; done = true; document.removeEventListener('visibilitychange', onVis); clearInterval(watch); err ? reject(err) : resolve(); };
    const onVis = () => { if (document.visibilityState === 'hidden') v.pause(); else if (!done) v.play().catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    const handle = (t) => {
      if (signal && signal.aborted) { v.pause(); return finish(new AbortError()); }
      if (t + 1e-3 >= next) { take(t); next = t + interval; }
      onProgress && onProgress(clamp(t / duration, 0, 1));
    };
    const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
    if (useRVFC) {
      const cb = (now, meta) => { if (done) return; handle(meta.mediaTime ?? v.currentTime); if (!done) v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      const loop = () => { if (done) return; if (v.readyState >= 2) handle(v.currentTime); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
    v.addEventListener('ended', () => finish());
    v.addEventListener('error', () => finish(new Error('The video could not be decoded during analysis.')));
    // watchdog: if playback stalls (slow decoder / throttling) fall back to seek-sampling
    const watch = setInterval(() => {
      if (document.visibilityState === 'hidden') { lastAdvance = performance.now(); return; }
      if (v.currentTime !== lastT) { lastT = v.currentTime; lastAdvance = performance.now(); }
      else if (performance.now() - lastAdvance > 6000) { v.pause(); finish(); }
    }, 500);
    v.play().catch(() => { v.pause(); finish(); });
  });
  checkAbort(signal);
  // Fill gaps by seeking (covers skipped frames and stalled playback)
  try { v.pause(); v.playbackRate = 1; } catch (e) {}
  const want = [];
  const times = samples.map((s) => s.t).sort((a, b) => a - b);
  let prev = 0;
  for (const t of [...times, duration]) {
    if (t - prev > interval * 3) for (let g = prev + interval * 1.5; g < t - interval; g += interval * 1.5) want.push(g);
    prev = t;
  }
  const maxFill = Math.min(want.length, 120);
  const fillStart = performance.now();
  for (let k = 0; k < maxFill; k++) {
    checkAbort(signal);
    if (performance.now() - fillStart > 15000) break; // time budget: coverage is already sufficient
    const t = want[Math.round(k * want.length / maxFill)] ?? want[k];
    try { await seekVideo(v, t, 8000); take(t); } catch (e) { /* skip unseekable point */ }
    onProgress && onProgress(0.95 + 0.05 * k / maxFill);
  }
  samples.sort((a, b) => a.t - b.t);
  // recompute motion in time order
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    let m = 0;
    if (a) { for (let k = 0; k < b.gray.length; k++) m += Math.abs(b.gray[k] - a.gray[k]); m /= b.gray.length; }
    b.motion = m;
    b.diff = a ? histDist(a.hist, b.hist) : 0;
    b.shift = a ? estimateShift(b.gray, a.gray, sw, sh) : [0, 0];
  }
  v.removeAttribute('src'); v.load();
  return { samples, width: vw, height: vh };
}

// ---------------- Audio ----------------
function biquad(type, f0, fs, q = 0.707) {
  const w0 = 2 * Math.PI * f0 / fs, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; }
  else { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; }
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function filt(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

export const AUDIO_HOP = 0.05; // 50 ms analysis windows

export async function analyzeAudio(file, signal) {
  let buffer = null;
  try {
    const ab = await file.arrayBuffer();
    checkAbort(signal);
    const ctx = new OfflineAudioContext(2, 1, 44100);
    buffer = await ctx.decodeAudioData(ab);
  } catch (e) {
    if (e instanceof AbortError) throw e;
    return { hasAudio: false, buffer: null, rms: [], speech: [], segments: [], speechRatio: 0, kind: 'none' };
  }
  checkAbort(signal);
  const fs = buffer.sampleRate, n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / buffer.numberOfChannels; }
  const band = filt(filt(mono, biquad('hp', 300, fs)), biquad('lp', 3200, fs));
  const hop = Math.round(fs * AUDIO_HOP);
  const frames = Math.floor(n / hop);
  const rms = new Float32Array(frames), brms = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    let s = 0, sb = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) { s += mono[i] * mono[i]; sb += band[i] * band[i]; const a = Math.abs(mono[i]); if (a > peak) peak = a; }
    rms[f] = Math.sqrt(s / hop); brms[f] = Math.sqrt(sb / hop);
  }
  if (peak < 0.003) return { hasAudio: false, silent: true, buffer, rms, speech: new Uint8Array(frames), segments: [], speechRatio: 0, kind: 'silent', peak };
  const sorted = [...brms].filter((x) => x > 1e-5).sort((a, b) => a - b);
  const noise = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0.001;
  const thr = Math.max(noise * 3.2, 0.006);
  let sp = new Uint8Array(frames);
  for (let f = 0; f < frames; f++) sp[f] = brms[f] > thr && brms[f] / Math.max(1e-6, rms[f]) > 0.45 ? 1 : 0;
  // smooth: fill short gaps (<300 ms) and remove short islands (<200 ms)
  const fillGap = Math.round(0.3 / AUDIO_HOP), minIsland = Math.round(0.2 / AUDIO_HOP);
  let f = 0;
  while (f < frames) {
    if (sp[f] === 0) { let e = f; while (e < frames && sp[e] === 0) e++; if (f > 0 && e < frames && e - f <= fillGap) sp.fill(1, f, e); f = e; }
    else f++;
  }
  f = 0;
  while (f < frames) {
    if (sp[f] === 1) { let e = f; while (e < frames && sp[e] === 1) e++; if (e - f < minIsland) sp.fill(0, f, e); f = e; }
    else f++;
  }
  const segments = [];
  f = 0;
  while (f < frames) { if (sp[f]) { let e = f; while (e < frames && sp[e]) e++; segments.push({ s: f * AUDIO_HOP, e: e * AUDIO_HOP }); f = e; } else f++; }
  let active = 0; for (let k = 0; k < frames; k++) active += sp[k];
  // Speech has frequent short dips in energy (syllables); music/ambience is continuous.
  let dips = 0, inSeg = 0;
  for (const s of segments) {
    const a = Math.floor(s.s / AUDIO_HOP), b = Math.floor(s.e / AUDIO_HOP);
    const vals = [...brms.slice(a, b)].sort((x, y) => x - y); const med = vals[Math.floor(vals.length / 2)] || 0;
    for (let k = a; k < b; k++) { inSeg++; if (brms[k] < med * 0.35) dips++; }
  }
  const dipRate = inSeg ? dips / inSeg : 0;
  const ratio = active / Math.max(1, frames);
  const looksLikeSpeech = ratio > 0.08 && (dipRate > 0.06 || segments.length > frames * AUDIO_HOP / 8);
  const loud = rms.reduce((a, b) => a + b, 0) / frames;
  return {
    hasAudio: true, buffer, rms, brms, speech: looksLikeSpeech ? sp : new Uint8Array(frames), segments: looksLikeSpeech ? segments : [],
    speechRatio: looksLikeSpeech ? ratio : 0, kind: looksLikeSpeech ? 'speech' : ratio > 0.3 ? 'music-or-ambience' : 'ambience',
    noise, peak, loudness: loud, dipRate,
  };
}

// ---------------- Content classification ----------------
export function classifyVideo(samples, audio, duration) {
  const avg = (k) => samples.reduce((a, s) => a + s[k], 0) / Math.max(1, samples.length);
  const motion = avg('motion'), skin = avg('skin'), colorful = avg('colorful'), lum = avg('lum');
  const faceRatio = samples.filter((s) => s.face).length / Math.max(1, samples.length);
  const cuts = samples.filter((s) => s.diff > 0.45).length;
  const cutsPerMin = cuts / Math.max(0.1, duration / 60);
  // jitter = high-frequency motion variation (handheld shake)
  // Shake = camera translation that keeps changing direction inside a shot (a pan is a steady
  // translation, a cut is ignored). Measured as the median change of the frame-to-frame shift.
  const acc = [];
  for (let i = 2; i < samples.length; i++) {
    const a = samples[i], b = samples[i - 1];
    if (a.diff > 0.3 || b.diff > 0.3 || !a.shift || !b.shift) continue;
    acc.push(Math.hypot(a.shift[0] - b.shift[0], a.shift[1] - b.shift[1]));
  }
  acc.sort((x, y) => x - y);
  const jit = acc.length ? acc[Math.floor(acc.length / 2)] : 0;
  const sr = audio.speechRatio || 0;
  const reasons = [];
  let type;
  if (sr > 0.35 && motion < 0.05 && faceRatio > 0.35) { type = 'talking-head'; reasons.push(`speech in ${Math.round(sr * 100)}% of the audio`, `a face visible in ${Math.round(faceRatio * 100)}% of frames`, 'mostly static framing'); }
  else if (sr > 0.18) { type = 'vlog'; reasons.push(`speech in ${Math.round(sr * 100)}% of the audio`, 'moving camera / changing scenes'); }
  else if (cutsPerMin > 8 && audio.hasAudio && audio.kind !== 'speech') { type = 'event'; reasons.push('many scene changes with continuous sound'); }
  else if (motion > 0.07) { type = 'action'; reasons.push('high on-screen motion'); }
  else if (faceRatio < 0.15 && (colorful > 0.12 || lum > 0.4)) { type = 'travel'; reasons.push('scenery with few or no faces, colourful footage'); }
  else { type = 'lifestyle'; reasons.push('general footage without dominant speech'); }
  return { type, reasons, motion, skin, faceRatio, colorful, lum, cutsPerMin, shaky: jit >= 2, jitter: jit };
}

export const VIDEO_TYPES_LABEL = {
  'talking-head': 'Talking-head / educational', vlog: 'Vlog', event: 'Event', action: 'Action / energetic lifestyle',
  travel: 'Travel / scenic', lifestyle: 'Cinematic lifestyle',
};
