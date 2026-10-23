// Inera Edit Flow — Mode 3: images → video.
// Honest method label: this is an AI-planned *animated slideshow* (camera pan/zoom, beat-timed
// transitions, colour-matched grading, original music). It is NOT generative AI motion.
import { clamp, lerp, checkAbort, pickRecorderMime, detectCodecs, verifyVideoBlob, canvasToBlob, LIMITS } from './utils.js';
import { analyzeSource, classifyScene, autoStyleFor, buildParams, renderVersion, faceFocus } from './image-engine.js';
import { generateMusic, generateSfx, MOODS } from './music.js';
import { Compositor, transitionState, drawTitleCard, recordTimeline } from './compositor.js';
import { encodeTimeline } from './media-encode.js';
import { makeCanvas } from './utils.js';

export const SLIDESHOW_METHOD = 'Animated slideshow — AI-planned pan & zoom, transitions and music (not generative AI motion)';

export async function prepareSlides(items, { onProgress, signal }) {
  // analyse each image (scene, faces/skin, saliency, colour)
  for (let i = 0; i < items.length; i++) {
    checkAbort(signal);
    const it = items[i];
    if (!it.analysis) {
      it.analysis = await analyzeSource(it.img);
      it.scene = classifyScene(it.analysis);
    }
    onProgress && onProgress((i + 1) / items.length);
  }
  return items;
}

function histOf(a) { return [a.meanR, a.meanG, a.meanB, a.mean, a.saturation, a.warmth]; }
function dist(x, y) { let s = 0; for (let k = 0; k < x.length; k++) s += (x[k] - y[k]) ** 2; return Math.sqrt(s); }

export function autoOrder(items) {
  if (items.length < 3) return { order: items.map((_, i) => i), how: 'kept upload order' };
  if (items.every((it) => it.exifDate)) {
    const order = items.map((_, i) => i).sort((a, b) => items[a].exifDate - items[b].exifDate);
    return { order, how: 'sorted by capture date (from photo EXIF data)' };
  }
  // start from the strongest "hook" image, then chain visually similar images
  const hookScore = (a) => Math.min(1, a.sharpness * 300) * 0.4 + Math.min(1, a.colorfulness * 4) * 0.3 + ((a.faces || []).length ? 0.3 : 0);
  let cur = items.map((it, i) => [hookScore(it.analysis), i]).sort((x, y) => y[0] - x[0])[0][1];
  const left = new Set(items.map((_, i) => i)); left.delete(cur);
  const order = [cur];
  while (left.size) {
    let best = -1, bd = Infinity;
    for (const j of left) { const d = dist(histOf(items[cur].analysis), histOf(items[j].analysis)); if (d < bd) { bd = d; best = j; } }
    order.push(best); left.delete(best); cur = best;
  }
  return { order, how: 'opened with the strongest image, then grouped visually similar photos for smooth flow' };
}

