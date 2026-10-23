// Inera Edit Flow — Mode 2: automatic video editing.
// Pipeline: analyse → classify content → plan edit (EDL) → compose original music →
// mix audio (dialogue, ambience, music with ducking, SFX) → GPU render → verify.
import { interpretVideoPrompt } from './prompt.js';
import { clamp, lerp, seededRandom, createVideoEl, waitEvent, seekVideo, makeCanvas, checkAbort, pickRecorderMime, detectCodecs, verifyVideoBlob, LIMITS } from './utils.js';
import { scanVideo, analyzeAudio, classifyVideo, AUDIO_HOP, VIDEO_TYPES_LABEL } from './video-analyzer.js';
import { generateMusic, generateSfx, MOODS } from './music.js';
import { Compositor, transitionState, drawTitleCard, recordTimeline } from './compositor.js';

export const VIDEO_STYLES = {
  auto: 'Auto (recommended)', creator: 'Creator Pro — hooks, punch-ins, energy', cinematic: 'Cinematic', natural: 'Natural vlog',
  energetic: 'Energetic montage', minimal: 'Minimal & clean',
};

const PROFILES = {
  'talking-head': { mood: 'subtle', music: 0.11, duck: 0.045, orig: 1, speechDriven: true, pauseMax: 0.35, trans: 'cut', punch: true, hook: false, sfx: 'pop', grade: 'natural', ramps: false },
  vlog: { mood: 'upbeat', music: 0.2, duck: 0.055, orig: 1, speechDriven: true, pauseMax: 0.45, trans: 'mixed', punch: true, hook: false, sfx: 'light', grade: 'warm', ramps: false, broll: true },
  travel: { mood: 'cinematic', music: 0.85, orig: 0.2, beats: 4, trans: 'smooth', hook: true, sfx: 'whoosh', grade: 'cinematic', ramps: true, keep: 0.5, maxT: 45 },
  action: { mood: 'energetic', music: 0.9, orig: 0.28, beats: 2, trans: 'dynamic', hook: true, sfx: 'whoosh', grade: 'punchy', ramps: true, keep: 0.4, maxT: 30 },
  event: { mood: 'upbeat', music: 0.65, orig: 0.55, beats: 4, trans: 'smooth', hook: true, sfx: 'light', grade: 'vibrant', ramps: false, keep: 0.55, maxT: 60 },
  lifestyle: { mood: 'cinematic', music: 0.8, orig: 0.25, beats: 4, trans: 'smooth', hook: true, sfx: 'whoosh', grade: 'cinematic', ramps: true, keep: 0.5, maxT: 40 },
};

const GRADES = {
  natural: { contrast: 0.08, sat: 1.06, vignette: 0.05 },
  warm: { contrast: 0.1, sat: 1.08, temp: 0.14, vignette: 0.08 },
  cinematic: { contrast: 0.2, sat: 0.96, splitS: [-0.25, 0.04, 0.25], splitH: [0.25, 0.1, -0.18], splitAmt: 0.08, vignette: 0.2 },
  punchy: { contrast: 0.22, sat: 1.14, vignette: 0.12 },
  vibrant: { contrast: 0.15, sat: 1.18, vignette: 0.06 },
  mono: { contrast: 0.25, sat: 0, mono: 1, vignette: 0.15 },
};

// ---------- Optional prompt interpreter ----------
// Prompt → settings. The full interpreter lives in prompt.js; this adapter keeps the shape older callers use.
export function parseVideoPrompt(text) {
  const r = interpretVideoPrompt(text);
  const m = { ...r.o, notes: r.notes, understood: r.understood, notUnderstood: r.notUnderstood, parts: r.parts };
  if (r.o.sfx === 'off') m.noSfx = true;
  if (r.o.noText) { m.noText = true; }
  if (m.targetDuration && m.targetDuration > LIMITS.longVideoMaxSeconds) delete m.targetDuration;
  return m;
}

export function outputSizeFor(aspect, srcW, srcH) {
  let a = aspect;
  if (!a || a === 'auto') { const r = srcW / srcH; a = r > 1.15 ? '16:9' : r < 0.87 ? '9:16' : '1:1'; }
  const dims = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] }[a] || [1920, 1080];
  // Same orientation: never exceed the source resolution. Changing the aspect (e.g. 16:9 → 9:16)
  // always crops, so use the platform standard (1080 short side) for best delivery quality.
  const srcShort = Math.min(srcW, srcH), outShort = Math.min(dims[0], dims[1]);
  const srcLand = srcW / srcH > 1.15 ? 'land' : srcW / srcH < 0.87 ? 'port' : 'sq';
  const outLand = dims[0] / dims[1] > 1.15 ? 'land' : dims[0] / dims[1] < 0.87 ? 'port' : 'sq';
  const s = srcLand === outLand ? Math.min(1, Math.max(480, srcShort) / outShort) : (srcShort < 480 ? 0.667 : 1);
  const even = (v) => Math.max(2, Math.round(v * s / 2) * 2);
  return { w: even(dims[0]), h: even(dims[1]), aspect: a };
}

