// Inera Edit Flow — transcript understanding ("story editor"): sentences, topics, keywords,
// emphasis, questions, calls-to-action, list beats, retakes, chapters, title & hashtag suggestions.
// Everything is derived from the speaker's own words — nothing is invented.
import { fetchText } from './gz.js';

let LEX = null;
export async function loadLexicon() {
  if (LEX) return LEX;
  LEX = JSON.parse(await fetchText(new URL('./visual-lexicon.dat', import.meta.url).href)); // gzip-compressed JSON
  return LEX;
}
// Only confident matches drive visuals: curated (2) or the emoji's own name (1); loose tags (0) are ignored.
export function emojiFor(word) { if (!LEX || !word) return null; const e = LEX.lex[word]; if (!e) return null; const st = LEX.strength ? LEX.strength[word] : 1; return st >= 1 ? e : null; }
export function svgFor(emoji) { return LEX ? LEX.svg[emoji] || null : null; }

const STOP = new Set(`next last first second third order ordered baked bake made making done doing able a about above after again against all almost also am an and any are aren't as at be because been before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each even ever every few for from further get gets getting got gonna had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just let let's like make makes many may maybe me might more most much must mustn't my myself need never no nor not now of off often on once one only or other others ought our ours ourselves out over own really right same say says see she she'd she'll she's should shouldn't so some something still such sure take than that that's the their theirs them themselves then there there's these they they'd they'll they're they've thing things think this those though through to too under until up us very want wanna was wasn't way we we'd we'll we're we've well were weren't what what's when when's where where's which while who who's whom why why's will with won't would wouldn't yeah yes yet you you'd you'll you're you've your yours yourself yourselves okay ok actually basically literally kind sort lot lots go going goes went come comes came know knew tell told look looks looking day today everyone everybody guys hey hi hello thanks thank watching video channel just also`.split(/\s+/));
const VERBISH = /(ing|ed|ize|ise)$/;
const POWER = new Set('best worst most least never always secret secrets mistake mistakes important biggest huge massive free easy simple fastest only first last top key critical warning stop must ultimate proven guaranteed instantly'.split(' '));
const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm', 'umm']);
const CTA = /\b(subscribe|follow|like (this|the) video|comment|share (this|it)|link in (the )?(bio|description)|hit the bell|turn on notifications|sign up|join (us|now)|download)\b/i;
const LIST = /\b(first|second|third|fourth|fifth|number (one|two|three|four|five)|step (one|two|three|\d)|tip (number )?\d|finally|lastly)\b/i;

