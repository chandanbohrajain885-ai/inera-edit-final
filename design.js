// Inera Edit Flow — image design tools: subject cut-out, background replacement, social designs
// (YouTube thumbnail, Instagram post, Story) laid out automatically like a graphic designer would.
import { makeCanvas, clamp } from './utils.js';

let worker = null, seq = 0; const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./segment-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.resolve(e.data.mask) : p.reject(new Error(e.data.error)); };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error('Segmentation engine crashed')); pending.clear(); worker = null; };
  return worker;
}

// Returns an alpha mask canvas (white = subject) at the source's size.
export async function subjectMask(src) {
  const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
  const c = makeCanvas(320, 320); const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, 320, 320);
  const px = x.getImageData(0, 0, 320, 320).data;
  const mask = await new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); getWorker().postMessage({ id, buffer: px.buffer }, [px.buffer]); });
  // probability → soft alpha (smoothstep), at model resolution
  const m = makeCanvas(320, 320); const mx = m.getContext('2d');
  const id = mx.createImageData(320, 320);
  for (let i = 0; i < mask.length; i++) {
    let v = clamp((mask[i] - 0.28) / 0.44, 0, 1); v = v * v * (3 - 2 * v);
    id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = Math.round(v * 255);
  }
  mx.putImageData(id, 0, 0);
  // upscale smoothly + slight feather
  const out = makeCanvas(w, h); const ox = out.getContext('2d');
  ox.imageSmoothingQuality = 'high';
  try { ox.filter = `blur(${Math.max(0.6, Math.min(w, h) / 900)}px)`; } catch (e) { /* no filter */ }
  ox.drawImage(m, 0, 0, w, h);
  ox.filter = 'none';
  return out;
}

export function cutout(src, mask) {
  const w = mask.width, h = mask.height;
  const c = makeCanvas(w, h); const x = c.getContext('2d');
  x.drawImage(src, 0, 0, w, h);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(mask, 0, 0);
  x.globalCompositeOperation = 'source-over';
  return c;
}

export const BG_MODES = { keep: 'Original background', transparent: 'Remove (transparent PNG)', blur: 'Portrait blur', studio: 'Studio gradient', white: 'Clean white (product)', color: 'Solid colour', image: 'Your image' };

export function replaceBackground(src, mask, { mode = 'blur', color = '#1e1b4b', image = null } = {}) {
  const w = mask.width, h = mask.height;
  const c = makeCanvas(w, h); const x = c.getContext('2d');
  if (mode === 'keep') { x.drawImage(src, 0, 0, w, h); return c; }
  if (mode === 'blur') {
    try { x.filter = `blur(${Math.round(Math.min(w, h) / 45)}px)`; } catch (e) { /* no filter */ }
    x.drawImage(src, -w * 0.03, -h * 0.03, w * 1.06, h * 1.06); x.filter = 'none';
  } else if (mode === 'studio') {
    const g = x.createRadialGradient(w * 0.5, h * 0.4, 0, w * 0.5, h * 0.45, Math.max(w, h) * 0.75);
    g.addColorStop(0, '#3b3f7a'); g.addColorStop(0.6, '#1b1d3d'); g.addColorStop(1, '#0b0c18');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
  } else if (mode === 'white') {
    const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#eef0f4'); x.fillStyle = g; x.fillRect(0, 0, w, h);
  } else if (mode === 'color') { x.fillStyle = color; x.fillRect(0, 0, w, h); }
  else if (mode === 'image' && image) { const s = Math.max(w / image.width, h / image.height); x.drawImage(image, (w - image.width * s) / 2, (h - image.height * s) / 2, image.width * s, image.height * s); }
  if (mode !== 'transparent') {
    // soft contact shadow under the subject for studio/white looks
    if (mode === 'white' || mode === 'studio') { x.save(); x.globalAlpha = 0.35; x.filter = 'blur(18px)'; x.drawImage(mask, w * 0.01, h * 0.02); x.restore(); x.filter = 'none'; }
  }
  x.drawImage(cutout(src, mask), 0, 0);
  return c;
}

