// Inera Edit Flow — prompt understanding = exact rules (prompt.js) + meaning matching (nlu-worker.js).
// Rules handle precise instructions (numbers, titles, colours, positions). Every phrase is also compared
// by meaning with the library in prompt-intents.js, so simple everyday wording works too.
import { splitClauses } from './prompt.js';
import { parseVideoPrompt } from './video-editor.js';
import { interpretImagePrompt } from './prompt.js';
import { VIDEO_INTENTS, IMAGE_INTENTS } from './prompt-intents.js';

const T_OK = 0.55;   // similarity needed to apply an intent
const T_NO = 0.66;   // stricter for "cannot do" answers (avoid false refusals)
const MIN_MARGIN = 0.03; // ignore near-ties between two different intents

function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export function nluModelUrl() {
  const o = safeGet('inera-nlu-base');
  return (o ? o.replace(/\/?$/, '/') : 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/') + 'onnx/model_quantized.onnx';
}

let worker = null, seq = 0, initP = null; const pending = new Map();
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./nlu-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error)); };
  worker.onerror = () => { for (const p of pending.values()) p.reject(new Error('Prompt engine crashed')); pending.clear(); worker = null; initP = null; };
  return worker;
}
const call = (msg) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); getWorker().postMessage({ ...msg, id }); });
function init() { if (!initP) { initP = call({ type: 'init', modelUrl: nluModelUrl() }); initP.catch(() => { initP = null; }); } return initP; }
export function preloadNlu() { init().catch(() => {}); }

// split a clause into meaningful fragments ("make it professional for linkedin with subtitles")
function fragments(clause) {
  const words = clause.split(/\s+/).filter(Boolean);
  const out = new Set([clause]);
  const raw = clause.split(/\s+(?=(?:with|for|and|but|so|because|plus|like|in|on)\b)/i);
  const pieces = raw.map((x) => x.trim()).filter((x) => { const n = x.split(/\s+/).length; return (n >= 3 || (n === 2 && /^(for|on|in|with|like)\s/i.test(x))) && !/^(make|do|please|it|this|the|and|but|so)\b(\s+\w+)?$/i.test(x); });
  if (raw.length > 1) pieces.forEach((x) => out.add(x));
  if (words.length > 14) for (let i = 0; i < words.length; i += 6) out.add(words.slice(i, i + 8).join(' '));
  return [...out].filter((x) => x.length > 2).slice(0, 12);
}

async function understand(text, kind) {
  const base = kind === 'image' ? interpretImagePrompt(text) : parseVideoPrompt(text);
  const res = { ...base, cannot: [], semantic: false };
  const raw = String(text || '').trim();
  if (!raw) return res;
  const clauses = splitClauses(raw);
  const frags = [], owner = [];
  clauses.forEach((c, ci) => fragments(c).forEach((f) => { frags.push(f); owner.push(ci); }));
  let matches;
  try { await init(); matches = await call({ type: 'match', kind, phrases: frags }); }
  catch (e) { res.semanticError = e.message; return res; } // rules-only fallback (e.g. offline first run)
  res.semantic = true;
  const list = kind === 'image' ? IMAGE_INTENTS : VIDEO_INTENTS;
  const best = new Map(); // intent index → {sim, clause}
  matches.forEach((m, i) => {
    const it = list[m.top];
    const need = it.no ? T_NO : T_OK;
    if (m.sim < need) return;
    if (m.second != null && m.sim - m.sim2 < MIN_MARGIN && !sameEffect(list[m.top], list[m.second])) return;
    const prev = best.get(m.top);
    if (!prev || m.sim > prev.sim) best.set(m.top, { sim: m.sim, clause: owner[i] });
  });
  const hitClauses = new Set((base.parts || []).map((p, i) => (p.hit ? i : -1)).filter((i) => i >= 0));
  const setByRules = new Set(Object.keys(base).filter((k) => !['notes', 'understood', 'notUnderstood', 'parts'].includes(k)));
  const applied = new Set();
  [...best.entries()].sort((a, b) => b[1].sim - a[1].sim).forEach(([k, b]) => {
    const it = list[k];
    hitClauses.add(b.clause);
    if (it.no) { if (!res.cannot.includes(it.note)) res.cannot.push(it.note); return; }
    let used = 0; const keys = Object.keys(it.set);
    for (const [key, val] of Object.entries(it.set)) {
      if (setByRules.has(key) || applied.has(key)) continue; // exact rules and stronger matches win
      res[key] = val; applied.add(key); used++;
    }
    // report it unless an exact rule already covered most of the same thing (avoids duplicate chips)
    if (used && !res.understood.includes(it.note)) res.understood.push(used < keys.length ? `${it.note} (combined with your other requests)` : it.note);
    void keys;
  });
  res.notUnderstood = clauses.filter((_, i) => !hitClauses.has(i));
  res.notes = [...res.understood];
  return res;
}
function sameEffect(a, b) { return !!a && !!b && JSON.stringify(a.set || a.no) === JSON.stringify(b.set || b.no); }

export const understandVideoPrompt = (text) => understand(text, 'video');
export const understandImagePrompt = (text) => understand(text, 'image');
