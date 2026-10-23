// Inera Edit Flow — application controller (UI, routing, jobs, projects)
import * as U from './utils.js';
import * as S from './store.js';
import * as IE from './image-engine.js';
import { analyzeForEdit, planEdit, renderEdit, parseVideoPrompt, VIDEO_STYLES, VIDEO_TYPES_LABEL, outputSizeFor } from './video-editor.js';
import { prepareSlides, autoOrder, planSlideshow, renderSlideshow, slideshowOutputSize, SLIDESHOW_METHOD } from './slideshow.js';
import { analyzeFrames, selectFrames, captureFrames, FRAME_MODES } from './frame-extractor.js';
import { MOODS } from './music.js';
import { openSource } from './media-source.js';
import { analyzeMedia } from './analysis.js';
import { planV2 } from './director.js';
import { renderV2 } from './render-engine.js';
import { deleteRenderFile } from './media-encode.js';
import { libraryFromFiles, creditsText, prefetchVisual } from './visuals.js';
import { titleCase, understand } from './understand.js';
import { interpretImagePrompt, promptSummary } from './prompt.js';
import { understandVideoPrompt, understandImagePrompt, preloadNlu } from './prompt-ai.js';
import { VOICES, speakScript, preloadTts } from './tts.js';
import { subjectMask, replaceBackground, makeDesign, BG_MODES, LAYOUTS } from './design.js';
import { transcribe, preloadAsr } from './asr.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = U.escapeHtml;
let settings = S.loadSettings();

// ======================= Toasts =======================
function toast(msg, type = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });

// Live prompt feedback: shows exactly what will be applied and what was not understood, before running.
function bindPromptFb(ta, fb, quick, deep) {
  let timer = null, ver = 0;
  const render = (r, pending) => {
    fb.innerHTML = (r.understood.length ? r.understood.map((n) => `<span class="chip-ok">✓ ${esc(n)}</span>`).join('') : (pending ? '' : '<span class="no">No instruction recognised yet — the edit stays automatic.</span>'))
      + (r.cannot && r.cannot.length ? `<div class="no">Not possible here: ${r.cannot.map((n) => `<span class="chip-no">✗ ${esc(n)}</span>`).join('')}</div>` : '')
      + (!pending && r.notUnderstood.length ? `<div class="no">Not understood (ignored): ${r.notUnderstood.map((n) => `<span class="chip-no">${esc(n.slice(0, 60))}</span>`).join('')}</div>` : '')
      + (pending ? '<div class="muted">Understanding your words…</div>' : '')
      + (r.semanticError ? '<div class="muted">Language model not available right now — exact phrases only.</div>' : '');
  };
  const show = async () => {
    const v = ta.value.trim(); const my = ++ver;
    if (!v) { fb.innerHTML = ''; return; }
    render(quick(v), true);
    const r = await deep(v).catch(() => quick(v));
    if (my === ver) render(r, false);
  };
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(show, 400); });
  ta.addEventListener('focus', () => preloadNlu(), { once: true });
  show();
}
const promptToast = (r) => toast(promptSummary(r), r.notUnderstood.length || (r.cannot && r.cannot.length) ? 'info' : 'ok', 9000);

// ======================= Router =======================
const TITLES = { home: 'Home', image: 'Image Editor', video: 'Video Editor', i2v: 'Image to Video', v2i: 'Video to Images', avatar: 'Avatar Studio', projects: 'Recent Projects', downloads: 'Downloads', settings: 'Settings', help: 'Help' };
function route() {
  let v = (location.hash || '').replace(/^#\/?/, '') || 'home';
  if (!TITLES[v]) v = 'home';
  $$('.view').forEach((s) => s.classList.toggle('active', s.dataset.view === v));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === v));
  $('#pageTitle').textContent = TITLES[v];
  document.title = `${TITLES[v]} · Inera Edit Flow`;
  closeMenu();
  window.scrollTo({ top: 0 });
  if (v === 'home') renderRecent();
  // warm up the speech engines as soon as the video page opens (one-time download, then from cache)
  if (v === 'video') setTimeout(() => { try { if (CAN_ENCODE && $('#vidAsr').value !== 'off') preloadAsr(resolveAsr(), $('#vidLang').value || undefined); } catch (e) { /* not ready */ } }, 0);
  if (v === 'projects') renderProjects();
  if (v === 'downloads') renderDownloads();
  if (v === 'settings') renderSettings();
  if (v === 'help') renderHelp();
}
window.addEventListener('hashchange', route);
const go = (v) => { if (location.hash !== '#/' + v) location.hash = '#/' + v; else route(); };
function closeMenu() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('show'); }
$('#menuBtn').addEventListener('click', () => { $('#sidebar').classList.add('open'); $('#scrim').classList.add('show'); });
$('#scrim').addEventListener('click', closeMenu);

// ======================= Drop zones =======================
function bindDrop(zone, input, onFiles) {
  const open = () => input && input.click();
  zone.addEventListener('click', (e) => { if (e.target.closest('button, a, select, input:not([type=file])')) return; open(); });
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); const f = [...(e.dataTransfer?.files || [])]; if (f.length) onFiles(f); });
  if (input) input.addEventListener('change', () => { const f = [...input.files]; input.value = ''; if (f.length) onFiles(f); });
}
// prevent the browser from opening files dropped outside a drop zone
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ======================= Jobs, locks, audio =======================
const jobs = new Map();
function setJob(mode, label) {
  if (label) jobs.set(mode, label); else jobs.delete(mode);
  const dot = $(`[data-dot="${mode}"]`);
  if (dot) { dot.classList.toggle('busy', !!label); if (label) dot.classList.remove('ready'); }
  const pill = $('#jobPill');
  if (jobs.size) { pill.hidden = false; $('#jobPillText').textContent = jobs.size === 1 ? [...jobs.values()][0] : `${jobs.size} jobs running`; pill.onclick = () => go([...jobs.keys()][0]); }
  else pill.hidden = true;
}
function setReady(mode, on) { const dot = $(`[data-dot="${mode}"]`); if (dot) dot.classList.toggle('ready', !!on); }
window.addEventListener('beforeunload', (e) => { if (jobs.size) { e.preventDefault(); e.returnValue = ''; } });

let renderBusy = Promise.resolve();
async function withRenderLock(fn, onWait) {
  const prev = renderBusy;
  let release;
  renderBusy = new Promise((r) => (release = r));
  let waited = false;
  const timer = setTimeout(() => { waited = true; onWait && onWait(); }, 50);
  try { await prev; } catch (e) {}
  clearTimeout(timer);
  void waited;
  try { return await fn(); } finally { release(); }
}

let audioCtx = null;
function getAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// ======================= Stage tracker =======================
const STAGE_LABELS = {
  read: 'Reading file', analyze: 'Analyzing media', audio: 'Analyzing audio & speech', plan: 'Planning the edit', enhance: 'Enhancing',
  music: 'Composing original music', mix: 'Mixing audio', render: 'Rendering', select: 'Selecting best frames', extract: 'Extracting images',
  verify: 'Verifying output', done: 'Ready to download', wait: 'Waiting for another render to finish',
  download: 'Downloading model (one time)', transcribe: 'Transcribing speech', visuals: 'Finding topic visuals',
  voice: 'Generating voice', stage: 'Loading the presenter', perform: 'Recording the performance',
};
function etaText(sec) { if (!isFinite(sec) || sec < 1) return ''; if (sec < 60) return `~${Math.ceil(sec / 5) * 5}s left`; if (sec < 3600) return `~${Math.round(sec / 60)} min left`; return `~${(sec / 3600).toFixed(1)} h left`; }
class Stages {
  constructor(box, ids, labels = {}) {
    this.box = box; this.ids = [...ids]; this.labels = { ...labels }; this.cur = -1; this.pct = null; this.t0 = performance.now(); this.lastDraw = 0;
    box.hidden = false;
    box.innerHTML = `<ol class="stages"></ol><div class="progress"><span></span></div><div class="stage-detail"></div>`;
    this.render();
    // heartbeat: the active step shows its running time every second, so a long step never looks frozen
    if (box._stages) clearInterval(box._stages.beat);
    box._stages = this;
    this.beat = setInterval(() => { if (box._stages !== this || !document.body.contains(box)) return clearInterval(this.beat); this.render(); }, 1000);
  }
  label(id) { return this.labels[id] || STAGE_LABELS[id] || id; }
  render() {
    const ol = this.box.querySelector('.stages');
    ol.innerHTML = this.ids.map((id, i) => {
      const cls = this.err && i === this.cur ? 'error' : i < this.cur || (this.finished && i <= this.cur) ? 'done' : i === this.cur ? 'active' : '';
      const icon = cls === 'done' ? '<svg class="ic"><use href="#i-check"/></svg>' : cls === 'error' ? '<svg class="ic"><use href="#i-x"/></svg>' : '';
      let pct = '';
      if (i === this.cur && cls === 'active') {
        const el = (performance.now() - this.t0) / 1000;
        const eta = this.pct != null && this.pct > 0.03 && el > 4 ? etaText(el * (1 - this.pct) / this.pct) : '';
        const parts = [];
        if (this.pct != null) parts.push(`${Math.round(this.pct * 100)}%`);
        if (eta) parts.push(eta);
        if (el >= 2) parts.push(U.fmtTime(el));
        if (parts.length) pct = `<span class="pct">${parts.join(' · ')}</span>`;
      }
      return `<li class="${cls}"><span class="dot">${icon}</span><span>${esc(this.label(id))}</span>${pct}</li>`;
    }).join('');
    const bar = this.box.querySelector('.progress span');
    const total = this.ids.length - 1;
    const base = Math.max(0, this.cur) / Math.max(1, total);
    const frac = this.pct != null ? this.pct / Math.max(1, total) : 0;
    bar.style.width = (this.finished ? 100 : Math.min(100, (base + frac) * 100)) + '%';
  }
  set(id, detail) {
    if (!this.ids.includes(id)) this.ids.splice(Math.max(0, this.cur + 1), 0, id);
    if (this.ids.indexOf(id) !== this.cur) {
      const now = performance.now();
      if (this.cur >= 0) { const prev = this.ids[this.cur]; this.spent = this.spent || {}; this.spent[prev] = (this.spent[prev] || 0) + (now - this.t0); }
      this.t0 = now;
    }
    this.cur = this.ids.indexOf(id); this.pct = null; this.err = false;
    if (detail !== undefined) this.detail(detail);
    this.render();
  }
  // show a one-time step (e.g. model download) just before another step
  enter(id, beforeId) {
    if (!this.ids.includes(id)) { const k = this.ids.indexOf(beforeId); this.ids.splice(k >= 0 ? k : this.cur + 1, 0, id); }
    if (this.ids[this.cur] !== id) this.set(id);
  }
  skip(id) { const i = this.ids.indexOf(id); if (i > this.cur) { this.ids.splice(i, 1); this.render(); } }
  progress(p) {
    const v = p == null ? null : U.clamp(p, 0, 1);
    if (v !== null && this.pct !== null && Math.abs(v - this.pct) < 0.005) return;
    this.pct = v;
    const now = performance.now();
    if (now - this.lastDraw < 250 && v !== 1) return; // keep the UI light during long jobs
    this.lastDraw = now; this.render();
  }
  detail(t) { this.box.querySelector('.stage-detail').textContent = t || ''; }
  // "Watching 12 s · Rendering 40 s · …" — where the time went on this computer
  timeReport() {
    const now = performance.now(); const sp = { ...(this.spent || {}) };
    if (this.cur >= 0 && this.ids[this.cur] !== 'done') sp[this.ids[this.cur]] = (sp[this.ids[this.cur]] || 0) + (now - this.t0);
    const total = Object.values(sp).reduce((a, b) => a + b, 0);
    return Object.entries(sp).filter(([, v]) => v >= 500).map(([k, v]) => `${this.label(k)} ${U.fmtTime(v / 1000)}`).join(' · ') + ` — total ${U.fmtTime(total / 1000)}`;
  }
  done(detail) { clearInterval(this.beat); this.cur = this.ids.indexOf('done'); this.finished = true; this.pct = null; this.render(); this.detail(detail || ''); }
  error(msg) {
    clearInterval(this.beat);
    this.err = true; this.render();
    const d = this.box.querySelector('.stage-detail');
    d.innerHTML = `<div class="stage-error">${esc(msg)}</div>`;
  }
}