// ---------- Edit planning ----------
function samplesIn(samples, a, b) { return samples.filter((s) => s.t >= a - 1e-3 && s.t <= b + 1e-3); }
function mean(arr, k) { return arr.length ? arr.reduce((x, s) => x + s[k], 0) / arr.length : 0; }

export function planEdit(an, opts, seed = 1) {
  const rnd = seededRandom(seed * 2654435761);
  const { samples, audio, cls, duration } = an;
  const P = { ...(PROFILES[cls.type] || PROFILES.lifestyle) };
  const decisions = [];
  // style overrides
  const style = opts.style || 'auto';
  if (style === 'cinematic') Object.assign(P, { grade: 'cinematic', trans: P.speechDriven ? 'mixed' : 'smooth', mood: P.speechDriven ? P.mood : 'cinematic' });
  if (style === 'energetic') Object.assign(P, { mood: P.speechDriven ? 'upbeat' : 'energetic', trans: P.speechDriven ? 'mixed' : 'dynamic', beats: 2, grade: 'punchy', ramps: !P.speechDriven });
  if (style === 'natural') Object.assign(P, { grade: 'natural', trans: P.speechDriven ? 'cut' : 'smooth', ramps: false });
  if (style === 'minimal') Object.assign(P, { trans: 'minimal', punch: false, sfx: 'none', ramps: false, hook: false });
  if (style === 'creator') Object.assign(P, { punch: true, hook: !P.speechDriven, sfx: P.sfx === 'none' ? 'light' : P.sfx === 'pop' ? 'light' : P.sfx });
  if (opts.transitions === 'minimal') P.trans = 'minimal';
  else if (opts.transitions === 'dynamic') P.trans = P.speechDriven ? 'mixed' : 'dynamic';
  if (opts.mood && MOODS[opts.mood]) P.mood = opts.mood;
  if (opts.grade) P.grade = opts.grade;
  if (opts.noSfx) P.sfx = 'none';
  const intensity = opts.intensity || 'auto';
  if (intensity === 'light') Object.assign(P, { punch: false, ramps: false, sfx: P.sfx === 'none' ? 'none' : 'pop' });
  if (intensity === 'bold' && !P.speechDriven) Object.assign(P, { beats: Math.min(P.beats || 4, 2), ramps: true });
  const bpm = MOODS[P.mood].bpm;
  const beat = 60 / bpm;
  const hasSpeech = audio.hasAudio && audio.segments.length > 0 && audio.speechRatio > 0.08;

  // quality per sample
  const sharpSorted = samples.map((s) => s.sharp).sort((a, b) => a - b);
  const sharpMed = sharpSorted[Math.floor(sharpSorted.length / 2)] || 1e-4;
  for (const s of samples) {
    const sh = clamp(s.sharp / (sharpMed * 1.5), 0, 1.4) / 1.4;
    const expo = 1 - Math.min(1, Math.abs(s.lum - 0.48) / 0.4);
    s.q = s.black || s.washed ? -1 : sh * 0.4 + expo * 0.25 + Math.min(1, s.colorful * 4) * 0.15 + Math.min(1, s.std * 4) * 0.1 + (s.face ? 0.1 : 0);
  }
  const badFrames = samples.filter((s) => s.q < 0).length;
  if (badFrames) decisions.push(`Found ${badFrames} black/blank or washed-out moments and excluded them`);

  let clips = [];
  const speechAt = (t) => { if (!hasSpeech) return 0; const i = Math.floor(t / AUDIO_HOP); return audio.speech[i] || 0; };
  const focusFor = (a, b) => {
    const ss = samplesIn(samples, a, b).filter((s) => s.face);
    if (!ss.length) return { fx: 0.5, fy: 0.45 };
    const fx = ss.reduce((x, s) => x + s.face.x, 0) / ss.length, fy = ss.reduce((x, s) => x + s.face.y, 0) / ss.length;
    return { fx, fy: clamp(fy + 0.05, 0.15, 0.85) };
  };

  if (P.speechDriven && hasSpeech) {
    // ----- speech-first edit: keep every spoken phrase, tighten long pauses -----
    const pauseMax = opts.keepPauses ? 1e9 : P.pauseMax;
    const ints = [];
    for (const seg of audio.segments) {
      const a = Math.max(0, seg.s - 0.12), b = Math.min(duration, seg.e + 0.22);
      const last = ints[ints.length - 1];
      if (last && a - last.b <= pauseMax) last.b = b; else ints.push({ a, b, speech: true });
    }
    // leading/trailing silence and long pauses are dropped; count the time removed
    const kept = ints.reduce((x, i) => x + (i.b - i.a), 0);
    decisions.push(`Detected ${audio.segments.length} spoken phrases; kept all speech`);
    if (duration - kept > 0.5) decisions.push(`Removed ${(duration - kept).toFixed(1)}s of dead air, long pauses and silent lead-in/out`);
    // B-roll: good-looking silent stretches in vlogs
    if (P.broll) {
      const gaps = [];
      let prev = 0;
      for (const i of ints) { if (i.a - prev > 2.5) gaps.push({ a: prev + 0.3, b: i.a - 0.3 }); prev = i.b; }
      if (duration - prev > 2.5) gaps.push({ a: prev + 0.3, b: duration - 0.3 });
      let added = 0;
      for (const g of gaps) {
        const ss = samplesIn(samples, g.a, g.b);
        const q = mean(ss, 'q');
        if (q > 0.35 && ss.every((s) => s.q >= 0)) {
          const len = Math.min(3, g.b - g.a);
          const best = ss.reduce((x, s) => (s.q > x.q ? s : x), ss[0]);
          const a = clamp(best.t - len / 2, g.a, g.b - len);
          ints.push({ a, b: a + len, speech: false, broll: true }); added++;
        }
      }
      ints.sort((x, y) => x.a - y.a);
      if (added) decisions.push(`Kept ${added} short visual moment(s) between talking parts as B-roll`);
    }
    // Target duration: keep the strongest phrases chronologically
    let chosen = ints;
    const target = opts.targetDuration;
    if (target && kept > target + 1 && !opts.keepAllSpeech) {
      const scored = ints.map((i, k) => ({ i, k, score: (i.speech ? 1 : 0.4) * Math.sqrt(i.b - i.a) * (1 + 0.6 * mean(samplesIn(samples, i.a, i.b), 'q')) + (k === 0 ? 2 : 0) }));
      scored.sort((x, y) => y.score - x.score);
      let tot = 0; const pick = new Set();
      for (const s of scored) { if (tot >= target) break; pick.add(s.k); tot += s.i.b - s.i.a; }
      chosen = ints.filter((_, k) => pick.has(k));
      decisions.push(`Shortened to about ${Math.round(tot)}s by keeping the strongest phrases in order`);
    } else if (target && kept > target + 1 && opts.keepAllSpeech) {
      decisions.push(`Kept all speech as requested, so the ${target}s target could not be met (${Math.round(kept)}s)`);
    }
    // Build clips; split long ones at phrase boundaries for punch-in alternation
    let t = 0;
    let k = 0;
    for (const iv of chosen) {
      const f = focusFor(iv.a, iv.b);
      const punches = [];
      if (P.punch && iv.speech) {
        // alternate framing at phrase starts inside the interval (hides jump cuts, adds energy)
        const inner = audio.segments.filter((s) => s.s > iv.a + 0.8 && s.s < iv.b - 1.0);
        let z = (k % 2) ? 1.12 : 1.0;
        punches.push({ t: 0, zoom: z });
        for (const s of inner) { z = z > 1.05 ? 1.0 : 1.12; punches.push({ t: s.s - iv.a, zoom: z }); }
        // emphasis: loudest moments get a short, stronger push
        if (audio.rms) {
          const a0 = Math.floor(iv.a / AUDIO_HOP), b0 = Math.floor(iv.b / AUDIO_HOP);
          const vals = []; for (let q = a0; q < b0; q++) vals.push(audio.rms[q] || 0);
          const sorted = [...vals].sort((x, y) => y - x); const thr = sorted[Math.floor(sorted.length * 0.04)] || 1;
          let lastE = -10;
          for (let q = 0; q < vals.length; q++) if (vals[q] >= thr && q * AUDIO_HOP - lastE > 6) { punches.push({ t: q * AUDIO_HOP, zoom: 1.2, hold: 0.9 }); lastE = q * AUDIO_HOP; }
          punches.sort((x, y) => x.t - y.t);
        }
      }
      clips.push({ start: t, dur: iv.b - iv.a, src0: iv.a, speed: 1, zoomA: iv.broll ? 1.0 : 1, zoomB: iv.broll ? 1.06 : 1, focusX: f.fx, focusY: f.fy, punches, orig: 1, speech: iv.speech, trans: { type: 'cut', dur: 0 } });
      t += iv.b - iv.a; k++;
    }
    if (P.punch) decisions.push('Added punch-in framing changes at phrase boundaries and emphasis zooms on the loudest moments');
    // transitions: jump cuts for talking heads; occasional smooth transition around B-roll
    clips.forEach((c, i) => {
      if (i === 0) return;
      if (P.trans === 'mixed' && (c.zoomB !== 1 || clips[i - 1].zoomB !== 1)) c.trans = { type: 'fade', dur: 0.35 };
      else c.trans = { type: 'cut', dur: 0 };
    });
  } else {
    // ----- montage edit: best moments, beat-synchronised -----
    const beatsPer = P.beats || 4;
    const clipLen = beatsPer * beat;
    const usable = samples.filter((s) => s.q >= 0).length / Math.max(1, samples.length) * duration;
    let T = opts.targetDuration || clamp(duration * (P.keep || 0.5), Math.min(duration, 12), P.maxT || 40);
    T = Math.min(T, usable * 0.95, LIMITS.videoOutputMaxSeconds);
    T = Math.max(Math.min(duration, 4), Math.round(T / beat) * beat);
    const cutsT = samples.filter((s) => s.diff > 0.45).map((s) => s.t);
    const windows = [];
    const step = Math.max(0.25, clipLen / 3);
    for (let a = 0; a + clipLen <= duration + 1e-6; a += step) {
      const ss = samplesIn(samples, a, a + clipLen);
      if (!ss.length) continue;
      if (ss.some((s) => s.q < 0)) continue;
      const straddles = cutsT.some((c) => c > a + 0.25 && c < a + clipLen - 0.25);
      const m = mean(ss, 'motion');
      const motionScore = P.mood === 'energetic' ? Math.min(1, m * 12) : 1 - Math.min(1, Math.abs(m - 0.03) * 15);
      const score = mean(ss, 'q') * 0.75 + motionScore * 0.25 - (straddles ? 0.4 : 0) + rnd() * 0.04;
      windows.push({ a, b: a + clipLen, score, motion: m, hist: ss[Math.floor(ss.length / 2)].hist, f: focusFor(a, a + clipLen) });
    }
    const picks = [];
    const sorted = [...windows].sort((x, y) => y.score - x.score);
    const histD = (x, y) => { let s = 0; for (let k = 0; k < 64; k++) s += Math.abs(x[k] - y[k]); return s / 2; };
    const tryPick = (strict) => {
      for (const w of sorted) {
        if (picks.length * clipLen >= T - 1e-3) break;
        if (picks.includes(w)) continue;
        if (picks.some((p) => w.a < p.b + 0.15 && w.b > p.a - 0.15)) continue;
        if (strict && picks.some((p) => Math.abs(p.a - w.a) < 4 && histD(p.hist, w.hist) < 0.06)) continue;
        picks.push(w);
      }
    };
    tryPick(true);
    if (picks.length * clipLen < T - 1e-3) tryPick(false);
    if (!picks.length && windows.length) picks.push(sorted[0]);
    if (!picks.length) {
      // very short/odd footage: use the whole usable video
      picks.push({ a: 0, b: Math.min(duration, T), score: 0, motion: 0, f: { fx: 0.5, fy: 0.45 } });
    }
    picks.sort((x, y) => x.a - y.a);
    decisions.push(`Selected the ${picks.length} strongest moments (sharpness, exposure, colour, motion) and kept them in their original order`);
    decisions.push(`Cut lengths follow the music: ${beatsPer} beats per clip at ${bpm} BPM`);
    let t = 0;
    // hook: a short teaser of the single best moment
    if (P.hook && picks.length >= 4 && T >= 10) {
      const best = [...picks].sort((x, y) => y.score - x.score)[0];
      const hl = Math.min(2 * beat, best.b - best.a);
      clips.push({ start: 0, dur: hl, src0: best.a, speed: 1, zoomA: 1.12, zoomB: 1.0, focusX: best.f.fx, focusY: best.f.fy, punches: [], orig: P.orig, hook: true, trans: { type: 'cut', dur: 0 } });
      t = hl;
      decisions.push('Opened with a 2-beat hook teaser of the best moment');
    }
    let rampCount = 0;
    picks.forEach((w, i) => {
      let speed = 1, src0 = w.a, dur = w.b - w.a;
      if (P.ramps && w.motion > 0.04 && rnd() < 0.35 && rampCount < Math.ceil(picks.length / 5)) {
        const sp = 1.7;
        if (w.a + dur * sp <= duration) { speed = sp; rampCount++; }
      }
      const push = i % 2 === 0;
      const z0 = P.trans === 'dynamic' && i % 3 === 1 ? 1.14 : push ? 1.0 : 1.07;
      const z1 = P.trans === 'dynamic' && i % 3 === 1 ? 1.0 : push ? 1.07 : 1.0;
      clips.push({ start: t, dur, src0, speed, zoomA: z0, zoomB: z1, focusX: w.f.fx, focusY: w.f.fy, punches: [], orig: speed === 1 ? P.orig : 0, trans: { type: 'cut', dur: 0 } });
      t += dur;
    });
    if (rampCount) decisions.push(`Applied ${rampCount} speed ramp(s) on high-motion moments`);
    // transitions
    clips.forEach((c, i) => {
      if (i === 0) return;
      let type = 'cut';
      if (P.trans === 'smooth') type = i % 4 === 0 ? 'zoom' : 'fade';
      else if (P.trans === 'dynamic') type = c.zoomA > 1.1 ? 'cut' : (i % 4 === 0 ? 'whip' : i % 4 === 2 ? 'zoom' : 'cut');
      else if (P.trans === 'minimal') type = i % 3 === 0 ? 'fade' : 'cut';
      if (clips[i - 1].hook) type = 'flash';
      const d = type === 'cut' ? 0 : type === 'fade' ? Math.min(0.6, beat) : type === 'flash' ? 0.3 : Math.min(0.45, beat * 0.8);
      c.trans = { type, dur: d };
    });
  }
  if (!clips.length) throw new Error('No usable footage was found (the video appears to be blank, black or unreadable).');

  // Make sure transitions have source "handles"; otherwise fall back to a cut
  for (let i = 1; i < clips.length; i++) {
    const c = clips[i], p = clips[i - 1], h = c.trans.dur / 2;
    if (!h) continue;
    const okIn = c.src0 - h * c.speed >= 0;
    const okOut = p.src0 + (p.dur + h) * p.speed <= duration - 0.05;
    if (!okIn || !okOut || c.dur < c.trans.dur * 1.5 || p.dur < c.trans.dur * 1.5) c.trans = { type: 'cut', dur: 0 };
  }
  const total = clips.reduce((x, c) => Math.max(x, c.start + c.dur), 0);
  // exposure matching per clip + global white balance
  const allS = [];
  for (const c of clips) {
    const ss = samplesIn(samples, c.src0, c.src0 + c.dur * c.speed);
    const lum = mean(ss, 'lum') || 0.45;
    c.gain = clamp(Math.pow(0.46 / Math.max(0.05, lum), 0.45), 0.85, 1.4);
    allS.push(...ss);
  }
  const mR = mean(allS, 'mR'), mG = mean(allS, 'mG'), mB = mean(allS, 'mB');
  const avg = (mR + mG + mB) / 3 || 0.4;
  const wb = [mR, mG, mB].map((m) => clamp(1 + (avg / Math.max(0.05, m) - 1) * 0.4, 0.92, 1.1));
  const grade = { ...GRADES[P.grade], wb };
  decisions.push(`Colour: ${P.grade} grade, per-clip exposure matching and white-balance correction`);
  const stabilize = opts.stabilize === 'on' || (opts.stabilize !== 'off' && cls.shaky);
  if (stabilize) { clips.forEach((c) => { c.stab = true; c.zoomA = Math.max(c.zoomA, 1.08); c.zoomB = Math.max(c.zoomB, 1.08); }); decisions.push('Camera shake detected: applied light digital stabilisation (translation only)'); }
  // SFX
  const sfx = [];
  if (P.sfx !== 'none') {
    clips.forEach((c, i) => {
      if (i && (c.trans.type === 'whip' || c.trans.type === 'zoom') && P.sfx === 'whoosh') sfx.push({ t: Math.max(0, c.start - 0.3), type: 'whoosh', gain: 0.35 });
      if (c.trans.type === 'flash') sfx.push({ t: Math.max(0, c.start - 0.05), type: 'hit', gain: 0.45 });
    });
  }
  // on-screen title (only text supplied by the user — never invented)
  const texts = [];
  if (opts.title && !opts.noText) {
    texts.push({ t0: 0.25, t1: Math.min(total - 0.5, 3.2), text: opts.title, position: P.speechDriven ? 'lower' : 'center' });
    if (P.sfx !== 'none') sfx.push({ t: 0.25, type: 'pop', gain: 0.3 });
    decisions.push('Added your on-screen title with an animated reveal');
  }
  if (sfx.length) decisions.push(`Added ${sfx.length} subtle sound effect(s) timed to transitions`);
  // music level
  const level = { off: 0, low: 0.55, medium: 1, high: 1.4, auto: 1 }[opts.music || 'auto'] ?? 1;
  const musicLevel = P.music * level;
  const origMode = opts.orig || 'auto';
  clips.forEach((c) => {
    if (origMode === 'none') c.orig = 0;
    else if (origMode === 'all') c.orig = c.speed === 1 ? 1 : 0;
    else if (origMode === 'speech') c.orig = c.speech ? 1 : 0;
  });
  return {
    clips, total, bpm, beat, mood: P.mood, musicLevel, duckLevel: P.speechDriven ? (P.duck || 0.05) * level : musicLevel * 0.3,
    speechDriven: !!(P.speechDriven && hasSpeech), grade, stabilize, sfx, texts, profile: cls.type, decisions, transStyle: P.trans,
  };
}