// ---------- social designs ----------
export const LAYOUTS = { youtube: { w: 1280, h: 720, label: 'YouTube thumbnail 1280×720' }, post: { w: 1080, h: 1350, label: 'Instagram post 1080×1350' }, story: { w: 1080, h: 1920, label: 'Story / Reel cover 1080×1920' } };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
function wrap(x, text, maxW) { const words = String(text).split(/\s+/); const lines = []; let cur = ''; for (const w of words) { const t = cur ? cur + ' ' + w : w; if (x.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines; }

// Bounding box of the subject in the mask (in mask pixels); null when nothing was found.
export function maskBox(mask, thr = 60) {
  const sc = Math.min(1, 400 / Math.max(mask.width, mask.height));
  const w = Math.max(1, Math.round(mask.width * sc)), h = Math.max(1, Math.round(mask.height * sc));
  const c = makeCanvas(w, h); const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(mask, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) if (d[(y * w + i) * 4 + 3] > thr) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0 / sc, y: y0 / sc, w: (x1 - x0 + 1) / sc, h: (y1 - y0 + 1) / sc, touchesBottom: y1 >= h - 4, area: (x1 - x0 + 1) * (y1 - y0 + 1) / (w * h) };
}

export function makeDesign(src, mask, { layout = 'youtube', title = '', subtitle = '', accent = '#facc15' } = {}) {
  const L = LAYOUTS[layout] || LAYOUTS.youtube; const W = L.w, H = L.h;
  const c = makeCanvas(W, H); const x = c.getContext('2d');
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  // background: blurred, darkened photo + brand gradient
  try { x.filter = 'blur(26px) brightness(0.5) saturate(1.2)'; } catch (e) { /* no filter */ }
  const s0 = Math.max(W / sw, H / sh) * 1.1; x.drawImage(src, (W - sw * s0) / 2, (H - sh * s0) / 2, sw * s0, sh * s0); x.filter = 'none';
  const g = x.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(124,58,237,0.55)'); g.addColorStop(1, 'rgba(37,99,235,0.35)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  const landscape = W > H;
  // ---- headline first (its height decides where the subject goes in tall layouts)
  let titleBottom = 0, lines = [], fs = 0, tx = 0, ty = 0;
  const T = String(title || '').trim();
  if (T) {
    const maxW = landscape ? W * 0.5 : W * 0.88;
    fs = Math.round(Math.min(W, H) * (landscape ? 0.15 : 0.11));
    x.font = `900 ${fs}px ${FONT}`;
    lines = wrap(x, T.toUpperCase(), maxW);
    while ((lines.length > 3 || lines.some((l) => x.measureText(l).width > maxW)) && fs > 28) { fs = Math.round(fs * 0.9); x.font = `900 ${fs}px ${FONT}`; lines = wrap(x, T.toUpperCase(), maxW); }
    const lh = fs * 1.04;
    const block = lines.length * lh + (subtitle ? fs * 0.6 : 0);
    tx = landscape ? W * 0.05 : W / 2;
    ty = landscape ? (H - block) / 2 + fs * 0.85 : H * 0.06 + fs * 0.85;
    titleBottom = landscape ? 0 : ty + (lines.length - 1) * lh + (subtitle ? fs * 0.7 : 0) + fs * 0.35;
  }
  // ---- subject: crop to its bounding box, place it big
  const box = maskBox(mask) || { x: 0, y: 0, w: sw, h: sh, touchesBottom: true };
  const cut = cutout(src, mask);
  const areaX = landscape ? (T ? W * 0.46 : W * 0.04) : W * 0.04;
  const areaY = landscape ? H * 0.04 : Math.max(H * 0.04, titleBottom);
  const areaW = landscape ? (T ? W * 0.52 : W * 0.92) : W * 0.92;
  const areaH = H - areaY - (box.touchesBottom ? 0 : H * 0.05);
  const s = Math.min(areaW / box.w, areaH / box.h);
  const dw = box.w * s, dh = box.h * s;
  const dx = areaX + (areaW - dw) / 2;
  const dy = box.touchesBottom ? H - dh : areaY + (areaH - dh) / 2;
  const drawSub = () => x.drawImage(cut, box.x, box.y, box.w, box.h, dx, dy, dw, dh);
  x.save(); x.shadowColor = 'rgba(255,255,255,0.55)'; x.shadowBlur = Math.min(W, H) * 0.03; drawSub(); x.restore();
  x.save(); x.shadowColor = 'rgba(0,0,0,0.6)'; x.shadowBlur = Math.min(W, H) * 0.05; drawSub(); x.restore();
  // ---- headline on top
  if (T) {
    const lh = fs * 1.04;
    x.font = `900 ${fs}px ${FONT}`;
    x.textAlign = landscape ? 'left' : 'center'; x.textBaseline = 'alphabetic'; x.lineJoin = 'round';
    lines.forEach((ln, i) => {
      x.lineWidth = fs * 0.16; x.strokeStyle = '#000'; x.strokeText(ln, tx, ty + i * lh);
      x.fillStyle = i === lines.length - 1 ? accent : '#ffffff'; x.fillText(ln, tx, ty + i * lh);
    });
    if (subtitle) {
      const sfs = Math.max(22, Math.round(fs * 0.4));
      x.font = `700 ${sfs}px ${FONT}`; x.lineWidth = sfs * 0.18; x.strokeStyle = 'rgba(0,0,0,0.8)';
      const sy = ty + (lines.length - 1) * lh + fs * 0.75;
      x.strokeText(subtitle, tx, sy); x.fillStyle = '#ffffff'; x.fillText(subtitle, tx, sy);
    }
  }
  return c;
}
