// Inera Edit Flow — the "director": turns analysis + transcript understanding into a complete
// edit decision list (EDL). Roles it plays: story editor, cutter, caption writer, motion designer,
// colourist, sound designer. All decisions are explained in plain language (edl.decisions).
import { planEdit as planMontage, outputSizeFor } from './video-editor.js';
import { MOODS } from './music.js';
import { clamp, lerp, seededRandom } from './utils.js';
import { AUDIO_HOP } from './analysis.js';

const GRADES = {
  natural: { contrast: 0.08, sat: 1.06, vignette: 0.05 },
  warm: { contrast: 0.1, sat: 1.08, temp: 0.12, vignette: 0.08 },
  cinematic: { contrast: 0.2, sat: 0.96, splitS: [-0.25, 0.04, 0.25], splitH: [0.25, 0.1, -0.18], splitAmt: 0.08, vignette: 0.2 },
  punchy: { contrast: 0.22, sat: 1.14, vignette: 0.12 },
  vibrant: { contrast: 0.15, sat: 1.18, vignette: 0.06 },
  mono: { contrast: 0.25, sat: 0, mono: 1, vignette: 0.15 },
};

const mean = (arr, f) => (arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : 0);
const inRange = (samples, a, b) => samples.filter((s) => s.t >= a - 1e-3 && s.t <= b + 1e-3);

function faceFocus(samples, a, b) {
  const ss = inRange(samples, a, b).filter((s) => s.face);
  if (!ss.length) return { fx: 0.5, fy: 0.45, faceY: null };
  const fx = mean(ss, (s) => s.face.x), fy = mean(ss, (s) => s.face.y);
  return { fx, fy: clamp(fy + 0.05, 0.15, 0.85), faceY: fy };
}

// ---------------- speech-first cut list (talking head, vlog, tutorial, podcast) ----------------
function planSpeechClips(an, story, opts, decisions) {
  const sentences = story.sentences;
  const removeRetakes = opts.removeRetakes !== false;
  const pauseMax = opts.keepPauses ? 1e9 : (opts.pacing === 'relaxed' ? 0.6 : opts.pacing === 'tight' ? 0.22 : 0.35);
  const kept = sentences.filter((s) => !(removeRetakes && s.retake));
  const dropped = sentences.length - kept.length;
  if (dropped) decisions.push(`Removed ${dropped} repeated take${dropped > 1 ? 's' : ''} (kept the final, cleaner version)`);
  // word list (fillers removed)
  let fillers = 0;
  const words = [];
  for (const s of kept) s.words.forEach((w, i) => { if (s.fillers.includes(i)) { fillers++; return; } words.push({ ...w, sent: s.i }); });
  if (fillers) decisions.push(`Cut ${fillers} filler word${fillers > 1 ? 's' : ''} (um / uh)`);
  // intervals: join words unless the pause is longer than pauseMax
  const ints = [];
  for (const w of words) {
    const a = Math.max(0, w.s - 0.12), b = Math.min(an.duration, w.e + 0.2);
    const last = ints[ints.length - 1];
    if (last && a - last.b <= pauseMax) { last.b = Math.max(last.b, b); last.sents.add(w.sent); }
    else ints.push({ a, b, sents: new Set([w.sent]) });
  }
  // resolve overlaps from padding
  for (let i = 1; i < ints.length; i++) if (ints[i].a < ints[i - 1].b) { const m = (ints[i].a + ints[i - 1].b) / 2; ints[i - 1].b = m; ints[i].a = m; }
  const keptDur = ints.reduce((x, i) => x + (i.b - i.a), 0);
  if (an.duration - keptDur > 0.5) decisions.push(`Removed ${(an.duration - keptDur).toFixed(1)}s of silence, long pauses and dead air`);
  // target length: keep the strongest sentences in order
  let chosen = ints;
  if (opts.targetDuration && keptDur > opts.targetDuration + 1 && !opts.keepAllSpeech) {
    const score = (iv) => mean([...iv.sents], (si) => sentences[si].score) * Math.sqrt(iv.b - iv.a) + ([...iv.sents].includes(story.hook) ? 3 : 0);
    const order = ints.map((iv, k) => ({ k, s: score(iv), d: iv.b - iv.a })).sort((x, y) => y.s - x.s);
    const pick = new Set(); let tot = 0;
    for (const o of order) { if (tot >= opts.targetDuration) break; pick.add(o.k); tot += o.d; }
    chosen = ints.filter((_, k) => pick.has(k));
    decisions.push(`Shortened to ~${Math.round(tot)}s by keeping your strongest lines, in their original order`);
  }
  return chosen;
}

