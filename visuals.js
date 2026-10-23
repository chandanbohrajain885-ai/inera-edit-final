// Inera Edit Flow — B-roll sourcing ("motion designer / researcher").
// Order: 1) the user's own B-roll library  2) Wikimedia Commons  3) Openverse  4) offline illustration.
// Only licences that allow commercial use AND modification without share-alike are accepted:
// CC0, Public Domain, CC BY. Attribution is recorded for every image used.
import { svgFor, emojiFor, titleCase } from './understand.js';
import { makeCanvas } from './utils.js';

const BLOCK = /(nude|naked|nsfw|sex|erotic|porn|genital|penis|vagina|breast|nipple|corpse|dead body|gore|blood|execution|lynch|torture|swastika|hitler|nazi|isis|terror|weapon|gun|rifle|pistol|drug|cocaine|heroin)/i;
const OK_LICENSE = /^(cc0|pdm|public domain|pd|cc by( [\d.]+)?|cc-by( [\d.]+)?|attribution( [\d.]+)?)$/i;

const ABSTRACT = new Set('secret secrets idea ideas success win time love power energy goal goals focus mindset mind think thinking smart memory question questions why rule rules plan strategy tip tips mistake mistakes wrong right correct done warning danger risk free new top fast speed quick slow growth future past problem solution help care trust value quality life world business work job career money health happiness fear hope dream dreams motivation result results change'.split(' '));
const memo = new Map();
const imgCache = new Map();
let ovChain = Promise.resolve(); // Openverse allows ~1 anonymous request per second: requests queue here

function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]); }
async function getJSON(url, ms = 9000) {
  const r = await withTimeout(fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }), ms);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
export async function loadImageFromUrl(url, ms = 15000) {
  if (imgCache.has(url)) return imgCache.get(url);
  const p = (async () => {
    const r = await withTimeout(fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }), ms);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    if (!/^image\//.test(blob.type) && blob.size < 100) throw new Error('not an image');
    const bmp = await createImageBitmap(blob);
    return bmp;
  })();
  imgCache.set(url, p);
  p.catch(() => imgCache.delete(url));
  return p;
}
const stripHtml = (h) => String(h || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function searchCommons(q) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|size|extmetadata|mime&iiurlwidth=1920`;
  const j = await getJSON(url);
  const pages = Object.values((j.query && j.query.pages) || {});
  const out = [];
  for (const pg of pages) {
    const ii = pg.imageinfo && pg.imageinfo[0]; if (!ii) continue;
    const md = ii.extmetadata || {};
    const lic = stripHtml(md.LicenseShortName && md.LicenseShortName.value);
    const title = stripHtml((md.ObjectName && md.ObjectName.value) || pg.title);
    const desc = stripHtml(md.ImageDescription && md.ImageDescription.value);
    if (!OK_LICENSE.test(lic.replace(/-/g, ' ').trim()) && !/^public domain/i.test(lic)) continue;
    if (BLOCK.test(title + ' ' + desc + ' ' + pg.title)) continue;
    if (!/jpeg|png|webp/.test(ii.mime || '')) continue;
    if ((ii.width || 0) < 800) continue;
    out.push({ src: ii.thumburl || ii.url, w: ii.thumbwidth || ii.width, h: ii.thumbheight || ii.height, source: 'Wikimedia Commons', title, author: stripHtml(md.Artist && md.Artist.value) || 'Unknown', license: lic, link: ii.descriptionurl || 'https://commons.wikimedia.org/' });
  }
  return out;
}
async function searchOpenverse(q) {
  const turn = ovChain; ovChain = ovChain.then(() => new Promise((r) => setTimeout(r, 1100)));
  await turn;
  const j = await getJSON(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=cc0,pdm,by&mature=false&page_size=12`);
  return (j.results || []).filter((r) => !BLOCK.test((r.title || '') + ' ' + (r.tags || []).map((t) => t.name).join(' ')))
    .map((r) => ({ src: r.thumbnail || `https://api.openverse.org/v1/images/${r.id}/thumb/`, w: Math.min(r.width || 600, 600), h: Math.min(r.height || 400, 400), source: 'Openverse' + (r.provider ? ' / ' + r.provider : ''), title: r.title || q, author: r.creator || 'Unknown', license: (r.license || '').toUpperCase() + ' ' + (r.license_version || ''), link: r.foreign_landing_url || r.url }));
}

// Illustration card: big Twemoji graphic + keyword, drawn on a brand gradient (always available offline).
export async function illustrationCard(keyword, emoji, W, H, accent = ['#7c3aed', '#2563eb']) {
  const c = makeCanvas(W, H);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0f1020'); g.addColorStop(1, '#151a33');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // soft accent glows
  const glow = (cx, cy, r, col) => { const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r); rg.addColorStop(0, col); rg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = rg; x.fillRect(0, 0, W, H); };
  glow(W * 0.25, H * 0.3, Math.max(W, H) * 0.6, accent[0] + '55');
  glow(W * 0.8, H * 0.8, Math.max(W, H) * 0.5, accent[1] + '44');
  const svg = emoji ? svgFor(emoji) : null;
  const size = Math.min(W, H) * 0.42;
  if (svg) {
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', `<svg width="${Math.round(size)}" height="${Math.round(size)}" `));
    const im = new Image(); im.src = url;
    try { await im.decode(); x.save(); x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = size * 0.12; x.shadowOffsetY = size * 0.05; x.drawImage(im, (W - size) / 2, H * 0.44 - size / 2, size, size); x.restore(); } catch (e) { /* draw text only */ }
  }
  const label = titleCase(keyword || '');
  if (label) {
    let fs = Math.round(Math.min(W, H) * 0.085);
    x.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    while (x.measureText(label).width > W * 0.85 && fs > 20) { fs -= 2; x.font = `800 ${fs}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`; }
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#ffffff';
    x.fillText(label, W / 2, svg ? H * 0.44 + size / 2 + fs * 1.1 : H / 2);
  }
  return c;
}