// ---------- Audio mixing (offline) ----------
export async function mixAudio(an, plan, musicBuffer, sfxBuffers) {
  const sr = 44100;
  const len = Math.max(1, Math.ceil((plan.total + 0.1) * sr));
  const ctx = new OfflineAudioContext(2, len, sr);
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4; limiter.knee.value = 2; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.12;
  master.connect(limiter); limiter.connect(ctx.destination);
  // Dialogue / original bus with gentle compression + normalisation
  const dia = ctx.createGain();
  const diaComp = ctx.createDynamicsCompressor();
  diaComp.threshold.value = -22; diaComp.ratio.value = 3; diaComp.attack.value = 0.005; diaComp.release.value = 0.15;
  dia.connect(diaComp); diaComp.connect(master);
  const audio = an.audio;
  let diaGain = 1;
  if (audio.hasAudio && audio.rms && audio.rms.length) {
    const act = []; for (let i = 0; i < audio.rms.length; i++) if (!audio.speech.length || audio.speech[i] || !audio.segments.length) act.push(audio.rms[i]);
    act.sort((a, b) => a - b);
    const ref = act[Math.floor(act.length * 0.7)] || 0.05;
    diaGain = clamp(0.12 / Math.max(1e-4, ref), 0.5, 6);
  }
  dia.gain.value = diaGain;
  const clips = plan.clips;
  if (audio.hasAudio && audio.buffer) {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      if (!c.orig || c.speed !== 1) continue;
      const hIn = c.trans.dur / 2, hOut = clips[i + 1] ? clips[i + 1].trans.dur / 2 : 0;
      const t0 = Math.max(0, c.start - hIn), t1 = c.start + c.dur + hOut;
      const off = c.src0 - (c.start - t0);
      if (off < 0 || off >= audio.buffer.duration) continue;
      const src = ctx.createBufferSource(); src.buffer = audio.buffer;
      const g = ctx.createGain();
      const fadeIn = Math.max(0.012, hIn * 2), fadeOut = Math.max(0.012, hOut * 2);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(c.orig, t0 + fadeIn);
      g.gain.setValueAtTime(c.orig, Math.max(t0 + fadeIn, t1 - fadeOut));
      g.gain.linearRampToValueAtTime(0, t1);
      src.connect(g); g.connect(dia);
      src.start(t0, off, Math.max(0.01, t1 - t0));
    }
  }
  // Music with ducking under speech on the OUTPUT timeline
  if (musicBuffer && plan.musicLevel > 0) {
    const m = ctx.createBufferSource(); m.buffer = musicBuffer;
    const mg = ctx.createGain();
    const step = 0.05;
    const n = Math.ceil(plan.total / step);
    const env = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const t = k * step;
      const c = clips.find((cl) => t >= cl.start && t < cl.start + cl.dur);
      let sp = 0;
      if (c && c.orig > 0 && audio.speech && audio.speech.length) {
        const st = c.src0 + (t - c.start) * c.speed;
        sp = audio.speech[Math.floor(st / AUDIO_HOP)] || 0;
      }
      env[k] = sp ? plan.duckLevel : plan.musicLevel;
    }
    // smooth: attack 150ms (duck early), release 400ms
    const sm = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      let v = env[k];
      for (let j = 1; j <= 3; j++) if (k + j < n) v = Math.min(v, env[k + j]); // look-ahead duck
      sm[k] = v;
    }
    for (let k = 1; k < n; k++) if (sm[k] > sm[k - 1]) sm[k] = sm[k - 1] + (sm[k] - sm[k - 1]) * 0.12;
    mg.gain.setValueAtTime(sm[0] || plan.musicLevel, 0);
    for (let k = 1; k < n; k++) if (Math.abs(sm[k] - sm[k - 1]) > 0.002) mg.gain.linearRampToValueAtTime(sm[k], k * step);
    m.connect(mg); mg.connect(master);
    m.start(0);
  }
  for (const s of plan.sfx) {
    const b = sfxBuffers[s.type];
    if (!b) continue;
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain(); g.gain.value = s.gain;
    src.connect(g); g.connect(master); src.start(s.t);
  }
  // master fade in/out
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(1, 0.08);
  master.gain.setValueAtTime(1, Math.max(0.1, plan.total - 0.6));
  master.gain.linearRampToValueAtTime(0, plan.total);
  const out = await ctx.startRendering();
  // peak-normalise to -1 dBFS
  let peak = 0;
  for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
  if (peak > 0.0001) {
    const g = Math.min(4, 0.89 / peak);
    for (let c = 0; c < out.numberOfChannels; c++) { const d = out.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  }
  return out;
}

