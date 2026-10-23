// Inera Edit Flow — GPU compositor (WebGL) + real-time recorder (MediaRecorder).
// Handles framing (cover crop, zoom, punch-ins, stabilisation offsets), transitions,
// colour grading and text overlays. The recorder captures the canvas + mixed audio.
import { AbortError, clamp } from './utils.js';

const VS = `
attribute vec2 aPos;
varying vec2 vUV;
void main(){ vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTexA, uTexB, uText;
uniform vec4 uRectA, uRectB;
uniform vec2 uShiftA, uShiftB;
uniform float uMix, uGainA, uGainB, uBlurA, uBlurB, uHasB, uTextOn, uFade, uFlash;
uniform float uContrast, uSat, uTemp, uTint, uSplitAmt, uVignette, uMono, uAspect;
uniform vec3 uWB, uSplitS, uSplitH;
uniform float uBlurMode;
vec3 samp(sampler2D t, vec4 r, vec2 uv, float blur){
  vec2 p = r.xy + (uv - 0.5) * r.zw;
  if (blur < 0.0005) return texture2D(t, clamp(p, 0.0, 1.0)).rgb;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float k = float(i) / 9.0 - 0.5;
    vec2 q = uBlurMode < 1.5 ? r.xy + (uv - 0.5) * r.zw * (1.0 + k * blur) : p + vec2(k * blur * r.z, 0.0);
    acc += texture2D(t, clamp(q, 0.0, 1.0)).rgb;
  }
  return acc / 10.0;
}
void main(){
  vec3 a = samp(uTexA, uRectA, vUV + uShiftA, uBlurA) * uGainA;
  vec3 col = a;
  if (uHasB > 0.5) {
    vec3 b = samp(uTexB, uRectB, vUV + uShiftB, uBlurB) * uGainB;
    col = mix(a, b, uMix);
  }
  col *= uWB;
  col.r += uTemp * 0.04; col.b -= uTemp * 0.04; col.g += uTint * 0.03;
  col = clamp(col, 0.0, 1.0);
  float L = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(L), col, uSat);
  col = clamp(col, 0.0, 1.0);
  col = col + uContrast * (col * col * (3.0 - 2.0 * col) - col) * 1.6;
  float L2 = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  col += uSplitS * (1.0 - L2) * (1.0 - L2) * uSplitAmt + uSplitH * L2 * L2 * uSplitAmt;
  if (uMono > 0.5) col = vec3(dot(col, vec3(0.2126, 0.7152, 0.0722)));
  vec2 d = (vUV - 0.5) * vec2(uAspect, 1.0);
  float rr = length(d) / length(vec2(uAspect, 1.0) * 0.5);
  col *= 1.0 - uVignette * pow(max(0.0, rr - 0.35) / 0.65, 2.0);
  if (uTextOn > 0.5) { vec4 tc = texture2D(uText, vUV); col = mix(col, tc.rgb, tc.a); }
  col = mix(col, vec3(1.0), uFlash);
  col *= (1.0 - uFade);
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export const DEFAULT_GRADE = { wb: [1, 1, 1], contrast: 0.1, sat: 1.05, temp: 0, tint: 0, splitS: [0, 0, 0], splitH: [0, 0, 0], splitAmt: 0, vignette: 0, mono: 0 };

export class Compositor {
  constructor(canvas, W, H) {
    this.canvas = canvas;
    canvas.width = W; canvas.height = H;
    this.W = W; this.H = H;
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, alpha: false, premultipliedAlpha: false })
      || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser, so video rendering cannot run. Try the latest Chrome, Edge, Firefox or Safari.');
    if (gl.isContextLost()) throw new Error('The graphics context was lost (GPU reset or low memory). Reload the page and try again.');
    this.gl = gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link error: ' + gl.getProgramInfoLog(p));
    gl.useProgram(p);
    this.prog = p;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uTexA', 'uTexB', 'uText', 'uRectA', 'uRectB', 'uShiftA', 'uShiftB', 'uMix', 'uGainA', 'uGainB', 'uBlurA', 'uBlurB', 'uHasB', 'uTextOn', 'uFade', 'uFlash', 'uContrast', 'uSat', 'uTemp', 'uTint', 'uSplitAmt', 'uVignette', 'uMono', 'uAspect', 'uWB', 'uSplitS', 'uSplitH', 'uBlurMode']) this.u[n] = gl.getUniformLocation(p, n);
    this.texA = this._tex(); this.texB = this._tex(); this.texText = this._tex();
    gl.uniform1i(this.u.uTexA, 0); gl.uniform1i(this.u.uTexB, 1); gl.uniform1i(this.u.uText, 2);
    gl.viewport(0, 0, W, H);
    this.grade = { ...DEFAULT_GRADE };
    this.textOn = false;
    this.lastA = null; this.lastB = null;
  }
  _tex() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }
  _upload(unit, tex, source) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); return true; }
    catch (e) { return false; }
  }
  // Rectangle in texture space for a cover-crop of a (sw x sh) source with focus & zoom.
  rectFor(sw, sh, { focusX = 0.5, focusY = 0.5, zoom = 1, offX = 0, offY = 0 } = {}) {
    const srcA = sw / sh, outA = this.W / this.H;
    let sx = 1, sy = 1;
    if (srcA > outA) sx = outA / srcA; else sy = srcA / outA;
    sx /= zoom; sy /= zoom;
    const cx = clamp(clamp(focusX, sx / 2, 1 - sx / 2) + offX, sx / 2, 1 - sx / 2);
    const cy = clamp(clamp(focusY, sy / 2, 1 - sy / 2) + offY, sy / 2, 1 - sy / 2);
    return [cx, 1 - cy, sx, sy];
  }
  setGrade(g) { this.grade = { ...DEFAULT_GRADE, ...g }; }
  setText(canvasOrNull) {
    if (!canvasOrNull) { this.textOn = false; return; }
    this.textOn = this._upload(2, this.texText, canvasOrNull);
  }
  // overlay unchanged since the last frame: keep the texture already on the GPU (no re-upload)
  keepText() { /* textOn stays as it is */ }
  _texFor(key) {
    if (!this.texMap) this.texMap = new Map();
    let t = this.texMap.get(key);
    if (!t) { t = this._tex(); this.texMap.set(key, t); }
    return t;
  }
  hasTex(key) { return !!(this.texMap && this.texMap.has(key) && this.uploaded && this.uploaded.has(key)); }
  releaseTex(key) {
    if (this.texMap && this.texMap.has(key)) { this.gl.deleteTexture(this.texMap.get(key)); this.texMap.delete(key); }
    if (this.uploaded) this.uploaded.delete(key);
  }
  // Layers: { source, key, upload (bool), rect, gain, blur, shift }. If upload is false the last
  // uploaded frame for that key is reused (e.g. while a video element is still seeking).
  draw(f) {
    const gl = this.gl, u = this.u, G = this.grade;
    if (!this.uploaded) this.uploaded = new Set();
    const keyA = f.a.key ?? 'A', keyB = f.b ? (f.b.key ?? 'B') : null;
    const tA = this._texFor(keyA);
    if (f.a.source && f.a.upload !== false && this._upload(0, tA, f.a.source)) this.uploaded.add(keyA);
    let tB = this.texB;
    if (f.b) { tB = this._texFor(keyB); if (f.b.source && f.b.upload !== false && this._upload(1, tB, f.b.source)) this.uploaded.add(keyB); }
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tA);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tB);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texText);
    gl.uniform4fv(u.uRectA, f.a.rect);
    gl.uniform4fv(u.uRectB, f.b ? f.b.rect : [0.5, 0.5, 1, 1]);
    gl.uniform2fv(u.uShiftA, f.a.shift || [0, 0]);
    gl.uniform2fv(u.uShiftB, (f.b && f.b.shift) || [0, 0]);
    gl.uniform1f(u.uMix, f.mix || 0);
    gl.uniform1f(u.uGainA, f.a.gain ?? 1);
    gl.uniform1f(u.uGainB, f.b ? (f.b.gain ?? 1) : 1);
    gl.uniform1f(u.uBlurA, f.a.blur || 0);
    gl.uniform1f(u.uBlurB, f.b ? f.b.blur || 0 : 0);
    gl.uniform1f(u.uHasB, f.b ? 1 : 0);
    gl.uniform1f(u.uBlurMode, f.blurMode || 1);
    gl.uniform1f(u.uTextOn, this.textOn ? 1 : 0);
    gl.uniform1f(u.uFade, clamp(f.fade || 0, 0, 1));
    gl.uniform1f(u.uFlash, clamp(f.flash || 0, 0, 1));
    gl.uniform1f(u.uContrast, G.contrast);
    gl.uniform1f(u.uSat, G.sat);
    gl.uniform1f(u.uTemp, G.temp);
    gl.uniform1f(u.uTint, G.tint);
    gl.uniform1f(u.uSplitAmt, G.splitAmt);
    gl.uniform1f(u.uVignette, G.vignette);
    gl.uniform1f(u.uMono, G.mono ? 1 : 0);
    gl.uniform1f(u.uAspect, this.W / this.H);
    gl.uniform3fv(u.uWB, G.wb);
    gl.uniform3fv(u.uSplitS, G.splitS);
    gl.uniform3fv(u.uSplitH, G.splitH);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // Free GPU resources but keep the context alive: the same <canvas> is reused for the next render
  // (losing the context would make every later render on this canvas fail).
  destroy() {
    const gl = this.gl;
    try {
      if (this.texMap) { for (const t of this.texMap.values()) gl.deleteTexture(t); this.texMap.clear(); }
      [this.texA, this.texB, this.texText].forEach((t) => t && gl.deleteTexture(t));
      if (this.uploaded) this.uploaded.clear();
    } catch (e) { /* context already gone */ }
  }
}

// Transition evaluation: returns mix + blur/shift/flash for progress p in [0,1]
export function transitionState(type, p) {
  const e = p * p * (3 - 2 * p);
  switch (type) {
    case 'fade': return { mix: e };
    case 'dip': return { mix: p < 0.5 ? 0 : 1, fade: 1 - Math.abs(p - 0.5) * 2 };
    case 'flash': return { mix: p < 0.5 ? 0 : 1, flash: Math.max(0, 1 - Math.abs(p - 0.5) * 3.2) };
    case 'zoom': return { mix: e, blurA: e * 0.35, blurB: (1 - e) * 0.35, zoomA: 1 + e * 0.35, zoomB: 1.35 - e * 0.35, blurMode: 1 };
    case 'whip': return { mix: e, blurA: Math.sin(p * Math.PI) * 0.5, blurB: Math.sin(p * Math.PI) * 0.5, shiftA: [-e * 0.35, 0], shiftB: [(1 - e) * 0.35, 0], blurMode: 2 };
    default: return { mix: p < 0.5 ? 0 : 1 };
  }
}

// Text overlay drawing (clean modern typography, mobile-safe sizes)
export function drawTitleCard(canvas, text, { progress = 1, sub = '', position = 'center' } = {}) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!text) return;
  const ease = 1 - Math.pow(1 - clamp(progress, 0, 1), 3);
  const base = Math.min(W, H);
  let size = Math.round(base * 0.085);
  ctx.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const maxW = W * 0.84;
  // wrap text into lines
  const words = String(text).split(/\s+/);
  let lines = [], cur = '';
  for (const w of words) {
    const test = cur ? cur + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; } else cur = test;
  }
  if (cur) lines.push(cur);
  while (lines.length > 3 && size > 18) { size = Math.round(size * 0.85); ctx.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; lines = [lines.join(' ')]; const all = lines[0].split(' '); lines = []; cur = ''; for (const w of all) { const t2 = cur ? cur + ' ' + w : w; if (ctx.measureText(t2).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t2; } if (cur) lines.push(cur); }
  const lh = size * 1.15;
  const blockH = lines.length * lh + (sub ? size * 0.9 : 0);
  let y0 = position === 'lower' ? H * 0.72 - blockH / 2 : H / 2 - blockH / 2;
  y0 += (1 - ease) * size * 0.6;
  ctx.globalAlpha = ease;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // backing pill for readability
  let widest = 0; for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
  const padX = size * 0.6, padY = size * 0.4;
  ctx.fillStyle = 'rgba(10,10,18,0.55)';
  const rx = W / 2 - widest / 2 - padX, ry = y0 - padY, rw = widest + padX * 2, rh = blockH + padY * 2;
  const r = size * 0.4;
  ctx.beginPath();
  ctx.moveTo(rx + r, ry); ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r); ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
  ctx.arcTo(rx, ry + rh, rx, ry, r); ctx.arcTo(rx, ry, rx + rw, ry, r); ctx.closePath(); ctx.fill();
  // accent bar
  const grad = ctx.createLinearGradient(rx, 0, rx + rw, 0);
  grad.addColorStop(0, '#8b5cf6'); grad.addColorStop(1, '#3b82f6');
  ctx.fillStyle = grad;
  ctx.fillRect(rx + r, ry + rh - Math.max(3, size * 0.08), (rw - 2 * r) * ease, Math.max(3, size * 0.08));
  ctx.fillStyle = '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh));
  if (sub) {
    ctx.font = `600 ${Math.round(size * 0.5)}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = 'rgba(220,220,255,0.9)';
    ctx.fillText(sub, W / 2, y0 + lines.length * lh + size * 0.25);
  }
  ctx.globalAlpha = 1;
}

