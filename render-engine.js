// Inera Edit Flow — offline render engine (faster than real time, unlimited length).
// Video: source frames (WebCodecs) → WebGL compositor (framing, transitions, grade) + 2D overlay
// (B-roll, captions, graphics) → VideoEncoder. Audio: disk-backed source PCM + original music loops
// + SFX with ducking, levelling and a peak limiter → AudioEncoder. Output streamed to disk.
import { Compositor, transitionState } from './compositor.js';
import { encodeTimeline } from './media-encode.js';
import { drawUpright, openSource } from './media-source.js';
import { drawCaptions, drawBroll, drawOverlay, preloadEmoji } from './graphics.js';
import { resolveVisual } from './visuals.js';
import { generateMusic, generateSfx } from './music.js';
import { clamp, lerp, makeCanvas, checkAbort, verifyVideoBlob } from './utils.js';

const SR = 48000;

// ---------- audio mixer ----------
async function buildMixer(edl, an, { seed = 1, signal } = {}) {
  const total = edl.total;
  // dialogue level: speech RMS (70th percentile) to a broadcast-friendly level
  let diaGain = 1;
  if (an.audio && an.audio.rms && an.audio.rms.length) {
    const act = [];
    const sp = an.audio.speech;
    for (let i = 0; i < an.audio.rms.length; i++) if (!sp.length || sp[i]) act.push(an.audio.rms[i]);
    act.sort((a, b) => a - b);
    const ref = act[Math.floor(act.length * 0.7)] || 0.05;
    diaGain = clamp(0.12 / Math.max(1e-4, ref), 0.5, 6);
  }
  // speech presence on the OUTPUT timeline (10 ms) for music ducking
  const step = 0.01, n = Math.ceil(total / step) + 2;
  const env = new Float32Array(n);
  const mark = (a, b) => { for (let i = Math.max(0, Math.floor(a / step)); i < Math.min(n, Math.ceil(b / step)); i++) env[i] = 1; };
  if (edl.captions && edl.captions.groups.length) for (const g of edl.captions.groups) for (const w of g.words) mark(w.s - 0.12, w.e + 0.2);
  else for (const c of edl.clips) {
    if (!c.orig || !an.audio.speech || !an.audio.speech.length) continue;
    for (let tt = c.start; tt < c.start + c.dur; tt += 0.05) { const st = c.src0 + (tt - c.start) * c.speed; if (an.audio.speech[Math.floor(st / 0.05)]) mark(tt - 0.1, tt + 0.15); }
  }
  // smooth: fast attack (look-ahead), slow release
  const sm = new Float32Array(n);
  let v = 0;
  for (let i = n - 1; i >= 0; i--) { v = Math.max(env[i], v - step / 0.12); sm[i] = v; }
  for (let i = 1; i < n; i++) if (sm[i] < sm[i - 1]) sm[i] = Math.max(sm[i], sm[i - 1] - step / 0.45);
  // music loops (two variations alternate so long videos don't feel repetitive)
  let loops = null, loopLen = 0, tail = 3, music = null;
  if (edl.musicLevel > 0) {
    const bars = total > 75 ? 16 : Math.max(4, Math.ceil(total / (240 / edl.bpm)) + 1);
    if (total > 75) {
      const a = await generateMusic({ mood: edl.mood, seed, sampleRate: SR, loopBars: bars, tail });
      checkAbort(signal);
      const b = await generateMusic({ mood: edl.mood, seed: seed + 1, sampleRate: SR, loopBars: bars, tail });
      loops = [a.buffer, b.buffer]; loopLen = a.loopLen; music = a.info;
    } else {
      const a = await generateMusic({ mood: edl.mood, duration: total + 0.3, seed, sampleRate: SR });
      loops = [a.buffer]; loopLen = Infinity; music = a.info;
    }
  }
  const sfxBufs = {};
  for (const type of new Set((edl.sfx || []).map((s) => s.type))) sfxBufs[type] = await generateSfx(type, SR);
  const loopCh = loops ? loops.map((b) => [b.getChannelData(0), b.numberOfChannels > 1 ? b.getChannelData(1) : b.getChannelData(0)]) : null;
  const relCoef = 1 - Math.exp(-1 / (0.15 * SR));
  let lim = 1;
  const store = an.store;
  return {
    music, diaGain,
    async block(t0, t1) {
      const N = Math.round((t1 - t0) * SR);
      const L = new Float32Array(N), R = new Float32Array(N);
      // dialogue / original sound
      if (store) {
        for (let i = 0; i < edl.clips.length; i++) {
          const c = edl.clips[i];
          if (!c.orig || c.speed !== 1) continue;
          const hIn = c.trans.dur / 2, next = edl.clips[i + 1], hOut = next ? next.trans.dur / 2 : 0;
          const wa = c.start - hIn, wb = c.start + c.dur + hOut;
          const a = Math.max(t0, wa), b = Math.min(t1, wb);
          if (b <= a) continue;
          const [sl, sr] = await store.read(c.src0 + (a - c.start), c.src0 + (b - c.start));
          const fin = Math.max(0.012, hIn * 2), fout = Math.max(0.012, hOut * 2);
          const o = Math.round((a - t0) * SR);
          for (let k = 0; k < sl.length && o + k < N; k++) {
            const tt = a + k / SR;
            const g = c.orig * diaGain * Math.min(1, (tt - wa) / fin, (wb - tt) / fout);
            L[o + k] += sl[k] * g; R[o + k] += sr[k] * g;
          }
        }
      }
      // music bed with ducking
      if (loopCh) {
        for (let k = 0; k < N; k++) {
          const tt = t0 + k / SR;
          const ei = Math.min(n - 1, Math.floor(tt / step));
          const mg = lerp(edl.musicLevel, edl.duckLevel ?? edl.musicLevel * 0.3, sm[ei]) * Math.min(1, tt / 1.2, (total - tt) / 2.0);
          if (mg <= 0) continue;
          let s0, s1;
          if (loopLen === Infinity) { const i = Math.floor(tt * SR); const ch = loopCh[0]; s0 = ch[0][i] || 0; s1 = ch[1][i] || 0; }
          else {
            const kk = Math.floor(tt / loopLen), w = tt - kk * loopLen, i = Math.floor(w * SR);
            const cur = loopCh[kk % loopCh.length];
            s0 = cur[0][i] || 0; s1 = cur[1][i] || 0;
            if (kk > 0 && w < tail) { const prev = loopCh[(kk - 1) % loopCh.length]; const j = Math.floor((loopLen + w) * SR); s0 += prev[0][j] || 0; s1 += prev[1][j] || 0; }
          }
          L[k] += s0 * mg; R[k] += s1 * mg;
        }
      }
      // sound effects
      for (const s of edl.sfx || []) {
        if (s.broll && !s.broll.visual) continue; // its picture was dropped: no whoosh either
        const buf = sfxBufs[s.type]; if (!buf) continue;
        const a = Math.max(t0, s.t), b = Math.min(t1, s.t + buf.duration);
        if (b <= a) continue;
        const d0 = buf.getChannelData(0), d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d0;
        const o = Math.round((a - t0) * SR), so = Math.round((a - s.t) * SR), m = Math.round((b - a) * SR);
        for (let k = 0; k < m && o + k < N; k++) { L[o + k] += d0[so + k] * s.gain; R[o + k] += d1[so + k] * s.gain; }
      }
      // master: fades + peak limiter (-1 dBFS)
      for (let k = 0; k < N; k++) {
        const tt = t0 + k / SR;
        const f = Math.min(1, tt / 0.08, (total - tt) / 0.5);
        let l = L[k] * f, r = R[k] * f;
        const pk = Math.max(Math.abs(l), Math.abs(r)) * lim;
        if (pk > 0.89) lim = 0.89 / Math.max(Math.abs(l), Math.abs(r)); else lim += (1 - lim) * relCoef;
        L[k] = l * lim; R[k] = r * lim;
      }
      return [L, R];
    },
  };
}