// ---------- Timeline playback for rendering ----------
class TimelinePlayer {
  constructor(url, plan, comp) {
    this.plan = plan; this.comp = comp;
    this.els = [0, 1, 2].map(() => createVideoEl(url));
    this.state = this.els.map(() => ({ clip: -1, ready: false, seeking: false, lastT: -1 }));
    this.stab = plan.clips.map(() => ({ px: 0, py: 0, sx: 0, sy: 0, prev: null, lastT: -1 }));
    this.tiny = makeCanvas(64, 36);
    this.tctx = this.tiny.getContext('2d', { willReadFrequently: true });
    this.textCanvas = makeCanvas(comp.W, comp.H);
    this.textState = '';
  }
  async init() {
    await Promise.all(this.els.map((e) => waitEvent(e, 'loadedmetadata', 20000)));
    this.srcW = this.els[0].videoWidth; this.srcH = this.els[0].videoHeight;
    await this.prepare(0, true);
    if (this.plan.clips[1]) await this.prepare(1, true);
  }
  window(i) {
    const c = this.plan.clips[i], n = this.plan.clips[i + 1];
    return [c.start - c.trans.dur / 2, c.start + c.dur + (n ? n.trans.dur / 2 : 0)];
  }
  srcTime(i, t) { const c = this.plan.clips[i]; return c.src0 + (t - c.start) * c.speed; }
  async prepare(i, wait = false) {
    const e = i % 3, st = this.state[e], el = this.els[e];
    if (st.clip === i) return;
    st.clip = i; st.ready = false; st.seeking = true;
    const w = this.window(i);
    el.pause();
    const p = seekVideo(el, Math.max(0, this.srcTime(i, w[0] - 0.12)), 12000).then(() => { if (st.clip === i) { st.ready = true; st.seeking = false; } }).catch(() => { st.seeking = false; st.ready = true; });
    if (wait) await p;
  }
  stabOffset(i, el) {
    const s = this.stab[i];
    if (el.currentTime === s.lastT || el.readyState < 2) return [s.sx - s.px, s.sy - s.py];
    s.lastT = el.currentTime;
    this.tctx.drawImage(el, 0, 0, 64, 36);
    const d = this.tctx.getImageData(0, 0, 64, 36).data;
    const g = new Float32Array(64 * 36);
    for (let k = 0; k < g.length; k++) g[k] = d[k * 4] * 0.3 + d[k * 4 + 1] * 0.59 + d[k * 4 + 2] * 0.11;
    if (s.prev) {
      let best = Infinity, bx = 0, by = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        let sum = 0;
        for (let y = 4; y < 32; y += 2) for (let x = 4; x < 60; x += 2) sum += Math.abs(g[y * 64 + x] - s.prev[(y + dy) * 64 + x + dx]);
        if (sum < best) { best = sum; bx = dx; by = dy; }
      }
      s.px += bx / 64; s.py += by / 36;
      s.sx = s.sx * 0.9 + s.px * 0.1; s.sy = s.sy * 0.9 + s.py * 0.1;
    }
    s.prev = g;
    return [s.sx - s.px, s.sy - s.py];
  }
  zoomAt(c, rel) {
    let z = lerp(c.zoomA, c.zoomB, clamp(rel / Math.max(0.01, c.dur), 0, 1));
    if (c.punches && c.punches.length) {
      let pz = 1;
      for (const p of c.punches) {
        if (rel < p.t) break;
        if (p.hold) { const e = rel - p.t; if (e < p.hold) { const k = Math.min(1, e / 0.18); pz = Math.max(pz, lerp(pz, p.zoom, k)); continue; } else continue; }
        pz = p.zoom;
      }
      z *= pz;
    }
    return z;
  }
  layerFor(i, t) {
    const c = this.plan.clips[i], e = i % 3, el = this.els[e], st = this.state[e];
    if (st.clip !== i) this.prepare(i);
    const expected = this.srcTime(i, t);
    let upload = st.ready && el.readyState >= 2 && !el.seeking;
    if (st.ready && !st.seeking) {
      if (el.paused) { el.playbackRate = c.speed; el.play().catch(() => {}); }
      const err = expected - el.currentTime;
      if (Math.abs(err) > 0.35) { el.currentTime = Math.max(0, expected); upload = false; }
      else el.playbackRate = clamp(c.speed * (1 + clamp(err * 1.5, -0.25, 0.25)), 0.25, 4);
    }
    let off = [0, 0];
    if (c.stab && upload) off = this.stabOffset(i, el);
    const rel = t - c.start;
    const rect = this.comp.rectFor(this.srcW, this.srcH, { focusX: c.focusX, focusY: c.focusY, zoom: this.zoomAt(c, rel), offX: off[0], offY: off[1] });
    return { source: el, key: 'el' + e, upload, rect, gain: c.gain || 1 };
  }
  drawText(t) {
    const tx = this.plan.texts.find((x) => t >= x.t0 && t <= x.t1);
    if (!tx) { if (this.textState !== '') { this.comp.setText(null); this.textState = ''; } return; }
    const pin = clamp((t - tx.t0) / 0.4, 0, 1), pout = clamp((tx.t1 - t) / 0.3, 0, 1);
    const prog = Math.min(pin, pout);
    const key = tx.text + '|' + prog.toFixed(2);
    if (key === this.textState) return;
    drawTitleCard(this.textCanvas, tx.text, { progress: prog, position: tx.position });
    this.comp.setText(this.textCanvas);
    this.textState = key;
  }
  frame(t) {
    const clips = this.plan.clips;
    const active = [];
    for (let i = 0; i < clips.length; i++) { const w = this.window(i); if (t >= w[0] && t < w[1]) active.push(i); if (w[0] > t + 3) break; }
    if (!active.length) active.push(clips.length - 1);
    // keep the next clip prepared in its (free) element
    const nextIdx = active[active.length - 1] + 1;
    if (clips[nextIdx]) {
      const e = nextIdx % 3; const busy = active.some((a) => a % 3 === e);
      if (!busy && this.state[e].clip !== nextIdx) this.prepare(nextIdx);
      // start playback a moment early so frames are flowing at the cut
      const w = this.window(nextIdx);
      if (!busy && t >= w[0] - 0.12 && this.state[e].ready && this.els[e].paused) { this.els[e].playbackRate = clips[nextIdx].speed; this.els[e].play().catch(() => {}); }
    }
    // pause elements not in use
    this.els.forEach((el, e) => { const inUse = active.some((a) => a % 3 === e) || this.state[e].clip === nextIdx; if (!inUse && !el.paused) el.pause(); });
    let f;
    if (active.length >= 2) {
      const [i, j] = active.slice(-2);
      const c = clips[j];
      const p = clamp((t - (c.start - c.trans.dur / 2)) / Math.max(0.001, c.trans.dur), 0, 1);
      const ts = transitionState(c.trans.type, p);
      const A = this.layerFor(i, t), B = this.layerFor(j, t);
      if (ts.zoomA) { A.rect[2] /= ts.zoomA; A.rect[3] /= ts.zoomA; }
      if (ts.zoomB) { B.rect[2] /= ts.zoomB; B.rect[3] /= ts.zoomB; }
      A.blur = ts.blurA || 0; B.blur = ts.blurB || 0; A.shift = ts.shiftA; B.shift = ts.shiftB;
      f = { a: A, b: B, mix: ts.mix, blurMode: ts.blurMode || 1, flash: ts.flash || 0, fade: ts.fade || 0 };
    } else {
      f = { a: this.layerFor(active[0], t), mix: 0 };
    }
    // fade in from black / out to black
    const total = this.plan.total;
    f.fade = Math.max(f.fade || 0, 1 - clamp(t / 0.35, 0, 1), 1 - clamp((total - t) / 0.6, 0, 1));
    this.drawText(t);
    this.comp.draw(f);
  }
  destroy() { this.els.forEach((el) => { el.pause(); el.removeAttribute('src'); el.load(); }); }
}