// ======================= Projects persistence =======================
async function createProject(mode, title, inputSummary) {
  const p = { id: U.uid('prj'), mode, title, status: 'processing', createdAt: Date.now(), inputSummary, outputs: [] };
  await S.saveProject(p).catch(() => {});
  if (!/firefox/i.test(navigator.userAgent)) S.requestPersistence();
  return p;
}
async function finishProject(p, outputs, thumbBlob, report) {
  try {
    p.outputs = [];
    for (const o of outputs) {
      const rec = { name: o.name, kind: o.kind, mime: (o.blob && o.blob.type) || o.mime || '', size: o.blob ? o.blob.size : o.size || 0, width: o.width, height: o.height, duration: o.duration, format: o.format };
      if (o.opfs) rec.opfs = o.opfs; // large render already on disk (Origin Private File System)
      else { rec.blobKey = U.uid('blob'); await S.putBlob(rec.blobKey, o.blob); }
      p.outputs.push(rec);
    }
    if (thumbBlob) { p.thumbKey = U.uid('thumb'); await S.putBlob(p.thumbKey, thumbBlob); }
    p.status = 'done'; p.report = report || null; p.error = null;
    await S.saveProject(p);
    await S.enforceHistoryLimit(settings.historyLimit);
  } catch (e) {
    toast('Your result is ready, but it could not be saved to Recent Projects (browser storage may be full). Download it now.', 'error', 8000);
  }
}
async function failProject(p, err) {
  if (!p) return;
  p.status = err instanceof U.AbortError ? 'cancelled' : 'failed';
  p.error = err instanceof U.AbortError ? 'Cancelled by you.' : String(err.message || err);
  await S.saveProject(p).catch(() => {});
}
const MODE_LABEL = { image: 'Image Editor', video: 'Video Editor', i2v: 'Image to Video', v2i: 'Video to Images', avatar: 'Avatar Studio', design: 'Image Editor · Design' };
const STATUS_LABEL = { done: 'Completed', processing: 'Processing', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', queued: 'Queued' };
function fmtDate(t) { try { return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (e) { return ''; } }
const thumbUrls = new Map();
async function thumbUrl(p) {
  if (!p.thumbKey) return null;
  if (thumbUrls.has(p.thumbKey)) return thumbUrls.get(p.thumbKey);
  const b = await S.getBlob(p.thumbKey).catch(() => null);
  if (!b) return null;
  const u = URL.createObjectURL(b); thumbUrls.set(p.thumbKey, u); return u;
}
function errorMessage(e) {
  if (e instanceof U.AbortError) return 'Cancelled.';
  const m = String(e && e.message || e || 'Unknown error');
  if (/QuotaExceeded|quota/i.test(m)) return 'Your browser ran out of storage space. Delete old projects in Settings and try again.';
  if (/out of memory|allocation|Array buffer allocation/i.test(m)) return 'This device ran out of memory for this file. Try a shorter/smaller file or close other tabs.';
  return m;
}

// ======================= HOME =======================
bindDrop($('#homeDrop'), $('#homeInput'), async (files) => {
  const types = await Promise.all(files.map((f) => U.sniffType(f)));
  const imgs = files.filter((_, i) => U.IMAGE_TYPES.includes(types[i]));
  const vids = files.filter((_, i) => U.VIDEO_TYPES.includes(types[i]));
  if (imgs.length && vids.length) return toast('Please upload either photos or one video at a time.', 'error');
  if (!imgs.length && !vids.length) return toast('Unsupported file. Use JPG, PNG, WebP photos or MP4, MOV, WebM videos.', 'error');
  if (imgs.length) chooser(`${imgs.length} photo${imgs.length > 1 ? 's' : ''} selected`, [
    { icon: 'i-image', cls: 'm1', title: 'Enhance my photos', sub: 'Raw Image → Edited Image', run: () => { go('image'); imgAdd(imgs); } },
    { icon: 'i-i2v', cls: 'm3', title: 'Turn them into a video', sub: 'Image → Video with music', run: () => { go('i2v'); i2vAdd(imgs); } },
  ]);
  else chooser(vids.length > 1 ? 'Only the first video will be used' : '1 video selected', [
    { icon: 'i-video', cls: 'm2', title: 'Auto edit this video', sub: 'Raw Video → Edited Video', run: () => { go('video'); vidSet(vids[0]); } },
    { icon: 'i-v2i', cls: 'm4', title: 'Extract the best photos', sub: 'Video → Images', run: () => { go('v2i'); v2iSet(vids[0]); } },
  ]);
});
function chooser(sub, opts) {
  const m = $('#chooser');
  $('#chooserSub').textContent = sub;
  const box = $('#chooserOpts');
  box.innerHTML = '';
  for (const o of opts) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="mode-icon sm ${o.cls}"><svg class="ic"><use href="#${o.icon}"/></svg></span><span><b>${esc(o.title)}</b><small>${esc(o.sub)}</small></span>`;
    b.addEventListener('click', () => { m.hidden = true; o.run(); });
    box.appendChild(b);
  }
  m.hidden = false;
}
$$('.modal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(m); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal').forEach((m) => { if (!m.hidden) closeModal(m); }); });
function closeModal(m) {
  m.hidden = true;
  if (m.id === 'viewer') { $$('video', m).forEach((v) => v.pause()); viewerUrls.forEach((u) => URL.revokeObjectURL(u)); viewerUrls = []; $('#viewerBody').innerHTML = ''; }
}
$$('.mode-card').forEach((card) => {
  const mode = card.dataset.mode;
  const zone = card.querySelector('.mini-drop');
  if (!zone) { card.querySelector('[data-open]').addEventListener('click', () => go(mode)); return; }
  const input = document.createElement('input');
  input.type = 'file'; input.hidden = true;
  input.accept = mode === 'image' || mode === 'i2v' ? 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp' : 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm';
  input.multiple = mode === 'image' || mode === 'i2v';
  card.appendChild(input);
  const handler = { image: (f) => { go('image'); imgAdd(f); }, i2v: (f) => { go('i2v'); i2vAdd(f); }, video: (f) => { go('video'); vidSet(f[0]); }, v2i: (f) => { go('v2i'); v2iSet(f[0]); } }[mode];
  bindDrop(zone, input, handler);
  card.querySelector('[data-open]').addEventListener('click', () => go(mode));
});

async function renderRecent() {
  const box = $('#recentStrip');
  const all = (await S.listProjects().catch(() => [])).slice(0, 8);
  if (!all.length) { box.innerHTML = '<div class="empty-mini">No projects yet. Upload something above — finished results will appear here.</div>'; return; }
  box.innerHTML = '';
  for (const p of all) {
    const b = document.createElement('button');
    b.className = 'recent-card';
    const tu = await thumbUrl(p);
    b.innerHTML = `<div class="thumb">${tu ? '' : `<svg class="ic big"><use href="#i-${p.mode === 'image' ? 'image' : p.mode === 'video' ? 'video' : p.mode}"/></svg>`}</div><div class="meta"><b>${esc(p.title)}</b><span>${esc(MODE_LABEL[p.mode] || '')} · </span><span class="status ${p.status}">${esc(STATUS_LABEL[p.status] || p.status)}</span></div>`;
    if (tu) b.querySelector('.thumb').style.backgroundImage = `url("${tu}")`;
    b.addEventListener('click', () => (p.status === 'done' ? openViewer(p.id) : go(p.mode)));
    box.appendChild(b);
  }
}

// ======================= MODE 1: IMAGE =======================
const img = { items: [], active: null, busy: false };
const styleSel = $('#imgStyle');
for (const [k, v] of Object.entries(IE.STYLES)) styleSel.insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v)}</option>`);
$('#imgIntensity').addEventListener('input', (e) => { $('#imgIntensityOut').textContent = e.target.value + '%'; });
bindDrop($('#imgDrop'), $('#imgInput'), (f) => imgAdd(f));
$('#imgFormat').value = settings.imageFormat;

async function imgAdd(files) {
  if (img.busy) return toast('Please wait until the current batch finishes.', 'error');
  for (const f of files) {
    if (img.items.length >= U.LIMITS.imageMaxCount) { toast(`Batch limit is ${U.LIMITS.imageMaxCount} photos. Extra files were skipped.`, 'error'); break; }
    const v = await U.validateImageFile(f);
    if (!v.ok) { toast(v.error, 'error', 7000); continue; }
    try {
      const L = await U.loadImage(f);
      img.items.push({ id: U.uid('im'), file: f, name: f.name, size: f.size, url: L.url, img: L.img, w: L.width, h: L.height, status: 'ready', versions: [], current: 0, history: [] });
    } catch (e) { toast(e.message, 'error', 7000); }
  }
  imgRenderList();
}
function imgRenderList() {
  const box = $('#imgList');
  box.innerHTML = '';
  for (const it of img.items) {
    const row = document.createElement('div');
    row.className = 'file-row';
    const st = { ready: 'ready', processing: 'processing', done: 'done', failed: 'failed' }[it.status];
    row.innerHTML = `<img alt=""><div class="fr-meta"><b></b><small>${it.w}×${it.h} · ${U.fmtBytes(it.size)}</small></div><span class="status ${st}">${it.status === 'ready' ? 'Ready' : it.status === 'processing' ? 'Processing' : it.status === 'done' ? 'Done' : 'Failed'}</span><button class="icon-btn mini" aria-label="Remove"><svg class="ic"><use href="#i-x"/></svg></button>`;
    row.querySelector('img').src = it.url;
    row.querySelector('b').textContent = it.name;
    row.querySelector('button').disabled = img.busy;
    row.querySelector('button').addEventListener('click', () => {
      img.items = img.items.filter((x) => x !== it);
      imgReleaseItem(it);
      if (img.active === it.id) img.active = img.items.find((x) => x.status === 'done')?.id || null;
      imgRenderList(); imgRenderEditor();
    });
    box.appendChild(row);
  }
  $('#imgRun').disabled = img.busy || !img.items.length;
  $('#imgClear').disabled = img.busy || !img.items.length;
  $('#imgRun').innerHTML = `<svg class="ic"><use href="#i-spark"/></svg>${img.items.some((x) => x.status === 'done') ? 'Re-run Auto Enhance' : 'Auto Enhance'}${img.items.length > 1 ? ` (${img.items.length})` : ''}`;
}
function imgReleaseItem(it) {
  URL.revokeObjectURL(it.url);
  for (const v of it.versions) { if (v.previewUrl) URL.revokeObjectURL(v.previewUrl); if (v.beforeUrl) URL.revokeObjectURL(v.beforeUrl); }
}
$('#imgClear').addEventListener('click', () => { img.items.forEach(imgReleaseItem); img.items = []; img.active = null; imgRenderList(); imgRenderEditor(); setReady('image', false); });

function imgOptions(mod = interpretImagePrompt($('#imgPrompt').value)) {
  if (mod.format) $('#imgFormat').value = mod.format;
  return { style: $('#imgStyle').value, aspect: mod.aspect || $('#imgAspect').value, intensity: Number($('#imgIntensity').value) / 100, mod };
}

async function imgMakeVersion(it, style, intensity, mod, label, aspect) {
  const { params, steps } = IE.buildParams(it.analysis, style, intensity, mod);
  const canvas = await IE.renderVersion(it.img, it.analysis, params, { maxLong: 1600, aspect });
  const blob = await U.canvasToBlob(canvas, 'image/jpeg', 0.9);
  return { id: U.uid('v'), label, style, intensity, mod, params, steps, aspect, previewUrl: URL.createObjectURL(blob), full: {} };
}
async function imgBeforeUrl(it, aspect) {
  const crop = IE.smartCropRect(it.analysis, aspect, it.w, it.h);
  const s = U.fitSize(crop.w, crop.h, 1600);
  const c = U.makeCanvas(s.w, s.h);
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(it.img, crop.x, crop.y, crop.w, crop.h, 0, 0, s.w, s.h);
  return URL.createObjectURL(await U.canvasToBlob(c, 'image/jpeg', 0.9));
}
async function imgFullBlob(it, v, mime) {
  if (v.full[mime]) return v.full[mime];
  const canvas = await IE.renderVersion(it.img, it.analysis, v.params, { aspect: v.aspect });
  const blob = await U.canvasToBlob(canvas, mime, mime === 'image/png' ? undefined : settings.imageQuality);
  const ver = await U.verifyImageBlob(blob);
  if (!ver.ok) throw new Error(ver.error);
  v.full[mime] = blob; v.outW = ver.width; v.outH = ver.height;
  return blob;
}

$('#imgRun').addEventListener('click', async () => {
  if (img.busy || !img.items.length) return;
  img.busy = true; imgRenderList();
  setJob('image', 'Enhancing photos…');
  const opts = imgOptions($('#imgPrompt').value.trim() ? await understandImagePrompt($('#imgPrompt').value) : undefined);
  const stages = new Stages($('#imgStages'), ['read', 'analyze', 'enhance', 'verify', 'done'], { read: 'Reading photos', analyze: 'Analyzing content', enhance: 'Enhancing', verify: 'Verifying full-resolution output' });
  if ($('#imgPrompt').value.trim()) promptToast(opts.mod);
  const n = img.items.length;
  const project = await createProject('image', n === 1 ? img.items[0].name : `${n} photos`, { count: n });
  const outputs = [];
  let failed = 0;
  try {
    stages.set('read'); stages.progress(1);
    for (let k = 0; k < n; k++) {
      const it = img.items[k];
      it.status = 'processing'; imgRenderList();
      try {
        stages.set('analyze', `Photo ${k + 1} of ${n}: ${it.name}`);
        it.analysis = await IE.analyzeSource(it.img);
        it.scene = IE.classifyScene(it.analysis);
        const autoStyle = IE.autoStyleFor(it.scene.type);
        const style = opts.mod.style || (opts.style !== 'auto' ? opts.style : autoStyle);
        stages.set('enhance', `Photo ${k + 1} of ${n}: ${it.scene.label} → ${IE.STYLES[style]}`);
        stages.progress(k / n);
        for (const v of it.versions) { if (v.previewUrl) URL.revokeObjectURL(v.previewUrl); }
        if (it.beforeUrl) URL.revokeObjectURL(it.beforeUrl);
        it.beforeUrl = await imgBeforeUrl(it, opts.aspect);
        const main = await imgMakeVersion(it, style, opts.intensity, opts.mod, (opts.style === 'auto' && !opts.mod.style ? 'AI pick: ' : '') + IE.STYLES[style], opts.aspect);
        main.auto = true;
        const alts = [];
        for (const s2 of IE.alternateStyles(it.scene.type, style)) alts.push(await imgMakeVersion(it, s2, opts.intensity, { ...opts.mod, style: undefined }, IE.STYLES[s2], opts.aspect));
        it.versions = [{ id: 'orig', label: 'Original', original: true, previewUrl: null, full: {}, steps: [] }, main, ...alts];
        it.current = 1; it.history = [];
        stages.set('verify', `Photo ${k + 1} of ${n}: rendering full resolution`);
        const mime = $('#imgFormat').value;
        const blob = await imgFullBlob(it, main, mime);
        outputs.push({ blob, name: `inera-${U.safeFileStem(it.name)}-edited.${U.extForBlob(blob)}`, kind: 'image', width: main.outW, height: main.outH, format: blob.type });
        it.status = 'done';
        if (!img.active || !img.items.find((x) => x.id === img.active && x.status === 'done')) img.active = it.id;
        imgRenderEditor();
      } catch (e) {
        if (e instanceof U.AbortError) throw e;
        it.status = 'failed'; it.error = errorMessage(e); failed++;
        toast(`${it.name}: ${it.error}`, 'error', 8000);
      }
      imgRenderList();
    }
    if (failed === n) throw new Error('None of the photos could be processed.');
    const first = img.items.find((x) => x.status === 'done');
    await finishProject(project, outputs, first ? await U.imageThumb(first.img) : null, { photos: n - failed });
    stages.done(`${n - failed} of ${n} photo${n > 1 ? 's' : ''} enhanced${failed ? ` · ${failed} failed` : ''}. Originals are untouched.`);
    toast('Photos enhanced. Compare, pick versions and download.', 'ok');
    setReady('image', true);
    await dsAutoFromPrompt(opts.mod);
  } catch (e) {
    stages.error(errorMessage(e));
    await failProject(project, e);
  } finally {
    img.busy = false; setJob('image', null); imgRenderList(); imgRenderEditor();
  }
});

function imgActive() { return img.items.find((x) => x.id === img.active && x.status === 'done'); }
function imgRenderEditor() {
  const it = imgActive();
  $('#imgEmpty').hidden = !!it;
  $('#imgEditor').hidden = !it;
  if (!it) return;
  const v = it.versions[it.current];
  $('#cmpBefore').src = it.beforeUrl;
  $('#cmpAfter').src = v.original ? it.beforeUrl : v.previewUrl;
  // info
  const sc = it.scene;
  const info = $('#imgInfo');
  info.innerHTML = `<div class="row"><span class="tag accent"><svg class="ic"><use href="#i-spark"/></svg>Detected: ${esc(sc.label)}</span><span class="tag">Style: ${esc(v.original ? 'Original (no edits)' : v.label.replace('AI pick: ', ''))}</span><span class="tag">${it.w}×${it.h}</span></div>
    <div class="muted">Why: ${esc(sc.reasons.join('; ') || 'general photo characteristics')}. Identity, people and objects are never changed — only light, colour, clarity and noise.</div>
    ${v.original ? '' : `<ul class="steps-list">${v.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`}`;
  // versions
  const vb = $('#imgVersions');
  vb.innerHTML = '';
  it.versions.forEach((ver, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === it.current ? ' active' : '');
    b.textContent = ver.label;
    b.addEventListener('click', () => { if (i === it.current) return; it.history.push(it.current); it.current = i; imgRenderEditor(); });
    vb.appendChild(b);
  });
  $('#imgUndo').disabled = !it.history.length;
  $('#imgRestore').disabled = it.current === 0;
  // filmstrip
  const fs = $('#imgStrip');
  fs.innerHTML = '';
  if (img.items.length > 1) {
    for (const x of img.items) {
      const b = document.createElement('button');
      b.className = x.id === img.active ? 'active' : '';
      b.style.backgroundImage = `url("${x.url}")`;
      b.setAttribute('aria-label', x.name);
      b.innerHTML = `<span class="st ${x.status}"></span>`;
      b.disabled = x.status !== 'done';
      b.addEventListener('click', () => { img.active = x.id; imgRenderEditor(); });
      fs.appendChild(b);
    }
  }
  $('#imgZip').hidden = img.items.filter((x) => x.status === 'done').length < 2;
  setCompare(Number($('#cmpRange').value));
}
function setCompare(v) {
  $('#cmpBeforeWrap').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $('#cmpHandle').style.left = v + '%';
}
$('#cmpRange').addEventListener('input', (e) => setCompare(Number(e.target.value)));
$('#imgUndo').addEventListener('click', () => { const it = imgActive(); if (it && it.history.length) { it.current = it.history.pop(); imgRenderEditor(); } });
$('#imgRestore').addEventListener('click', () => { const it = imgActive(); if (it && it.current !== 0) { it.history.push(it.current); it.current = 0; imgRenderEditor(); toast('Showing the untouched original. Download gives you the original file.', 'info'); } });
$('#imgRegen').addEventListener('click', async (e) => {
  const it = imgActive(); if (!it || img.busy) return;
  const btn = e.currentTarget; btn.disabled = true;
  try {
    const base = it.versions[it.current].original ? it.versions[1] : it.versions[it.current];
    const n = it.versions.filter((v) => v.variation).length + 1;
    const r = U.seededRandom(Date.now() & 0xffff);
    const mod = { ...(base.mod || {}), temp: (base.mod?.temp || 0) + (r() - 0.5) * 0.2, vibrance: (base.mod?.vibrance || 0) + (r() - 0.5) * 0.14, contrast: (r() - 0.5) * 0.1 };
    const v = await imgMakeVersion(it, base.style, U.clamp(base.intensity * (0.85 + r() * 0.35), 0.4, 1.5), mod, `Variation ${n}`, base.aspect);
    v.variation = true;
    it.versions.push(v); it.history.push(it.current); it.current = it.versions.length - 1;
    imgRenderEditor();
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { btn.disabled = false; }
});
$('#imgDownload').addEventListener('click', async (e) => {
  const it = imgActive(); if (!it) return;
  const v = it.versions[it.current];
  if (v.original) { U.downloadBlob(it.file, it.name); return; }
  const btn = e.currentTarget; btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>Preparing…';
  try {
    const blob = await imgFullBlob(it, v, $('#imgFormat').value);
    U.downloadBlob(blob, `inera-${U.safeFileStem(it.name)}-${U.safeFileStem(v.label.replace('AI pick: ', '')).toLowerCase()}.${U.extForBlob(blob)}`);
    toast(`Downloaded ${v.outW}×${v.outH} ${U.extForBlob(blob).toUpperCase()} (${U.fmtBytes(blob.size)}).`, 'ok');
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { btn.disabled = false; btn.innerHTML = old; }
});
$('#imgZip').addEventListener('click', async (e) => {
  const btn = e.currentTarget; btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>Building ZIP…';
  try {
    const files = [];
    const mime = $('#imgFormat').value;
    for (const it of img.items.filter((x) => x.status === 'done')) {
      const v = it.versions[it.current];
      const blob = v.original ? it.file : await imgFullBlob(it, v, mime);
      files.push({ name: `inera-${U.safeFileStem(it.name)}${v.original ? '-original' : '-edited'}.${v.original ? (it.name.split('.').pop() || 'jpg') : U.extForBlob(blob)}`, blob });
    }
    U.downloadBlob(await U.makeZip(files), 'inera-edited-photos.zip');
  } catch (err) { toast(errorMessage(err), 'error'); }
  finally { btn.disabled = false; btn.innerHTML = old; }
});

// ---- Mode 1: background & design tools ----
const ds = { maskKey: '', mask: null, srcCanvas: null, out: null, bgImg: null, busy: false };
for (const [k, v] of Object.entries(BG_MODES)) if (k !== 'keep') $('#dsBg').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v)}</option>`);
$('#dsBg').value = 'transparent';
$('#dsBg').addEventListener('change', (e) => { $('#dsColorWrap').hidden = e.target.value !== 'color'; $('#dsBgImgWrap').hidden = e.target.value !== 'image'; });
$('#dsBgImg').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const v = await U.validateImageFile(f); if (!v.ok) return toast(v.error, 'error');
  try { ds.bgImg = (await U.loadImage(f)).img; } catch (err) { toast(err.message, 'error'); }
});
async function dsSource() {
  const it = imgActive(); if (!it) throw new Error('Enhance a photo first.');
  const v = it.versions[it.current];
  const key = it.id + ':' + v.id;
  if (ds.maskKey === key && ds.mask) return { it, v };
  let srcC;
  if (v.original) { const s0 = U.fitSize(it.w, it.h, 4096); srcC = U.makeCanvas(s0.w, s0.h); srcC.getContext('2d').drawImage(it.img, 0, 0, s0.w, s0.h); }
  else srcC = await IE.renderVersion(it.img, it.analysis, v.params, { aspect: v.aspect, maxLong: 4096 });
  ds.srcCanvas = srcC;
  ds.mask = await subjectMask(srcC);
  ds.maskKey = key;
  return { it, v };
}
async function dsRun(btn, fn) {
  if (ds.busy) return; ds.busy = true;
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Cutting out the subject…';
  try { await fn(); } catch (e) { toast(errorMessage(e), 'error', 8000); }
  finally { ds.busy = false; btn.disabled = false; btn.innerHTML = old; }
}
function dsShow(canvas, label, mime, name) {
  ds.out = { canvas, mime, name };
  const url = canvas.toDataURL(mime === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
  $('#dsOut').src = url; $('#dsWrap').hidden = false; $('#dsBar').hidden = false;
  $('#dsInfo').textContent = `${label} · ${canvas.width}×${canvas.height} · ${mime === 'image/png' ? 'PNG' : 'JPEG'}`;
}
async function dsDoApply() {
  const mode = $('#dsBg').value;
  if (mode === 'image' && !ds.bgImg) throw new Error('Choose a background image first.');
  const { it } = await dsSource();
  const c = replaceBackground(ds.srcCanvas, ds.mask, { mode, color: $('#dsColor').value, image: ds.bgImg });
  const png = mode === 'transparent';
  dsShow(c, BG_MODES[mode], png ? 'image/png' : 'image/jpeg', `inera-${U.safeFileStem(it.name)}-${mode}.${png ? 'png' : 'jpg'}`);
}
async function dsDoMake() {
  const { it } = await dsSource();
  const layout = $('#dsLayout').value;
  const c = makeDesign(ds.srcCanvas, ds.mask, { layout, title: $('#dsTitle').value.trim(), subtitle: $('#dsSub').value.trim(), accent: $('#dsAccent').value });
  dsShow(c, LAYOUTS[layout].label, 'image/jpeg', `inera-${U.safeFileStem(it.name)}-${layout}.jpg`);
}
$('#dsApply').addEventListener('click', (e) => dsRun(e.currentTarget, dsDoApply));
$('#dsMake').addEventListener('click', (e) => dsRun(e.currentTarget, dsDoMake));
// Prompt-driven: "remove background", "white background", "YouTube thumbnail with title '…'" run automatically
async function dsAutoFromPrompt(mod) {
  if (!mod.bg && !mod.design) return;
  if (ds.busy) return;
  ds.busy = true;
  try {
    if (mod.bg) {
      $('#dsBg').value = mod.bg; $('#dsBg').dispatchEvent(new Event('change'));
      if (mod.bgColor) $('#dsColor').value = mod.bgColor;
      await dsDoApply();
    }
    if (mod.design) {
      $('#dsLayout').value = mod.design;
      if (mod.designTitle) $('#dsTitle').value = mod.designTitle;
      if (mod.designAccent) $('#dsAccent').value = mod.designAccent;
      await dsDoMake();
    }
    $('#imgDesign').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(`Done from your prompt: ${[mod.bg ? BG_MODES[mod.bg] : '', mod.design ? LAYOUTS[mod.design].label : ''].filter(Boolean).join(' + ')} — see "Background & social designs".`, 'ok', 7000);
  } catch (e) { toast(errorMessage(e), 'error', 8000); }
  finally { ds.busy = false; }
}
$('#dsDl').addEventListener('click', async () => {
  if (!ds.out) return;
  // YouTube thumbnails must be under 2 MB: step JPEG quality down until it fits
  let blob = await U.canvasToBlob(ds.out.canvas, ds.out.mime, ds.out.mime === 'image/png' ? undefined : 0.92);
  for (let q = 0.85; ds.out.mime !== 'image/png' && blob.size > 1.9 * 1024 * 1024 && q >= 0.5; q -= 0.1) blob = await U.canvasToBlob(ds.out.canvas, 'image/jpeg', q);
  U.downloadBlob(blob, ds.out.name);
});

// ======================= shared video helpers =======================
function videoInfoHtml(file, probe, modeLabel) {
  return `<video controls playsinline preload="metadata"></video><div class="mi-meta"><b></b><span>${U.fmtBytes(file.size)}</span><span>${U.fmtTime(probe.duration)}</span><span>${probe.width}×${probe.height}</span><span class="mode-tag">${esc(modeLabel)}</span></div>`;
}
async function loadVideoFor(file, box, modeLabel, maxSeconds = U.LIMITS.videoMaxSeconds, maxBytes = U.LIMITS.videoMaxBytes) {
  const v = await U.validateVideoFile(file, maxBytes);
  if (!v.ok) { toast(v.error, 'error', 8000); return null; }
  box.hidden = false;
  box.innerHTML = `<div class="mi-meta"><span class="spinner"></span>&nbsp;Checking that your browser can decode this video…</div>`;
  const probe = await U.probeVideo(file);
  if (!probe.ok) { box.hidden = true; box.innerHTML = ''; toast(probe.error, 'error', 12000); return null; }
  if (probe.duration > maxSeconds + 0.5) {
    URL.revokeObjectURL(probe.url); box.hidden = true; box.innerHTML = '';
    toast(`This video is ${U.fmtTime(probe.duration)} long. The limit in this browser is ${U.fmtTime(maxSeconds)} because all processing runs on your device.`, 'error', 10000);
    return null;
  }
  box.innerHTML = videoInfoHtml(file, probe, modeLabel);
  box.querySelector('video').src = probe.url;
  box.querySelector('b').textContent = file.name;
  return probe;
}
function resultVideoHtml() {
  return `<video class="result-video" controls playsinline></video>
    <div class="toolbar"><span class="tag" data-r="fmt"></span><span class="grow"></span>
    <button class="btn ghost sm" data-r="again"><svg class="ic"><use href="#i-refresh"/></svg>Edit again (new variation)</button>
    <button class="btn primary sm" data-r="dl"><svg class="ic"><use href="#i-download"/></svg>Download</button></div>
    <div class="report" data-r="report"></div>`;
}

// ======================= MODE 2: VIDEO =======================
// v2 engine (desktop Chrome / Edge / any browser with WebCodecs encoders): watch + listen → transcript →
// story → director EDL → offline render to disk. Fallback: v1 real-time renderer.
const CAN_ENCODE = typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
const vid = { file: null, probe: null, src: null, busy: false, abort: null, an: null, anKey: '', bg: null, seed: 1, resultUrl: null, legacyAnalysis: null, library: [] };
const vstyle = $('#vidStyle');
for (const [k, v] of Object.entries(VIDEO_STYLES)) vstyle.insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v)}</option>`);
const vidMaxSeconds = () => (CAN_ENCODE ? U.LIMITS.longVideoMaxSeconds : U.LIMITS.videoMaxSeconds);
const vidMaxBytes = () => (CAN_ENCODE ? U.LIMITS.longVideoMaxBytes : U.LIMITS.videoMaxBytes);
$('#vidLimitText').textContent = CAN_ENCODE
  ? `MP4, MOV, WebM · up to ${U.fmtBytes(U.LIMITS.longVideoMaxBytes)} · 1 second to ${U.LIMITS.longVideoMaxSeconds / 3600} hours`
  : `MP4, MOV, WebM · max ${U.fmtBytes(U.LIMITS.videoMaxBytes)} · max ${U.LIMITS.videoMaxSeconds / 60} minutes in this browser (use desktop Chrome or Edge for long videos)`;
if (!CAN_ENCODE) $('#vidNote span').textContent = 'This browser has no video encoder, so the classic real-time editor is used: no automatic captions or topic visuals, max 5 minutes. For the full AI editor use desktop Chrome or Edge.';
bindDrop($('#vidDrop'), $('#vidInput'), (f) => vidSet(f[0]));
$('#vidLibrary').addEventListener('change', (e) => {
  const files = [...e.target.files].filter((f) => f.size < 2 * 1024 * 1024 * 1024);
  vid.library = libraryFromFiles(files);
  if (files.length) toast(`${files.length} B-roll file${files.length > 1 ? 's' : ''} added. They are used when your speech mentions their file names.`, 'ok');
});

function vidDisposeSource() {
  vidStopBg();
  if (vid.an && vid.an.store) { try { vid.an.store.dispose(); } catch (e) { /* ignore */ } }
  if (vid.src) { try { vid.src.dispose(); } catch (e) { /* ignore */ } }
  vid.src = null; vid.an = null; vid.anKey = ''; vid.legacyAnalysis = null;
}
async function vidSet(file) {
  if (vid.busy) return toast('An edit is running. Cancel it first to load a different video.', 'error');
  $('#vidRun').disabled = true;
  if (vid.probe) URL.revokeObjectURL(vid.probe.url);
  vidDisposeSource();
  vid.file = null; vid.probe = null;
  const v = await U.validateVideoFile(file, vidMaxBytes());
  if (!v.ok) return toast(v.error, 'error', 8000);
  const box = $('#vidInfo');
  box.hidden = false;
  box.innerHTML = `<div class="mi-meta"><span class="spinner"></span>&nbsp;Checking that this browser can decode the video…</div>`;
  let probe = await U.probeVideo(file);
  let src = null;
  if (CAN_ENCODE) {
    try { src = await openSource(file); } catch (e) { src = null; }
    if (!probe.ok && src && src.kind === 'webcodecs') probe = { ok: true, url: URL.createObjectURL(file), duration: src.duration, width: src.width, height: src.height, noPreview: true };
  }
  if (!probe.ok) { box.hidden = true; box.innerHTML = ''; if (src) src.dispose(); return toast(probe.error, 'error', 12000); }
  const duration = src ? src.duration || probe.duration : probe.duration;
  if (duration > vidMaxSeconds() + 0.5) {
    URL.revokeObjectURL(probe.url); box.hidden = true; box.innerHTML = ''; if (src) src.dispose();
    return toast(`This video is ${U.fmtTime(duration)} long. The limit in this browser is ${U.fmtTime(vidMaxSeconds())}.${CAN_ENCODE ? '' : ' Desktop Chrome or Edge can edit videos up to 3 hours.'}`, 'error', 10000);
  }
  if (duration < 1) { URL.revokeObjectURL(probe.url); box.hidden = true; if (src) src.dispose(); return toast('This video is shorter than 1 second — too short to edit.', 'error', 7000); }
  if (src && src.kind === 'element' && duration > U.LIMITS.videoMaxSeconds) toast('This video uses a codec that is slow to read in this browser. Long edits will take much longer — re-exporting as H.264 MP4 makes it fast.', 'info', 9000);
  box.innerHTML = videoInfoHtml(file, { ...probe, duration }, CAN_ENCODE ? 'AI auto edit' : 'Classic auto edit');
  if (probe.noPreview) box.querySelector('video').replaceWith(Object.assign(document.createElement('div'), { className: 'no-preview', textContent: 'Preview not available in this browser, but the video can be edited.' }));
  else box.querySelector('video').src = probe.url;
  box.querySelector('b').textContent = file.name;
  vid.file = file; vid.probe = { ...probe, duration }; vid.src = src; vid.seed = 1;
  // start the one-time speech-model download now, while the user looks at options
  if (CAN_ENCODE && src && $('#vidAsr').value !== 'off') preloadAsr(resolveAsr(), $('#vidLang').value || undefined);
  $('#vidRun').disabled = false;
  vidStartBg(); // the AI starts watching and listening right away, while you choose options or type a prompt
}
// ---- background analysis: starts the moment a video is loaded; "AI auto edit" picks it up where it is ----
function vidAnKey(opts) { return `${opts.asr}|${opts.language || ''}`; }
// an analysis made with "auto" serves a "fast" (tiny) request too when it ran on tiny (English)
function vidKeyFits(have, want, an) {
  if (have === want) return true;
  const [ha, hl] = have.split('|'), [wa, wl] = want.split('|');
  return hl === wl && ha === 'auto' && wa === 'tiny' && (!an || !an.transcript || !an.transcript.engine || an.transcript.engine.model === 'tiny');
}
function vidStopBg() { if (vid.bg) { vid.bg.abort.abort(); vid.bg = null; } }
function vidBgNote(text) {
  const box = $('#vidInfo'); if (!box || box.hidden) return;
  let el = box.querySelector('.bg-note');
  if (!el) { el = Object.assign(document.createElement('div'), { className: 'mi-meta bg-note' }); box.appendChild(el); }
  el.textContent = text;
}
function vidStartBg() {
  if (!CAN_ENCODE || !vid.src || vid.busy) return;
  let opts; try { opts = vidOptions(parseVideoPrompt($('#vidPrompt').value)); } catch (e) { return; }
  const key = vidAnKey(opts);
  if ((vid.an && vid.anKey === key) || (vid.bg && vid.bg.key === key)) return;
  vidStopBg();
  if (vid.an && vid.an.store) { try { vid.an.store.dispose(); } catch (e) { /* ignore */ } }
  vid.an = null; vid.anKey = '';
  const bg = { key, abort: new AbortController(), st: null, m: null, pct: null, note: '', sink: null, t0: performance.now() };
  const emit = (type, a, b) => {
    if (type === 'stage') { bg.st = a; bg.m = b; bg.pct = null; } else if (type === 'progress') bg.pct = a; else bg.note = a;
    if (bg.sink) bg.sink(type, a, b);
    else if (vid.bg === bg) {
      const what = bg.st === 'download' ? 'loading the speech model' : bg.st === 'transcribe' ? 'transcribing' : bg.st === 'audio' ? 'listening' : 'watching & listening';
      vidBgNote(`AI is already ${what}${bg.pct != null ? ` · ${Math.round(bg.pct * 100)}%` : ''} — press AI auto edit any time.`);
    }
  };
  vid.bg = bg;
  bg.promise = analyzeMedia(vid.src, {
    asrModel: opts.asr, language: opts.language, skipAsr: opts.asr === 'off', signal: bg.abort.signal,
    onStage: (st, m) => emit('stage', st, m), onProgress: (p) => emit('progress', p), onNote: (t) => emit('note', t),
  });
  bg.promise.then((an) => {
    if (vid.bg !== bg) return;
    vid.an = an; vid.anKey = key; vid.bg = null;
    if (!vid.busy) vidBgNote(`AI has watched and listened to the whole video (${U.fmtTime((performance.now() - bg.t0) / 1000)}) — the edit itself starts immediately.`);
    vidPrefetchVisuals(an, opts);
  }, () => { if (vid.bg === bg) { vid.bg = null; vidBgNote(''); } });
}
// while you look at the options, the likely topic pictures are already searched and downloaded
function vidPrefetchVisuals(an, opts) {
  try {
    if (!opts.online || opts.broll === 'off') return;
    const edl = planV2(an, opts, vid.seed);
    const W = edl.size.w, H = edl.size.h, context = edl.story.mainTopic || '';
    let i = 0; const list = edl.broll;
    const worker = async () => { while (i < list.length) { const b = list[i++]; await prefetchVisual(b.keyword, b.key, { online: true, W, H, context }).catch(() => {}); } };
    Promise.all([worker(), worker(), worker()]).catch(() => {});
  } catch (e) { /* the render resolves visuals itself anyway */ }
}
['#vidAsr', '#vidLang', '#vidRes'].forEach((id) => $(id).addEventListener('change', () => { if (vid.src && !vid.busy) vidStartBg(); }));
// speech model: Auto = fast "tiny" for English (1.65x faster, ~98% the same words), accurate "base" for other languages
function resolveAsr(fast = false) {
  const v = $('#vidAsr').value;
  if (v === 'auto' && fast) return 'tiny';
  return v;
}
function vidOptions(pm = parseVideoPrompt($('#vidPrompt').value)) {
  const P = (k, v) => (pm[k] !== undefined ? pm[k] : v); // the prompt always wins over the dropdowns
  const len = $('#vidLength').value;
  const pacing = $('#vidPacing').value;
  const fast = pm.resolution === 1080 ? false : !!pm.fast || pm.resolution === 720 || $('#vidRes').value === '720';
  return {
    style: P('style', $('#vidStyle').value),
    targetDuration: P('targetDuration', len !== 'auto' ? Number(len) : undefined),
    aspect: P('aspect', $('#vidAspect').value),
    music: P('music', $('#vidMusic').value),
    orig: P('orig', $('#vidOrig').value),
    intensity: P('intensity', $('#vidIntensity').value),
    transitions: P('transitions', $('#vidTrans').value),
    stabilize: P('stabilize', $('#vidStab').value),
    title: P('title', $('#vidTitle').value.trim()).slice(0, 80),
    mood: pm.mood, grade: pm.grade, keepAllSpeech: pm.keepAllSpeech, keepPauses: P('keepPauses', pacing === 'keep'), noText: pm.noText, noSfx: pm.noSfx,
    pacing: P('pacing', pacing === 'tight' || pacing === 'relaxed' ? pacing : undefined),
    removeRetakes: P('removeRetakes', $('#vidRetakes').value !== 'off'), hook: P('hook', $('#vidHook').value),
    captions: P('captions', $('#vidCaptions').value), captionCase: P('captionCase', $('#vidCapCase').value),
    captionPos: pm.captionPos, captionColor: pm.captionColor, captionScale: pm.captionScale, punch: pm.punch,
    broll: P('broll', $('#vidBroll').value), graphics: P('graphics', $('#vidGraphics').value), sfx: P('sfx', $('#vidSfx').value),
    speakerName: P('speakerName', $('#vidSpeaker').value.trim()).slice(0, 40), speakerRole: P('speakerRole', $('#vidRole').value.trim()).slice(0, 50),
    online: P('online', $('#vidOnline').value === 'on'), quality: P('quality', $('#vidQuality').value),
    asr: resolveAsr(fast),
    resolution: fast ? 720 : 1080, bright: pm.bright,
    language: P('language', $('#vidLang').value || undefined),
    notes: pm.notes, prompt: pm, hasPrompt: !!$('#vidPrompt').value.trim(),
  };
}
$('#vidRun').addEventListener('click', () => vidRun());
$('#vidCancel').addEventListener('click', () => { if (vid.abort) vid.abort.abort(); });
async function vidRun() {
  if (vid.busy || !vid.file) return;
  // understand the prompt fully (rules + meaning) before starting
  let pm;
  if ($('#vidPrompt').value.trim()) { vid.busy = true; $('#vidRun').disabled = true; try { pm = await understandVideoPrompt($('#vidPrompt').value); } finally { vid.busy = false; $('#vidRun').disabled = false; } }
  vid.pm = pm;
  if (CAN_ENCODE && vid.src) return vidRunV2();
  if (vid.probe.duration > U.LIMITS.videoMaxSeconds + 0.5 || vid.file.size > U.LIMITS.videoMaxBytes) return toast('This video is too long for the classic editor in this browser. Use desktop Chrome or Edge.', 'error', 8000);
  if (vid.probe.noPreview) return toast('This browser cannot play this video for the classic editor. Use desktop Chrome or Edge.', 'error', 8000);
  return vidRunLegacy();
}

// ---- helpers for text outputs ----
function srtTime(t, sep = ',') { const ms = Math.max(0, Math.round(t * 1000)); const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms % 1000).padStart(3, '0')}`; }
function groupsToSrt(groups) { return groups.map((g, i) => `${i + 1}\n${srtTime(g.t0)} --> ${srtTime(g.t1)}\n${g.words.map((w) => w.w).join(' ')}\n`).join('\n'); }
function groupsToVtt(groups) { return 'WEBVTT\n\n' + groups.map((g) => `${srtTime(g.t0, '.')} --> ${srtTime(g.t1, '.')}\n${g.words.map((w) => w.w).join(' ')}\n`).join('\n'); }
function clockTime(t) { t = Math.max(0, Math.floor(t)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; }
function edlChapters(edl) {
  const ch = edl.overlays.filter((o) => o.type === 'chapter').map((o) => ({ t: o.t0, title: o.text }));
  if (!ch.length) return [];
  return [{ t: 0, title: edl.story.mainTopic ? titleCase(edl.story.mainTopic) : 'Intro' }, ...ch.filter((c) => c.t >= 10)];
}
function descriptionText(edl, credits, music) {
  const lines = [];
  if (edl.story.title) lines.push(edl.story.title, '');
  const ch = edlChapters(edl);
  if (ch.length >= 3) { lines.push('Chapters'); ch.forEach((c) => lines.push(`${clockTime(c.t)} ${c.title}`)); lines.push(''); }
  if (edl.story.hashtags && edl.story.hashtags.length) lines.push(edl.story.hashtags.join(' '), '');
  if (music) lines.push(`Music: "${music.title}" — ${music.license}`);
  const cr = creditsText(credits);
  if (cr) lines.push('', cr);
  return lines.join('\n').trim() + '\n';
}
const textBlob = (s, type = 'text/plain') => new Blob([s], { type: type + ';charset=utf-8' });

async function vidRunV2() {
  const opts = vidOptions(vid.pm);
  vid.busy = true;
  const abort = new AbortController(); vid.abort = abort;
  $('#vidRun').disabled = true; $('#vidCancel').hidden = false;
  $('#vidEmpty').hidden = true; $('#vidResult').hidden = true;
  setJob('video', 'AI editing video…');
  if (opts.hasPrompt) promptToast(opts.prompt);
  const stages = new Stages($('#vidStages'), ['read', 'audio', 'analyze', 'transcribe', 'plan', 'visuals', 'music', 'render', 'verify', 'done'], {
    analyze: 'Watching (faces, motion, scenes) while transcribing', audio: 'Listening (audio & speech activity)', download: 'Downloading speech model (one time)', transcribe: 'Transcribing speech',
    plan: 'Directing the edit (story, cuts, captions)', visuals: 'Finding topic visuals', music: 'Composing music & mixing', render: 'Rendering & encoding',
  });
  if (opts.asr === 'off') stages.skip('transcribe');
  const project = await createProject('video', vid.file.name, { duration: vid.probe.duration });
  let wakeLock = null;
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  try {
    stages.set('read'); stages.progress(1);
    const anKey = vidAnKey(opts);
    const onSt = (st, m) => {
      if (st === 'download') {
        if (m && m.phase === 'load') { stages.set('transcribe', 'Starting the speech engines on this device…'); return; }
        stages.enter('download', 'transcribe');
        if (m && m.total) { stages.progress(m.loaded / m.total); stages.detail(`${m.cached ? 'Loading cached' : 'Downloading'} speech model: ${U.fmtBytes(m.loaded)} of ${U.fmtBytes(m.total)} — free, one time, then cached in this browser.`); }
        return;
      }
      stages.set(st);
      if (st === 'transcribe') stages.detail('Converting your speech to text on this device (several engines in parallel)…');
    };
    if (vid.an && vidKeyFits(vid.anKey, anKey, vid.an)) stages.set('transcribe');
    else if (vid.bg && vidKeyFits(vid.bg.key, anKey)) {
      // the analysis started when the video was loaded: continue showing it from where it is
      const bg = vid.bg;
      if (bg.st) onSt(bg.st, bg.m);
      if (bg.pct != null) stages.progress(bg.pct);
      if (bg.note) stages.detail(bg.note);
      bg.sink = (type, a, b) => { if (type === 'stage') onSt(a, b); else if (type === 'progress') stages.progress(a); else stages.detail(a); };
      const stop = () => bg.abort.abort(); abort.signal.addEventListener('abort', stop);
      try { vid.an = await bg.promise; vid.anKey = bg.key; } finally { abort.signal.removeEventListener('abort', stop); if (vid.bg === bg) vid.bg = null; }
      checkAbortSafe(abort.signal);
    } else {
      vidStopBg();
      if (vid.an && vid.an.store) { try { vid.an.store.dispose(); } catch (e) { /* ignore */ } }
      vid.an = null;
      vid.an = await analyzeMedia(vid.src, {
        asrModel: opts.asr, language: opts.language, skipAsr: opts.asr === 'off', signal: abort.signal,
        onStage: onSt, onProgress: (p) => stages.progress(p), onNote: (t) => stages.detail(t),
      });
      vid.anKey = anKey;
    }
    const an = vid.an;
    stages.set('plan');
    const edl = planV2(an, opts, vid.seed);
    const words = an.transcript.segments.reduce((a, sg) => a + (sg.words ? sg.words.length : 0), 0);
    stages.detail(`${VIDEO_TYPES_LABEL[an.cls.type] || an.cls.type} · ${words} words heard · ${edl.clips.length} clips · ${U.fmtTime(edl.total)} output`);
    if (edl.musicLevel <= 0) stages.labels.music = 'Mixing audio';
    $('#vidRenderWrap').hidden = false;
    const result = await withRenderLock(() => renderV2({
      src: vid.src, an, edl, canvas: $('#vidCanvas'), library: vid.library, online: opts.online, quality: opts.quality, seed: vid.seed, signal: abort.signal,
      name: `inera-${U.safeFileStem(vid.file.name)}-edited`,
      onStage: (st) => { stages.set(st); if (st === 'render') stages.detail(`Rendering ${edl.size.w}×${edl.size.h} · ${U.fmtTime(edl.total)} — faster than real time on most computers.`); },
      onProgress: (p) => stages.progress(p),
    }), () => stages.set('wait'));
    $('#vidRenderWrap').hidden = true;
    if (vid.resultUrl) URL.revokeObjectURL(vid.resultUrl);
    vid.resultUrl = URL.createObjectURL(result.file);
    const stem = `inera-${U.safeFileStem(vid.file.name)}-edited${vid.seed > 1 ? '-v' + vid.seed : ''}`;
    const vname = `${stem}.${result.fileName.split('.').pop()}`;
    // text outputs
    const extras = [];
    if (edl.subtitles && edl.subtitles.length) {
      extras.push({ name: `${stem}.srt`, blob: textBlob(groupsToSrt(edl.subtitles), 'application/x-subrip'), label: 'Subtitles (SRT)' });
      extras.push({ name: `${stem}.vtt`, blob: textBlob(groupsToVtt(edl.subtitles), 'text/vtt'), label: 'Subtitles (VTT)' });
    }
    if (an.transcript.segments.length) extras.push({ name: `${stem}-transcript.txt`, blob: textBlob(an.transcript.segments.map((sg) => `[${clockTime(sg.start)}] ${sg.text.trim()}`).join('\n') + '\n'), label: 'Full transcript' });
    const desc = descriptionText(edl, result.credits, result.music);
    extras.push({ name: `${stem}-description.txt`, blob: textBlob(desc), label: 'Title, chapters, hashtags & credits' });
    const box = $('#vidResult');
    box.hidden = false;
    box.innerHTML = resultVideoHtml();
    box.querySelector('video').src = vid.resultUrl + '#t=0.5';
    box.querySelector('[data-r=fmt]').textContent = `${result.label} · ${result.check.width}×${result.check.height} · ${U.fmtTime(result.check.duration)} · ${U.fmtBytes(result.file.size)}`;
    box.querySelector('[data-r=dl]').addEventListener('click', () => U.downloadBlob(result.file, vname));
    box.querySelector('[data-r=again]').addEventListener('click', () => { vid.seed++; vidRun(); });
    const dls = document.createElement('div'); dls.className = 'extra-dl';
    for (const x of extras) { const b = document.createElement('button'); b.className = 'btn ghost sm'; b.innerHTML = `<svg class="ic"><use href="#i-download"/></svg>${esc(x.label)}`; b.addEventListener('click', () => U.downloadBlob(x.blob, x.name)); dls.appendChild(b); }
    box.querySelector('.toolbar').after(dls);
    const cls = an.cls;
    const brollUsed = edl.broll.filter((b) => b.visual);
    box.querySelector('[data-r=report]').innerHTML = `<h4>What the AI did</h4>
      <div class="kv"><span>Content type</span><span>${esc(VIDEO_TYPES_LABEL[cls.type] || cls.type)} — ${esc(cls.reasons.join(', '))}</span>
      <span>Length</span><span>${U.fmtTime(an.duration)} raw → ${U.fmtTime(edl.total)} edited</span>
      <span>Speech</span><span>${an.transcript.segments.length ? `${words} words transcribed${an.transcript.language ? ` (${esc(an.transcript.language)})` : ''}${an.transcript.missingSeconds > 0.5 ? ` — ${U.fmtTime(an.transcript.missingSeconds)} of speech could not be transcribed in time on this computer, so that part has no captions` : ''}` : an.transcript.missingSeconds > 0.5 ? `Speech found, but this computer could not transcribe it in time, so there are no captions (the talk was kept uncut)` : an.audio.hasAudio ? 'No clear speech found' : 'No usable audio track'}</span>
      ${an.scanStop ? `<span>Video scan</span><span>To stay fast, ${esc(an.scanStop)} (the edit still uses the whole video).</span>` : ''}
      ${edl.story.title ? `<span>Suggested title</span><span>${esc(edl.story.title)}</span>` : ''}
      <span>Visuals</span><span>${brollUsed.length ? brollUsed.map((b) => `${esc(b.keyword)} (${b.visual.source === 'web' ? 'free web photo' : b.visual.source === 'library' ? 'your clip' : 'illustration'})`).join(', ') : 'None needed'}</span>
      <span>Music</span><span>${result.music ? `${esc(result.music.title)} · ${esc((MOODS[edl.mood] || {}).label || edl.mood)}${edl.speechDriven ? ' · ducked under speech' : ' · cuts on the beat'}` : 'Off'}</span>
      <span>Render</span><span>${esc(result.label)} in ${U.fmtTime(result.elapsed)}${result.perf && result.profile ? ` — reading source frames ${U.fmtTime(result.profile.decodeComposeMs / 1000)}, drawing captions & graphics ${U.fmtTime(result.profile.overlayMs / 1000)}, frame capture ${U.fmtTime(result.perf.captureMs / 1000)}, encoder ${U.fmtTime(result.perf.encoderWaitMs / 1000)}, sound ${U.fmtTime(result.profile.audioMs / 1000)}` : ''}</span>
      ${an.transcript.engine ? `<span>Speech engine</span><span>Whisper ${esc(an.transcript.engine.model)} · ${an.transcript.engine.engines || 1} parallel engine${(an.transcript.engine.engines || 1) > 1 ? 's' : ''} × ${an.transcript.engine.threads || 1} thread${(an.transcript.engine.threads || 1) > 1 ? 's' : ''} on the processor (${navigator.hardwareConcurrency || '?'} cores)</span>` : ''}
      <span>Time taken</span><span>${esc(stages.timeReport())}</span></div>
      <ul>${edl.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      ${result.music ? `<div class="license"><svg class="ic"><use href="#i-music"/></svg> Music licence: ${esc(result.music.license)}</div>` : ''}
      ${result.credits.length ? `<div class="license">Visual credits are included in the "credits" text download — keep them in your video description (required by CC BY).</div>` : ''}`;
    const thumb = await U.grabVideoThumb(vid.resultUrl, Math.min(1.5, result.check.duration / 3)).catch(() => null);
    const outs = [{ blob: result.onDisk ? null : result.file, opfs: result.onDisk ? result.fileName : null, size: result.file.size, mime: result.mime, name: vname, kind: 'video', width: result.check.width, height: result.check.height, duration: result.check.duration, format: result.label }];
    for (const x of extras) outs.push({ blob: x.blob, name: x.name, kind: 'text', format: x.label });
    await finishProject(project, outs, thumb, { type: cls.type, decisions: edl.decisions });
    stages.done(`Verified: playable ${result.check.width}×${result.check.height} video${result.check.hasAudio ? ' with audio' : ''}.`);
    toast('Your edited video is ready.', 'ok');
    setReady('video', true);
  } catch (e) {
    $('#vidRenderWrap').hidden = true;
    stages.error(errorMessage(e));
    if (!vid.resultUrl) $('#vidEmpty').hidden = false;
    await failProject(project, e);
  } finally {
    try { wakeLock && wakeLock.release(); } catch (e) { /* ignore */ }
    vid.busy = false; vid.abort = null; setJob('video', null);
    $('#vidRun').disabled = !vid.file; $('#vidCancel').hidden = true;
  }
}

async function vidRunLegacy() {
  const actx = getAudioCtx(); // created inside the click (user gesture) so audio can render
  vid.busy = true;
  const abort = new AbortController(); vid.abort = abort;
  $('#vidRun').disabled = true; $('#vidCancel').hidden = false;
  $('#vidEmpty').hidden = true; $('#vidResult').hidden = true;
  setJob('video', 'Auto-editing video…');
  const opts = vidOptions(vid.pm);
  if (opts.hasPrompt) promptToast(opts.prompt);
  const stages = new Stages($('#vidStages'), ['read', 'analyze', 'audio', 'plan', 'music', 'mix', 'render', 'verify', 'done'], { analyze: 'Analyzing video (scenes, motion, faces, quality)' });
  const project = await createProject('video', vid.file.name, { duration: vid.probe.duration });
  const pauseNote = (p) => stages.detail(p ? 'Paused because the tab is hidden — come back to continue rendering.' : 'Rendering in real time…');
  try {
    stages.set('read'); stages.progress(1);
    if (!vid.legacyAnalysis) {
      vid.legacyAnalysis = await analyzeForEdit(vid.file, vid.probe, { onStage: (st) => stages.set(st), onProgress: (p) => stages.progress(p), signal: abort.signal });
    } else { stages.set('audio'); }
    const an = vid.legacyAnalysis;
    stages.set('plan');
    const plan = planEdit(an, opts, vid.seed);
    stages.detail(`${VIDEO_TYPES_LABEL[an.cls.type]} detected · ${plan.clips.length} clips · ${plan.total.toFixed(1)}s`);
    if (plan.musicLevel <= 0) stages.skip('music');
    const size = outputSizeFor(opts.aspect, an.width, an.height);
    $('#vidRenderWrap').hidden = false;
    const result = await withRenderLock(() => renderEdit(an, plan, {
      url: vid.probe.url, canvas: $('#vidCanvas'), audioCtx: actx, opts, seed: vid.seed, signal: abort.signal,
      onStage: (st) => { stages.set(st); if (st === 'render') stages.detail(`Rendering ${size.w}×${size.h} in real time (${plan.total.toFixed(0)}s)…`); },
      onProgress: (p) => stages.progress(p), onPauseChange: pauseNote,
    }), () => stages.set('wait'));
    $('#vidRenderWrap').hidden = true;
    if (vid.resultUrl) URL.revokeObjectURL(vid.resultUrl);
    vid.resultUrl = URL.createObjectURL(result.blob);
    const ext = U.extForBlob(result.blob);
    const name = `inera-${U.safeFileStem(vid.file.name)}-edited${vid.seed > 1 ? '-v' + vid.seed : ''}.${ext}`;
    const box = $('#vidResult');
    box.hidden = false;
    box.innerHTML = resultVideoHtml();
    box.querySelector('video').src = vid.resultUrl + '#t=1';
    box.querySelector('[data-r=fmt]').textContent = `${result.format} · ${result.check.width}×${result.check.height} · ${result.check.duration.toFixed(1)}s · ${U.fmtBytes(result.blob.size)}`;
    box.querySelector('[data-r=dl]').addEventListener('click', () => U.downloadBlob(result.blob, name));
    box.querySelector('[data-r=again]').addEventListener('click', () => { vid.seed++; vidRun(); });
    const cls = an.cls;
    box.querySelector('[data-r=report]').innerHTML = `<h4>What the AI did</h4>
      <div class="kv"><span>Content type</span><span>${esc(VIDEO_TYPES_LABEL[cls.type])} — ${esc(cls.reasons.join(', '))}</span>
      <span>Length</span><span>${U.fmtTime(an.duration)} raw → ${U.fmtTime(plan.total)} edited</span>
      <span>Audio</span><span>${an.audio.hasAudio ? (an.audio.segments.length ? `Speech detected (${an.audio.segments.length} phrases) — kept and levelled` : 'Original sound kept as ambience where useful') : 'No usable audio track in the source'}</span>
      <span>Music</span><span>${result.music ? `${esc(result.music.title)} · ${esc(MOODS[plan.mood].label)} · ${plan.bpm} BPM${plan.speechDriven ? ' · ducked under speech' : ' · cuts synced to the beat'}` : 'Off'}</span></div>
      <ul>${plan.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      ${result.music ? `<div class="license"><svg class="ic"><use href="#i-music"/></svg> Music licence: ${esc(result.music.license)}</div>` : ''}
      <div class="license">Classic editor (this browser has no video encoder): captions and topic visuals need desktop Chrome or Edge.</div>`;
    const thumb = await U.grabVideoThumb(vid.resultUrl, Math.min(1.5, result.check.duration / 3)).catch(() => null);
    await finishProject(project, [{ blob: result.blob, name, kind: 'video', width: result.check.width, height: result.check.height, duration: result.check.duration, format: result.format }], thumb, { type: cls.type, decisions: plan.decisions });
    stages.done('Verified: playable video stream' + (result.check.hasAudio ? ' with audio' : '') + '.');
    toast('Your edited video is ready.', 'ok');
    setReady('video', true);
  } catch (e) {
    $('#vidRenderWrap').hidden = true;
    stages.error(errorMessage(e));
    if (!vid.resultUrl) $('#vidEmpty').hidden = false;
    await failProject(project, e);
  } finally {
    vid.busy = false; vid.abort = null; setJob('video', null);
    $('#vidRun').disabled = !vid.file; $('#vidCancel').hidden = true;
  }
}

// ======================= MODE 3: IMAGE → VIDEO =======================
const i2v = { items: [], busy: false, abort: null, seed: 1, resultUrl: null, manualOrder: false };
bindDrop($('#i2vDrop'), $('#i2vInput'), (f) => i2vAdd(f));
async function i2vAdd(files) {
  if (i2v.busy) return toast('Please wait until the current video finishes.', 'error');
  for (const f of files) {
    if (i2v.items.length >= U.LIMITS.slideshowMaxImages) { toast(`Limit is ${U.LIMITS.slideshowMaxImages} photos per video.`, 'error'); break; }
    const v = await U.validateImageFile(f);
    if (!v.ok) { toast(v.error, 'error', 7000); continue; }
    try {
      const L = await U.loadImage(f);
      i2v.items.push({ id: U.uid('s'), file: f, name: f.name, url: L.url, img: L.img, w: L.width, h: L.height, exifDate: await U.readExifDate(f) });
    } catch (e) { toast(e.message, 'error'); }
  }
  i2vRenderList();
}
function i2vRenderList() {
  const box = $('#i2vList');
  box.innerHTML = '';
  i2v.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.draggable = !i2v.busy;
    row.innerHTML = `<span class="num">${i + 1}</span><img alt=""><div class="fr-meta"><b></b><small>${it.w}×${it.h}${it.exifDate ? ' · ' + esc(new Date(it.exifDate).toLocaleDateString()) : ''}</small></div>
      <button class="icon-btn mini" data-a="up" aria-label="Move up"><svg class="ic"><use href="#i-up"/></svg></button>
      <button class="icon-btn mini" data-a="down" aria-label="Move down"><svg class="ic"><use href="#i-down"/></svg></button>
      <button class="icon-btn mini" data-a="rm" aria-label="Remove"><svg class="ic"><use href="#i-x"/></svg></button>`;
    row.querySelector('img').src = it.url;
    row.querySelector('b').textContent = it.name;
    row.querySelectorAll('button').forEach((b) => { b.disabled = i2v.busy; });
    row.querySelector('[data-a=up]').disabled = i2v.busy || i === 0;
    row.querySelector('[data-a=down]').disabled = i2v.busy || i === i2v.items.length - 1;
    const move = (to) => { const [x] = i2v.items.splice(i, 1); i2v.items.splice(to, 0, x); i2vManual(); i2vRenderList(); };
    row.querySelector('[data-a=up]').addEventListener('click', () => move(i - 1));
    row.querySelector('[data-a=down]').addEventListener('click', () => move(i + 1));
    row.querySelector('[data-a=rm]').addEventListener('click', () => { URL.revokeObjectURL(it.url); i2v.items.splice(i, 1); i2vRenderList(); });
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/plain')) { e.preventDefault(); e.stopPropagation(); row.classList.add('drag-over'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isInteger(from) || e.dataTransfer.files.length) return;
      e.preventDefault(); e.stopPropagation();
      const [x] = i2v.items.splice(from, 1); i2v.items.splice(i, 0, x); i2vManual(); i2vRenderList();
    });
    box.appendChild(row);
  });
  $('#i2vRun').disabled = i2v.busy || !i2v.items.length;
  $('#i2vClear').disabled = i2v.busy || !i2v.items.length;
}
function i2vManual() { if ($('#i2vOrder').value !== 'manual') { $('#i2vOrder').value = 'manual'; toast('Your custom order will be kept. Switch "Photo order" back to Auto anytime.', 'info'); } }
$('#i2vClear').addEventListener('click', () => { i2v.items.forEach((it) => URL.revokeObjectURL(it.url)); i2v.items = []; i2vRenderList(); });
$('#i2vCancel').addEventListener('click', () => { if (i2v.abort) i2v.abort.abort(); });
$('#i2vRun').addEventListener('click', () => i2vRun());
async function i2vRun() {
  if (i2v.busy || !i2v.items.length) return;
  const actx = getAudioCtx();
  i2v.busy = true; const abort = new AbortController(); i2v.abort = abort;
  i2vRenderList();
  $('#i2vRun').disabled = true; $('#i2vCancel').hidden = false; $('#i2vEmpty').hidden = true; $('#i2vResult').hidden = true;
  setJob('i2v', 'Creating video…');
  const pm = $('#i2vPrompt').value.trim() ? await understandVideoPrompt($('#i2vPrompt').value) : parseVideoPrompt('');
  if ($('#i2vPrompt').value.trim()) promptToast(pm);
  const stages = new Stages($('#i2vStages'), ['analyze', 'plan', 'enhance', 'music', 'render', 'verify', 'done'], { analyze: 'Analyzing photos', plan: 'Planning sequence & camera moves', enhance: 'Enhancing & colour-matching photos' });
  const items = i2v.items;
  const project = await createProject('i2v', items.length === 1 ? items[0].name : `${items.length}-photo video`, { count: items.length });
  try {
    stages.set('analyze');
    await prepareSlides(items, { onProgress: (p) => stages.progress(p), signal: abort.signal });
    stages.set('plan');
    const aspect = pm.aspect || $('#i2vAspect').value;
    const size = slideshowOutputSize(aspect, items);
    const ord = $('#i2vOrder').value === 'manual' ? { order: items.map((_, i) => i), how: 'kept your order' } : autoOrder(items);
    const opts = {
      outW: size.w, outH: size.h,
      mood: pm.mood || (pm.style === 'energetic' ? 'energetic' : pm.style === 'cinematic' ? 'cinematic' : null) || $('#i2vMood').value,
      pace: pm.pacing === 'tight' || pm.style === 'energetic' ? 'fast' : pm.pacing === 'relaxed' ? 'slow' : $('#i2vPace').value, targetDuration: pm.targetDuration,
      music: pm.music === 'off' ? 'off' : pm.music === 'low' ? 'low' : pm.music ? 'on' : $('#i2vMusic').value,
      title: (pm.title || $('#i2vTitle').value.trim() || '').slice(0, 80),
      transitions: pm.transitions === 'minimal' || (!pm.transitions && $('#i2vTrans').value === 'minimal') ? 'minimal' : 'auto',
      grade: pm.grade, noSfx: pm.noSfx, bright: pm.bright,
    };
    if (pm.noText) opts.title = '';
    const plan = planSlideshow(items, ord.order, opts, i2v.seed);
    stages.detail(`${items.length} photo${items.length > 1 ? 's' : ''} · ${plan.total.toFixed(1)}s · ${size.w}×${size.h} · ${MOODS[plan.mood].label} music`);
    $('#i2vRenderWrap').hidden = false;
    const result = await withRenderLock(() => renderSlideshow(items, plan, opts, {
      canvas: $('#i2vCanvas'), audioCtx: actx, seed: i2v.seed, signal: abort.signal,
      onStage: (s) => stages.set(s), onProgress: (p) => stages.progress(p),
      onPauseChange: (p) => stages.detail(p ? 'Paused because the tab is hidden — come back to continue rendering.' : 'Rendering in real time…'),
    }), () => stages.set('wait'));
    $('#i2vRenderWrap').hidden = true;
    if (i2v.resultUrl) URL.revokeObjectURL(i2v.resultUrl);
    i2v.resultUrl = URL.createObjectURL(result.blob);
    const name = `inera-photo-video${i2v.seed > 1 ? '-v' + i2v.seed : ''}.${U.extForBlob(result.blob)}`;
    const box = $('#i2vResult');
    box.hidden = false;
    box.innerHTML = resultVideoHtml();
    box.querySelector('video').src = i2v.resultUrl + '#t=1';
    box.querySelector('[data-r=fmt]').textContent = `${result.format} · ${result.check.width}×${result.check.height} · ${result.check.duration.toFixed(1)}s · ${U.fmtBytes(result.blob.size)}`;
    box.querySelector('[data-r=dl]').addEventListener('click', () => U.downloadBlob(result.blob, name));
    box.querySelector('[data-r=again]').addEventListener('click', () => { i2v.seed++; i2vRun(); });
    const motions = plan.slides.map((s) => `${esc(items[s.idx].name)}: ${esc(items[s.idx].scene.label)} → ${esc(s.motion.name)}`);
    box.querySelector('[data-r=report]').innerHTML = `<h4>What the AI did</h4>
      <div class="kv"><span>Method</span><span>${esc(SLIDESHOW_METHOD)}</span><span>Order</span><span>${esc(ord.how)}</span>
      <span>Timing</span><span>${(plan.slides[0].dur).toFixed(2)}s per photo = ${plan.slides[0].dur / plan.beat} beats at ${plan.bpm} BPM</span>
      <span>Music</span><span>${opts.music === 'off' ? 'Off' : `${esc(result.music.title)} · ${esc(MOODS[plan.mood].label)}`}</span></div>
      <ul>${motions.slice(0, 12).map((m) => `<li>${m}</li>`).join('')}${motions.length > 12 ? `<li>…and ${motions.length - 12} more</li>` : ''}</ul>
      ${opts.music === 'off' ? '' : `<div class="license">Music licence: ${esc(result.music.license)}</div>`}`;
    const thumb = await U.imageThumb(items[ord.order[0]].img).catch(() => null);
    await finishProject(project, [{ blob: result.opfs ? null : result.blob, opfs: result.opfs, size: result.blob.size, mime: result.blob.type, name, kind: 'video', width: result.check.width, height: result.check.height, duration: result.check.duration, format: result.format }], thumb, { method: SLIDESHOW_METHOD });
    stages.done('Verified: playable video' + (result.check.hasAudio ? ' with audio' : '') + '.');
    toast('Your video is ready.', 'ok');
    setReady('i2v', true);
  } catch (e) {
    $('#i2vRenderWrap').hidden = true;
    stages.error(errorMessage(e));
    if (!i2v.resultUrl) $('#i2vEmpty').hidden = false;
    await failProject(project, e);
  } finally {
    i2v.busy = false; i2v.abort = null; setJob('i2v', null);
    $('#i2vCancel').hidden = true; i2vRenderList();
  }
}

// ======================= MODE 4: VIDEO → IMAGES =======================
const v2i = { file: null, probe: null, busy: false, abort: null, frames: [], fa: null };
for (const [k, v] of Object.entries(FRAME_MODES)) $('#v2iMode').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v)}</option>`);
$('#v2iFormat').value = settings.imageFormat;
$('#v2iMode').addEventListener('change', () => {
  const m = $('#v2iMode').value;
  $('#v2iTsWrap').hidden = m !== 'timestamps';
  $('#v2iIntWrap').hidden = m !== 'all';
});
bindDrop($('#v2iDrop'), $('#v2iInput'), (f) => v2iSet(f[0]));
async function v2iSet(file) {
  if (v2i.busy) return toast('Extraction is running. Cancel it first to load a different video.', 'error');
  $('#v2iRun').disabled = true;
  if (v2i.probe) URL.revokeObjectURL(v2i.probe.url);
  v2i.file = null; v2i.probe = null; v2i.fa = null; v2i.faP = null;
  if (v2i.bgAbort) { v2i.bgAbort.abort(); v2i.bgAbort = null; }
  if (v2i.src) { try { v2i.src.dispose(); } catch (e) { /* ignore */ } v2i.src = null; }
  const probe = await loadVideoFor(file, $('#v2iInfo'), 'Extract best frames', CAN_ENCODE ? U.LIMITS.longVideoMaxSeconds : U.LIMITS.videoMaxSeconds, CAN_ENCODE ? U.LIMITS.longVideoMaxBytes : U.LIMITS.videoMaxBytes);
  if (!probe) return;
  v2i.file = file; v2i.probe = probe;
  $('#v2iRun').disabled = false;
  // start scanning right away (fast WebCodecs decoder when available), while you pick the options
  if (CAN_ENCODE) { try { v2i.src = await openSource(file); } catch (e) { v2i.src = null; } }
  if (v2i.file !== file) return;
  const ab = new AbortController(); v2i.bgAbort = ab; v2i.bgProg = 0; v2i.bgSink = null;
  const faP = analyzeFrames(probe, { src: v2i.src, signal: ab.signal, onProgress: (p) => { v2i.bgProg = p; if (v2i.bgSink) v2i.bgSink(p); } });
  v2i.faP = faP;
  faP.then((fa) => { if (v2i.faP === faP) v2i.fa = fa; }, () => { if (v2i.faP === faP) v2i.faP = null; });
}
$('#v2iCancel').addEventListener('click', () => { if (v2i.abort) v2i.abort.abort(); });
$('#v2iRun').addEventListener('click', async () => {
  if (v2i.busy || !v2i.file) return;
  const mode = $('#v2iMode').value;
  let timestamps = [];
  if (mode === 'timestamps') {
    timestamps = U.parseTimestamps($('#v2iTs').value, v2i.probe.duration);
    if (!timestamps.length) return toast(`Enter at least one timestamp between 0:00 and ${U.fmtTime(v2i.probe.duration)}, e.g. 0:05, 1:12.5`, 'error', 7000);
  }
  v2i.busy = true; const abort = new AbortController(); v2i.abort = abort;
  $('#v2iRun').disabled = true; $('#v2iCancel').hidden = false; $('#v2iEmpty').hidden = true; $('#v2iResult').hidden = true;
  setJob('v2i', 'Extracting frames…');
  const enhance = $('#v2iEnhance').value === 'on';
  const needScan = mode !== 'timestamps' && mode !== 'all';
  const stages = new Stages($('#v2iStages'), needScan ? ['read', 'analyze', 'select', 'extract', 'verify', 'done'] : ['read', 'extract', 'verify', 'done'], { analyze: 'Scanning video (scenes, sharpness, faces)', extract: enhance ? 'Extracting & enhancing images' : 'Extracting full-quality images' });
  const project = await createProject('v2i', v2i.file.name, { duration: v2i.probe.duration });
  try {
    stages.set('read'); stages.progress(1);
    let sel;
    const opts = { mode, count: Number($('#v2iCount').value) || 0, timestamps, interval: Number($('#v2iInterval').value) || 2, includeBlurry: $('#v2iBlurry').checked, resolution: $('#v2iRes').value, format: $('#v2iFormat').value, enhance };
    if (needScan) {
      stages.set('analyze');
      if (!v2i.fa && v2i.faP) {
        // the scan started when the video was loaded: show it from where it is
        stages.progress(v2i.bgProg || 0); v2i.bgSink = (p) => stages.progress(p);
        const stop = () => { if (v2i.bgAbort) v2i.bgAbort.abort(); }; abort.signal.addEventListener('abort', stop);
        try { v2i.fa = await v2i.faP; } finally { abort.signal.removeEventListener('abort', stop); v2i.bgSink = null; }
      }
      if (!v2i.fa) v2i.fa = await analyzeFrames(v2i.probe, { src: v2i.src, onProgress: (p) => stages.progress(p), signal: abort.signal });
      stages.set('select');
      sel = selectFrames(v2i.fa, opts, v2i.probe.duration);
    } else sel = selectFrames({ samples: [], scenes: 1 }, opts, v2i.probe.duration);
    if (!sel.picks.length) throw new Error('No usable frames were found. The video may be blank, black or extremely blurred. Turn on "Include blurred frames" to extract anyway.');
    stages.set('extract');
    const frames = await captureFrames(v2i.probe.url, sel.picks, opts, { onProgress: (p) => stages.progress(p), signal: abort.signal });
    stages.set('verify'); stages.progress(1);
    v2iShow(frames, sel, opts);
    const stem = U.safeFileStem(v2i.file.name);
    await finishProject(project, frames.map((f) => ({ blob: f.blob, name: v2iName(stem, f), kind: 'image', width: f.width, height: f.height, format: f.mime })), frames[0] ? await U.imageThumb(await createImageBitmap(frames[0].blob)).catch(() => null) : null, { stats: sel.stats });
    stages.done(`${frames.length} image${frames.length > 1 ? 's' : ''} extracted and verified.`);
    toast('Frames extracted.', 'ok');
    setReady('v2i', true);
  } catch (e) {
    stages.error(errorMessage(e));
    if (!v2i.frames.length) $('#v2iEmpty').hidden = false;
    await failProject(project, e);
  } finally {
    v2i.busy = false; v2i.abort = null; setJob('v2i', null);
    $('#v2iRun').disabled = !v2i.file; $('#v2iCancel').hidden = true;
  }
});
function v2iName(stem, f) {
  const m = Math.floor(f.t / 60), s = (f.t - m * 60).toFixed(2).padStart(5, '0').replace('.', '_');
  return `${stem}_${m}m${s}s.${U.extForBlob(f.blob)}`;
}
function v2iShow(frames, sel, opts) {
  v2i.frames.forEach((f) => f.url && URL.revokeObjectURL(f.url));
  v2i.frames = frames.map((f) => ({ ...f, url: URL.createObjectURL(f.blob), selected: true }));
  $('#v2iResult').hidden = false;
  const st = sel.stats;
  const fa = v2i.fa;
  $('#v2iReport').innerHTML = `<div class="row"><span class="tag accent"><svg class="ic"><use href="#i-spark"/></svg>${esc(FRAME_MODES[opts.mode])}</span>
    ${fa ? `<span class="tag">${st.candidates} frames analysed</span><span class="tag">${fa.scenes} scene${fa.scenes > 1 ? 's' : ''}</span>` : ''}
    ${st.blurry ? `<span class="tag">${st.blurry} blurred skipped</span>` : ''}${st.black ? `<span class="tag">${st.black} black/blank skipped</span>` : ''}${st.duplicates ? `<span class="tag">${st.duplicates} near-duplicates removed</span>` : ''}
    <span class="tag">${opts.enhance ? 'AI enhanced' : 'Original appearance preserved'}</span></div>`;
  const g = $('#v2iGallery');
  g.innerHTML = '';
  const stem = U.safeFileStem(v2i.file.name);
  v2i.frames.forEach((f) => {
    const el = document.createElement('div');
    el.className = 'g-item';
    el.innerHTML = `<img alt="" loading="lazy"><input type="checkbox" class="g-sel" checked aria-label="Select image"><span class="g-time">${U.fmtTime(f.t, true)}</span>
      <div class="g-meta"><span class="grow" title=""></span><span>${f.width}×${f.height}</span><button class="icon-btn mini" aria-label="Download image"><svg class="ic"><use href="#i-download"/></svg></button></div>`;
    el.querySelector('img').src = f.url;
    el.querySelector('.grow').textContent = f.reason;
    el.querySelector('.grow').title = f.reason;
    el.querySelector('img').addEventListener('click', () => openImageViewer(f.url, `${U.fmtTime(f.t, true)} · ${f.width}×${f.height}`));
    el.querySelector('.g-sel').addEventListener('change', (e) => { f.selected = e.target.checked; $('#v2iAll').checked = v2i.frames.every((x) => x.selected); });
    el.querySelector('button').addEventListener('click', () => U.downloadBlob(f.blob, v2iName(stem, f)));
    g.appendChild(el);
  });
  $('#v2iAll').checked = true;
}
$('#v2iAll').addEventListener('change', (e) => { v2i.frames.forEach((f) => (f.selected = e.target.checked)); $$('#v2iGallery .g-sel').forEach((c) => (c.checked = e.target.checked)); });
async function v2iZip(list, btn) {
  if (!list.length) return toast('Select at least one image.', 'error');
  const stem = U.safeFileStem(v2i.file?.name || 'video');
  if (list.length === 1) return U.downloadBlob(list[0].blob, v2iName(stem, list[0]));
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Zipping…';
  try { U.downloadBlob(await U.makeZip(list.map((f) => ({ name: v2iName(stem, f), blob: f.blob }))), `${stem}-frames.zip`); }
  catch (e) { toast(errorMessage(e), 'error'); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}
$('#v2iZipSel').addEventListener('click', (e) => v2iZip(v2i.frames.filter((f) => f.selected), e.currentTarget));
$('#v2iZipAll').addEventListener('click', (e) => v2iZip(v2i.frames, e.currentTarget));

// ======================= AVATAR STUDIO =======================
const av = { src: 'script', recBlob: null, recorder: null, recTimer: null, upBlob: null, busy: false, abort: null, voiceWav: null, resultUrl: null, glbUrl: null, bgImg: null, seed: 1 };
const AV_BACKGROUNDS = { studio: 'Studio gradient', office: 'Soft office light', dark: 'Dark premium', green: 'Green screen (key it out later)', custom: 'My image…' };
for (const [k, v] of Object.entries(VOICES)) $('#avVoice').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v)}</option>`);
for (const [k, v] of Object.entries(AV_BACKGROUNDS)) $('#avBg').insertAdjacentHTML('beforeend', `<option value="${k}">${esc(v)}</option>`);
$$('#avSrcSeg button').forEach((b) => b.addEventListener('click', () => {
  if (av.busy) return;
  av.src = b.dataset.src;
  $$('#avSrcSeg button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.av-src').forEach((x) => { x.hidden = x.dataset.src !== av.src; });
}));
function avScriptInfo() {
  const t = $('#avScript').value.trim();
  const words = t ? t.split(/\s+/).length : 0;
  const sec = words / 2.5 / Number($('#avSpeed').value);
  $('#avScriptInfo').textContent = `English voices · ${words} words · about ${U.fmtTime(sec)} of speech · recording takes about as long.`;
}
$('#avScript').addEventListener('input', avScriptInfo);
$('#avScript').addEventListener('focus', () => preloadTts(), { once: true }); // voice model downloads while you type
$('#avSpeed').addEventListener('input', (e) => { $('#avSpeedOut').textContent = Number(e.target.value).toFixed(2).replace(/0$/, '') + '×'; avScriptInfo(); });
avScriptInfo();
$('#avAvatar').addEventListener('change', (e) => { $('#avGlbWrap').hidden = e.target.value !== 'custom'; });
$('#avBg').addEventListener('change', (e) => { $('#avBgWrap').hidden = e.target.value !== 'custom'; });
$('#avGlb').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 200 * 1024 * 1024) { toast('That avatar file is larger than 200 MB.', 'error'); e.target.value = ''; return; }
  if (av.glbUrl) URL.revokeObjectURL(av.glbUrl);
  av.glbUrl = URL.createObjectURL(f);
});
$('#avBgImg').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const v = await U.validateImageFile(f); if (!v.ok) { toast(v.error, 'error'); return; }
  try { av.bgImg = (await U.loadImage(f)).img; } catch (err) { toast(err.message, 'error'); }
});
// ---- microphone recording ----
$('#avRecBtn').addEventListener('click', async () => {
  if (av.busy) return;
  if (av.recorder && av.recorder.state === 'recording') { av.recorder.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('This browser cannot record audio here.', 'error');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
  catch (e) { return toast('Microphone access was blocked. Allow the microphone for this site (address-bar icon) and try again.', 'error', 8000); }
  const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  const chunks = [];
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const t0 = Date.now();
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(av.recTimer);
    av.recBlob = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
    const a = $('#avRecAudio'); if (a.src) URL.revokeObjectURL(a.src); a.src = URL.createObjectURL(av.recBlob); a.hidden = false;
    $('#avRecBtn').innerHTML = '<svg class="ic"><use href="#i-mic"/></svg>Record again';
    $('#avRecBtn').classList.remove('danger');
    $('#rfVoice').disabled = false; av.voiceWav = null;
    toast(`Recorded ${U.fmtTime((Date.now() - t0) / 1000)}. Press "Create Avatar Video".`, 'ok');
  };
  rec.start(1000);
  av.recorder = rec;
  preloadAsr('auto'); // speech model downloads while you talk
  $('#avRecBtn').innerHTML = '<span class="rec-dot"></span>Stop recording';
  $('#avRecBtn').classList.add('danger');
  av.recTimer = setInterval(() => { const sec = (Date.now() - t0) / 1000; $('#avRecTime').textContent = U.fmtTime(sec); if (sec > 30 * 60 && rec.state === 'recording') { rec.stop(); toast('Recording stopped at the 30-minute limit.', 'info'); } }, 250);
});
bindDrop($('#avAudDrop'), $('#avAudInput'), async (files) => {
  const f = files[0];
  if (!f) return;
  if (f.size > 1024 * 1024 * 1024) return toast('Voice files up to 1 GB are supported.', 'error');
  av.upBlob = f; $('#rfVoice').disabled = false; av.voiceWav = null;
  $('#avAudInfo').textContent = `${f.name} · ${U.fmtBytes(f.size)}`;
});
$('#rfConsent').addEventListener('change', (e) => { $('#rfNotebook').disabled = !e.target.checked; });
$('#rfNotebook').addEventListener('click', async () => {
  try { const r = await fetch('inera-realface-lipsync.ipynb'); if (!r.ok) throw new Error('HTTP ' + r.status); U.downloadBlob(new Blob([await r.arrayBuffer()], { type: 'application/x-ipynb+json' }), 'inera-realface-lipsync.ipynb'); }
  catch (e) { toast('Could not load the notebook file: ' + e.message, 'error'); }
});
$('#rfVoice').addEventListener('click', () => {
  if (av.voiceWav) return U.downloadBlob(av.voiceWav, 'inera-voice.wav');
  const b = av.src === 'record' ? av.recBlob : av.src === 'upload' ? av.upBlob : null;
  if (b) U.downloadBlob(b, av.src === 'upload' ? av.upBlob.name : `inera-voice.${b.type.includes('mp4') ? 'm4a' : b.type.includes('ogg') ? 'ogg' : 'webm'}`);
  else toast('Create a voice first (script or recording).', 'info');
});
function wavBlob(f32, sr) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), true);
  return new Blob([buf], { type: 'audio/wav' });
}
// decode any audio/video file to mono Float32 at `rate`
async function decodeVoice(blob, rate) {
  const ab = await blob.arrayBuffer();
  let buf;
  try { buf = await new OfflineAudioContext(1, 1, rate).decodeAudioData(ab); }
  catch (e) { throw new Error('This browser could not decode that voice file. Use WAV, MP3, M4A or WebM.'); }
  const n = buf.length, ch = buf.numberOfChannels, out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}
function resample(f32, from, to) {
  if (from === to) return f32;
  const n = Math.floor(f32.length * to / from), out = new Float32Array(n), r = from / to;
  // windowed average (anti-alias for downsampling speech)
  for (let i = 0; i < n; i++) { const a = i * r, b = a + r; let s = 0, c = 0; for (let k = Math.floor(a); k < Math.min(f32.length, Math.ceil(b)); k++) { s += f32[k]; c++; } out[i] = c ? s / c : 0; }
  return out;
}
function transcriptFromWords(words, sentences, offset = 0) {
  const segs = [];
  for (const s of sentences) {
    const ws = words.filter((w) => w.s >= s.s - 1e-3 && w.s < s.e).map((w) => ({ w: w.w, s: w.s + offset, e: w.e + offset }));
    if (ws.length) segs.push({ start: ws[0].s, end: ws[ws.length - 1].e, text: ws.map((w) => w.w).join(' '), words: ws });
  }
  return { language: 'en', segments: segs };
}
$('#avCancel').addEventListener('click', () => { if (av.abort) av.abort.abort(); });
$('#avRun').addEventListener('click', () => avRun());
async function avRun() {
  if (av.busy) return;
  const src = av.src;
  const script = $('#avScript').value.trim();
  if (src === 'script') {
    if (script.split(/\s+/).length < 2) return toast('Type a script of at least a few words.', 'error');
    const nonLatin = (script.match(/[^\u0000-ɏḀ-ỿ -⁯₠-⃏\s]/g) || []).length;
    if (nonLatin > script.length * 0.15) return toast('The built-in voices speak English only. For other languages, record or upload your own voice — captions and lip-sync still work.', 'error', 9000);
  }
  if (src === 'record' && !av.recBlob) return toast('Record your voice first.', 'error');
  if (src === 'upload' && !av.upBlob) return toast('Choose a voice file first.', 'error');
  if ($('#avAvatar').value === 'custom' && !av.glbUrl) return toast('Choose your .glb avatar file, or pick the built-in presenter.', 'error');
  if ($('#avBg').value === 'custom' && !av.bgImg) return toast('Choose a background image, or pick another background.', 'error');
  if (typeof MediaRecorder === 'undefined') return toast('This browser cannot record video. Use Chrome, Edge or Safari.', 'error');
  const edit = $('#avEdit').value;
  const canEdit = CAN_ENCODE && edit !== 'off';
  if (edit !== 'off' && !CAN_ENCODE) toast('Auto-edit needs desktop Chrome or Edge — you will get the raw presenter video.', 'info', 7000);
  av.busy = true; const abort = new AbortController(); av.abort = abort;
  $('#avRun').disabled = true; $('#avCancel').hidden = false; $('#avEmpty').hidden = true; $('#avResult').hidden = true;
  setJob('avatar', 'Creating avatar video…');
  const first = src === 'script' ? ['voice'] : ['read', 'transcribe'];
  const editIds = canEdit ? ['analyze', 'plan', 'visuals', 'music', 'render', 'verify'] : ['verify'];
  const stages = new Stages($('#avStages'), [...first, 'stage', 'perform', ...editIds, 'done'], {
    voice: 'Generating natural voice', read: 'Reading your voice', transcribe: 'Transcribing (for lip-sync & captions)', download: 'Downloading model (one time)',
    stage: 'Loading the presenter', perform: CAN_ENCODE ? 'Rendering the presenter (frame by frame)' : 'Recording the performance (real time)', analyze: 'Analyzing the recording', plan: 'Directing the edit', visuals: 'Finding topic visuals', music: 'Composing music & mixing', render: 'Rendering & encoding',
  });
  const aspect = $('#avAspect').value;
  const [W, H] = aspect === '16:9' ? [1920, 1080] : aspect === '1:1' ? [1080, 1080] : [1080, 1920];
  const project = await createProject('avatar', src === 'script' ? (script.slice(0, 40) + (script.length > 40 ? '…' : '')) : 'Avatar video (my voice)', { source: src });
  let head = null, AV = null, wakeLock = null;
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ }
  try {
    // 1) voice + exact word timings
    let audioF32, sr, words, transcript;
    const onDl = (m, before) => { stages.enter('download', before); if (m && m.total) { stages.progress(m.loaded / m.total); stages.detail(`${U.fmtBytes(m.loaded)} of ${U.fmtBytes(m.total)} — free, one time, cached afterwards.`); } };
    if (src === 'script') {
      stages.set('voice');
      const tts = await speakScript(script, { voice: $('#avVoice').value, speed: Number($('#avSpeed').value), signal: abort.signal, onProgress: (p) => { if (stages.ids[stages.cur] !== 'voice') stages.set('voice'); stages.progress(p); }, onDownload: (m) => onDl({ loaded: m.loaded, total: m.total }, 'voice') });
      audioF32 = tts.audio; sr = tts.sampleRate; words = tts.words;
      transcript = transcriptFromWords(tts.words, tts.sentences);
      av.voiceWav = wavBlob(audioF32, sr); $('#rfVoice').disabled = false;
    } else {
      stages.set('read');
      const blob = src === 'record' ? av.recBlob : av.upBlob;
      sr = 24000;
      audioF32 = await decodeVoice(blob, sr);
      if (audioF32.length / sr > 30 * 60 + 1) throw new Error('Voice recordings up to 30 minutes are supported in Avatar Studio.');
      let pk = 0; for (let i = 0; i < audioF32.length; i++) pk = Math.max(pk, Math.abs(audioF32[i]));
      if (pk < 0.01) throw new Error('The recording is silent. Check your microphone and try again.');
      if (pk < 0.5) { const g = 0.8 / pk; for (let i = 0; i < audioF32.length; i++) audioF32[i] *= g; }
      stages.set('transcribe');
      const tr = await transcribe(resample(audioF32, sr, 16000), { model: 'auto', signal: abort.signal, onProgress: (p) => { if (stages.ids[stages.cur] !== 'transcribe') stages.set('transcribe'); stages.progress(p); }, onDownload: (m) => { if (m.phase === 'download') onDl(m, 'transcribe'); else if (m.phase === 'load') stages.set('transcribe'); } });
      if (!tr.segments.length) throw new Error('No speech was recognised in the recording.');
      transcript = { language: tr.language, segments: tr.segments };
      words = tr.segments.flatMap((sg) => sg.words || []);
    }
    checkAbortSafe(abort.signal);
    // 2) presenter
    stages.set('stage', 'Loading the 3D presenter…');
    AV = await import('./avatar.js');
    $('#avStageWrap').hidden = false;
    const box = $('#avStage'); box.innerHTML = '';
    head = await AV.createStage(box, { avatar: 'female', customUrl: $('#avAvatar').value === 'custom' ? av.glbUrl : null, background: $('#avBg').value, bgImg: av.bgImg, W, H, view: $('#avView').value, onProgress: (p) => stages.progress(p) });
    const story = await understand(transcript);
    const gestures = $('#avGest').value === 'off' ? [] : AV.planGestures(story, words);
    const audioBuffer = new AudioBuffer({ length: audioF32.length, sampleRate: sr, numberOfChannels: 1 });
    audioBuffer.copyToChannel(audioF32, 0);
    // 3) perform: offline frame-exact render (Chrome/Edge) or real-time recording (other browsers)
    let rec, recOnDisk = false;
    if (CAN_ENCODE) {
      stages.set('perform', `Rendering ${U.fmtTime(audioBuffer.duration)} frame by frame — smooth on any computer.`);
      const r = await AV.renderOffline(head, { voice: audioF32, sr, words, gestures, mood: $('#avMood').value, name: 'inera-avatar-raw' }, { signal: abort.signal, onProgress: (p) => stages.progress(p) });
      rec = { file: r.file, mime: r.mime, startOffset: r.voiceStart, label: r.label, fileName: r.fileName };
      recOnDisk = r.onDisk;
    } else {
      stages.set('perform', `Performing ${U.fmtTime(audioBuffer.duration)} in real time — keep this tab visible.`);
      rec = await AV.performAndRecord(head, { audioBuffer, words, gestures, mood: $('#avMood').value }, { signal: abort.signal, onProgress: (p) => stages.progress(p) });
      rec.label = rec.mime === 'video/mp4' ? 'MP4' : 'WebM'; rec.fileName = rec.file.name;
    }
    AV.disposeStage(head); head = null; $('#avStageWrap').hidden = true;
    let finalFile = rec.file, label = rec.label, onDisk = recOnDisk, fileName = rec.fileName, decisions = [`Presenter performed ${words.length} words with lip-sync, blinks, head motion${gestures.length ? ` and ${gestures.length} gesture${gestures.length > 1 ? 's' : ''}` : ''}`], extras = [];
    // 4) optional auto-edit with the known transcript
    if (canEdit) {
      const srcV = await openSource(rec.file);
      try {
        const shifted = { language: transcript.language, segments: transcript.segments.map((sg) => ({ ...sg, start: sg.start + rec.startOffset, end: sg.end + rec.startOffset, words: sg.words.map((w) => ({ ...w, s: w.s + rec.startOffset, e: w.e + rec.startOffset })) })) };
        const an = await analyzeMedia(srcV, { knownTranscript: shifted, signal: abort.signal, onStage: (st) => stages.set(st === 'audio' ? 'analyze' : st, ''), onProgress: (p) => stages.progress(p) });
        stages.set('plan');
        const capsOnly = edit === 'captions';
        const opts = { aspect: 'auto', style: 'auto', captions: 'auto', broll: capsOnly ? 'off' : 'auto', graphics: capsOnly ? 'off' : 'auto', music: capsOnly ? 'off' : 'auto', sfx: capsOnly ? 'off' : 'auto', hook: 'off', synthetic: true, stabilize: 'off', title: $('#avTitle').value.trim().slice(0, 80), removeRetakes: src !== 'script', topicChip: !capsOnly };
        const edl = planV2(an, opts, av.seed);
        const res = await withRenderLock(() => renderV2({ src: srcV, an, edl, canvas: $('#avCanvas'), online: $('#avOnline').value === 'on', signal: abort.signal, name: 'inera-avatar', onStage: (st) => { stages.set(st); if (st === 'render') $('#avRenderWrap').hidden = false; }, onProgress: (p) => stages.progress(p) }), () => stages.set('wait'));
        $('#avRenderWrap').hidden = true;
        if (an.store) { try { an.store.dispose(); } catch (e) { /* ignore */ } }
        if (recOnDisk) deleteRenderFile(rec.fileName); // intermediate presenter render no longer needed
        finalFile = res.file; label = res.label; onDisk = res.onDisk; fileName = res.fileName;
        decisions.push(...edl.decisions);
        if (edl.subtitles.length) extras.push({ name: 'inera-avatar.srt', blob: textBlob(groupsToSrt(edl.subtitles), 'application/x-subrip'), label: 'Subtitles (SRT)' });
        extras.push({ name: 'inera-avatar-description.txt', blob: textBlob(descriptionText(edl, res.credits, res.music)), label: 'Title, hashtags & credits' });
      } finally { srcV.dispose(); }
    } else {
      stages.set('verify');
      const chk = await U.verifyVideoBlob(rec.file, { expectAudio: true });
      if (!chk.ok) throw new Error(chk.error);
    }
    if (av.voiceWav) extras.push({ name: 'inera-voice.wav', blob: av.voiceWav, label: 'Voice (WAV) for the real-face notebook' });
    // 5) show
    if (av.resultUrl) URL.revokeObjectURL(av.resultUrl);
    av.resultUrl = URL.createObjectURL(finalFile);
    const vname = `inera-avatar-${Date.now().toString(36)}.${fileName.split('.').pop()}`;
    const rbox = $('#avResult'); rbox.hidden = false; rbox.innerHTML = resultVideoHtml();
    rbox.querySelector('video').src = av.resultUrl;
    rbox.querySelector('[data-r=fmt]').textContent = `${label} · ${W}×${H} · ${U.fmtBytes(finalFile.size)} · AI-generated presenter`;
    rbox.querySelector('[data-r=dl]').addEventListener('click', () => U.downloadBlob(finalFile, vname));
    rbox.querySelector('[data-r=again]').addEventListener('click', () => { av.seed++; avRun(); });
    const dls = document.createElement('div'); dls.className = 'extra-dl';
    for (const x of extras) { const b = document.createElement('button'); b.className = 'btn ghost sm'; b.innerHTML = `<svg class="ic"><use href="#i-download"/></svg>${esc(x.label)}`; b.addEventListener('click', () => U.downloadBlob(x.blob, x.name)); dls.appendChild(b); }
    rbox.querySelector('.toolbar').after(dls);
    rbox.querySelector('[data-r=report]').innerHTML = `<h4>What the AI did</h4><ul>${decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul><div class="license">Voice: ${src === 'script' ? 'Kokoro-82M (Apache-2.0), generated on your device' : 'your own recording'}. Presenter: MakeHuman/MPFB avatar (CC0) animated with TalkingHead (MIT).</div>`;
    const thumb = await U.grabVideoThumb(av.resultUrl, 1).catch(() => null);
    const outs = [{ blob: onDisk ? null : finalFile, opfs: onDisk ? fileName : null, size: finalFile.size, mime: finalFile.type, name: vname, kind: 'video', width: W, height: H, format: label }];
    for (const x of extras) outs.push({ blob: x.blob, name: x.name, kind: 'text', format: x.label });
    await finishProject(project, outs, thumb, { decisions });
    stages.done('Verified: playable video with audio.');
    toast('Your avatar video is ready.', 'ok');
    setReady('avatar', true);
  } catch (e) {
    $('#avStageWrap').hidden = true; $('#avRenderWrap').hidden = true;
    stages.error(errorMessage(e));
    if (!av.resultUrl) $('#avEmpty').hidden = false;
    await failProject(project, e);
  } finally {
    if (head && AV) { try { AV.disposeStage(head); } catch (e) { /* ignore */ } }
    try { wakeLock && wakeLock.release(); } catch (e) { /* ignore */ }
    av.busy = false; av.abort = null; setJob('avatar', null);
    $('#avRun').disabled = false; $('#avCancel').hidden = true;
  }
}
function checkAbortSafe(signal) { if (signal && signal.aborted) throw new U.AbortError(); }

// ======================= Viewer =======================
let viewerUrls = [];
function openImageViewer(url, caption) {
  const body = $('#viewerBody');
  body.innerHTML = `<img alt="" class="viewer-img"><p class="muted"></p>`;
  body.querySelector('img').src = url;
  body.querySelector('p').textContent = caption;
  $('#viewer').hidden = false;
}
async function openViewer(id) {
  const p = await S.getProject(id);
  if (!p) return toast('Project not found.', 'error');
  const body = $('#viewerBody');
  viewerUrls.forEach((u) => URL.revokeObjectURL(u)); viewerUrls = [];
  body.innerHTML = `<h3></h3><p class="muted">${esc(MODE_LABEL[p.mode] || '')} · ${esc(fmtDate(p.updatedAt))} · ${p.outputs.length} file${p.outputs.length === 1 ? '' : 's'}</p><div class="vbody"></div>`;
  body.querySelector('h3').textContent = p.title;
  const vb = body.querySelector('.vbody');
  const blobs = [];
  for (const o of p.outputs) blobs.push(await S.getOutputBlob(o).catch(() => null));
  if (blobs.some((b) => !b)) vb.insertAdjacentHTML('beforeend', '<p class="stage-error">Some files are missing from browser storage (they may have been cleared by the browser).</p>');
  const vids = p.outputs.map((o, i) => i).filter((i) => p.outputs[i].kind === 'video' && blobs[i]);
  const imgs = p.outputs.map((o, i) => i).filter((i) => p.outputs[i].kind === 'image' && blobs[i]);
  const others = p.outputs.map((o, i) => i).filter((i) => !['video', 'image'].includes(p.outputs[i].kind) && blobs[i]);
  for (const i of vids) {
    const o = p.outputs[i]; const u = URL.createObjectURL(blobs[i]); viewerUrls.push(u);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<video class="result-video" controls playsinline></video><div class="toolbar"><span class="tag"></span><span class="grow"></span><button class="btn primary sm" data-dl="${i}"><svg class="ic"><use href="#i-download"/></svg>Download</button></div>`;
    wrap.querySelector('video').src = u;
    wrap.querySelector('.tag').textContent = `${o.format || ''} · ${o.width}×${o.height}${o.duration ? ' · ' + U.fmtTime(o.duration) : ''} · ${U.fmtBytes(o.size || blobs[i].size)}`;
    vb.appendChild(wrap);
  }
  if (imgs.length) {
    const grid = document.createElement('div'); grid.className = 'viewer-grid';
    for (const i of imgs) {
      const o = p.outputs[i]; const u = URL.createObjectURL(blobs[i]); viewerUrls.push(u);
      const fig = document.createElement('figure');
      fig.innerHTML = `<img alt=""><figcaption><span></span><button class="icon-btn mini" data-dl="${i}" aria-label="Download"><svg class="ic"><use href="#i-download"/></svg></button></figcaption>`;
      fig.querySelector('img').src = u; fig.querySelector('span').textContent = `${o.width}×${o.height}`;
      grid.appendChild(fig);
    }
    vb.appendChild(grid);
  }
  if (others.length) {
    const box = document.createElement('div'); box.className = 'extra-dl';
    for (const i of others) { const b = document.createElement('button'); b.className = 'btn ghost sm'; b.dataset.dl = String(i); b.innerHTML = '<svg class="ic"><use href="#i-download"/></svg><span></span>'; b.querySelector('span').textContent = p.outputs[i].format || p.outputs[i].name; box.appendChild(b); }
    vb.appendChild(box);
  }
  if (p.outputs.length > 1) vb.insertAdjacentHTML('beforeend', '<div class="actions end"><button class="btn primary sm" data-zip><svg class="ic"><use href="#i-zip"/></svg>Download all as ZIP</button></div>');
  if (p.report && p.report.decisions) vb.insertAdjacentHTML('beforeend', `<div class="report"><h4>What the AI did</h4><ul>${p.report.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`);
  vb.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.dl); if (blobs[i]) U.downloadBlob(blobs[i], p.outputs[i].name); }));
  const z = vb.querySelector('[data-zip]');
  if (z) z.addEventListener('click', () => zipOutputs(p.outputs.map((o, i) => ({ name: o.name, blob: blobs[i] })).filter((x) => x.blob), `${U.safeFileStem(p.title)}.zip`, z));
  $('#viewer').hidden = false;
}
// ZIP in memory is fine for photos and text; very large videos are downloaded one by one instead.
async function zipOutputs(files, zipName, btn) {
  const total = files.reduce((a, f) => a + f.blob.size, 0);
  if (total > 1.5 * 1024 * 1024 * 1024) { toast('These files are too large to zip in the browser — downloading them one by one.', 'info'); for (const f of files) { U.downloadBlob(f.blob, f.name); await U.sleep(400); } return; }
  const old = btn ? btn.innerHTML : ''; if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Zipping…'; }
  try { U.downloadBlob(await U.makeZip(files), zipName); } catch (e) { toast(errorMessage(e), 'error'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

// ======================= Projects & Downloads =======================
let projFilter = 'all';
$$('#projFilters .chip').forEach((c) => c.addEventListener('click', () => { projFilter = c.dataset.f; $$('#projFilters .chip').forEach((x) => x.classList.toggle('active', x === c)); renderProjects(); }));
async function downloadProject(p) {
  const blobs = await Promise.all(p.outputs.map((o) => S.getOutputBlob(o).catch(() => null)));
  const files = p.outputs.map((o, i) => ({ name: o.name, blob: blobs[i] })).filter((f) => f.blob);
  if (!files.length) return toast('Files are no longer in browser storage.', 'error');
  if (files.length === 1) U.downloadBlob(files[0].blob, files[0].name);
  else await zipOutputs(files, `${U.safeFileStem(p.title)}.zip`);
}
async function renderProjects() {
  const box = $('#projList');
  let all = await S.listProjects().catch(() => []);
  all = all.filter((p) => projFilter === 'all' || (projFilter === 'done' && p.status === 'done') || (projFilter === 'processing' && p.status === 'processing') || (projFilter === 'failed' && ['failed', 'interrupted', 'cancelled'].includes(p.status)));
  if (!all.length) { box.innerHTML = '<div class="empty-mini">Nothing here yet.</div>'; return; }
  box.innerHTML = '';
  for (const p of all) {
    const row = document.createElement('div');
    row.className = 'proj-row';
    const tu = await thumbUrl(p);
    row.innerHTML = `<div class="thumb">${tu ? '' : '<svg class="ic"><use href="#i-projects"/></svg>'}</div>
      <div class="pm"><b></b><small>${esc(MODE_LABEL[p.mode])} · ${esc(fmtDate(p.updatedAt))}${p.outputs?.length ? ` · ${p.outputs.length} file${p.outputs.length > 1 ? 's' : ''} · ${U.fmtBytes(p.outputs.reduce((a, o) => a + (o.size || 0), 0))}` : ''}</small>${p.error ? `<span class="err">${esc(p.error)}</span>` : ''}</div>
      <span class="status ${p.status}">${esc(STATUS_LABEL[p.status] || p.status)}</span>
      <div class="row-actions">${p.status === 'done' ? '<button class="btn ghost sm" data-a="open">Open</button><button class="btn ghost sm" data-a="dl"><svg class="ic"><use href="#i-download"/></svg></button>' : `<button class="btn ghost sm" data-a="go">Go to ${esc(MODE_LABEL[p.mode])}</button>`}<button class="btn ghost sm" data-a="del" aria-label="Delete project"><svg class="ic"><use href="#i-trash"/></svg></button></div>`;
    if (tu) row.querySelector('.thumb').style.backgroundImage = `url("${tu}")`;
    row.querySelector('b').textContent = p.title;
    row.querySelector('[data-a=open]')?.addEventListener('click', () => openViewer(p.id));
    row.querySelector('[data-a=dl]')?.addEventListener('click', () => downloadProject(p));
    row.querySelector('[data-a=go]')?.addEventListener('click', () => go(p.mode));
    row.querySelector('[data-a=del]').addEventListener('click', async () => {
      if (p.status === 'processing' && jobs.has(p.mode)) return toast('This project is still processing.', 'error');
      if (!confirm(`Delete "${p.title}" and its files from this browser?`)) return;
      await S.deleteProject(p.id); renderProjects();
    });
    box.appendChild(row);
  }
}
async function renderDownloads() {
  const box = $('#dlList');
  const all = (await S.listProjects().catch(() => [])).filter((p) => p.status === 'done');
  const rows = [];
  for (const p of all) for (const o of p.outputs) rows.push({ p, o });
  if (!rows.length) { box.innerHTML = '<div class="empty-mini">No downloads yet. Finished outputs from all four modes appear here.</div>'; return; }
  box.innerHTML = '';
  for (const { p, o } of rows.slice(0, 300)) {
    const row = document.createElement('div');
    row.className = 'dl-row';
    const dims = o.width ? `${o.width}×${o.height} · ` : '';
    row.innerHTML = `<div class="thumb"><svg class="ic"><use href="#i-${o.kind === 'video' ? 'video' : o.kind === 'image' ? 'image' : 'download'}"/></svg></div><div class="pm"><b></b><small>${esc(MODE_LABEL[p.mode] || '')} · ${dims}${o.duration ? U.fmtTime(o.duration) + ' · ' : ''}${U.fmtBytes(o.size)} · ${esc(fmtDate(p.updatedAt))}</small></div><div class="row-actions"><button class="btn primary sm"><svg class="ic"><use href="#i-download"/></svg>Download</button></div>`;
    row.querySelector('b').textContent = o.name;
    row.querySelector('button').addEventListener('click', async () => { const b = await S.getOutputBlob(o).catch(() => null); if (b) U.downloadBlob(b, o.name); else toast('This file is no longer in browser storage.', 'error'); });
    if (o.kind === 'image') S.getBlob(o.blobKey).then((b) => { if (b) { const u = URL.createObjectURL(b); viewerUrls.push(u); const th = row.querySelector('.thumb'); th.innerHTML = ''; th.style.backgroundImage = `url("${u}")`; } }).catch(() => {});
    else if (p.thumbKey) thumbUrl(p).then((u) => { if (u) { const th = row.querySelector('.thumb'); th.innerHTML = ''; th.style.backgroundImage = `url("${u}")`; } });
    box.appendChild(row);
  }
}

// ======================= Settings =======================
try { localStorage.removeItem('inera-asr-ep'); } catch (e) { /* storage blocked */ } // old experimental setting
$('#setFormat').value = settings.imageFormat;
$('#setQuality').value = Math.round(settings.imageQuality * 100);
$('#setQualityOut').textContent = Math.round(settings.imageQuality * 100);
$('#setHistory').value = String(settings.historyLimit);
$('#setFormat').addEventListener('change', (e) => { settings.imageFormat = e.target.value; S.saveSettings(settings); $('#imgFormat').value = settings.imageFormat; $('#v2iFormat').value = settings.imageFormat; toast('Saved.', 'ok', 1500); });
$('#setQuality').addEventListener('input', (e) => { $('#setQualityOut').textContent = e.target.value; });
$('#setQuality').addEventListener('change', (e) => { settings.imageQuality = Number(e.target.value) / 100; S.saveSettings(settings); img.items.forEach((it) => it.versions.forEach((v) => (v.full = {}))); toast('Saved.', 'ok', 1500); });
$('#setHistory').addEventListener('change', async (e) => { settings.historyLimit = Number(e.target.value); S.saveSettings(settings); await S.enforceHistoryLimit(settings.historyLimit); toast('Saved.', 'ok', 1500); });
$('#setPersist').addEventListener('click', async () => { const ok = await S.requestPersistence(); toast(ok ? 'Persistent storage granted — the browser will not auto-clear your projects.' : 'The browser did not grant persistent storage (it decides based on usage). Your projects are still saved normally.', ok ? 'ok' : 'info', 7000); renderSettings(); });
$('#setClear').addEventListener('click', async () => {
  if (jobs.size) return toast('Wait for running jobs to finish first.', 'error');
  if (!confirm('Delete ALL projects and saved outputs from this browser? This cannot be undone.')) return;
  await S.clearAll(); thumbUrls.forEach((u) => URL.revokeObjectURL(u)); thumbUrls.clear(); toast('All projects deleted.', 'ok'); renderSettings();
});
async function renderSettings() {
  const e = await S.storageEstimate();
  const pct = e.quota ? Math.min(100, (e.usage / e.quota) * 100) : 0;
  $('#storageFill').style.width = pct.toFixed(1) + '%';
  const persistent = await S.isPersistentAvailable();
  $('#storageText').textContent = `${U.fmtBytes(e.usage)} used of about ${U.fmtBytes(e.quota)} available to this site. ${e.persisted ? 'Persistent storage is ON.' : 'Persistent storage is off (the browser may clear data if the disk gets full).'}${persistent ? '' : ' IndexedDB is unavailable (private mode?) — projects last only until you close this tab.'}`;
  const mime = U.pickRecorderMime();
  let webgl = false; try { webgl = !!document.createElement('canvas').getContext('webgl'); } catch (err) {}
  const L = U.LIMITS;
  const rows = [
    ['Photo size', `${U.fmtBytes(L.imageMaxBytes)} · ${L.imageMaxMegapixels} MP max`, `Processed at up to ${L.imageProcessMegapixels} MP`],
    ['Photos per batch', `${L.imageMaxCount}`, 'Mode 1'],
    ['Photos per video', `${L.slideshowMaxImages}`, 'Mode 3'],
    ['Video length (Video Editor)', CAN_ENCODE ? `Up to ${L.longVideoMaxSeconds / 3600} hours · ${U.fmtBytes(L.longVideoMaxBytes)}` : `Up to ${L.videoMaxSeconds / 60} minutes · ${U.fmtBytes(L.videoMaxBytes)}`, CAN_ENCODE ? 'AI editor (WebCodecs, rendered to disk)' : 'Classic editor — use desktop Chrome/Edge for long videos'],
    ['Extracted images', `${L.framesMaxCount} per run`, 'Mode 4'],
    ['Simultaneous renders', '1 video at a time', 'Others wait in a queue'],
    ['Video export format', CAN_ENCODE ? 'Checked on the self-test page' : mime ? U.describeMime(mime) : 'Not supported in this browser', CAN_ENCODE ? 'MP4 (H.264) where available, else WebM (VP9)' : mime && mime.startsWith('video/mp4') ? 'Best compatibility' : 'Use Chrome/Edge/Safari for MP4'],
    ['GPU (WebGL)', webgl ? 'Available' : 'Not available', webgl ? 'Used for video rendering' : 'Video modes will not work'],
    ['CPU threads', String(navigator.hardwareConcurrency || '?'), navigator.deviceMemory ? `~${navigator.deviceMemory} GB RAM reported` : ''],
  ];
  $('#limitsTable').innerHTML = rows.map(([a, b, c]) => `<div><span>${esc(a)}</span><b>${esc(b)}</b><span>${esc(c)}</span></div>`).join('') + '<div><span>Full device check</span><b><a href="self-test.html">Open self-test</a></b><span>Codecs, storage, model downloads, web images</span></div>';
}

// ======================= Help =======================
function renderHelp() {
  if ($('#helpContent').dataset.done) return;
  $('#helpContent').dataset.done = '1';
  $('#helpContent').innerHTML = `
  <div class="panel"><h3>The 30-second version</h3><ul>
    <li>Pick a mode on the dashboard (or drop a file in the big upload box).</li>
    <li>Press the one big button. No prompt, no timeline, no music hunting needed.</li>
    <li>Watch the stages (with time left), preview, download. Everything is also saved under <b>Recent Projects</b> and <b>Downloads</b>.</li>
    <li>Optional: open <b>Customize</b> for captions style, length, aspect ratio, visuals, speaker name — or type a request like "Create a 30-second Reel".</li>
    <li>New computer? Open the <a href="self-test.html">device self-test</a> once — it tells you exactly what this browser supports.</li></ul></div>
  <div class="panel"><h3>Privacy &amp; cost</h3><ul>
    <li>Your photos, videos and voice are processed <b>inside your browser</b>. They are never uploaded to any server.</li>
    <li>No sign-up, no login, no payment, no API keys. You can't be "signed out".</li>
    <li>Free AI models (speech recognition ~160 MB, voice ~90 MB) download once from Hugging Face and are cached by your browser. Topic photos are searched on Wikimedia Commons / Openverse (only the keyword is sent) — you can switch that off.</li>
    <li>Projects are stored in this browser on this device. Clearing browser data deletes them.</li></ul></div>
  <div class="panel span2"><h3>Honest capability list</h3><table>
    <tr><th>Feature</th><th>Status</th><th>How it works</th></tr>
    <tr><td>Following your prompt</td><td class="yes">Yes</td><td>Optional — write it in simple words ("make it professional for LinkedIn with subtitles", "it's a wedding video, make it emotional"). Exact instructions (numbers, titles, colours, positions) are read precisely, and every phrase is also matched by meaning with a small on-device language model (all-MiniLM-L6-v2, 23 MB once). Green chips show what will be applied; anything not understood or not possible is shown — never silently ignored. It controls the editor's real settings; it cannot invent new content.</td></tr>
    <tr><td>Speech-to-text captions</td><td class="yes">Yes</td><td>OpenAI Whisper (base or tiny) running on your device; word-timed captions, 99 languages, SRT/VTT export. Accuracy is very good for clear speech; check names and jargon before publishing.</td></tr>
    <tr><td>Understanding what you say</td><td class="yes">Yes</td><td>Sentences, topics, questions, numbers, lists and calls-to-action are detected from the transcript. Retakes, fillers (um/uh) and long pauses are cut. Topic detection is strongest in English.</td></tr>
    <tr><td>Topic visuals (B-roll)</td><td class="yes">Yes</td><td>When you mention concrete things (pizza, Paris, laptop…) a matching visual appears: your own clips first, then free CC0 / public-domain / CC BY photos from Wikimedia Commons and Openverse (credits exported), else an offline illustration. It does not generate new images.</td></tr>
    <tr><td>Graphics</td><td class="yes">Yes</td><td>Animated key numbers, subscribe button on calls-to-action, topic chip, title, name lower-third, chapter cards, hook opening, punch-in zooms, sound effects.</td></tr>
    <tr><td>Long videos</td><td class="yes">Yes</td><td>1 second to 3 hours in desktop Chrome / Edge (rendered to disk, faster than real time on most computers). Other browsers: classic editor up to 5 minutes.</td></tr>
    <tr><td>Avatar presenter</td><td class="yes">Yes</td><td>3D presenter (CC0) with lip-sync, blinks, eye contact, head nods, hand gestures and emotions. Script voice: Kokoro (English). Any language with your own recorded voice.</td></tr>
    <tr><td>Your real face talking</td><td class="part">Via Colab</td><td>Free Google Colab notebook (LatentSync 1.5) on a free GPU — a browser cannot run it. Not verified on a GPU by the builder; licence note inside.</td></tr>
    <tr><td>Photo enhancement</td><td class="yes">Yes</td><td>White balance, exposure, shadows/highlights, clarity, vibrance with skin protection, sharpening, noise reduction.</td></tr>
    <tr><td>Background removal &amp; designs</td><td class="yes">Yes</td><td>U²-Net subject cut-out on your device: transparent PNG, blur, studio, white, colour or your image; YouTube thumbnail, Instagram post and Story designs.</td></tr>
    <tr><td>Background music</td><td class="yes">Yes</td><td>Original music composed on your device for each edit. Royalty-free, commercial use allowed. It ducks under speech automatically.</td></tr>
    <tr><td>Removing music from a video</td><td class="no">No</td><td>Separating a song from a voice needs a large model that is not practical in a browser. "Mute original audio" or "Keep speech only" are available.</td></tr>
    <tr><td>Generative image-to-video / text-to-image</td><td class="no">No</td><td>Mode 3 makes a labelled animated slideshow; no images or motion are invented.</td></tr>
    <tr><td>Best-frame extraction</td><td class="yes">Yes</td><td>Scene detection, sharpness, exposure, composition, duplicate removal, full-resolution capture, ZIP export.</td></tr>
  </table></div>
  <div class="panel"><h3>Formats</h3><ul>
    <li>Photos in: JPG, PNG, WebP (checked by content). HEIC: export as JPG first.</li>
    <li>Videos in: MP4, MOV, WebM if the browser can decode the codec. iPhone HEVC: set Camera → Formats → Most Compatible, or convert to H.264.</li>
    <li>Videos out: MP4 (H.264 + AAC) in Chrome / Edge on Windows and Mac; WebM (VP9 + Opus) where MP4 encoding is unavailable. The exact format is shown on every result.</li>
    <li>Text out: SRT, VTT, transcript, and a ready-to-paste description with chapters, hashtags and credits.</li></ul></div>
  <div class="panel"><h3>Tips for best results</h3><ul>
    <li>The AI starts listening and watching the moment you drop a video — by the time you have chosen options or typed a prompt, most of the work is done.</li>
    <li>Use desktop Chrome or Edge, plugged in, for long videos. Every result shows a <b>Time taken</b> line per step and a render breakdown — send it if something is slow.</li>
    <li>Always open the app from the same address — each new preview link is a different site to the browser and downloads the AI models again.</li>
    <li>Keep the tab open. For the avatar, keep the tab <b>visible</b> while it performs (it records in real time).</li>
    <li>Speak clearly and name things ("this Neapolitan pizza") — that's what drives captions and visuals.</li>
    <li>Name your own B-roll files by topic (e.g. <i>pizza-oven.mp4</i>) and add them under Customize → B-roll.</li></ul></div>`;
}

// ======================= Boot =======================
(async function boot() {
  document.documentElement.classList.add('js-ok');
  await S.recoverInterrupted().catch(() => {});
  S.cleanOrphanFiles().catch(() => {});
  bindPromptFb($('#imgPrompt'), $('#imgPromptFb'), interpretImagePrompt, understandImagePrompt);
  bindPromptFb($('#vidPrompt'), $('#vidPromptFb'), parseVideoPrompt, understandVideoPrompt);
  bindPromptFb($('#i2vPrompt'), $('#i2vPromptFb'), parseVideoPrompt, understandVideoPrompt);
  route();
  if (typeof MediaRecorder === 'undefined') toast('Your browser cannot record video, so video modes will not work here. Photo modes still work. Try the latest Chrome, Edge or Safari.', 'error', 10000);
})();
