// Inera Edit Flow — Mode 4: video → best still images.
// Scene detection + sharpness/motion-blur + exposure + composition + near-duplicate removal.
import { clamp, createVideoEl, waitEvent, seekVideo, makeCanvas, fitSize, canvasToBlob, checkAbort, verifyImageBlob, LIMITS } from './utils.js';
import { scanVideo, hamming, histDist, frameMetrics, estimateShift } from './video-analyzer.js';
import { loadFaceDetector, detectFacesSync, toGray } from './face-detect.js';
import { drawUpright } from './media-source.js';
import { analyzeSource, buildParams, renderVersion } from './image-engine.js';

export const FRAME_MODES = {
  best: 'Best moments (recommended)',
  scenes: 'One per scene (scene thumbnails)',
  even: 'Evenly spaced',
  timestamps: 'Specific timestamps',
  all: 'Complete extraction at an interval',
};

// Fast scan with the WebCodecs decoder: frames are decoded as fast as the computer can (no real-time
// playback, no seeking), with the same measurements as the <video> element scan.
async function scanSource(src, duration, { interval, sampleW = 160, onProgress, signal }) {
  const sw = sampleW, sh = Math.max(16, Math.round(sampleW * src.height / src.width));
  const c = makeCanvas(sw, sh), ctx = c.getContext('2d', { willReadFrequently: true });
  const classify = await loadFaceDetector();
  const reader = src.createFrameReader();
  const samples = [];
  const t0 = performance.now(), budget = clamp(8000 + duration * 400, 15000, 300000);
  const tab = src.info && src.info.video ? src.info.video.samples : null;
  const canJump = !!(tab && tab.keys && tab.keys.length >= 3);
  let step = interval, coarse = false;
  try {
    for (let t = 0; t < duration - 0.04; t += step) {
      checkAbort(signal);
      if (!coarse && performance.now() - t0 > budget && samples.length >= 8) { if (!canJump) break; coarse = true; step = Math.max(interval, (duration - t) / 24); }
      let fr;
      try { if (coarse) reader.jump(t); fr = await reader.frameAt(t); } catch (e) { if (e && e.stalled) break; continue; }
      drawUpright(ctx, fr, src.rotation, sw, sh);
      const img = ctx.getImageData(0, 0, sw, sh);
      const m = frameMetrics(img, null);
      m.t = t;
      m.faces = classify ? detectFacesSync(classify, toGray(img.data, sw, sh), sw, sh, 8) : [];
      m.face = m.faces.length ? m.faces.reduce((a, b) => (b.size > a.size ? b : a)) : null;
      samples.push(m);
      onProgress && onProgress(clamp(t / duration, 0, 1));
    }
  } finally { reader.close(); }
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    let m = 0;
    if (a) { for (let k = 0; k < b.gray.length; k++) m += Math.abs(b.gray[k] - a.gray[k]); m /= b.gray.length; }
    b.motion = m;
    b.diff = a ? histDist(a.hist, b.hist) : 0;
    b.shift = a ? estimateShift(b.gray, a.gray, sw, sh) : [0, 0];
  }
  return { samples, width: src.width, height: src.height };
}