// ---------- Orchestrator ----------
export async function analyzeForEdit(file, probe, { onStage, onProgress, signal }) {
  onStage('analyze');
  const interval = clamp(probe.duration / 300, 0.25, 1);
  const scan = await scanVideo(probe.url, probe.duration, { interval, sampleW: 160, onProgress, signal });
  checkAbort(signal);
  onStage('audio');
  onProgress(0.1);
  const audio = await analyzeAudio(file, signal);
  onProgress(1);
  const cls = classifyVideo(scan.samples, audio, probe.duration);
  return { samples: scan.samples, audio, cls, duration: probe.duration, width: scan.width, height: scan.height };
}

export async function renderEdit(an, plan, { url, canvas, audioCtx, opts, seed = 1, onStage, onProgress, onPauseChange, signal }) {
  let music = null;
  if (plan.musicLevel > 0) { onStage('music'); music = await generateMusic({ mood: plan.mood, duration: plan.total + 0.2, seed, energy: 1 }); }
  checkAbort(signal);
  const sfxBuffers = {};
  for (const type of new Set(plan.sfx.map((s) => s.type))) sfxBuffers[type] = await generateSfx(type);
  onStage('mix');
  const mixed = await mixAudio(an, plan, music ? music.buffer : null, sfxBuffers);
  checkAbort(signal);
  onStage('render');
  const size = outputSizeFor(opts.aspect, an.width, an.height);
  const comp = new Compositor(canvas, size.w, size.h);
  comp.setGrade(plan.grade);
  const player = new TimelinePlayer(url, plan, comp);
  const mime = pickRecorderMime();
  if (mime === null) throw new Error('This browser cannot record video. Please use the latest Chrome, Edge, Firefox or Safari.');
  let blob;
  try {
    await player.init();
    blob = await recordTimeline({
      canvas, audioCtx, audioBuffer: mixed, duration: plan.total, fps: 30, mime,
      bitrate: Math.round(size.w * size.h * 30 * 0.14),
      onFrame: (t) => player.frame(t), onProgress, onPauseChange, signal,
    });
  } finally {
    player.destroy();
    comp.destroy();
  }
  onStage('verify');
  const check = await verifyVideoBlob(blob, { expectedDuration: plan.total, expectAudio: plan.musicLevel > 0 || plan.clips.some((c) => c.orig > 0) });
  if (!check.ok) throw new Error(check.error);
  return {
    blob, check, size, format: (await detectCodecs(blob)).label,
    music: music ? music.info : null,
  };
}

export { VIDEO_TYPES_LABEL };