function speechClipsToTimeline(an, story, intervals, opts, decisions) {
  const clips = [];
  let t = 0, k = 0;
  const punch = opts.punch !== false;
  for (const iv of intervals) {
    const f = faceFocus(an.samples, iv.a, iv.b);
    const punches = [];
    if (punch) {
      // framing alternates at each new sentence (hides jump cuts, adds energy)
      let z = k % 2 ? 1.12 : 1.0;
      punches.push({ t: 0, zoom: z });
      for (const si of [...iv.sents].slice(1)) {
        const s = story.sentences[si];
        if (s.start > iv.a + 0.6 && s.start < iv.b - 0.8) { z = z > 1.05 ? 1.0 : 1.12; punches.push({ t: s.start - iv.a, zoom: z }); }
      }
      // emphasis push-ins on numbers / power words
      for (const si of iv.sents) {
        const s = story.sentences[si];
        if (s.type !== 'stat' && s.type !== 'power' && s.type !== 'question') continue;
        const ei = s.emphasis[0]; if (ei === undefined) continue;
        const wt = s.words[ei].s;
        if (wt > iv.a && wt < iv.b - 0.3) punches.push({ t: wt - iv.a, zoom: 1.22, hold: 0.9 });
      }
      punches.sort((a, b) => a.t - b.t);
    }
    clips.push({ start: t, dur: iv.b - iv.a, src0: iv.a, speed: 1, zoomA: 1, zoomB: 1, focusX: f.fx, focusY: f.fy, faceY: f.faceY, punches, orig: 1, speech: true, sents: [...iv.sents], trans: { type: 'cut', dur: 0 } });
    t += iv.b - iv.a; k++;
  }
  if (punch) decisions.push('Alternated framing at sentence changes and pushed in on key numbers and power words');
  return clips;
}

// ---------------- helpers shared by both edit types ----------------
function finishClips(an, clips, opts, P, decisions) {
  const samples = an.samples;
  if (opts.synthetic) { // rendered presenter: colours are already correct — no exposure / white-balance changes
    clips.forEach((c) => { c.gain = 1; });
    decisions.push('Colour: presenter colours kept exactly as rendered');
    return { grade: { contrast: 0, sat: 1, vignette: 0, wb: [1, 1, 1] }, stabilize: false };
  }
  const allS = [];
  for (const c of clips) {
    const ss = inRange(samples, c.src0, c.src0 + c.dur * c.speed);
    const lum = mean(ss, (s) => s.lum) || 0.45;
    c.gain = clamp(Math.pow(0.46 / Math.max(0.05, lum), 0.45), 0.85, 1.4);
    allS.push(...ss);
  }
  const mR = mean(allS, (s) => s.mR), mG = mean(allS, (s) => s.mG), mB = mean(allS, (s) => s.mB);
  const avg = (mR + mG + mB) / 3 || 0.4;
  const wb = [mR, mG, mB].map((m) => clamp(1 + (avg / Math.max(0.05, m) - 1) * 0.4, 0.92, 1.1));
  if (opts.bright && opts.bright !== 1) { clips.forEach((c) => { c.gain = clamp((c.gain || 1) * opts.bright, 0.7, 1.6); }); decisions.push(opts.bright > 1 ? 'Brightened the picture (as requested)' : 'Darkened the picture (as requested)'); }
  const gradeName = opts.grade || P.grade;
  decisions.push(`Colour: ${gradeName} grade, exposure matched across shots, white balance corrected`);
  const stabilize = opts.stabilize === 'on' || (opts.stabilize !== 'off' && an.cls.shaky);
  if (stabilize) { clips.forEach((c) => { c.stab = true; c.zoomA = Math.max(c.zoomA, 1.08); c.zoomB = Math.max(c.zoomB, 1.08); }); decisions.push('Camera shake detected: applied digital stabilisation'); }
  return { grade: { ...GRADES[gradeName] || GRADES.natural, wb }, stabilize };
}