/**
 * Resolve the visual for a keyword.
 * opts: { library: [{name, kind, file, tags:Set}], online: bool, W, H, context }
 * Returns { kind: 'image'|'video'|'card', source:'library'|'web'|'illustration', bitmap?, file?, credit? }
 */
// search results are shared (in-flight searches too), so a prefetch and the real render never search twice
function searchCands(q) {
  if (!memo.has(q)) {
    const p = (async () => {
      let cands = [];
      try { cands = await searchCommons(q); } catch (e) { /* offline / blocked */ }
      if (cands.length < 2) { try { cands = cands.concat(await searchOpenverse(q)); } catch (e) { /* offline / blocked */ } }
      return cands;
    })();
    memo.set(q, p);
  }
  return memo.get(q);
}
// Warm-up while the user is still choosing options: search + download the likely pictures, without
// reserving them (the real render picks from the same, now cached, results).
export async function prefetchVisual(keyword, key, { online = true, W = 1920, H = 1080, context = '' } = {}) {
  const k = (key || keyword || '').toLowerCase();
  if (!online || !keyword || ABSTRACT.has(k)) return;
  const cands = await searchCands(keyword);
  const tr = W / H;
  const ranked = [...cands].sort((a, b) => Math.abs(Math.log(a.w / a.h / tr)) - Math.abs(Math.log(b.w / b.h / tr)));
  await Promise.all(ranked.slice(0, 2).map((c) => loadImageFromUrl(c.src).catch(() => null)));
  void context;
}
export async function resolveVisual(keyword, key, emoji, { library = [], online = true, W = 1920, H = 1080, context = '' } = {}) {
  const k = (key || keyword || '').toLowerCase();
  // 1) user library (filename / tag match)
  const lib = library.find((it) => it.tags.has(k) || [...it.tags].some((t) => t.length > 3 && (t.startsWith(k) || k.startsWith(t))));
  if (lib) return { kind: lib.kind, source: 'library', file: lib.file, name: lib.name, bitmap: lib.bitmap || null, credit: null };
  // 2/3) free, commercially-usable web images — only for concrete things & places
  // (abstract words like "secret" or "success" get an illustration instead of a random photo)
  const abstract = ABSTRACT.has(k);
  if (online && keyword && !abstract) {
    const queries = [keyword, context && context !== k ? `${keyword} ${context}` : null].filter(Boolean);
    for (const q of queries) {
      const cands = await searchCands(q);
      const ranked = [...cands].sort((a, b) => {
        const ar = a.w / a.h, br = b.w / b.h, tr = W / H;
        return (Math.abs(Math.log(ar / tr)) - Math.abs(Math.log(br / tr))) + (b.w > 1200 ? -0.3 : 0) - (a.w > 1200 ? -0.3 : 0);
      });
      for (const c of ranked.slice(0, 4)) {
        if (c.used) continue;
        c.used = true; // reserve before awaiting (visuals are resolved in parallel)
        try {
          const bmp = await loadImageFromUrl(c.src);
          if (bmp.width < 300) { c.used = false; continue; }
          return { kind: 'image', source: 'web', bitmap: bmp, credit: { title: c.title, author: c.author, license: c.license, link: c.link, source: c.source }, hires: bmp.width >= 1200 };
        } catch (e) { c.used = false; /* try next */ }
      }
    }
  }
  // 4) offline illustration
  const em = emoji || emojiFor(k);
  const card = await illustrationCard(keyword, em, W, H);
  return { kind: 'card', source: 'illustration', bitmap: card, credit: em ? { title: 'Twemoji graphic', author: 'Twitter, Inc. and contributors (jdecked/twemoji)', license: 'CC BY 4.0', link: 'https://github.com/jdecked/twemoji', source: 'Twemoji' } : null };
}

// Build the user's B-roll library from uploaded files (tags from file names, e.g. "pizza-oven.mp4")
export function libraryFromFiles(files) {
  return files.map((f) => {
    const tags = new Set(f.name.toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9À-ɏ]+/).filter((t) => t.length > 1).map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t)));
    return { name: f.name, file: f, kind: /^video\//.test(f.type) || /\.(mp4|mov|webm)$/i.test(f.name) ? 'video' : 'image', tags };
  });
}

export function creditsText(credits) {
  const uniq = new Map();
  for (const c of credits) if (c) uniq.set(c.link + c.title, c);
  if (!uniq.size) return '';
  return 'Visual credits\n' + [...uniq.values()].map((c) => `- "${c.title}" by ${c.author} — ${c.license} — ${c.source} — ${c.link}`).join('\n');
}