export function planSlideshow(items, order, opts, seed = 1) {
  const scenes = items.map((it) => it.scene.type);
  const count = (t) => scenes.filter((s) => s === t).length;
  let mood = opts.mood && opts.mood !== 'auto' ? opts.mood : null;
  if (!mood) {
    if (count('landscape') + count('outdoor') >= items.length / 2) mood = 'cinematic';
    else if (count('portrait') + count('group') + count('event') + count('food') >= items.length / 2) mood = 'upbeat';
    else mood = items.reduce((a, it) => a + it.analysis.saturation, 0) / items.length < 0.18 ? 'calm' : 'cinematic';
  }
  const bpm = MOODS[mood].bpm, beat = 60 / bpm;
  let beatsPer = mood === 'calm' ? 4 : mood === 'cinematic' ? 4 : 4;
  if (opts.pace === 'fast') beatsPer = 2; else if (opts.pace === 'slow') beatsPer = 8;
  let per = beatsPer * beat;
  if (items.length === 1) per = Math.max(6, Math.round(7 / beat) * beat);
  if (opts.targetDuration && items.length > 1) per = clamp(Math.round((opts.targetDuration / items.length) / beat) * beat, beat * 2, beat * 12);
  const transType = { cinematic: 'fade', calm: 'fade', upbeat: 'zoom', energetic: 'whip', subtle: 'fade' }[mood] || 'fade';
  const slides = [];
  let t = 0;
  order.forEach((idx, k) => {
    const it = items[idx], a = it.analysis;
    const ff = faceFocus(a);
    const face = !!ff;
    const fx = face ? ff.x : a.salX, fy = face ? clamp(ff.y, 0.15, 0.85) : a.salY;
    let motion;
    const imgA = a.srcW / a.srcH;
    const outA = opts.outW / opts.outH;
    if (face) motion = { z0: 1.02, z1: 1.16, f0: [0.5, 0.45], f1: [fx, fy], name: 'slow push-in toward the person' };
    else if (imgA > outA * 1.35) motion = k % 2 ? { z0: 1.03, z1: 1.03, f0: [0.0, fy], f1: [1.0, fy], name: 'pan across the scene' } : { z0: 1.03, z1: 1.03, f0: [1.0, fy], f1: [0.0, fy], name: 'pan across the scene' };
    else if (imgA < outA / 1.35) motion = { z0: 1.03, z1: 1.03, f0: [fx, 0.0], f1: [fx, 1.0], name: 'vertical reveal pan' };
    else motion = k % 2 ? { z0: 1.16, z1: 1.03, f0: [fx, fy], f1: [0.5, 0.5], name: 'slow pull-out' } : { z0: 1.03, z1: 1.15, f0: [0.5, 0.5], f1: [fx, fy], name: 'slow push-in toward the subject' };
    const tt = k === 0 ? { type: 'cut', dur: 0 } : { type: opts.transitions === 'minimal' ? 'fade' : (k % 5 === 0 && transType !== 'fade' ? 'flash' : transType), dur: Math.min(0.7, beat * (transType === 'fade' ? 1 : 0.75)) };
    slides.push({ idx, start: t, dur: per, motion, trans: tt });
    t += per;
  });
  // transitions overlap: extend previous slide by half the next transition
  const total = t;
  const texts = opts.title ? [{ t0: 0.3, t1: Math.min(total - 0.4, 3.4), text: opts.title }] : [];
  return { slides, total, mood, bpm, beat, texts, transType };
}