// Map a source time to every output time where it appears (hook clips can duplicate a moment)
function srcToOut(clips, t) {
  const out = [];
  for (const c of clips) { const end = c.src0 + c.dur * c.speed; if (t >= c.src0 - 1e-6 && t < end) out.push(c.start + (t - c.src0) / c.speed); }
  return out;
}

// ---------------- captions ----------------
function buildCaptions(an, story, clips, opts, size) {
  const style = opts.captions === 'off' ? 'off' : opts.captions && opts.captions !== 'auto' ? opts.captions : (size.aspect === '16:9' ? 'clean' : 'creator');
  if (style === 'off') return { style: 'off', groups: [] };
  const words = [];
  for (const c of clips) {
    if (!c.speech && !c.hook) continue;
    const a = c.src0, b = c.src0 + c.dur * c.speed;
    for (const s of story.sentences) {
      if (s.end < a || s.start > b) continue;
      s.words.forEach((w, i) => {
        if (w.s < a - 0.05 || w.s >= b) return;
        if (s.fillers.includes(i)) return;
        const kw = s.keywords.some((k) => k.k && w.w.toLowerCase().includes(k.k));
        words.push({ w: w.w, s: c.start + (w.s - a) / c.speed, e: c.start + (Math.min(w.e, b) - a) / c.speed, emph: s.emphasis.includes(i), kw, q: s.type === 'question' });
      });
    }
  }
  words.sort((x, y) => x.s - y.s);
  const groups = [];
  const maxWords = style === 'creator' ? 3 : 8, maxChars = style === 'creator' ? 16 : 42;
  let cur = [];
  const flush = () => { if (cur.length) { groups.push({ t0: cur[0].s, t1: cur[cur.length - 1].e, words: cur }); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const chars = cur.reduce((a, x) => a + x.w.length + 1, 0) + w.w.length;
    if (cur.length && (cur.length >= maxWords || chars > maxChars || w.s - cur[cur.length - 1].e > 0.3)) flush();
    cur.push(w);
    if (/[.!?,;:]$/.test(w.w) && (style === 'creator' || /[.!?]$/.test(w.w))) flush();
  }
  flush();
  for (let i = 0; i < groups.length; i++) {
    const next = groups[i + 1];
    groups[i].t1 = Math.min(next ? next.t0 : Infinity, groups[i].t1 + 0.5);
  }
  // caption position: avoid the face
  const faces = an.samples.filter((s) => s.face);
  const faceLow = faces.length && mean(faces, (s) => s.face.y) > 0.58;
  return { style, groups, position: opts.captionPos || (style === 'creator' ? (faceLow ? 'top' : 'lower') : 'bottom'), uppercase: style === 'creator' && opts.captionCase !== 'normal', accent: opts.captionColor || null, scale: opts.captionScale || 1 };
}

// ---------------- B-roll + graphics plan ----------------
function planGraphics(an, story, clips, opts, total, size, decisions) {
  const broll = [], overlays = [], sfx = [];
  const coverage = { off: 0, less: 0.2, auto: 0.32, more: 0.5 }[opts.broll || 'auto'];
  const firstFace = 2.0;
  const usedKeys = new Map();
  if (coverage > 0) {
    const cands = [];
    for (const s of story.sentences) {
      if (!s.visual || s.type === 'cta' || s.retake) continue;
      if (s.type === 'stat' && opts.graphics !== 'off' && s.words.some((w) => /\d/.test(w.w))) continue; // the number pop is the visual
      const outs = srcToOut(clips, s.visual.at);
      const outEnds = srcToOut(clips, Math.max(s.visual.at, s.end - 0.05));
      if (!outs.length) continue;
      const t0 = Math.max(0, outs[0] - 0.2);
      const endOut = outEnds.length ? outEnds[0] : outs[0] + 2;
      const dur = clamp(endOut - outs[0] + 0.25, 1.6, 3.2);
      cands.push({ t0, t1: Math.min(total - 0.3, t0 + dur), sent: s.i, keyword: s.visual.keyword, key: s.visual.key, emoji: s.visual.emoji, score: s.score + (s.visual.emoji ? 0.5 : 0) + (/^\p{Lu}/u.test(s.visual.keyword) ? 0.3 : 0) });
    }
    cands.sort((a, b) => b.score - a.score);
    let covered = 0;
    for (const c of cands) {
      if (c.t1 - c.t0 < 1.2 || c.t0 < firstFace) continue;
      if (covered + (c.t1 - c.t0) > total * coverage) continue;
      if (broll.some((b) => c.t0 < b.t1 + 2.2 && c.t1 > b.t0 - 2.2)) continue;
      const n = usedKeys.get(c.key) || 0;
      if (n >= 2) continue; // don't repeat the same visual endlessly
      usedKeys.set(c.key, n + 1);
      broll.push(c); covered += c.t1 - c.t0;
    }
    broll.sort((a, b) => a.t0 - b.t0);
    broll.forEach((b, i) => { b.motion = i % 2 ? 'pull' : 'push'; sfx.push({ t: Math.max(0, b.t0 - 0.25), type: 'whoosh', gain: 0.22, broll: b }); });
    if (broll.length) decisions.push(`Added ${broll.length} topic visual${broll.length > 1 ? 's' : ''} matched to what you say (${broll.slice(0, 5).map((b) => b.keyword).join(', ')}${broll.length > 5 ? '…' : ''})`);
  }
  // number pops for statistics
  if (opts.graphics !== 'off') {
    let pops = 0;
    for (const s of story.sentences) {
      if (s.type !== 'stat' || s.retake) continue;
      const i = s.words.findIndex((w) => /\d/.test(w.w));
      if (i < 0) continue;
      const num = s.words[i].w.replace(/[^\d.,%$₹€£]/g, '');
      const unit = (s.words[i + 1] && /^[\p{L}%]+[.,!?]?$/u.test(s.words[i + 1].w) && !/^(and|or|to|in|of|a|the)$/i.test(s.words[i + 1].w.replace(/[.,!?]/g, ''))) ? s.words[i + 1].w.replace(/[.,!?]/g, '') : '';
      const outs = srcToOut(clips, s.words[i].s);
      if (!outs.length || !num) continue;
      const t0 = outs[0];
      if (broll.some((b) => t0 < b.t1 && t0 + 1.6 > b.t0)) continue;
      overlays.push({ type: 'number', t0, t1: Math.min(total, t0 + 1.7), text: (num + (unit ? ' ' + unit : '')).toUpperCase() });
      sfx.push({ t: t0, type: 'pop', gain: 0.25 }); pops++;
    }
    if (pops) decisions.push(`Animated ${pops} key number${pops > 1 ? 's' : ''} on screen as you say ${pops > 1 ? 'them' : 'it'}`);
    // call-to-action sticker
    const cta = story.sentences.find((s) => s.type === 'cta' && !s.retake);
    if (cta) {
      const outs = srcToOut(clips, cta.start);
      if (outs.length) {
        const t0 = outs[0];
        overlays.push({ type: 'cta', t0, t1: Math.min(total, t0 + Math.max(2.2, cta.end - cta.start + 0.4)), text: /follow/i.test(cta.text) ? 'Follow' : 'Subscribe' });
        sfx.push({ t: t0, type: 'pop', gain: 0.25 });
        decisions.push('Added an animated subscribe button when you ask viewers to subscribe');
      }
    }
    // opening topic chip + optional user title / lower third
    if (story.mainTopic && opts.topicChip !== false) overlays.push({ type: 'chip', t0: 0.3, t1: Math.min(total, 3.6), text: story.mainTopic.toUpperCase(), emoji: story.topics[0] && story.topics[0].emoji });
    if (opts.title) { overlays.push({ type: 'title', t0: 0.25, t1: Math.min(total - 0.5, 3.2), text: opts.title, top: true }); sfx.push({ t: 0.25, type: 'pop', gain: 0.25 }); decisions.push('Added your title with an animated reveal'); }
    if (opts.speakerName) { overlays.push({ type: 'lower', t0: 1.0, t1: Math.min(total, 5), text: opts.speakerName, sub: opts.speakerRole || '' }); decisions.push('Added a name lower-third'); }
    // chapter cards for long videos
    if (story.chapters && story.chapters.length > 1) {
      let n = 0;
      for (const ch of story.chapters.slice(1)) {
        const outs = srcToOut(clips, ch.start + 0.01);
        if (outs.length) { overlays.push({ type: 'chapter', t0: outs[0], t1: Math.min(total, outs[0] + 2.4), text: ch.title }); n++; }
      }
      if (n) decisions.push(`Marked ${n} chapter${n > 1 ? 's' : ''} with on-screen titles (chapters list included for YouTube)`);
    }
  }
  return { broll, overlays, sfx };
}

// ---------------- main entry ----------------
export function planV2(an, opts = {}, seed = 1) {
  const decisions = [];
  const story = an.story;
  const size = outputSizeFor(opts.aspect, an.width, an.height);
  if (opts.resolution && Math.min(size.w, size.h) > opts.resolution) { // faster export: e.g. 720p
    const k = opts.resolution / Math.min(size.w, size.h);
    size.w = Math.round(size.w * k / 2) * 2; size.h = Math.round(size.h * k / 2) * 2;
  }
  const hasSpeech = an.transcript.segments.length > 0 && an.audio.speechRatio > 0.08;
  const speechType = an.cls.type === 'talking-head' || an.cls.type === 'vlog' || (hasSpeech && an.audio.speechRatio > 0.25);
  let plan;
  if (speechType && hasSpeech) {
    const P = { mood: an.cls.type === 'vlog' ? 'upbeat' : 'subtle', music: an.cls.type === 'vlog' ? 0.2 : 0.11, duck: 0.045, grade: an.cls.type === 'vlog' ? 'warm' : 'natural' };
    if (opts.style === 'cinematic') Object.assign(P, { grade: 'cinematic', mood: 'cinematic' });
    if (opts.style === 'energetic') Object.assign(P, { grade: 'punchy', mood: 'upbeat', music: 0.16 });
    if (opts.style === 'minimal') Object.assign(P, { music: 0.08 });
    if (opts.orig === 'none') Object.assign(P, { music: Math.max(P.music, 0.6), duck: 0.6 });
    if (opts.mood && MOODS[opts.mood]) P.mood = opts.mood;
    decisions.push(`Understood the video as ${an.cls.type === 'vlog' ? 'a vlog' : 'a talking-to-camera video'}: ${story.sentences.length} sentences, main topic “${story.mainTopic || '—'}”`);
    // a hook teaser counts toward the requested length
    const hs = story.hook != null ? story.sentences[story.hook] : null;
    const hookLen = hs && opts.hook !== 'off' && opts.style !== 'minimal' && hs.start > 1 ? hs.end - hs.start + 0.3 : 0;
    const intervals = planSpeechClips(an, story, opts.targetDuration && hookLen ? { ...opts, targetDuration: Math.max(5, opts.targetDuration - hookLen) } : opts, decisions);
    if (!intervals.length) throw new Error('No usable speech was found to edit.');
    const clips = speechClipsToTimeline(an, story, intervals, { ...opts, punch: opts.punch === false ? false : opts.punch === true || (opts.style !== 'minimal' && opts.intensity !== 'light') }, decisions);
    if (opts.intensity === 'bold') clips.forEach((c) => c.punches.forEach((p) => { p.zoom = 1 + (p.zoom - 1) * 1.5; }));
    // transitions between speech clips: cuts by default (cleanest for talking), styled when asked
    if (opts.transitions === 'dynamic' || opts.style === 'energetic') {
      const kinds = ['zoom', 'whip', 'flash'];
      clips.forEach((c, i) => { if (i && c.src0 - clips[i - 1].src0 - clips[i - 1].dur > 0.6) c.trans = { type: kinds[i % kinds.length], dur: 0.32 }; });
      decisions.push('Added dynamic transitions at topic changes (as requested)');
    } else if (opts.transitions === 'smooth') {
      clips.forEach((c, i) => { if (i && c.src0 - clips[i - 1].src0 - clips[i - 1].dur > 0.6) c.trans = { type: 'fade', dur: 0.4 }; });
      decisions.push('Smooth cross-fades between sections');
    }
    if (opts.orig === 'none') { clips.forEach((c) => { c.orig = 0; }); decisions.push('Original audio muted (as requested)'); }
    // hook teaser: open with the strongest early line when it is not already first
    const hookS = story.hook != null ? story.sentences[story.hook] : null;
    const totalRaw = clips.reduce((a, c) => a + c.dur, 0);
    const forced = opts.hook === 'on';
    if (forced && hookS && hookS.start <= (forced ? 1.0 : 2.5)) decisions.push('Hook: your strongest line already opens the video, so no teaser was added');
    else if (forced && (!hookS || hookS.end - hookS.start > 9)) decisions.push('Hook: no short, strong line was found to use as a teaser');
    if ((forced || (opts.hook !== 'off' && opts.style !== 'minimal')) && hookS && !hookS.retake && hookS.start > (forced ? 1.0 : 2.5) && totalRaw > (forced ? 8 : 25) && hookS.end - hookS.start <= (forced ? 9 : 7)) {
      const f = faceFocus(an.samples, hookS.start, hookS.end);
      const hd = hookS.end - hookS.start + 0.3;
      clips.forEach((c) => { c.start += hd; });
      clips.unshift({ start: 0, dur: hd, src0: Math.max(0, hookS.start - 0.12), speed: 1, zoomA: 1.18, zoomB: 1.1, focusX: f.fx, focusY: f.fy, faceY: f.faceY, punches: [], orig: 1, speech: true, hook: true, sents: [hookS.i], trans: { type: 'cut', dur: 0 } });
      clips[1].trans = { type: 'flash', dur: 0.3 };
      decisions.push(`Opened with your strongest line as a hook: “${hookS.text.slice(0, 70)}${hookS.text.length > 70 ? '…' : ''}”`);
    }
    // transition handles
    for (let i = 1; i < clips.length; i++) {
      const c = clips[i], p = clips[i - 1], h = c.trans.dur / 2;
      if (!h) continue;
      if (c.src0 - h < 0 || p.src0 + p.dur + h > an.duration - 0.05) c.trans = { type: 'cut', dur: 0 };
    }
    const total = clips.reduce((a, c) => Math.max(a, c.start + c.dur), 0);
    const fin = finishClips(an, clips, opts, P, decisions);
    const level = { off: 0, low: 0.55, medium: 1, high: 1.4, auto: 1 }[opts.music || 'auto'] ?? 1;
    plan = { clips, total, mood: P.mood, bpm: MOODS[P.mood].bpm, beat: 60 / MOODS[P.mood].bpm, musicLevel: P.music * level, duckLevel: P.duck * level, speechDriven: true, ...fin, sfx: [], texts: [], profile: an.cls.type };
  } else if (an.transcript.missingSeconds > 0 && an.audio.speechRatio > 0.2) {
    // someone is talking but this computer could not transcribe it in time: never cut speech blindly —
    // keep the whole talk, with gentle framing, grade and music under the voice
    const P = { mood: 'subtle', music: 0.11, duck: 0.045, grade: 'natural' };
    const f = faceFocus(an.samples, 0, an.duration);
    const clips = [{ start: 0, dur: an.duration, src0: 0, speed: 1, zoomA: 1.0, zoomB: 1.05, focusX: f.fx, focusY: f.fy, faceY: f.faceY, punches: [], orig: opts.orig === 'none' ? 0 : 1, speech: true, sents: [], trans: { type: 'cut', dur: 0 } }];
    decisions.push('Kept the whole talk uncut: the speech could not be transcribed in time on this computer, so no words were removed');
    const fin = finishClips(an, clips, opts, P, decisions);
    const level = { off: 0, low: 0.55, medium: 1, high: 1.4, auto: 1 }[opts.music || 'auto'] ?? 1;
    plan = { clips, total: an.duration, mood: P.mood, bpm: MOODS[P.mood].bpm, beat: 60 / MOODS[P.mood].bpm, musicLevel: P.music * level, duckLevel: P.duck * level, speechDriven: true, ...fin, sfx: [], texts: [], profile: 'talking-head' };
  } else {
    // montage (travel, action, event, lifestyle): reuse the proven montage planner
    const legacyAudio = { hasAudio: an.audio.hasAudio, segments: an.audio.segments, speechRatio: an.audio.speechRatio, speech: an.audio.speech, rms: an.audio.rms, kind: an.audio.kind };
    const samples = an.samples.map((s) => ({ ...s, skin: s.face ? 0.05 : 0, skinX: s.face ? s.face.x : 0.5, skinY: s.face ? s.face.y : 0.45 }));
    plan = planMontage({ samples, audio: legacyAudio, cls: an.cls, duration: an.duration }, { ...opts, title: null }, seed);
    decisions.push(...plan.decisions);
    plan.texts = [];
    if (opts.bright && opts.bright !== 1) { plan.clips.forEach((c) => { c.gain = clamp((c.gain || 1) * opts.bright, 0.7, 1.6); }); decisions.push(opts.bright > 1 ? 'Brightened the picture (as requested)' : 'Darkened the picture (as requested)'); }
  }
  // graphics, captions, sound design (speech-aware for both edit types)
  const g = planGraphics(an, story, plan.clips, opts, plan.total, size, decisions);
  const captions = hasSpeech ? buildCaptions(an, story, plan.clips, opts, size) : { style: 'off', groups: [] };
  // keep graphics clear of the captions (e.g. when captions are asked to sit at the top)
  const cp = captions.style !== 'off' && captions.groups.length ? captions.position : null;
  for (const o of g.overlays) {
    if (cp === 'top' && (o.type === 'number' || o.type === 'chapter' || (o.type === 'title' && o.top))) o.y = 0.56;
    if (cp === 'middle' && o.type === 'cta') o.y = 0.8;
    if (cp === 'middle' && o.type === 'title' && !o.top) o.y = 0.17;
  }
  // subtitle file (SRT/VTT) for the edited timeline — always produced when there is speech, even if not burned in
  const subtitles = hasSpeech ? buildCaptions(an, story, plan.clips, { ...opts, captions: 'clean' }, size).groups : [];
  if (captions.groups.length) decisions.push(`Wrote ${captions.groups.length} word-timed caption${captions.groups.length > 1 ? 's' : ''} from your speech (${captions.style === 'creator' ? 'bold creator style, key words highlighted' : 'clean subtitles'})`);
  const sfx = opts.sfx === 'off' ? [] : [...(plan.sfx || []), ...g.sfx];
  plan.clips.forEach((c, i) => { if (i && c.trans.type === 'flash') sfx.push({ t: Math.max(0, c.start - 0.05), type: 'hit', gain: 0.4 }); });
  if (sfx.length) decisions.push(`Sound design: ${sfx.length} subtle effect${sfx.length > 1 ? 's' : ''} (whooshes on visuals, pops on graphics)`);
  return {
    ...plan, decisions, size, broll: g.broll, overlays: g.overlays, captions, subtitles, sfx,
    story: { title: story.titleSuggestion, hashtags: story.hashtags, chapters: story.chapters, mainTopic: story.mainTopic },
    fps: 30,
  };
}