export async function analyzeFrames(probe, { onProgress, signal, src = null }) {
  const interval = clamp(probe.duration / 240, 0.2, probe.duration > 600 ? 3 : 1.25); // long videos: ~1 sample / 3 s
  let scan = null;
  if (src && src.kind === 'webcodecs') { try { scan = await scanSource(src, probe.duration, { interval, sampleW: 160, onProgress, signal }); } catch (e) { if (e && e.name === 'AbortError') throw e; scan = null; } }
  if (!scan || scan.samples.length < 2) scan = await scanVideo(probe.url, probe.duration, { interval, sampleW: 160, onProgress, signal });
  const s = scan.samples;
  const sharpSorted = s.map((x) => x.sharp).sort((a, b) => a - b);
  const med = sharpSorted[Math.floor(sharpSorted.length / 2)] || 1e-4;
  let scene = 0;
  for (let i = 0; i < s.length; i++) {
    const f = s[i];
    if (i && f.diff > 0.33) scene++;
    f.scene = scene;
    f.blurry = false; // decided per scene below
    const expo = 1 - Math.min(1, Math.abs(f.lum - 0.5) / 0.42);
    const sharpN = clamp(f.sharp / (med * 1.6), 0, 1.3) / 1.3;
    // composition: detected face near rule-of-thirds lines or centred
    let comp = 0.5;
    if (f.face) {
      const dx = Math.min(Math.abs(f.face.x - 1 / 3), Math.abs(f.face.x - 0.5), Math.abs(f.face.x - 2 / 3));
      comp = 1 - Math.min(1, dx * 4);
    }
    // stillness relative to neighbours avoids motion blur mid-action
    f.score = f.black || f.washed ? -1 : sharpN * 0.42 + expo * 0.2 + Math.min(1, f.std * 4) * 0.12 + Math.min(1, f.colorful * 4) * 0.1 + comp * 0.08 + (f.face ? 0.1 : 0) - Math.min(0.15, f.motion * 2);
  }
  // Blur is judged inside each scene (motion blur relative to that scene's own sharp frames),
  // so uniformly soft scenes are still represented; only near-featureless frames fail globally.
  const byScene = new Map();
  for (const f of s) { if (!byScene.has(f.scene)) byScene.set(f.scene, []); byScene.get(f.scene).push(f.sharp); }
  const sceneMed = new Map([...byScene].map(([k, v]) => { v.sort((a, b) => a - b); return [k, v[Math.floor(v.length / 2)]]; }));
  for (const f of s) {
    f.blurry = f.sharp < sceneMed.get(f.scene) * 0.5 || f.sharp < med * 0.08;
    // rank within the scene too, so the best frame of a soft scene can compete
    f.score += 0.12 * Math.min(1, f.sharp / Math.max(1e-6, sceneMed.get(f.scene) * 1.5));
  }
  return { samples: s, scenes: scene + 1, width: scan.width, height: scan.height };
}

