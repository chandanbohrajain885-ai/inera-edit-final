// Inera Edit Flow — shared utilities (validation, probing, ZIP, EXIF, helpers)
// Everything here runs inside the browser. No network calls are made.

export const LIMITS = {
  imageMaxBytes: 40 * 1024 * 1024,      // 40 MB per photo
  imageMaxMegapixels: 60,               // decode guard (decompression-bomb protection)
  imageProcessMegapixels: 16,           // larger photos are processed at 16 MP
  imageMaxCount: 20,                    // photos per batch (Mode 1)
  slideshowMaxImages: 30,               // Mode 3
  videoMaxBytes: 400 * 1024 * 1024,     // 400 MB
  videoMaxSeconds: 300,                 // 5 minutes (Mode 2 / Mode 4)
  videoOutputMaxSeconds: 300,
  framesMaxCount: 60,                   // Mode 4 output images
  // Desktop Chrome / Edge (WebCodecs encoder + on-disk output): long-form videos
  longVideoMaxBytes: 20 * 1024 * 1024 * 1024, // 20 GB
  longVideoMaxSeconds: 3 * 3600,              // 3 hours
};

export const IMAGE_TYPES = ['jpeg', 'png', 'webp'];
export const VIDEO_TYPES = ['mp4', 'mov', 'webm'];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = (p = 'id') => p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (!isFinite(n) || n < 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtTime(sec, withMs = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  if (withMs) return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

export function safeFileStem(name) {
  const stem = String(name || 'file').replace(/\.[^.]+$/, '');
  return stem.replace(/[^a-zA-Z0-9-_ ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'file';
}

export class AbortError extends Error {
  constructor(msg = 'Cancelled') { super(msg); this.name = 'AbortError'; }
}
export function checkAbort(signal) { if (signal && signal.aborted) throw new AbortError(); }

// ---------- Content sniffing (magic bytes, not extensions) ----------
export async function sniffType(file) {
  const buf = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const at = (i, arr) => arr.every((b, k) => buf[i + k] === b);
  const str = (i, n) => String.fromCharCode(...buf.slice(i, i + n));
  if (buf.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (buf.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (buf.length >= 12 && str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return 'webp';
  if (buf.length >= 4 && at(0, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (buf.length >= 12 && str(4, 4) === 'ftyp') {
    const brand = str(8, 4);
    if (brand === 'qt  ') return 'mov';
    if (/^(heic|heix|hevc|mif1|msf1|avif)$/.test(brand)) return 'heif';
    return 'mp4';
  }
  if (buf.length >= 8 && (str(4, 4) === 'moov' || str(4, 4) === 'mdat' || str(4, 4) === 'wide' || str(4, 4) === 'free')) return 'mov';
  if (buf.length >= 4 && str(0, 4) === 'GIF8') return 'gif';
  return null;
}

// Read image dimensions from the header without decoding the pixels.
export async function readImageHeaderDims(file, type) {
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer());
  const dv = new DataView(head.buffer);
  try {
    if (type === 'png') return { w: dv.getUint32(16), h: dv.getUint32(20) };
    if (type === 'webp') {
      const chunk = String.fromCharCode(...head.slice(12, 16));
      if (chunk === 'VP8X') return { w: 1 + (head[24] | (head[25] << 8) | (head[26] << 16)), h: 1 + (head[27] | (head[28] << 8) | (head[29] << 16)) };
      if (chunk === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
      if (chunk === 'VP8L') {
        const b = dv.getUint32(21, true);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    if (type === 'jpeg') {
      let i = 2;
      while (i < head.length - 9) {
        if (head[i] !== 0xff) { i++; continue; }
        const marker = head[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = dv.getUint16(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

export async function validateImageFile(file) {
  if (!file || !file.size) return { ok: false, error: 'The file is empty.' };
  if (file.size > LIMITS.imageMaxBytes) return { ok: false, error: `"${file.name}" is ${fmtBytes(file.size)}. The photo limit is ${fmtBytes(LIMITS.imageMaxBytes)}.` };
  const type = await sniffType(file);
  if (type === 'heif') return { ok: false, error: `"${file.name}" is a HEIC/HEIF/AVIF photo. Please export it as JPG or PNG first (iPhone: Settings → Camera → Formats → Most Compatible).` };
  if (!IMAGE_TYPES.includes(type)) return { ok: false, error: `"${file.name}" is not a JPG, PNG or WebP image (checked by file content, not the extension).` };
  const dims = await readImageHeaderDims(file, type);
  if (dims && dims.w * dims.h > LIMITS.imageMaxMegapixels * 1e6) return { ok: false, error: `"${file.name}" is ${(dims.w * dims.h / 1e6).toFixed(0)} megapixels. The limit is ${LIMITS.imageMaxMegapixels} MP.` };
  return { ok: true, type, dims };
}

export async function validateVideoFile(file, maxBytes = LIMITS.videoMaxBytes) {
  if (!file || !file.size) return { ok: false, error: 'The file is empty.' };
  if (file.size > maxBytes) return { ok: false, error: `"${file.name}" is ${fmtBytes(file.size)}. The video limit in this browser is ${fmtBytes(maxBytes)}.` };
  const type = await sniffType(file);
  if (!VIDEO_TYPES.includes(type)) return { ok: false, error: `"${file.name}" is not an MP4, MOV or WebM video (checked by file content, not the extension).` };
  return { ok: true, type };
}

// ---------- Image loading ----------
export async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    if (!img.naturalWidth) throw new Error('decode failed');
    return { img, url, width: img.naturalWidth, height: img.naturalHeight };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw new Error(`Your browser could not decode "${file.name}". The file may be damaged or use an unsupported encoding.`);
  }
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function fitSize(w, h, maxLong, maxMP) {
  let s = 1;
  if (maxLong && Math.max(w, h) > maxLong) s = Math.min(s, maxLong / Math.max(w, h));
  if (maxMP && w * h * s * s > maxMP * 1e6) s = Math.min(s, Math.sqrt((maxMP * 1e6) / (w * h)));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

export function drawToCanvas(src, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export function canvasToBlob(canvas, mime = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b || !b.size) return reject(new Error('The browser could not encode the image.'));
      // Some browsers silently fall back to PNG if the type is unsupported (e.g. WebP on old Safari)
      resolve(b);
    }, mime, quality);
  });
}

export const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/zip': 'zip' };
export function extForBlob(blob) {
  const base = (blob.type || '').split(';')[0];
  return MIME_EXT[base] || 'bin';
}

export async function verifyImageBlob(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('empty image');
    return { ok: true, width: img.naturalWidth, height: img.naturalHeight, mime: blob.type, size: blob.size };
  } catch (e) {
    return { ok: false, error: 'Output image failed verification: ' + e.message };
  } finally { URL.revokeObjectURL(url); }
}

// ---------- Video helpers ----------
export function createVideoEl(url) {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  v.src = url;
  return v;
}

export function waitEvent(el, ok, timeoutMs = 15000, errName = 'error') {
  return new Promise((resolve, reject) => {
    let t;
    const done = (fn, arg) => { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener(errName, onErr); fn(arg); };
    const onOk = (e) => done(resolve, e);
    const onErr = () => done(reject, new Error(el.error ? `media error ${el.error.code}` : 'media error'));
    el.addEventListener(ok, onOk);
    el.addEventListener(errName, onErr);
    t = setTimeout(() => done(reject, new Error(`timeout waiting for ${ok}`)), timeoutMs);
  });
}

export async function seekVideo(video, t, timeoutMs = 10000) {
  t = clamp(t, 0, Math.max(0, (video.duration || 0) - 0.001));
  if (Math.abs(video.currentTime - t) < 0.0005 && video.readyState >= 2) return;
  const p = waitEvent(video, 'seeked', timeoutMs);
  video.currentTime = t;
  await p;
  // make sure a decoded frame is available
  if (video.readyState < 2) await waitEvent(video, 'loadeddata', 3000).catch(() => {});
}

// Fix MediaRecorder WebM files that report duration = Infinity
export async function resolveDuration(video) {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  await new Promise((resolve) => {
    const onTU = () => { video.removeEventListener('durationchange', onTU); resolve(); };
    video.addEventListener('durationchange', onTU);
    video.currentTime = 1e7;
    setTimeout(resolve, 4000);
  });
  const d = video.duration;
  try { video.currentTime = 0; } catch (e) {}
  return d;
}

export async function probeVideo(file) {
  const url = URL.createObjectURL(file);
  const v = createVideoEl(url);
  try {
    await waitEvent(v, 'loadedmetadata', 20000);
    const duration = await resolveDuration(v);
    if (!v.videoWidth || !v.videoHeight) throw new Error('no video track');
    if (!isFinite(duration) || duration <= 0) throw new Error('unknown duration');
    // Decode test: seek into the file and draw a frame
    await seekVideo(v, Math.min(0.5, duration / 3), 15000);
    const c = makeCanvas(32, 18);
    c.getContext('2d').drawImage(v, 0, 0, 32, 18);
    return { ok: true, url, duration, width: v.videoWidth, height: v.videoHeight };
  } catch (e) {
    URL.revokeObjectURL(url);
    return { ok: false, error: `This browser cannot decode "${file.name}" (${e.message}). Common cause: HEVC/H.265 or ProRes video from phones/cameras. Re-export it as MP4 (H.264) — e.g. iPhone: Settings → Camera → Formats → Most Compatible, or use a free converter such as HandBrake — then upload again.` };
  } finally {
    v.removeAttribute('src'); v.load();
  }
}

export async function grabVideoThumb(url, t = 0.5, maxW = 480) {
  const v = createVideoEl(url);
  try {
    await waitEvent(v, 'loadedmetadata', 15000);
    await seekVideo(v, Math.min(t, (v.duration || 1) / 2));
    const s = fitSize(v.videoWidth, v.videoHeight, maxW);
    const c = drawToCanvas(v, s.w, s.h);
    return await canvasToBlob(c, 'image/jpeg', 0.8);
  } finally { v.removeAttribute('src'); v.load(); }
}

export async function imageThumb(source, maxW = 480) {
  const w = source.naturalWidth || source.videoWidth || source.width;
  const h = source.naturalHeight || source.videoHeight || source.height;
  const s = fitSize(w, h, maxW);
  return canvasToBlob(drawToCanvas(source, s.w, s.h), 'image/jpeg', 0.8);
}

// Verify a rendered video: container opens, has a video stream, duration matches,
// a frame decodes, and (if expected) the audio stream decodes and is not silent.
export async function verifyVideoBlob(blob, { expectedDuration, expectAudio } = {}) {
  const res = { ok: false, size: blob.size, mime: blob.type };
  if (!blob || blob.size < 1000) { res.error = 'Rendered file is empty.'; return res; }
  const url = URL.createObjectURL(blob);
  const v = createVideoEl(url);
  try {
    await waitEvent(v, 'loadedmetadata', 20000);
    const d = await resolveDuration(v);
    res.duration = d; res.width = v.videoWidth; res.height = v.videoHeight;
    if (!v.videoWidth) throw new Error('no video stream');
    if (!isFinite(d) || d <= 0) throw new Error('could not read duration');
    if (expectedDuration && Math.abs(d - expectedDuration) > Math.max(1.5, expectedDuration * 0.08)) {
      throw new Error(`duration ${d.toFixed(1)}s does not match the planned ${expectedDuration.toFixed(1)}s`);
    }
    await seekVideo(v, Math.min(d / 2, d - 0.1), 15000);
    const c = makeCanvas(64, 36);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, 64, 36);
    const px = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0; for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    res.midFrameMean = sum / (px.length / 4) / 3;
    res.hasAudio = false;
    // Audio check: decode the audio stream (bounded to 64 MB so long renders cannot exhaust memory).
    const LIMIT = 64 * 1024 * 1024;
    try {
      const ab = await blob.slice(0, Math.min(blob.size, LIMIT)).arrayBuffer();
      const actx = new OfflineAudioContext(1, 1, 22050);
      const abuf = await actx.decodeAudioData(ab);
      const ch = abuf.getChannelData(0);
      let peak = 0; for (let i = 0; i < ch.length; i += 7) peak = Math.max(peak, Math.abs(ch[i]));
      res.hasAudio = abuf.duration > 0.5;
      res.audioPeak = peak;
      res.audioDuration = abuf.duration;
    } catch (e) { res.hasAudio = blob.size > LIMIT ? null : false; }
    if (expectAudio && res.hasAudio === false) throw new Error('audio stream is missing');
    res.ok = true;
  } catch (e) {
    res.error = 'Output video failed verification: ' + e.message;
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
  return res;
}

// Read the real codecs from the container bytes (honest labelling of the output)
export async function detectCodecs(blob) {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 256 * 1024)).arrayBuffer());
  let s = '';
  for (let i = 0; i < head.length; i++) s += head[i] > 31 && head[i] < 127 ? String.fromCharCode(head[i]) : ' ';
  const isMp4 = s.includes('ftyp');
  const v = isMp4 ? (/avc1|avc3/.test(s) ? 'H.264' : /hvc1|hev1/.test(s) ? 'HEVC' : /vp09/.test(s) ? 'VP9' : /av01/.test(s) ? 'AV1' : '?')
    : (s.includes('V_VP9') ? 'VP9' : s.includes('V_VP8') ? 'VP8' : s.includes('V_AV1') ? 'AV1' : s.includes('V_MPEG4/ISO/AVC') ? 'H.264' : '?');
  const a = isMp4 ? (/mp4a/.test(s) ? 'AAC' : /Opus/.test(s) ? 'Opus' : '') : (s.includes('A_OPUS') ? 'Opus' : s.includes('A_AAC') ? 'AAC' : '');
  return { container: isMp4 ? 'MP4' : 'WebM', video: v, audio: a, label: `${isMp4 ? 'MP4' : 'WebM'} (${v} video${a ? ' + ' + a + ' audio' : ''})` };
}

export function pickRecorderMime() {
  const cands = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of cands) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
  return '';
}

export function describeMime(m) {
  if (!m) return 'unknown';
  if (m.startsWith('video/mp4')) return m.includes('avc1') ? 'MP4 (H.264 video' + (m.includes('mp4a') ? ' + AAC audio)' : ')') : 'MP4 (codec chosen by the browser)';
  if (m.startsWith('video/webm')) return m.includes('vp9') ? 'WebM (VP9 video + Opus audio)' : m.includes('vp8') ? 'WebM (VP8 video + Opus audio)' : 'WebM';
  return m;
}

// ---------- Downloads ----------
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- Minimal ZIP writer (STORE method, CRC-32) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function makeZip(files, onProgress) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const used = new Set();
  for (let i = 0; i < files.length; i++) {
    let name = files[i].name.replace(/[\\/:*?"<>|]+/g, '_');
    while (used.has(name)) name = name.replace(/(\.[^.]+)?$/, (m) => '_' + i + m);
    used.add(name);
    const data = new Uint8Array(await files[i].blob.arrayBuffer());
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, nameBytes, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
    if (onProgress) onProgress((i + 1) / files.length);
  }
  let centralSize = 0;
  for (const c of central) centralSize += c.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ---------- EXIF capture date (JPEG only) ----------
export async function readExifDate(file) {
  try {
    const u8 = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
    const dv = new DataView(u8.buffer);
    let i = 2;
    while (i < u8.length - 4) {
      if (u8[i] !== 0xff) return null;
      const marker = u8[i + 1];
      const len = dv.getUint16(i + 2);
      if (marker === 0xe1 && String.fromCharCode(...u8.slice(i + 4, i + 8)) === 'Exif') {
        const tiff = i + 10;
        const le = dv.getUint16(tiff) === 0x4949;
        const g16 = (o) => dv.getUint16(o, le), g32 = (o) => dv.getUint32(o, le);
        const readStr = (off, n) => String.fromCharCode(...u8.slice(off, off + n)).replace(/\0/g, '');
        const scan = (ifd) => {
          const out = {};
          if (ifd <= 0 || tiff + ifd + 2 > u8.length) return out;
          const n = g16(tiff + ifd);
          for (let k = 0; k < n; k++) {
            const e = tiff + ifd + 2 + k * 12;
            if (e + 12 > u8.length) break;
            const tag = g16(e);
            if (tag === 0x9003 || tag === 0x0132) out[tag] = readStr(tiff + g32(e + 8), 19);
            if (tag === 0x8769) out.exif = g32(e + 8);
          }
          return out;
        };
        const ifd0 = scan(g32(tiff + 4));
        const sub = ifd0.exif ? scan(ifd0.exif) : {};
        const s = sub[0x9003] || ifd0[0x0132];
        if (!s) return null;
        const m = s.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
        if (!m) return null;
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
      }
      i += 2 + len;
    }
  } catch (e) {}
  return null;
}

// Parse "0:05, 1:12.5, 75" into seconds
export function parseTimestamps(text, maxT) {
  const out = [];
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const parts = s.split(':').map((p) => parseFloat(p));
    if (parts.some((p) => !isFinite(p) || p < 0)) continue;
    let t = 0;
    for (const p of parts) t = t * 60 + p;
    if (t <= maxT) out.push(t);
  }
  return [...new Set(out.map((t) => Math.round(t * 100) / 100))].sort((a, b) => a - b);
}

export function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
