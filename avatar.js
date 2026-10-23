// Inera Edit Flow — Avatar Studio (3D presenter): lip-sync from word timings, natural blinks,
// head movement and eye contact (TalkingHead, MIT), gestures on emphasis, studio background,
// real-time recording of the performance (canvas + speech audio).
import { TalkingHead, THREE } from './avatar-lib.js';
import { pickRecorderMime, AbortError, makeCanvas, checkAbort } from './utils.js';
import { encodeTimeline } from './media-encode.js';
import { fetchBytes } from './gz.js';

export const VISEME_BOOST = 1.75;
export const AVATARS = {
  female: { url: new URL('./avatar-female.glb.dat', import.meta.url).href, packed: true, body: 'F', label: 'Studio presenter — female (CC0)' },
};

export const BACKGROUNDS = {
  studio: 'Studio gradient', office: 'Soft office light', dark: 'Dark premium', green: 'Green screen (for your own background)', custom: 'Your image',
};
export function paintBackground(kind, W, H, img = null) {
  const c = makeCanvas(W, H), x = c.getContext('2d');
  if (kind === 'custom' && img) {
    const s = Math.max(W / img.width, H / img.height); const dw = img.width * s, dh = img.height * s;
    x.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
    x.fillStyle = 'rgba(0,0,0,0.12)'; x.fillRect(0, 0, W, H);
    return c;
  }
  if (kind === 'green') { x.fillStyle = '#00b140'; x.fillRect(0, 0, W, H); return c; }
  const g = x.createLinearGradient(0, 0, 0, H);
  if (kind === 'office') { g.addColorStop(0, '#e9e4dc'); g.addColorStop(1, '#b9ae9f'); }
  else if (kind === 'dark') { g.addColorStop(0, '#16172a'); g.addColorStop(1, '#07070d'); }
  else { g.addColorStop(0, '#2b2f63'); g.addColorStop(1, '#0d0f24'); }
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(W * 0.5, H * 0.38, 0, W * 0.5, H * 0.38, Math.max(W, H) * 0.6);
  glow.addColorStop(0, kind === 'office' ? 'rgba(255,255,255,0.55)' : 'rgba(139,92,246,0.35)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = glow; x.fillRect(0, 0, W, H);
  if (kind !== 'office') { // subtle bokeh lights
    for (let i = 0; i < 14; i++) { const r = Math.max(W, H) * (0.02 + ((i * 37) % 10) / 300); x.fillStyle = `rgba(${120 + (i * 13) % 100},${130 + (i * 7) % 90},255,0.07)`; x.beginPath(); x.arc(((i * 211) % 100) / 100 * W, ((i * 137) % 100) / 100 * H * 0.7, r, 0, Math.PI * 2); x.fill(); }
  }
  return c;
}

// Build the stage. container must be in the DOM; W x H is the output resolution.
export async function createStage(container, { avatar = 'female', customUrl = null, background = 'studio', bgImage = null, W = 1080, H = 1920, view = 'upper', onProgress } = {}) {
  const dpr = window.devicePixelRatio || 1;
  // on-page stage is W/k x H/k CSS px; the WebGL canvas renders at exactly W x H
  const k = [3, 2, 4, 1].find((d) => W % d === 0 && H % d === 0 && Math.max(W, H) / d <= 720) || 2;
  container.style.width = Math.round(W / k) + 'px';
  container.style.height = Math.round(H / k) + 'px';
  let headRef = null;
  // Per-frame hook: open the jaw on vowel visemes (lips alone look like mumbling on this avatar)
  const update = () => {
    const h = headRef; if (!h || !h.mtAvatar || !h.mtAvatar.jawOpen) return;
    const m = h.mtAvatar, v = (k) => (m[k] ? m[k].value || 0 : 0);
    const open = Math.min(0.5, 0.55 * v('viseme_aa') + 0.4 * v('viseme_O') + 0.28 * v('viseme_E') + 0.22 * v('viseme_U') + 0.16 * v('viseme_I'));
    m.jawOpen.realtime = h.isSpeaking ? open : null;
    m.jawOpen.needsUpdate = true;
  };
  const head = new TalkingHead(container, {
    update,
    ttsEndpoint: null, lipsyncModules: ['en'], lipsyncLang: 'en', cameraView: view,
    modelPixelRatio: k / dpr, modelFPS: 30, cameraRotateEnable: false, cameraPanEnable: false, cameraZoomEnable: false,
    avatarSpeakingEyeContact: 0.75, avatarSpeakingHeadMove: 0.65, avatarIdleEyeContact: 0.5, avatarIdleHeadMove: 0.4,
    lightAmbientIntensity: 2.2, lightDirectIntensity: 24, mixerGainSpeech: 1,
  });
  const a = AVATARS[avatar] || AVATARS.female;
  headRef = head;
  let url = customUrl;
  if (!url) { // built-in avatar is stored gzip-compressed: unpack once per page into a blob URL
    if (!a.blobUrl) a.blobUrl = URL.createObjectURL(new Blob([await fetchBytes(a.url)], { type: 'model/gltf-binary' }));
    url = a.blobUrl;
  }
  await head.showAvatar({ url, body: a.body, avatarMood: 'happy', lipsyncLang: 'en' }, (ev) => {
    if (onProgress && ev && ev.lengthComputable) onProgress(ev.loaded / ev.total);
  });
  // This avatar's mouth shapes are subtle; amplify visemes (only) so speech reads clearly on screen.
  for (const [name, o] of Object.entries(head.mtAvatar || {})) {
    if (/^viseme_/.test(name) && name !== 'viseme_sil') {
      const mx = o.max ?? 1;
      o.limit = (v) => Math.min(mx, v * VISEME_BOOST);
    }
  }
  const bg = paintBackground(background, W, H, bgImage);
  const tex = new THREE.CanvasTexture(bg);
  tex.colorSpace = THREE.SRGBColorSpace;
  head.scene.background = tex;
  return head;
}

// Gesture plan from the script's understanding: emphasis → hand gestures; CTA → thumbs up.
export function planGestures(story, words) {
  const out = [];
  if (!story) return out;
  let last = -10;
  const names = ['handup', 'index', 'side', 'ok'];
  let k = 0;
  for (const s of story.sentences) {
    let g = null;
    if (s.type === 'cta') g = 'thumbup';
    else if (s.type === 'question') g = 'shrug';
    else if (s.type === 'list' || s.type === 'stat' || s.type === 'power') g = names[k++ % names.length];
    if (!g || s.start - last < 3.5) continue;
    const at = s.emphasis.length ? s.words[s.emphasis[0]].s : s.start + 0.2;
    out.push({ t: Math.max(0.2, at - 0.25), name: g, dur: Math.min(2.6, Math.max(1.4, s.end - at)), mirror: k % 2 === 0 });
    last = at;
  }
  return out;
}

// Perform the speech and record it in real time. Returns { file, mime, startOffset }.
export async function performAndRecord(head, { audioBuffer, words, gestures = [], mood = 'happy' }, { signal, onProgress } = {}) {
  const ctx = head.audioCtx;
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* user gesture needed */ } }
  if (ctx.state !== 'running') throw new Error('Audio is blocked by the browser. Click the button again.');
  const canvas = head.renderer.domElement;
  const dest = ctx.createMediaStreamDestination();
  head.audioReverbNode.connect(dest);
  const vs = canvas.captureStream(30);
  const stream = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const mime = pickRecorderMime();
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: Math.round(canvas.width * canvas.height * 30 * 0.12), audioBitsPerSecond: 192000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  head.setMood(mood);
  const t0 = performance.now();
  rec.start(500);
  await new Promise((r) => setTimeout(r, 450)); // a short idle lead-in (natural blink/breath)
  const speakAt = (performance.now() - t0) / 1000;
  head.speakAudio({
    audio: audioBuffer,
    words: words.map((w) => w.w + ' '),
    wtimes: words.map((w) => Math.round(w.s * 1000)),
    wdurations: words.map((w) => Math.max(60, Math.round((w.e - w.s) * 1000))),
  }, { lipsyncLang: 'en' });
  const timers = gestures.map((g) => setTimeout(() => { try { head.playGesture(g.name, g.dur, !!g.mirror, 600); } catch (e) { /* unknown gesture */ } }, (g.t) * 1000));
  const dur = audioBuffer.duration;
  let hidden = false;
  const onVis = () => { if (document.visibilityState === 'hidden') hidden = true; };
  document.addEventListener('visibilitychange', onVis);
  try {
    await new Promise((resolve, reject) => {
      const tick = () => {
        if (signal && signal.aborted) return reject(new AbortError());
        if (hidden) return reject(new Error('The tab was hidden during the avatar recording, which freezes 3D rendering. Keep this tab visible and try again.'));
        const el = (performance.now() - t0) / 1000 - speakAt;
        onProgress && onProgress(Math.min(1, el / (dur + 0.8)));
        if (el > dur + 0.8 && !head.isSpeaking) return resolve();
        if (el > dur + 6) return resolve(); // safety
        setTimeout(tick, 100);
      };
      tick();
    });
  } finally {
    timers.forEach(clearTimeout);
    document.removeEventListener('visibilitychange', onVis);
    try { head.stopSpeaking && head.stopSpeaking(); } catch (e) { /* ignore */ }
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    vs.getTracks().forEach((t) => t.stop());
    try { head.audioReverbNode.disconnect(dest); } catch (e) { /* ignore */ }
  }
  const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type });
  const file = new File([blob], `inera-avatar-${Date.now().toString(36)}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type });
  return { file, mime: type, startOffset: speakAt };
}

// Offline, frame-exact performance: the animation clock is advanced by exactly 1/fps per frame and every
// frame is encoded, so lip-sync and gestures are perfectly smooth on any computer (fast or slow) and the
// tab does not need to stay visible. Requires WebCodecs encoders (desktop Chrome / Edge).
// voice: Float32 mono at `sr`. words: [{w,s,e}] in seconds relative to the voice. Returns encodeTimeline result
// plus { voiceStart } = where the voice starts in the output (seconds).
export async function renderOffline(head, { voice, sr, words, gestures = [], mood = 'happy', fps = 30, quality = 'high', name = 'inera-avatar' }, { signal, onProgress } = {}) {
  const LEAD = 0.6, PAD = 0.3, TAIL = 0.9;
  const ctx = head.audioCtx;
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* user gesture needed */ } }
  if (ctx.state !== 'running') throw new Error('Audio is blocked by the browser. Click the button again.');
  const glc = head.renderer.domElement;
  const W = glc.width, H = glc.height;
  const out = makeCanvas(W, H), ox = out.getContext('2d');
  // take over the animation loop: TalkingHead's own animate() is called with a synthetic clock that
  // advances exactly one frame per call (its internal requestAnimationFrame is cancelled every time).
  if (head._raf) cancelAnimationFrame(head._raf);
  const tick = (ms) => { head.animate(head.animTimeLast + ms + 0.01); if (head._raf) cancelAnimationFrame(head._raf); };
  head.setMood(mood);
  for (let i = 0; i < 45; i++) tick(1000 / fps); // pre-roll: camera settles, idle pose starts
  const voiceStart = LEAD + PAD;
  const dur = voice.length / sr;
  const total = voiceStart + dur + TAIL;
  const step = 1000 / fps;
  let spoke = false, ended = false;
  const gq = gestures.map((g) => ({ ...g, t: g.t + voiceStart, started: false, stopped: false })).sort((a, b) => a.t - b.t);
  const startSpeech = () => {
    // a silent buffer of the same length drives TalkingHead's speech state; the real voice is mixed below
    const silent = new AudioBuffer({ length: Math.max(1, Math.round(dur * 8000)), sampleRate: 8000, numberOfChannels: 1 });
    head.speakAudio({
      audio: silent,
      words: words.map((w) => w.w + ' '),
      wtimes: words.map((w) => Math.round((w.s + PAD) * 1000)),
      wdurations: words.map((w) => Math.max(60, Math.round((w.e - w.s) * 1000))),
    }, { lipsyncLang: 'en' });
    // stop the real-time audio element: the offline clock decides when speech ends
    const src = head.audioSpeechSource;
    if (src) { src.onended = null; try { src.stop(); } catch (e) { /* ignore */ } }
    head.isSpeaking = true; head.stateName = 'speaking';
  };
  const endSpeech = () => {
    head.speechQueue.length = 0; head.audioPlaylist.length = 0;
    head.isAudioPlaying = false; head.isSpeaking = false; head.stateName = 'idle';
  };
  const renderFrame = async (t) => {
    checkAbort(signal);
    if (!spoke && t >= LEAD) { startSpeech(); spoke = true; }
    if (spoke && !ended && t >= voiceStart + dur + 0.15) { endSpeech(); ended = true; }
    for (const g of gq) {
      if (!g.started && t >= g.t) { g.started = true; try { head.playGesture(g.name, null, !!g.mirror, 600); } catch (e) { /* unknown gesture */ } }
      if (g.started && !g.stopped && t >= g.t + g.dur) { g.stopped = true; try { head.stopGesture(600); } catch (e) { /* ignore */ } }
    }
    tick(step); // animates and renders
    ox.drawImage(glc, 0, 0, W, H);
  };
  const audioBlock = (a, b) => {
    const n = Math.round((b - a) * 48000); const L = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tv = a + i / 48000 - voiceStart; if (tv < 0) continue;
      const x = tv * sr; const k = Math.floor(x); if (k + 1 >= voice.length) break;
      const f = x - k; L[i] = voice[k] * (1 - f) + voice[k + 1] * f;
    }
    return [L, L];
  };
  try {
    const res = await encodeTimeline({ canvas: out, W, H, fps, duration: total, renderFrame, audioBlock, quality, name, signal, onProgress });
    return { ...res, voiceStart, duration: total };
  } finally {
    if (spoke && !ended) endSpeech();
  }
}

export function disposeStage(head) {
  try { head.stop && head.stop(); } catch (e) { /* ignore */ }
  try { head.renderer && head.renderer.dispose(); } catch (e) { /* ignore */ }
  try { head.audioCtx && head.audioCtx.close(); } catch (e) { /* ignore */ }
}