export function selectFrames(fa, opts, duration) {
  const s = fa.samples;
  const stats = { black: s.filter((x) => x.black).length, blurry: s.filter((x) => x.blurry && !x.black).length, duplicates: 0, candidates: s.length };
  const max = clamp(opts.count || 0, 1, LIMITS.framesMaxCount);
  const isDup = (a, list) => list.some((b) => hamming(a.hash, b.hash) <= 8 && histDist(a.hist, b.hist) < 0.12);
  let picks = [];
  if (opts.mode === 'timestamps') {
    return { picks: (opts.timestamps || []).slice(0, LIMITS.framesMaxCount).map((t) => ({ t, reason: 'Your timestamp' })), stats };
  }
  if (opts.mode === 'all') {
    const step = Math.max(0.1, opts.interval || 1);
    for (let t = 0; t < duration && picks.length < LIMITS.framesMaxCount; t += step) picks.push({ t: Math.min(t, duration - 0.05), reason: 'Interval frame' });
    return { picks, stats };
  }
  if (opts.mode === 'even') {
    const n = opts.count || 10;
    const gap = duration / n;
    for (let k = 0; k < n; k++) {
      const target = gap * (k + 0.5);
      const near = s.filter((x) => Math.abs(x.t - target) <= Math.min(0.6, gap / 3) && x.score >= 0);
      const best = near.sort((a, b) => b.score - a.score)[0];
      picks.push(best ? { t: best.t, reason: `Evenly spaced (sharpest within ±${Math.min(0.6, gap / 3).toFixed(1)}s)`, score: best.score } : { t: target, reason: 'Evenly spaced' });
    }
    return { picks, stats };
  }
  const good = s.filter((x) => x.score >= 0 && (!x.blurry || opts.includeBlurry));
  if (opts.mode === 'scenes') {
    const byScene = new Map();
    for (const f of good) { const b = byScene.get(f.scene); if (!b || f.score > b.score) byScene.set(f.scene, f); }
    picks = [...byScene.values()].sort((a, b) => b.score - a.score).slice(0, max);
    picks = picks.map((f) => ({ t: f.t, score: f.score, reason: `Best frame of scene ${f.scene + 1}` }));
    return { picks: picks.sort((a, b) => a.t - b.t), stats };
  }
  // best moments: first the best frame of every scene (coverage), then fill with the next best
  // frames that are well separated in time and not near-duplicates.
  const n = opts.count || clamp(Math.round(duration / 5), 6, 16);
  const minGap = Math.max(0.8, duration / (n * 2.5));
  const sorted = [...good].sort((a, b) => b.score - a.score);
  const chosen = [];
  const sceneCount = new Map();
  const perSceneCap = Math.max(1, Math.ceil(n / Math.max(1, fa.scenes)) + 1);
  const ok = (f) => !chosen.some((c) => Math.abs(c.t - f.t) < minGap) && !isDup(f, chosen);
  const bestPerScene = new Map();
  for (const f of sorted) if (!bestPerScene.has(f.scene)) bestPerScene.set(f.scene, f);
  for (const f of [...bestPerScene.values()].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= n) break;
    if (ok(f)) { chosen.push(f); sceneCount.set(f.scene, 1); } else stats.duplicates++;
  }
  for (const f of sorted) {
    if (chosen.length >= n) break;
    if (chosen.includes(f) || (sceneCount.get(f.scene) || 0) >= perSceneCap) continue;
    if (!ok(f)) { if (isDup(f, chosen)) stats.duplicates++; continue; }
    chosen.push(f); sceneCount.set(f.scene, (sceneCount.get(f.scene) || 0) + 1);
  }
  picks = chosen.map((f) => ({ t: f.t, score: f.score, reason: f.face ? 'Sharp, well-exposed moment with a face in frame' : 'Sharp, well-exposed, distinct moment' }));
  return { picks: picks.sort((a, b) => a.t - b.t), stats };
}

// Capture picked frames at full quality from the original file
export async function captureFrames(url, picks, opts, { onProgress, signal }) {
  const v = createVideoEl(url);
  await waitEvent(v, 'loadedmetadata', 20000);
  const W = v.videoWidth, H = v.videoHeight;
  const maxLong = opts.resolution === 'original' ? 0 : parseInt(opts.resolution, 10) || 0;
  const size = fitSize(W, H, maxLong); // never upscales
  const out = [];
  const mime = opts.format || 'image/jpeg';
  try {
    for (let k = 0; k < picks.length; k++) {
      checkAbort(signal);
      const p = picks[k];
      await seekVideo(v, p.t, 15000);
      // wait for the frame to be painted (rVFC when available)
      if ('requestVideoFrameCallback' in v) await new Promise((r) => { let done = false; v.requestVideoFrameCallback(() => { done = true; r(); }); setTimeout(() => { if (!done) r(); }, 250); });
      let c = makeCanvas(size.w, size.h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(v, 0, 0, size.w, size.h);
      let enhanced = false;
      if (opts.enhance) {
        const a = await analyzeSource(c);
        const { params } = buildParams(a, 'natural', 0.7);
        params.vignette = 0;
        c = await renderVersion(c, a, params, {});
        enhanced = true;
      }
      const blob = await canvasToBlob(c, mime, mime === 'image/png' ? undefined : 0.93);
      const ver = await verifyImageBlob(blob);
      if (!ver.ok) throw new Error(ver.error);
      out.push({ t: p.t, blob, width: ver.width, height: ver.height, reason: p.reason, enhanced, mime: blob.type });
      onProgress && onProgress((k + 1) / picks.length);
    }
  } finally { v.removeAttribute('src'); v.load(); }
  return out;
}