// Real-time recorder. Audio context clock is the master clock; frames are drawn by onFrame(t).
export async function recordTimeline({ canvas, audioCtx, audioBuffer, duration, fps = 30, mime, bitrate, onFrame, onProgress, onPauseChange, signal }) {
  if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) throw new Error('This browser cannot record video (MediaRecorder / canvas capture is missing). Please use the latest Chrome, Edge, Firefox or Safari.');
  if (audioCtx.state !== 'running') { try { await audioCtx.resume(); } catch (e) {} }
  if (audioCtx.state !== 'running') throw new Error('Audio is blocked by the browser. Click the button again to start rendering.');
  const dest = audioCtx.createMediaStreamDestination();
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(dest);
  const vStream = canvas.captureStream(fps);
  const stream = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const opts = { videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 };
  if (mime) opts.mimeType = mime;
  const rec = new MediaRecorder(stream, opts);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res, rej) => { rec.onstop = res; rec.onerror = (e) => rej(new Error('Recorder error: ' + (e.error && e.error.message || 'unknown'))); });

  await onFrame(0);
  rec.start(1000);
  const startAt = audioCtx.currentTime + 0.05;
  src.start(startAt);
  let paused = false, aborted = false;
  const onVis = async () => {
    if (document.visibilityState === 'hidden' && !paused) {
      paused = true;
      try { rec.pause(); } catch (e) {}
      try { await audioCtx.suspend(); } catch (e) {}
      onPauseChange && onPauseChange(true);
    } else if (document.visibilityState === 'visible' && paused) {
      paused = false;
      try { await audioCtx.resume(); } catch (e) {}
      try { rec.resume(); } catch (e) {}
      onPauseChange && onPauseChange(false);
    }
  };
  document.addEventListener('visibilitychange', onVis);
  const onAbort = () => { aborted = true; };
  signal && signal.addEventListener('abort', onAbort);
  try {
    await new Promise((resolve, reject) => {
      const tick = async () => {
        if (aborted) return reject(new AbortError());
        if (paused) { requestAnimationFrame(tick); return; }
        const t = audioCtx.currentTime - startAt;
        try { await onFrame(Math.max(0, Math.min(duration, t))); } catch (e) { return reject(e); }
        onProgress && onProgress(clamp(t / duration, 0, 1));
        if (t >= duration + 0.08) return resolve();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  } finally {
    document.removeEventListener('visibilitychange', onVis);
    signal && signal.removeEventListener('abort', onAbort);
    try { src.stop(); } catch (e) {}
    try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {}
    await stopped.catch(() => {});
    vStream.getTracks().forEach((t) => t.stop());
    dest.stream.getTracks().forEach((t) => t.stop());
  }
  if (aborted) throw new AbortError();
  const type = (rec.mimeType || mime || 'video/webm');
  return new Blob(chunks, { type: type.split(';')[0] === 'video/mp4' ? 'video/mp4' : 'video/webm' });
}
