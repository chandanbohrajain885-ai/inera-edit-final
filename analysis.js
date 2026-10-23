// Inera Edit Flow — full media understanding pass (watch + listen):
// frames (faces, sharpness, exposure, motion, shake, scene cuts) + audio (speech activity, loudness)
// + speech-to-text (Whisper) + transcript understanding.
import { frameMetrics, estimateShift, histDist, classifyVideo } from './video-analyzer.js';
import { loadFaceDetector, detectFacesSync, toGray } from './face-detect.js';
import { drawUpright } from './media-source.js';
import { transcribe, speechFrames } from './asr.js';
import { understand } from './understand.js';
import { makeCanvas, clamp, checkAbort } from './utils.js';

export const AUDIO_HOP = 0.05;

export async function analyzeMedia(src, { asrModel = 'auto', language, skipAsr = false, knownTranscript = null, onStage, onProgress, onNote, signal } = {}) {
  const duration = src.duration;
  // ---- 1. listen first: decode audio (fast), then start speech-to-text on its worker thread ----
  checkAbort(signal);
  onStage && onStage('audio');
  let pcm16 = null, store = null;
  if (src.hasAudio) {
    try { ({ pcm16, store } = await src.decodeAudio({ signal, onProgress })); }
    catch (e) { if (e && e.name === 'AbortError') throw e; pcm16 = null; store = null; }
  }
  const audio = { hasAudio: false, speech: new Uint8Array(0), segments: [], speechRatio: 0, rms: new Float32Array(0), kind: 'none' };
  let vad = null;
  if (pcm16 && pcm16.length > 1600) {
    vad = speechFrames(pcm16);
    // 50 ms RMS for loudness / emphasis
    const hop = 800, n = Math.floor(pcm16.length / hop);
    const rms = new Float32Array(n); let peak = 0;
    for (let f = 0; f < n; f++) { let s = 0; for (let i = f * hop; i < (f + 1) * hop; i++) { const v = pcm16[i] / 32768; s += v * v; const a = Math.abs(v); if (a > peak) peak = a; } rms[f] = Math.sqrt(s / hop); }
    audio.rms = rms; audio.peak = peak; audio.hasAudio = peak > 0.003;
  }
  // speech-to-text runs IN PARALLEL with the frame analysis below (worker thread vs main thread)
  let asrProgress = 0, asrPhase = 'wait', lastDl = null, framesDone = false;
  let transcriptP = Promise.resolve({ language: null, segments: [] });
  if (knownTranscript) transcriptP = Promise.resolve(knownTranscript); // e.g. Avatar Studio: words are already known exactly
  else if (audio.hasAudio && !skipAsr) {
    asrPhase = 'run';
    transcriptP = transcribe(pcm16, {
      model: asrModel, language, signal,
      onProgress: (p) => { asrProgress = p; if (framesDone) onProgress && onProgress(p); },
      onDownload: (m) => { lastDl = m; if (framesDone) onStage && onStage('download', m); },
    });
    transcriptP.catch(() => {}); // handled when awaited
  }
  // one status line for both jobs running at the same time
  const asrNote = () => {
    if (lastDl && lastDl.phase === 'download' && lastDl.total && lastDl.loaded < lastDl.total) return `speech model ${lastDl.cached ? 'loading' : 'downloading (one time)'} ${Math.round(lastDl.loaded / 1048576)}/${Math.round(lastDl.total / 1048576)} MB`;
    if (lastDl && lastDl.phase === 'load' && asrProgress === 0) return 'speech engines starting';
    return `speech-to-text ${Math.round(asrProgress * 100)}%`;
  };
  // ---- 2. watch: sample frames ----
  onStage && onStage('analyze');
  const interval = clamp(duration / 600, 0.25, 3);
  const sw = 160, sh = Math.max(16, Math.round(160 * src.height / src.width));
  const c = makeCanvas(sw, sh);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const classify = await loadFaceDetector();
  const reader = src.createFrameReader();
  const samples = [];
  let prevGray = null;
  // Fast path (phone / camera footage with frequent keyframes): jump keyframe to keyframe and decode only a
  // short run after each one, instead of decoding every frame of the video. Same measurements, far less work.
  const tab = src.kind === 'webcodecs' && src.info && src.info.video ? src.info.video.samples : null;
  const keyTimes = [];
  if (tab && tab.keys && tab.keys.length >= 2 && duration / tab.keys.length <= 2.5 && typeof reader.jump === 'function') {
    let last = -1e9;
    const ks = Array.from(tab.keys, (k) => tab.pts[k]).sort((a, b) => a - b);
    for (const kt of ks) if (kt - last >= interval && kt < duration - 0.3) { keyTimes.push(kt); last = kt; }
  }
  const GAP = 0.2; // motion is measured across 0.2 s, like the regular path
  // Time budget for watching: enough samples to understand the video is all the edit needs. If this
  // computer decodes slowly, the scan stops early instead of making you wait (the edit still uses
  // every second of the video; only the analysis is sampled).
  const scanT0 = performance.now();
  const budgetMs = clamp(6000 + duration * 400, 12000, 240000);
  let scanStop = '';
  const overBudget = (t) => {
    const el = performance.now() - scanT0;
    if (el > budgetMs && samples.length >= 8) { scanStop = `sampled ${Math.round((t / duration) * 100)}% of the video within the time budget`; return true; }
    return false;
  };
  try {
    if (duration >= 60 && keyTimes.length >= Math.min(8, duration / 3)) {
      let prevHist = null;
      for (let k = 0; k < keyTimes.length; k++) {
        checkAbort(signal);
        const t = keyTimes[k];
        let fa, fb;
        if (overBudget(t)) break;
        try { reader.jump(t); fa = await reader.frameAt(t); } catch (e) { if (e && e.stalled) { scanStop = 'the video decoder stopped responding'; break; } continue; }
        drawUpright(ctx, fa, src.rotation, sw, sh);
        const imgA = ctx.getImageData(0, 0, sw, sh);
        let grayB = null;
        try {
          fb = await reader.frameAt(Math.min(duration - 0.05, t + GAP));
          drawUpright(ctx, fb, src.rotation, sw, sh);
          grayB = frameMetrics(ctx.getImageData(0, 0, sw, sh), null).gray;
        } catch (e) { grayB = null; }
        const m = frameMetrics(imgA, grayB);
        m.t = t;
        m.faces = classify ? detectFacesSync(classify, toGray(imgA.data, sw, sh), sw, sh, 8) : [];
        m.face = m.faces.length ? m.faces.reduce((a, b) => (b.size > a.size ? b : a)) : null;
        m.diff = prevHist ? histDist(prevHist, m.hist) : 0;
        m.shift = grayB ? estimateShift(grayB, m.gray, sw, sh) : [0, 0];
        prevHist = m.hist;
        delete m.hist0;
        samples.push(m);
        onProgress && onProgress(t / duration);
        if (onNote && asrPhase === 'run' && k % 3 === 0) onNote(`Video scan ${Math.round(t / duration * 100)}% · ${asrNote()}`);
      }
    } else {
      let k = 0, coarse = false, step = interval;
      const canJump = !!(tab && tab.keys && tab.keys.length >= 3 && typeof reader.jump === 'function');
      for (let t = 0; t < duration - 0.05; t += step) {
        checkAbort(signal);
        let fr;
        if (!coarse && overBudget(t)) {
          // slow computer: cover the rest of the video with a few keyframe samples instead of decoding every frame
          if (!canJump) break;
          coarse = true; scanStop = ''; step = Math.max(interval, (duration - t) / 16); prevGray = null;
        }
        if (coarse && performance.now() - scanT0 > budgetMs * 2) { scanStop = `sampled ${Math.round((t / duration) * 100)}% of the video within the time budget`; break; }
        try { if (coarse) reader.jump(t); fr = await reader.frameAt(t); } catch (e) { if (e && e.stalled) { scanStop = 'the video decoder stopped responding'; break; } continue; }
        drawUpright(ctx, fr, src.rotation, sw, sh);
        const img = ctx.getImageData(0, 0, sw, sh);
        const m = frameMetrics(img, prevGray);
        m.t = t;
        m.faces = classify ? detectFacesSync(classify, toGray(img.data, sw, sh), sw, sh, 8) : [];
        m.face = m.faces.length ? m.faces.reduce((a, b) => (b.size > a.size ? b : a)) : null;
        m.diff = samples.length ? histDist(samples[samples.length - 1].hist, m.hist) : 0;
        m.shift = prevGray ? estimateShift(m.gray, prevGray, sw, sh) : [0, 0];
        prevGray = coarse ? null : m.gray; // far-apart keyframe samples say nothing about motion
        delete m.hist0;
        samples.push(m);
        onProgress && onProgress(t / duration);
        if (onNote && asrPhase === 'run' && ++k % 6 === 0) onNote(`Video scan ${Math.round(t / duration * 100)}% · ${asrNote()}`);
      }
    }
  } finally { reader.close(); }
  for (const s of samples) { s.gray = null; } // free memory; hist/hash kept for selection
  // ---- 3. wait for the speech-to-text that has been running meanwhile ----
  framesDone = true;
  if (asrPhase === 'run') {
    checkAbort(signal);
    if (lastDl && lastDl.phase === 'download' && lastDl.loaded < lastDl.total) onStage && onStage('download', lastDl);
    else { onStage && onStage('transcribe'); onProgress && onProgress(asrProgress); onNote && onNote(`Video scan done · ${asrNote()}`); }
  }
  const transcript = await transcriptP;
  // speech map at 50 ms from word timings (more reliable than energy alone)
  if (audio.hasAudio) {
    const n = audio.rms.length; const sp = new Uint8Array(n);
    for (const seg of transcript.segments) for (const w of seg.words || []) {
      const a = Math.max(0, Math.floor((w.s - 0.05) / AUDIO_HOP)), b = Math.min(n, Math.ceil((w.e + 0.05) / AUDIO_HOP));
      for (let i = a; i < b; i++) sp[i] = 1;
    }
    // speech that could not be transcribed in time still counts as speech (from voice activity),
    // so a talking video is never cut like a silent montage
    if (transcript.missingSeconds > 0 && vad) {
      const per = AUDIO_HOP / vad.hop;
      for (let i = 0; i < n; i++) { const f = Math.floor(i * per); if (vad.active[f]) sp[i] = 1; }
    }
    let act = 0; for (let i = 0; i < n; i++) act += sp[i];
    audio.speech = sp;
    audio.speechRatio = act / Math.max(1, n);
    audio.segments = transcript.segments.map((s) => ({ s: s.start, e: s.end }));
    if (!audio.segments.length && act > 0 && transcript.missingSeconds > 0) {
      for (let i = 0; i < n; i++) if (sp[i] && (i === 0 || !sp[i - 1])) { let j = i; while (j < n && sp[j]) j++; audio.segments.push({ s: i * AUDIO_HOP, e: j * AUDIO_HOP }); }
    }
    audio.kind = audio.segments.length ? 'speech' : 'ambience';
  }
  const story = await understand(transcript);
  const cls = classifyVideo(samples, audio, duration);
  if (transcript.segments.length && audio.speechRatio > 0.3 && cls.type !== 'talking-head' && cls.motion < 0.05 && cls.faceRatio > 0.25) { cls.type = 'talking-head'; cls.reasons.unshift('continuous speech with a person on camera'); }
  return { duration, width: src.width, height: src.height, rotation: src.rotation, samples, audio, vad, transcript, story, cls, store, pcm16, scanStop };
}
