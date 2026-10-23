// Inera Edit Flow — motion graphics drawn per frame on a transparent 2D canvas (composited over video).
import { clamp } from './utils.js';
import { svgFor } from './understand.js';

const FILTER_OK = typeof CanvasRenderingContext2D !== 'undefined' && 'filter' in CanvasRenderingContext2D.prototype;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const ACCENT = '#facc15';      // highlight yellow (high contrast on most footage)
const ACCENT2 = ['#8b5cf6', '#3b82f6'];
const easeOut = (x) => 1 - Math.pow(1 - clamp(x, 0, 1), 3);
const easeBack = (x) => { x = clamp(x, 0, 1); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const env = (t, t0, t1, a = 0.18, b = 0.18) => Math.min(clamp((t - t0) / a, 0, 1), clamp((t1 - t) / b, 0, 1));

function roundRect(x, X, Y, W, H, r) {
  r = Math.min(r, W / 2, H / 2);
  x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
}

const emojiImgs = new Map();
export async function preloadEmoji(emoji) {
  if (!emoji || emojiImgs.has(emoji)) return;
  const svg = svgFor(emoji); if (!svg) return;
  const im = new Image();
  im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg width="256" height="256" '));
  try { await im.decode(); emojiImgs.set(emoji, im); } catch (e) { /* skip */ }
}

// ---------------- captions ----------------
export function drawCaptions(x, W, H, cap, t) {
  if (!cap || cap.style === 'off') return;
  const g = cap.groups.find((gr) => t >= gr.t0 && t < gr.t1);
  if (!g) return;
  const base = Math.min(W, H);
  if (cap.style === 'creator') {
    const fs = Math.round(base * 0.072 * (cap.scale || 1));
    x.font = `900 ${fs}px ${FONT}`;
    x.textAlign = 'left'; x.textBaseline = 'middle';
    const toks = g.words.map((w) => (cap.uppercase ? w.w.toUpperCase() : w.w).replace(/[,;:]$/, ''));
    const space = fs * 0.28;
    const widths = toks.map((s) => x.measureText(s).width);
    // wrap to max width
    const maxW = W * 0.86;
    const lines = [[]]; let lw = 0;
    toks.forEach((s, i) => { if (lw + widths[i] > maxW && lines[lines.length - 1].length) { lines.push([]); lw = 0; } lines[lines.length - 1].push(i); lw += widths[i] + space; });
    const lh = fs * 1.12;
    const cy = cap.position === 'top' ? H * 0.2 : cap.position === 'middle' ? H * 0.5 : cap.position === 'bottom' ? H * 0.84 : H * 0.74;
    const pop = easeBack((t - g.t0) / 0.14);
    lines.forEach((ln, li) => {
      const tw = ln.reduce((a, i) => a + widths[i], 0) + space * (ln.length - 1);
      let cx = W / 2 - tw / 2;
      const y = cy + (li - (lines.length - 1) / 2) * lh;
      for (const i of ln) {
        const w = g.words[i];
        const active = t >= w.s && t < Math.max(w.e, w.s + 0.12);
        const color = active ? (cap.accent || ACCENT) : '#ffffff';
        const sc = (active ? 1.1 : 1) * (0.85 + 0.15 * pop);
        x.save();
        x.translate(cx + widths[i] / 2, y);
        x.scale(sc, sc);
        x.lineJoin = 'round';
        x.lineWidth = fs * 0.16; x.strokeStyle = 'rgba(0,0,0,0.85)';
        x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = fs * 0.25; x.shadowOffsetY = fs * 0.06;
        x.strokeText(toks[i], -widths[i] / 2, 0);
        x.shadowColor = 'transparent';
        if ((w.emph || w.kw) && !active) {
          const gr = x.createLinearGradient(-widths[i] / 2, 0, widths[i] / 2, 0); gr.addColorStop(0, '#c4b5fd'); gr.addColorStop(1, '#7dd3fc');
          x.fillStyle = gr;
        } else x.fillStyle = color;
        x.fillText(toks[i], -widths[i] / 2, 0);
        x.restore();
        cx += widths[i] + space;
      }
    });
  } else {
    const fs = Math.round(base * 0.046 * (cap.scale || 1));
    x.font = `600 ${fs}px ${FONT}`;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    const text = g.words.map((w) => w.w).join(' ');
    // wrap into max 2 lines
    const words = text.split(' '); const lines = []; let cur = '';
    for (const w of words) { const tst = cur ? cur + ' ' + w : w; if (x.measureText(tst).width > W * 0.8 && cur) { lines.push(cur); cur = w; } else cur = tst; }
    if (cur) lines.push(cur);
    const lh = fs * 1.3;
    const y0 = (cap.position === 'top' ? H * 0.12 + (lines.length - 1) * lh : cap.position === 'middle' ? H * 0.5 : H * 0.88) - (lines.length - 1) * lh;
    const a = env(t, g.t0, g.t1, 0.08, 0.08);
    x.globalAlpha = a;
    lines.forEach((ln, i) => {
      const tw = x.measureText(ln).width;
      x.fillStyle = 'rgba(8,8,14,0.62)';
      roundRect(x, W / 2 - tw / 2 - fs * 0.45, y0 + i * lh - fs * 0.68, tw + fs * 0.9, fs * 1.36, fs * 0.3); x.fill();
      x.fillStyle = '#ffffff'; x.fillText(ln, W / 2, y0 + i * lh);
    });
    x.globalAlpha = 1;
  }
}

// ---------------- B-roll ----------------
function drawCover(x, img, W, H, zoom, fx = 0.5, fy = 0.5, rx = 0, ry = 0, rw = W, rh = H) {
  const iw = img.width || img.videoWidth || img.displayWidth, ih = img.height || img.videoHeight || img.displayHeight;
  if (!iw || !ih) return;
  const s = Math.max(rw / iw, rh / ih) * zoom;
  const dw = iw * s, dh = ih * s;
  const dx = rx + (rw - dw) * fx, dy = ry + (rh - dh) * fy;
  x.drawImage(img, dx, dy, dw, dh);
}
export function drawBroll(x, W, H, b, t, faceX = 0.5) {
  if (!b.visual || !(b.visual.bitmap || b.frame)) return;
  const img = b.frame || b.visual.bitmap;
  const p = clamp((t - b.t0) / (b.t1 - b.t0), 0, 1);
  const a = env(t, b.t0, b.t1, 0.2, 0.2);
  const zoom = b.motion === 'push' ? 1.04 + 0.1 * p : 1.14 - 0.1 * p;
  if (b.style === 'fit') {
    // low-resolution image: blurred, darkened cover background + sharp centred image (no ugly upscaling)
    x.save(); x.globalAlpha = a;
    if (FILTER_OK) x.filter = 'blur(28px) brightness(0.55)';
    drawCover(x, img, W, H, 1.15);
    if (FILTER_OK) x.filter = 'none'; else { x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillRect(0, 0, W, H); }
    const iw = img.width || img.displayWidth, ih = img.height || img.displayHeight;
    const s = Math.min((W * 0.86) / iw, (H * 0.5) / ih) * (0.96 + 0.06 * p);
    const dw = iw * s, dh = ih * s, dx = (W - dw) / 2, dy = H * 0.4 - dh / 2;
    x.shadowColor = 'rgba(0,0,0,0.55)'; x.shadowBlur = Math.min(W, H) * 0.05;
    roundRect(x, dx, dy, dw, dh, Math.min(W, H) * 0.03); x.save(); x.clip(); x.shadowColor = 'transparent';
    x.drawImage(img, dx, dy, dw, dh); x.restore();
    x.restore();
    return;
  }
  if (b.style === 'full') {
    x.save(); x.globalAlpha = a;
    drawCover(x, img, W, H, zoom, 0.5 + (b.motion === 'push' ? -0.04 : 0.04) * (p - 0.5), 0.5);
    // subtle bottom gradient so captions stay readable
    const gr = x.createLinearGradient(0, H * 0.55, 0, H); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.45)');
    x.fillStyle = gr; x.fillRect(0, H * 0.55, W, H * 0.45);
    x.restore();
    return;
  }
  // card: rounded, floating, placed away from the face
  const portrait = H > W;
  const cw = portrait ? W * 0.78 : W * 0.4;
  const ch = portrait ? H * 0.32 : H * 0.56;
  const cx = portrait ? (W - cw) / 2 : (faceX < 0.5 ? W * 0.55 : W * 0.05);
  const cy = portrait ? H * 0.1 : (H - ch) / 2 - H * 0.04;
  const sIn = easeBack((t - b.t0) / 0.32), sOut = clamp((b.t1 - t) / 0.2, 0, 1);
  const sc = 0.82 + 0.18 * sIn;
  const float = Math.sin(t * 2.2) * H * 0.004;
  x.save();
  x.globalAlpha = sOut;
  x.translate(cx + cw / 2, cy + ch / 2 + float);
  x.scale(sc, sc);
  x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = Math.min(W, H) * 0.04; x.shadowOffsetY = Math.min(W, H) * 0.015;
  roundRect(x, -cw / 2, -ch / 2, cw, ch, Math.min(W, H) * 0.03);
  x.fillStyle = '#ffffff'; x.fill();
  x.shadowColor = 'transparent';
  const pad = Math.min(W, H) * 0.008;
  roundRect(x, -cw / 2 + pad, -ch / 2 + pad, cw - 2 * pad, ch - 2 * pad, Math.min(W, H) * 0.025);
  x.save(); x.clip();
  drawCover(x, img, cw - 2 * pad, ch - 2 * pad, zoom, 0.5, 0.5, -cw / 2 + pad, -ch / 2 + pad, cw - 2 * pad, ch - 2 * pad);
  x.restore();
  x.restore();
}