export const norm = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/'s$/, '');
function singular(w) { if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'; if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1); return w; }

// Split ASR segments (with word timings) into sentences.
export function sentencesFrom(segments) {
  const words = [];
  for (const s of segments) for (const w of s.words || []) words.push(w);
  const out = [];
  let cur = [];
  const push = () => { if (cur.length) { out.push({ start: cur[0].s, end: cur[cur.length - 1].e, words: cur, text: cur.map((w) => w.w).join(' ') }); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const endP = /[.!?…]["')\]]*$/.test(words[i].w);
    const gap = words[i + 1] ? words[i + 1].s - words[i].e : 0;
    const clause = /[,;:]["')\]]*$/.test(words[i].w);
    if ((endP && cur.length >= 3) || gap > 1.2 || (gap > 0.5 && cur.length >= 6) || (clause && gap > 0.35 && cur.length >= 8) || cur.length >= 28) push();
  }
  push();
  // merge very short fragments into the previous sentence when close in time
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.words.length < 3 && s.start - last.end < 0.6) { last.words.push(...s.words); last.end = s.end; last.text += ' ' + s.text; }
    else merged.push(s);
  }
  return merged;
}

// Words too general to be "the topic" of a video (still fine inside a sentence).
const GENERIC = new Set('people person persons thing stuff life time times way ways something anything everything better good great bad lot result results quality part parts kind type types year years month week minute minutes second seconds hour hours moment place point reason reasons question answer example fact facts idea ideas home world experience level number numbers everyone someone anyone welcome name host common either means ultimately'.split(' '));
// "This video is all about how to build a coaching practice" → the speaker says the topic out loud
const TOPIC_CUE = /\b(?:all about|is about|talk(?:ing)? about|going to (?:show|teach|tell) you|learn(?:ing)?|guide to|introduction to|today(?:'s video)? (?:is|we(?:'re| are)?)(?: going)?(?: to)?(?: talk about| learn| look at| cover)?)\s+((?:how to |why |what )?[^.,!?;]{4,70})/i;

export async function understand(transcript, { title } = {}) {
  await loadLexicon().catch(() => null);
  const sents = sentencesFrom(transcript.segments || []);
  const english = !transcript.language || transcript.language === 'en';
  // people's names ("my name is Eric Ken", "I'm Sarah") are never used as picture keywords or topics
  const names = new Set();
  const fullText = sents.map((s) => s.text).join(' ');
  for (const m of fullText.matchAll(/\b(?:my name is|my name's|i am|i'm|this is|called|named|with me is|joined by)\s+((?:\p{Lu}[\p{L}'-]+\s*){1,3})/giu)) {
    for (const w of m[1].trim().split(/\s+/)) { const n = norm(w); if (n && !emojiFor(n)) names.add(n); }
  }
  // document frequency for keyword weighting
  const df = new Map();
  const toks = sents.map((s) => {
    const t = s.words.map((w, i) => { const n = norm(w.w); const proper = i > 0 && /^\p{Lu}/u.test(w.w); return { raw: w.w, n, w, k: proper ? n : singular(n) }; });
    const uniq = new Set(t.map((x) => x.k).filter(Boolean));
    uniq.forEach((k) => df.set(k, (df.get(k) || 0) + 1));
    return t;
  });
  const N = Math.max(1, sents.length);
  const freq = new Map();
  toks.forEach((t) => t.forEach((x) => { const k = x.k; if (k && k.length > 2 && !STOP.has(x.n)) freq.set(k, (freq.get(k) || 0) + 1); }));
  const isCandidate = (x, i, t) => {
    if (!x.n || x.n.length < 3 || STOP.has(x.n) || FILLERS.has(x.n) || names.has(x.n)) return false;
    if (/^\d/.test(x.n)) return false;
    if (english && VERBISH.test(x.n) && !emojiFor(x.n) && !emojiFor(singular(x.n))) return false;
    return true;
  };
  const story = { sentences: [], topics: [], language: transcript.language || null };
  for (let si = 0; si < sents.length; si++) {
    const s = sents[si], t = toks[si];
    const scored = [];
    t.forEach((x, i) => {
      if (!isCandidate(x, i, t)) return;
      const k = x.k;
      const idf = Math.log(1 + N / (df.get(k) || 1));
      const cap = i > 0 && /^\p{Lu}/u.test(x.raw) ? 0.8 : 0;
      const emoji = emojiFor(x.n) || emojiFor(k);
      const score = (freq.get(k) || 1) * 0.35 + idf + (emoji ? 1.2 : 0) + cap + Math.min(0.6, x.n.length * 0.05);
      scored.push({ k, word: x.raw.replace(/[^\p{L}\p{N}'-]/gu, ''), score, emoji, t: x.w.s, e: x.w.e });
    });
    const best = new Map();
    for (const c of scored) if (!best.has(c.k) || best.get(c.k).score < c.score) best.set(c.k, c);
    const keywords = [...best.values()].sort((a, b) => b.score - a.score).slice(0, 4);
    // emphasis words: numbers, power words, top keyword
    const emphasis = new Set();
    t.forEach((x, i) => {
      if (/\d/.test(x.raw) || POWER.has(x.n) || (keywords[0] && x.k === keywords[0].k)) emphasis.add(i);
      if (x.raw.length > 2 && x.raw === x.raw.toUpperCase() && /\p{L}/u.test(x.raw)) emphasis.add(i);
    });
    const fillers = t.map((x, i) => (FILLERS.has(x.n) ? i : -1)).filter((i) => i >= 0);
    const type = /\?\s*$/.test(s.text) ? 'question' : CTA.test(s.text) ? 'cta' : LIST.test(s.text) ? 'list' : /\d/.test(s.text) ? 'stat' : t.some((x) => POWER.has(x.n)) ? 'power' : 'plain';
    const visual = keywords.find((k) => k.emoji) || keywords[0] || null;
    story.sentences.push({
      i: si, start: s.start, end: s.end, text: s.text, words: s.words, keywords, emphasis: [...emphasis], fillers, type,
      visual: visual ? { keyword: visual.word, key: visual.k, emoji: visual.emoji || null, at: visual.t } : null,
      score: keywords.reduce((a, k) => a + k.score, 0) / Math.max(1, keywords.length) + (type === 'stat' || type === 'power' ? 1 : 0) + (type === 'question' ? 0.6 : 0),
    });
  }
  // retakes: a sentence immediately repeated (similar words, close in time) — keep the later take
  const bag = (s) => new Set(s.words.map((w) => norm(w.w)).filter((w) => w && !STOP.has(w)));
  for (let i = 0; i < story.sentences.length - 1; i++) {
    const a = story.sentences[i], b = story.sentences[i + 1];
    const A = bag(a), B = bag(b);
    if (A.size < 2 || B.size < 2) continue;
    let inter = 0; A.forEach((w) => { if (B.has(w)) inter++; });
    const jac = inter / (A.size + B.size - inter);
    if (jac >= 0.6 && b.start - a.end < 15) a.retake = true;
  }
  // global topics
  // the topic the speaker announces ("… is all about how to build a successful coaching practice")
  const cue = english ? TOPIC_CUE.exec(fullText) : null;
  const cueWords = new Set(cue ? cue[1].split(/\s+/).map((w) => singular(norm(w))).filter((w) => w && !STOP.has(w) && !GENERIC.has(w)) : []);
  // repeated two-word phrases ("coaching practice") are strong topic evidence
  const pairs = new Map();
  toks.forEach((t) => { for (let i = 0; i + 1 < t.length; i++) { const a = t[i], b = t[i + 1]; if (!a.n || !b.n || STOP.has(a.n) || STOP.has(b.n) || a.n.length < 3 || b.n.length < 3 || names.has(a.n) || names.has(b.n)) continue; const k = a.k + ' ' + b.k; pairs.set(k, (pairs.get(k) || 0) + 1); } });
  story.topics = [...freq.entries()].filter(([k]) => !STOP.has(k) && k.length > 2 && !GENERIC.has(k) && !names.has(k) && !(english && VERBISH.test(k) && !emojiFor(k)))
    .map(([k, f]) => {
      let sc = f * (emojiFor(k) ? 1.5 : 1);
      if (cueWords.has(k)) sc += 2.5;
      for (const [pk, pf] of pairs) if (pf >= 2 && pk.split(' ').includes(k)) sc += pf;
      return { k, f, emoji: emojiFor(k), score: sc };
    })
    .sort((a, b) => b.score - a.score).slice(0, 8);
  let main = story.topics[0] ? story.topics[0].k : null;
  // a repeated phrase containing the top word is the clearer topic ("coaching practice", not "practice")
  if (main) {
    const best = [...pairs.entries()].filter(([pk, pf]) => pf >= 2 && pk.split(' ').includes(main) && pk.split(' ').every((w) => !GENERIC.has(w))).sort((a, b) => b[1] - a[1])[0];
    if (best) main = best[0];
  }
  story.mainTopic = main;
  const phrase = cue ? cue[1].trim().replace(/\s+(and|so|because|but)\b.*$/i, '').split(/\s+/).slice(0, 9).join(' ') : '';
  // hook: strongest short sentence in the first 40% that mentions the main topic
  const early = story.sentences.filter((s) => s.start < (story.sentences.at(-1)?.end || 0) * 0.4 && s.type !== 'cta');
  const hook = early.filter((s) => s.words.length <= 18).sort((a, b) => (b.score + (main && b.text.toLowerCase().includes(main) ? 1 : 0)) - (a.score + (main && a.text.toLowerCase().includes(main) ? 1 : 0)))[0];
  story.hook = hook ? hook.i : null;
  // title suggestion (from the speaker's words; user can edit)
  const SMALL = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'at', 'by']);
  const phraseTitle = phrase && phrase.split(/\s+/).length >= 2 ? phrase.split(/\s+/).map((w, i) => (i && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1))).join(' ') : '';
  story.titleSuggestion = title || phraseTitle || (main ? titleCase(main) + (story.topics[1] ? ' & ' + titleCase(story.topics[1].k) : '') : null);
  story.hashtags = story.topics.slice(0, 5).map((t) => '#' + t.k.replace(/[^\p{L}\p{N}]/gu, ''));
  // chapters for longer talks
  story.chapters = [];
  const dur = story.sentences.at(-1)?.end || 0;
  if (dur > 120) {
    let start = 0, curKeys = new Map(), chStart = story.sentences[0]?.start || 0;
    const flush = (endIdx) => {
      const keys = [...curKeys.entries()].sort((a, b) => b[1] - a[1]);
      if (keys.length) story.chapters.push({ start: chStart, title: titleCase(keys[0][0]) + (keys[1] ? ' & ' + titleCase(keys[1][0]) : '') });
    };
    story.sentences.forEach((s, i) => {
      const ks = s.keywords.map((k) => k.k);
      const overlap = ks.filter((k) => curKeys.has(k)).length;
      if (i > start + 3 && s.start - chStart > 60 && overlap === 0 && ks.length) { flush(i); curKeys = new Map(); chStart = s.start; start = i; }
      ks.forEach((k) => curKeys.set(k, (curKeys.get(k) || 0) + 1));
    });
    flush(story.sentences.length);
    if (story.chapters.length) story.chapters[0].start = 0;
  }
  return story;
}

export function titleCase(s) { return String(s || '').replace(/\b\p{L}/gu, (c) => c.toUpperCase()); }

export function chaptersText(chapters) {
  const f = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60), h = Math.floor(m / 60); return (h ? h + ':' + String(m % 60).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
  return chapters.map((c) => `${f(c.start)} ${c.title}`).join('\n');
}