export async function renderSlideshow(items, plan, opts, { canvas, audioCtx, seed = 1, onStage, onProgress, onPauseChange, signal }) {
  // 1) enhance every image for consistent colour (stored as JPEG to keep memory low)
  onStage('enhance');
  const maxLong = Math.min(2600, Math.round(Math.max(opts.outW, opts.outH) * 1.3));
  const enhanced = [];
  for (let k = 0; k < items.length; k++) {
    checkAbort(signal);
    const it = items[k];
    const style = opts.grade === 'mono' ? 'mono' : autoStyleFor(it.scene.type);
    const { params } = buildParams(it.analysis, style, 0.8, opts.bright ? { exposure: opts.bright > 1 ? 0.15 : -0.1 } : {});
    params.vignette = 0; // vignette is applied once, globally, by the compositor
    const c = await renderVersion(it.img, it.analysis, params, { maxLong });
    enhanced[k] = { blob: await canvasToBlob(c, 'image/jpeg', 0.93), w: c.width, h: c.height };
    onProgress((k + 1) / items.length);
  }
  checkAbort(signal);
  onStage('music');
  const music = await generateMusic({ mood: plan.mood, duration: plan.total + 0.2, seed });
  const sfx = {};
  for (const ty of ['whoosh', 'hit', 'pop']) sfx[ty] = await generateSfx(ty);
  // mix: music + subtle sfx on whip/flash/zoom transitions
  const sr = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil((plan.total + 0.1) * sr), sr);
  const m = ctx.createBufferSource(); m.buffer = music.buffer;
  const mg = ctx.createGain(); mg.gain.value = opts.music === 'off' ? 0 : opts.music === 'low' ? 0.55 : 0.9;
  m.connect(mg); mg.connect(ctx.destination); m.start(0);
  if (!opts.noSfx) {
    for (const s of plan.slides) {
      const ty = s.trans.type === 'whip' || s.trans.type === 'zoom' ? 'whoosh' : s.trans.type === 'flash' ? 'hit' : null;
      if (!ty) continue;
      const src = ctx.createBufferSource(); src.buffer = sfx[ty];
      const g = ctx.createGain(); g.gain.value = ty === 'hit' ? 0.3 : 0.25;
      src.connect(g); g.connect(ctx.destination); src.start(Math.max(0, s.start - 0.3));
    }
    if (plan.texts.length) { const src = ctx.createBufferSource(); src.buffer = sfx.pop; const g = ctx.createGain(); g.gain.value = 0.25; src.connect(g); g.connect(ctx.destination); src.start(0.3); }
  }
  const mixed = await ctx.startRendering();
  checkAbort(signal);
  // 2) render
  onStage('render');
  const comp = new Compositor(canvas, opts.outW, opts.outH);
  comp.setGrade({ contrast: 0.06, sat: opts.grade === 'mono' ? 0 : 1.02, vignette: 0.12, mono: opts.grade === 'mono' ? 1 : 0 });
  const bitmaps = new Map();
  const loading = new Map();
  const ensure = (k) => {
    if (bitmaps.has(k) || loading.has(k) || k < 0 || k >= plan.slides.length) return loading.get(k);
    const e = enhanced[plan.slides[k].idx];
    // HTMLImageElement (not ImageBitmap): WebGL's UNPACK_FLIP_Y flag is ignored for ImageBitmap,
    // which would render photos upside-down.
    const url = URL.createObjectURL(e.blob);
    const im = new Image();
    im.src = url;
    const p = im.decode().then(() => { im.close = () => URL.revokeObjectURL(url); bitmaps.set(k, im); loading.delete(k); })
      .catch(() => { URL.revokeObjectURL(url); loading.delete(k); });
    loading.set(k, p);
    return p;
  };
  await ensure(0); await ensure(1);
  const textCanvas = makeCanvas(opts.outW, opts.outH);
  let textKey = '';
  const layer = async (k, t) => {
    const s = plan.slides[k];
    if (!bitmaps.has(k)) await ensure(k);
    const bm = bitmaps.get(k);
    const p = clamp((t - s.start + (s.trans.dur / 2)) / (s.dur + s.trans.dur), 0, 1);
    const e = p * p * (3 - 2 * p) * 0.6 + p * 0.4;
    const mo = s.motion;
    const rect = comp.rectFor(bm.naturalWidth, bm.naturalHeight, { zoom: lerp(mo.z0, mo.z1, e), focusX: lerp(mo.f0[0], mo.f1[0], e), focusY: lerp(mo.f0[1], mo.f1[1], e) });
    const key = 'img' + k;
    return { source: bm, key, upload: !comp.hasTex(key), rect, gain: 1 };
  };
  // Chrome / Edge: frame-exact offline encode (faster than real time, tab may be hidden).
  // Other browsers: real-time MediaRecorder capture.
  const offline = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  const mime = offline ? '' : pickRecorderMime();
  if (mime === null) throw new Error('This browser cannot record video. Please use the latest Chrome, Edge, Firefox or Safari.');
  let blob, label = null, disk = null;
  const L = mixed.getChannelData(0), R = mixed.numberOfChannels > 1 ? mixed.getChannelData(1) : L;
  try {
    const onFrame = async (t) => {
        let i = plan.slides.findIndex((s) => t >= s.start && t < s.start + s.dur);
        if (i < 0) i = plan.slides.length - 1;
        ensure(i + 1); ensure(i + 2);
        // release textures and bitmaps that are no longer needed
        for (const k of [...bitmaps.keys()]) if (k < i - 1) { comp.releaseTex('img' + k); bitmaps.get(k).close && bitmaps.get(k).close(); bitmaps.delete(k); }
        const next = plan.slides[i + 1];
        let f;
        if (next && next.trans.dur && t >= next.start - next.trans.dur / 2) {
          const p = clamp((t - (next.start - next.trans.dur / 2)) / next.trans.dur, 0, 1);
          const ts = transitionState(next.trans.type, p);
          const A = await layer(i, t), B = await layer(i + 1, t);
          if (ts.zoomA) { A.rect[2] /= ts.zoomA; A.rect[3] /= ts.zoomA; }
          if (ts.zoomB) { B.rect[2] /= ts.zoomB; B.rect[3] /= ts.zoomB; }
          A.blur = ts.blurA || 0; B.blur = ts.blurB || 0; A.shift = ts.shiftA; B.shift = ts.shiftB;
          f = { a: A, b: B, mix: ts.mix, blurMode: ts.blurMode || 1, flash: ts.flash || 0, fade: ts.fade || 0 };
        } else {
          const cur = plan.slides[i];
          if (cur.trans.dur && t < cur.start + cur.trans.dur / 2 && i > 0) {
            const p = clamp((t - (cur.start - cur.trans.dur / 2)) / cur.trans.dur, 0, 1);
            const ts = transitionState(cur.trans.type, p);
            const A = await layer(i - 1, t), B = await layer(i, t);
            if (ts.zoomA) { A.rect[2] /= ts.zoomA; A.rect[3] /= ts.zoomA; }
            if (ts.zoomB) { B.rect[2] /= ts.zoomB; B.rect[3] /= ts.zoomB; }
            A.blur = ts.blurA || 0; B.blur = ts.blurB || 0; A.shift = ts.shiftA; B.shift = ts.shiftB;
            f = { a: A, b: B, mix: ts.mix, blurMode: ts.blurMode || 1, flash: ts.flash || 0, fade: ts.fade || 0 };
          } else f = { a: await layer(i, t), mix: 0 };
        }
        f.fade = Math.max(f.fade || 0, 1 - clamp(t / 0.5, 0, 1), 1 - clamp((plan.total - t) / 0.7, 0, 1));
        const tx = plan.texts.find((x) => t >= x.t0 && t <= x.t1);
        if (tx) {
          const prog = Math.min(clamp((t - tx.t0) / 0.4, 0, 1), clamp((tx.t1 - t) / 0.3, 0, 1));
          const key = prog.toFixed(2);
          if (key !== textKey) { drawTitleCard(textCanvas, tx.text, { progress: prog }); comp.setText(textCanvas); textKey = key; }
        } else if (textKey) { comp.setText(null); textKey = ''; }
        comp.draw(f);
    };
    if (offline) {
      const res = await encodeTimeline({
        canvas, W: opts.outW, H: opts.outH, fps: 30, duration: plan.total, renderFrame: onFrame, quality: 'high', name: 'inera-photo-video', signal, onProgress,
        audioBlock: (a, b) => { const i0 = Math.round(a * 48000), n = Math.round((b - a) * 48000); return [L.slice(i0, i0 + n), R.slice(i0, i0 + n)]; },
      });
      blob = res.file; label = res.label; disk = res.onDisk ? res.fileName : null;
    } else {
      blob = await recordTimeline({ canvas, audioCtx, audioBuffer: mixed, duration: plan.total, fps: 30, mime, bitrate: Math.round(opts.outW * opts.outH * 30 * 0.12), onProgress, onPauseChange, signal, onFrame });
    }
  } finally {
    for (const b of bitmaps.values()) b.close && b.close();
    comp.destroy();
  }
  onStage('verify');
  const check = await verifyVideoBlob(blob, { expectedDuration: plan.total, expectAudio: opts.music !== 'off' });
  if (!check.ok) throw new Error(check.error);
  return { blob, check, format: label || (await detectCodecs(blob)).label, music: music.info, opfs: disk };
}

export function slideshowOutputSize(aspect, items) {
  let a = aspect;
  if (!a || a === 'auto') {
    const portrait = items.filter((it) => it.analysis ? it.analysis.srcH > it.analysis.srcW : it.img.naturalHeight > it.img.naturalWidth).length;
    a = portrait >= items.length / 2 ? '9:16' : '16:9';
  }
  const d = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] }[a] || [1920, 1080];
  return { w: d[0], h: d[1], aspect: a };
}
export { LIMITS };