// ---------------- graphics ----------------
export function drawOverlay(x, W, H, o, t) {
  const base = Math.min(W, H);
  const a = env(t, o.t0, o.t1, 0.2, 0.25);
  if (a <= 0) return;
  x.save();
  if (o.type === 'number') {
    const s = easeBack((t - o.t0) / 0.3);
    const fs = base * 0.11;
    x.font = `900 ${fs}px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    const y = H * (o.y != null ? o.y : H > W ? 0.12 : 0.16);
    x.globalAlpha = a; x.translate(W / 2, y); x.scale(s, s);
    const tw = x.measureText(o.text).width;
    x.shadowColor = 'rgba(0,0,0,0.55)'; x.shadowBlur = fs * 0.3;
    x.lineWidth = fs * 0.12; x.strokeStyle = 'rgba(0,0,0,0.8)'; x.lineJoin = 'round';
    x.strokeText(o.text, 0, 0);
    const gr = x.createLinearGradient(-tw / 2, 0, tw / 2, 0); gr.addColorStop(0, '#fde047'); gr.addColorStop(1, '#fb923c');
    x.fillStyle = gr; x.fillText(o.text, 0, 0);
    x.shadowColor = 'transparent';
    x.fillStyle = gr; x.fillRect(-tw / 2 * easeOut((t - o.t0) / 0.5), fs * 0.62, tw * easeOut((t - o.t0) / 0.5), fs * 0.08);
  } else if (o.type === 'cta') {
    const s = easeBack((t - o.t0) / 0.35);
    const fs = base * 0.05;
    x.font = `800 ${fs}px ${FONT}`; x.textAlign = 'left'; x.textBaseline = 'middle';
    const label = o.text.toUpperCase();
    const tw = x.measureText(label).width, ic = fs * 1.4;
    const bw = tw + ic + fs * 1.8, bh = fs * 2.1;
    const y = H * (o.y != null ? o.y : H > W ? 0.6 : 0.62);
    x.globalAlpha = a; x.translate(W / 2, y + (1 - s) * bh); x.scale(0.9 + 0.1 * s, 0.9 + 0.1 * s);
    x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = fs * 0.6; x.shadowOffsetY = fs * 0.15;
    roundRect(x, -bw / 2, -bh / 2, bw, bh, bh / 2); x.fillStyle = '#ef4444'; x.fill();
    x.shadowColor = 'transparent';
    const bell = emojiImgs.get('🔔');
    const wig = Math.sin((t - o.t0) * 18) * 0.25 * Math.max(0, 1 - (t - o.t0) / 1.2);
    if (bell) { x.save(); x.translate(-bw / 2 + fs * 0.6 + ic / 2, 0); x.rotate(wig); x.drawImage(bell, -ic / 2, -ic / 2, ic, ic); x.restore(); }
    x.fillStyle = '#fff'; x.fillText(label, -bw / 2 + fs * 0.9 + ic, 0);
  } else if (o.type === 'chip') {
    const fs = base * 0.034;
    x.font = `800 ${fs}px ${FONT}`; x.textAlign = 'left'; x.textBaseline = 'middle';
    const em = o.emoji && emojiImgs.get(o.emoji);
    const tw = x.measureText(o.text).width, ic = em ? fs * 1.35 : 0;
    const bw = tw + ic + fs * (em ? 1.9 : 1.4), bh = fs * 1.9;
    const s = easeOut((t - o.t0) / 0.35);
    x.globalAlpha = a; x.translate(W * 0.05 - (1 - s) * bw * 0.3, H * 0.07);
    roundRect(x, 0, 0, bw, bh, bh / 2);
    const gr = x.createLinearGradient(0, 0, bw, 0); gr.addColorStop(0, ACCENT2[0]); gr.addColorStop(1, ACCENT2[1]);
    x.fillStyle = gr; x.fill();
    if (em) x.drawImage(em, fs * 0.55, (bh - ic) / 2, ic, ic);
    x.fillStyle = '#fff'; x.fillText(o.text, fs * 0.7 + ic + (em ? fs * 0.25 : 0), bh / 2);
  } else if (o.type === 'title' || o.type === 'chapter') {
    const fs = base * (o.type === 'title' ? 0.085 : 0.065);
    x.font = `900 ${fs}px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    const words = String(o.text).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) { const tst = cur ? cur + ' ' + w : w; if (x.measureText(tst).width > W * 0.82 && cur) { lines.push(cur); cur = w; } else cur = tst; }
    if (cur) lines.push(cur);
    const lh = fs * 1.15, blockH = lines.length * lh;
    const y0 = (o.y != null ? H * o.y : o.type === 'chapter' || o.top ? H * 0.17 : H * 0.42) - blockH / 2 + (1 - easeOut((t - o.t0) / 0.4)) * fs * 0.5;
    let widest = 0; for (const l of lines) widest = Math.max(widest, x.measureText(l).width);
    x.globalAlpha = a;
    roundRect(x, W / 2 - widest / 2 - fs * 0.6, y0 - fs * 0.45, widest + fs * 1.2, blockH + fs * 0.6, fs * 0.35);
    x.fillStyle = 'rgba(10,10,18,0.6)'; x.fill();
    const gr = x.createLinearGradient(W / 2 - widest / 2, 0, W / 2 + widest / 2, 0); gr.addColorStop(0, ACCENT2[0]); gr.addColorStop(1, ACCENT2[1]);
    x.fillStyle = gr; x.fillRect(W / 2 - widest / 2, y0 + blockH, widest * easeOut((t - o.t0) / 0.6), Math.max(3, fs * 0.07));
    x.fillStyle = '#fff';
    lines.forEach((l, i) => x.fillText(l, W / 2, y0 + i * lh + fs * 0.42));
    if (o.type === 'chapter') { x.font = `700 ${fs * 0.38}px ${FONT}`; x.fillStyle = 'rgba(220,220,255,0.9)'; x.fillText('CHAPTER', W / 2, y0 - fs * 0.75); }
  } else if (o.type === 'lower') {
    const fs = base * 0.045;
    const s = easeOut((t - o.t0) / 0.4);
    x.globalAlpha = a;
    x.font = `800 ${fs}px ${FONT}`; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    const tw = x.measureText(o.text).width;
    x.font = `600 ${fs * 0.6}px ${FONT}`; const sw = o.sub ? x.measureText(o.sub).width : 0;
    const bw = Math.max(tw, sw) + fs * 1.4, bh = fs * (o.sub ? 2.3 : 1.6);
    const X = W * 0.05 - (1 - s) * bw, Y = H * 0.66;
    x.fillStyle = 'rgba(10,10,18,0.72)'; roundRect(x, X, Y, bw, bh, fs * 0.25); x.fill();
    const gr = x.createLinearGradient(X, 0, X, Y + bh); gr.addColorStop(0, ACCENT2[0]); gr.addColorStop(1, ACCENT2[1]);
    x.fillStyle = gr; x.fillRect(X, Y, fs * 0.18, bh);
    x.fillStyle = '#fff'; x.font = `800 ${fs}px ${FONT}`; x.fillText(o.text, X + fs * 0.6, Y + fs * 1.2);
    if (o.sub) { x.fillStyle = 'rgba(220,220,255,0.85)'; x.font = `600 ${fs * 0.6}px ${FONT}`; x.fillText(o.sub, X + fs * 0.6, Y + fs * 1.95); }
  }
  x.restore();
}