// ---------- render ----------
export async function renderV2({ src, an, edl, canvas, library = [], online = true, quality = 'high', seed = 1, onStage, onProgress, signal, name = 'inera-edit' }) {
  const { w: W, h: H } = edl.size;
  // 1) visuals
  // music is composed while visuals are fetched (independent work)
  const mixerP = buildMixer(edl, an, { seed, signal }); mixerP.catch(() => {});
  onStage && onStage('visuals');
  const credits = [];
  // resolve visuals 4 at a time; after a 10-second budget, remaining ones use offline illustrations
  const deadline = performance.now() + 10000;
  let done = 0, next = 0;
  const one = async (b) => {
    try {
      b.visual = await resolveVisual(b.keyword, b.key, b.emoji, { library, online: online && performance.now() < deadline, W, H, context: edl.story.mainTopic || '' });
      // a card with only a word on it (no photo, no icon) looks cheap: leave the speaker on screen instead
      if (b.visual && b.visual.source === 'illustration' && !b.visual.credit) b.visual = null;
      if (!b.visual) { done++; onProgress && onProgress(done / Math.max(1, edl.broll.length)); return; }
      if (b.visual.source === 'library' && b.visual.kind === 'video') {
        const ls = await openSource(b.visual.file, { signal });
        b.libSrc = ls; b.reader = ls.createFrameReader();
        b.style = 'full';
      } else if (b.visual.source === 'library' && b.visual.kind === 'image' && !b.visual.bitmap) {
        b.visual.bitmap = await createImageBitmap(b.visual.file);
        b.style = 'full';
      } else {
        const portrait = H > W;
        const hires = b.visual.kind === 'image' && b.visual.hires;
        // vertical video: cutaways never cover the face; horizontal: floating card beside the speaker
        b.style = hires ? 'full' : portrait ? (b.visual.source === 'illustration' ? 'full' : 'fit') : 'card';
      }
    } catch (e) { b.visual = null; }
    done++; onProgress && onProgress(done / Math.max(1, edl.broll.length));
  };
  await Promise.all(Array.from({ length: Math.min(4, edl.broll.length) }, async () => {
    while (next < edl.broll.length) { checkAbort(signal); await one(edl.broll[next++]); }
  }));
  for (const b of edl.broll) if (b.visual && b.visual.credit) credits.push(b.visual.credit);
  await preloadEmoji('🔔');
  for (const o of edl.overlays) if (o.emoji) await preloadEmoji(o.emoji);
  // 2) audio
  onStage && onStage('music');
  const mixer = await mixerP;
  // 3) video
  onStage && onStage('render');
  const comp = new Compositor(canvas, W, H);
  comp.setGrade(edl.grade);
  const readers = [src.createFrameReader(), src.createFrameReader()];
  const srcW = src.width, srcH = src.height;
  const rotCanvas = src.rotation ? [makeCanvas(srcW, srcH), makeCanvas(srcW, srcH)] : null;
  const overlay = makeCanvas(W, H);
  const ox = overlay.getContext('2d');
  const tiny = makeCanvas(64, 36), tctx = tiny.getContext('2d', { willReadFrequently: true });
  const stab = new Map();
  const clips = edl.clips;
  const windowOf = (i) => { const c = clips[i], n = clips[i + 1]; return [c.start - c.trans.dur / 2, c.start + c.dur + (n ? n.trans.dur / 2 : 0)]; };
  const zoomAt = (c, rel) => {
    let z = lerp(c.zoomA, c.zoomB, clamp(rel / Math.max(0.01, c.dur), 0, 1));
    let pz = 1;
    for (const p of c.punches || []) {
      if (rel < p.t) break;
      if (p.hold) { const e = rel - p.t; if (e < p.hold) { const k = Math.min(1, e / 0.18); pz = Math.max(pz, lerp(pz, p.zoom, k)); } continue; }
      pz = p.zoom;
    }
    return z * pz;
  };
  const stabOffset = (i, frame) => {
    let s = stab.get(i); if (!s) { s = { px: 0, py: 0, sx: 0, sy: 0, prev: null }; stab.set(i, s); }
    drawUpright(tctx, frame, src.rotation, 64, 36);
    const d = tctx.getImageData(0, 0, 64, 36).data;
    const g = new Float32Array(64 * 36);
    for (let k = 0; k < g.length; k++) g[k] = d[k * 4] * 0.3 + d[k * 4 + 1] * 0.59 + d[k * 4 + 2] * 0.11;
    if (s.prev) {
      let best = Infinity, bx = 0, by = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        let sum = 0;
        for (let y = 4; y < 32; y += 2) for (let x = 4; x < 60; x += 2) sum += Math.abs(g[y * 64 + x] - s.prev[(y + dy) * 64 + x + dx]);
        if (sum < best) { best = sum; bx = dx; by = dy; }
      }
      s.px += bx / 64; s.py += by / 36; s.sx = s.sx * 0.9 + s.px * 0.1; s.sy = s.sy * 0.9 + s.py * 0.1;
    }
    s.prev = g;
    return [s.sx - s.px, s.sy - s.py];
  };
  const layer = async (i, t) => {
    const c = clips[i];
    const rd = readers[i % 2];
    const srcT = Math.max(0, c.src0 + (t - c.start) * c.speed);
    const fr = await rd.frameAt(srcT);
    let source = fr;
    if (rotCanvas) { const rc = rotCanvas[i % 2]; drawUpright(rc.getContext('2d'), fr, src.rotation, srcW, srcH); source = rc; }
    const off = c.stab ? stabOffset(i, fr) : [0, 0];
    const rect = comp.rectFor(srcW, srcH, { focusX: c.focusX, focusY: c.focusY, zoom: zoomAt(c, t - c.start), offX: off[0], offY: off[1] });
    return { source, key: 'r' + (i % 2), upload: true, rect, gain: c.gain || 1 };
  };
  let cursor = 0;
  const faceX = (() => { const f = an.samples.filter((s) => s.face); return f.length ? f.reduce((a, s) => a + s.face.x, 0) / f.length : 0.5; })();
  const prof = { frame: 0, overlay: 0, audio: 0, n: 0, cached: 0 };
  // A string that is identical for two frames exactly when the overlay pixels are identical;
  // null = animating (must redraw). Mirrors the animation windows used in graphics.js.
  let lastSig = null;
  const capGroups = edl.captions && edl.captions.groups && edl.captions.style !== 'off' ? edl.captions.groups : [];
  let noCache = false; try { noCache = localStorage.getItem('inera-overlay-cache') === 'off'; } catch (e) { /* storage blocked */ }
  const overlaySignature = (t) => {
    if (noCache) return null;
    const parts = [];
    for (const b of edl.broll) if (b.visual && t >= b.t0 && t < b.t1) return null; // moving pictures
    for (let k = 0; k < edl.overlays.length; k++) {
      const o = edl.overlays[k];
      if (t < o.t0 || t >= o.t1) continue;
      if (t - o.t0 < 1.3 || o.t1 - t < 0.3) return null; // entering / leaving / wiggling
      parts.push('o' + k);
    }
    for (let k = 0; k < capGroups.length; k++) {
      const g = capGroups[k];
      if (t < g.t0 || t >= g.t1) continue;
      if (t - g.t0 < 0.16 || g.t1 - t < 0.1) return null; // pop-in / fade
      let act = '';
      for (let i = 0; i < g.words.length; i++) { const w = g.words[i]; if (t >= w.s && t < Math.max(w.e, w.s + 0.12)) act += i + ','; }
      parts.push('c' + k + ':' + act);
    }
    return parts.join('|') || 'none';
  };
  const renderFrame = async (t) => {
    const pf0 = performance.now();
    while (cursor < clips.length - 1 && windowOf(cursor)[1] <= t) cursor++;
    const active = [];
    for (let i = Math.max(0, cursor - 1); i < clips.length; i++) { const w = windowOf(i); if (t >= w[0] && t < w[1]) active.push(i); if (w[0] > t) break; }
    if (!active.length) active.push(Math.min(cursor, clips.length - 1));
    let f;
    if (active.length >= 2) {
      const [i, j] = active.slice(-2);
      const c = clips[j];
      const p = clamp((t - (c.start - c.trans.dur / 2)) / Math.max(0.001, c.trans.dur), 0, 1);
      const ts = transitionState(c.trans.type, p);
      const A = await layer(i, t), B = await layer(j, t);
      if (ts.zoomA) { A.rect[2] /= ts.zoomA; A.rect[3] /= ts.zoomA; }
      if (ts.zoomB) { B.rect[2] /= ts.zoomB; B.rect[3] /= ts.zoomB; }
      A.blur = ts.blurA || 0; B.blur = ts.blurB || 0; A.shift = ts.shiftA; B.shift = ts.shiftB;
      f = { a: A, b: B, mix: ts.mix, blurMode: ts.blurMode || 1, flash: ts.flash || 0, fade: ts.fade || 0 };
    } else f = { a: await layer(active[0], t), mix: 0 };
    f.fade = Math.max(f.fade || 0, 1 - clamp(t / 0.3, 0, 1), 1 - clamp((edl.total - t) / 0.5, 0, 1));
    const pf1 = performance.now(); prof.frame += pf1 - pf0; prof.n++;
    // overlay layer — only redrawn (and re-uploaded to the GPU) when what it shows changes:
    // during animations every frame, otherwise only when a caption word / graphic changes
    const sig = overlaySignature(t);
    if (sig && sig === lastSig) { comp.keepText(); comp.draw(f); prof.overlay += performance.now() - pf1; prof.cached++; return; }
    lastSig = sig;
    let drew = false;
    ox.clearRect(0, 0, W, H);
    for (const b of edl.broll) {
      if (t < b.t0 || t >= b.t1 || !b.visual) continue;
      if (b.reader) { try { b.frame = await b.reader.frameAt(Math.min(t - b.t0, (b.libSrc.duration || 1) - 0.05)); } catch (e) { b.frame = null; } }
      drawBroll(ox, W, H, b, t, faceX); drew = true;
    }
    for (const o of edl.overlays) if (t >= o.t0 && t < o.t1) { drawOverlay(ox, W, H, o, t); drew = true; }
    if (edl.captions && edl.captions.groups.length) { const before = drew; drawCaptions(ox, W, H, edl.captions, t); drew = before || edl.captions.groups.some((g) => t >= g.t0 && t < g.t1); }
    comp.setText(drew ? overlay : null);
    comp.draw(f);
    prof.overlay += performance.now() - pf1;
  };
  let res;
  try {
    res = await encodeTimeline({ canvas, W, H, fps: edl.fps || 30, duration: edl.total, renderFrame, audioBlock: async (a, b) => { const q = performance.now(); const r = await mixer.block(a, b); prof.audio += performance.now() - q; return r; }, quality, name, signal, onProgress });
  } finally {
    readers.forEach((r) => r.close());
    for (const b of edl.broll) { if (b.reader) b.reader.close(); if (b.libSrc) b.libSrc.dispose(); }
    comp.destroy();
  }
  onStage && onStage('verify');
  const check = await verifyVideoBlob(res.file, { expectedDuration: edl.total, expectAudio: true });
  if (!check.ok) throw new Error(check.error);
  return { ...res, check, credits, music: mixer.music, profile: { decodeComposeMs: Math.round(prof.frame), overlayMs: Math.round(prof.overlay), audioMs: Math.round(prof.audio), frames: prof.n, cachedOverlayFrames: prof.cached, totalMs: Math.round(res.elapsed * 1000) } };
}
