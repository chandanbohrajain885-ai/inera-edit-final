// Inera Edit Flow — prompt interpreter (runs on the device, no AI service).
// Turns plain-English requests into concrete edit settings and reports back, honestly, which parts
// were understood (and applied) and which were not. The prompt always wins over the dropdowns.

const COLORS = {
  yellow: '#facc15', red: '#ef4444', green: '#22c55e', blue: '#3b82f6', orange: '#f97316', pink: '#ec4899',
  purple: '#a855f7', violet: '#8b5cf6', white: '#ffffff', black: '#111111', cyan: '#22d3ee', gold: '#d4a017',
  grey: '#9ca3af', gray: '#9ca3af', navy: '#1e3a8a', teal: '#14b8a6', beige: '#e8dcc4', cream: '#f5efe0', brown: '#8b5a2b',
};
const LANGS = { english: 'en', hindi: 'hi', spanish: 'es', french: 'fr', german: 'de', portuguese: 'pt', italian: 'it', arabic: 'ar', japanese: 'ja', korean: 'ko', chinese: 'zh', russian: 'ru', bengali: 'bn', bangla: 'bn', tamil: 'ta', telugu: 'te', marathi: 'mr', gujarati: 'gu', urdu: 'ur', kannada: 'kn', malayalam: 'ml', punjabi: 'pa', indonesian: 'id', turkish: 'tr' };

// Split into clauses so every part of the request can be reported as applied or not.
function clauses(text) {
  return String(text).replace(/["“”][^"“”]*["“”]/g, (q) => q.replace(/[,.;]/g, ' ')) // keep quoted titles whole
    .split(/[\n;.!?]+|,(?![^"“”]*["”])|\band then\b|\bthen\b|\balso\b/i)
    .flatMap((c) => c.split(/\band\b(?=\s+(?:make|add|use|remove|keep|put|no|cut|give|set|change|show|turn|apply|create|start))/i))
    .map((c) => c.trim()).filter((c) => c.length > 1);
}
function quoted(text, keys) {
  const re = new RegExp(`(?:${keys})\\s*(?:is|as|:|=|-|saying|that says|reading)?\\s*["“']([^"”']{1,90})["”']`, 'i');
  const m = String(text).match(re);
  return m ? m[1].trim() : null;
}
function colorIn(t) { for (const [k, v] of Object.entries(COLORS)) if (new RegExp(`\\b${k}\\b`).test(t)) return { name: k, hex: v }; const h = t.match(/#[0-9a-f]{6}\b/); return h ? { name: h[0], hex: h[0] } : null; }

// Each rule: test(clause, fullText) → returns a note string (and mutates o) when it applies.
function runRules(text, rules) {
  const o = {}, understood = [], notUnderstood = [], parts = [];
  const full = String(text || '').trim();
  if (!full) return { o, understood, notUnderstood, notes: [], parts };
  for (const c of clauses(full)) {
    const t = c.toLowerCase();
    let hit = false;
    for (const r of rules) { const n = r(t, c, o, full); if (n) { hit = true; if (!understood.includes(n)) understood.push(n); } }
    if (!hit) notUnderstood.push(c);
    parts.push({ text: c, hit });
  }
  const notes = [...understood];
  return { o, understood, notUnderstood, notes, parts };
}
const has = (t, ...w) => w.some((x) => (x instanceof RegExp ? x.test(t) : t.includes(x)));

// ---------------- video (Mode 2, Mode 3, Avatar edits) ----------------
const VIDEO_RULES = [
  // length
  (t, c, o) => {
    let m = t.match(/(\d{1,3}(?:\.\d)?)\s*(?:-|\s)?\s*(?:s\b|sec|secs|second|seconds)\b/), v = null;
    if (m) v = parseFloat(m[1]);
    else if ((m = t.match(/(\d{1,3})\s*(?:-|\s)?\s*(?:min|mins|minute|minutes)\b/))) v = parseInt(m[1], 10) * 60;
    else if ((m = t.match(/\b(half a minute)\b/))) v = 30;
    else if (/\b(one|a) minute\b/.test(t)) v = 60;
    if (v && v >= 3 && v <= 3 * 3600) { o.targetDuration = v; return `Length ≈ ${v >= 60 ? Math.round(v / 6) / 10 + ' min' : v + ' s'}`; }
    if (has(t, 'short version', 'shorter', 'quick version', 'trailer', 'teaser', 'highlight')) { o.targetDuration = 30; return 'Short version (~30 s)'; }
    if (has(t, 'full length', 'keep everything', 'keep all content', "don't shorten", 'do not shorten', 'no trimming')) { o.keepAllSpeech = true; return 'Full length — nothing shortened'; }
    return null;
  },
  // aspect
  (t, c, o) => {
    if (has(t, /\breels?\b/, /\bshorts\b/, 'tiktok', 'vertical', '9:16', /\b(insta(gram)?|whatsapp|for|as an?) stor(y|ies)\b/, /\bstory (format|size|video)\b/, 'portrait video', 'whatsapp status')) { o.aspect = '9:16'; return 'Vertical 9:16'; }
    if (has(t, 'square', '1:1')) { o.aspect = '1:1'; return 'Square 1:1'; }
    if (has(t, '4:5', 'feed post', 'instagram post', 'portrait post')) { o.aspect = '4:5'; return '4:5 feed'; }
    if (has(t, /\binsta(gram)?\b/)) { o.aspect = '9:16'; return 'Instagram Reel format (9:16)'; }
    if (has(t, /\bfacebook\b/, /\bfb\b/)) { o.aspect = '4:5'; return 'Facebook feed format (4:5)'; }
    if (has(t, /\blinkedin\b/)) { o.aspect = '1:1'; return 'LinkedIn format (1:1)'; }
    if (has(t, 'youtube', 'landscape', '16:9', 'widescreen', 'horizontal')) { o.aspect = '16:9'; return 'Landscape 16:9'; }
    return null;
  },
  // style
  (t, c, o) => {
    if (has(t, 'cinematic', 'film look', 'movie', 'filmic')) { o.style = 'cinematic'; o.grade = o.grade || 'cinematic'; o.mood = o.mood || 'cinematic'; return 'Cinematic style'; }
    if (has(t, 'energetic', 'hype', 'high energy', /\baction (video|edit|style|packed|movie)\b/, 'dynamic edit', 'fast edit', 'fast-paced', 'fast paced')) { o.style = 'energetic'; o.pacing = 'tight'; o.transitions = o.transitions || 'dynamic'; return 'Energetic, fast-paced edit'; }
    if (has(t, 'viral', 'creator', 'engaging', 'mrbeast', 'youtuber', 'ishan sharma', 'retention')) { o.style = 'creator'; o.hook = 'on'; o.captions = o.captions || 'creator'; return 'Creator style (hook, bold captions, punch-ins)'; }
    if (has(t, 'minimal', 'clean edit', 'simple edit', 'professional', 'corporate')) { o.style = 'minimal'; o.mood = o.mood || 'subtle'; return 'Clean, minimal, professional'; }
    if (has(t, 'vlog', 'natural look', 'natural style')) { o.style = 'natural'; return 'Natural vlog style'; }
    return null;
  },
  // pacing
  (t, c, o) => {
    if (has(t, 'keep pauses', 'keep the pauses', 'no jump cut', 'no jumpcut', "don't cut pauses", 'do not cut pauses', 'keep silence')) { o.keepPauses = true; return 'Pauses kept (no jump cuts)'; }
    if (has(t, 'remove silence', 'cut silence', 'remove pauses', 'cut pauses', 'remove dead air', 'jump cut', 'tight', 'snappy')) { o.pacing = 'tight'; return 'Tight cuts — silences removed'; }
    if (has(t, /\bslow(er)?\b(?! ?mo)/, 'relaxed', 'calm pace', 'breathing room')) { o.pacing = 'relaxed'; return 'Relaxed pacing'; }
    return null;
  },
  // retakes / fillers
  (t, c, o) => {
    if (has(t, 'keep retakes', 'keep mistakes', "don't cut mistakes", 'do not cut mistakes', 'keep fillers', 'keep um')) { o.removeRetakes = false; return 'Retakes and fillers kept'; }
    if (has(t, 'remove retakes', 'remove mistakes', 'cut mistakes', 'remove fillers', 'remove um', 'remove repeated')) { o.removeRetakes = true; return 'Retakes and fillers removed'; }
    return null;
  },
  // hook
  (t, c, o) => {
    if (has(t, 'no hook', 'without hook', "don't add a hook", 'start from the beginning')) { o.hook = 'off'; return 'No hook opening'; }
    if (has(t, 'hook', 'grab attention', 'strong opening', 'start strong')) { o.hook = 'on'; return 'Hook opening (strongest line first)'; }
    return null;
  },
  // captions
  (t, c, o) => {
    if (!has(t, 'caption', 'subtitle', 'text on screen', 'on-screen text', 'srt')) return null;
    const notes = [];
    if (has(t, 'no caption', 'without caption', 'remove caption', 'no subtitle', 'without subtitle', 'captions off', 'no text')) { o.captions = 'off'; return 'No captions'; }
    if (has(t, 'small', 'clean', 'simple', 'subtle', 'normal subtitle', 'netflix', 'professional')) { o.captions = 'clean'; notes.push('clean subtitles'); }
    else { o.captions = 'creator'; notes.push('bold creator captions'); }
    if (has(t, 'big', 'large', 'huge', 'bigger')) { o.captionScale = 1.25; notes.push('larger'); }
    if (has(t, 'smaller')) { o.captionScale = 0.8; notes.push('smaller'); }
    if (has(t, 'top')) { o.captionPos = 'top'; notes.push('at the top'); }
    else if (has(t, 'middle', 'center', 'centre')) { o.captionPos = 'middle'; notes.push('in the middle'); }
    else if (has(t, 'bottom')) { o.captionPos = 'bottom'; notes.push('at the bottom'); }
    if (has(t, 'lowercase', 'normal case', 'sentence case')) { o.captionCase = 'normal'; notes.push('normal case'); }
    if (has(t, 'uppercase', 'capital', 'all caps')) { o.captionCase = 'upper'; notes.push('UPPERCASE'); }
    const col = colorIn(t); if (col && o.captions === 'creator') { o.captionColor = col.hex; notes.push(`${col.name} highlight`); }
    return 'Captions: ' + notes.join(', ');
  },
  // B-roll / visuals
  (t, c, o) => {
    if (has(t, 'no visual', 'no b-roll', 'no broll', 'no image', 'no photos', 'no pictures', 'without visuals', 'without images', 'only me', 'only my face')) { o.broll = 'off'; return 'No topic visuals'; }
    if (has(t, 'more visual', 'more b-roll', 'more broll', 'more image', 'more photos', 'lots of visuals', 'show visuals', 'show images', 'topic images', 'related images', 'add visuals', 'add images', 'add b-roll')) { o.broll = 'more'; return 'More topic visuals'; }
    if (has(t, 'fewer visual', 'less visual', 'less b-roll', 'few images')) { o.broll = 'less'; return 'Fewer topic visuals'; }
    if (has(t, 'offline only', 'no internet', 'no web image', 'no online')) { o.online = false; return 'Offline visuals only'; }
    return null;
  },
  // graphics & sfx
  (t, c, o) => {
    if (has(t, /\bno (on-?screen )?text\b/, 'no words on screen', 'without text')) { o.noText = true; o.captions = 'off'; o.graphics = 'off'; delete o.title; return 'No on-screen text at all'; }
    if (has(t, 'no graphic', 'no sticker', 'no subscribe', 'no animation', 'no emoji', 'no overlay')) { o.graphics = 'off'; return 'No graphics or stickers'; }
    if (has(t, 'no sound effect', 'no sfx', 'no whoosh', 'without sound effects')) { o.sfx = 'off'; return 'No sound effects'; }
    if (has(t, 'sound effect', 'sfx', 'whoosh')) { o.sfx = 'auto'; return 'Sound effects on'; }
    if (has(t, 'subscribe button', 'add graphics', 'add stickers', 'animated text')) { o.graphics = 'auto'; return 'Graphics on'; }
    return null;
  },
  // zoom
  (t, c, o) => {
    if (has(t, 'no zoom', 'no punch', 'static camera', 'no camera movement', 'without zoom')) { o.punch = false; return 'No zooms or punch-ins'; }
    if (has(t, 'more zoom', 'zoom in', 'punch in', 'punch-in', 'add zoom')) { o.punch = true; o.intensity = 'bold'; return 'Stronger punch-in zooms'; }
    return null;
  },
  // transitions
  (t, c, o) => {
    if (!has(t, 'transition', 'hard cut', 'crossfade', 'cross-fade', 'cross fade')) return null;
    if (has(t, 'no transition', 'minimal transition', 'simple transition', 'hard cut', 'only cuts')) { o.transitions = 'minimal'; return 'Hard cuts only'; }
    if (has(t, 'smooth', 'fade', 'crossfade', 'cross-fade', 'cross fade', 'soft')) { o.transitions = 'smooth'; return 'Smooth fade transitions'; }
    o.transitions = 'dynamic'; return 'Dynamic transitions (zoom, whip, flash)';
  },
  // music
  (t, c, o) => {
    if (has(t, 'no music', 'without music', 'remove music', 'mute music', 'no background music', 'music off')) { o.music = 'off'; return 'No background music'; }
    let n = null;
    if (has(t, 'quiet music', 'low music', 'soft music', 'subtle music', 'background music low', 'lower music', 'music lower', 'music softer')) { o.music = 'low'; n = 'Quieter music'; }
    else if (has(t, 'loud music', 'more music', 'strong music', 'louder music', 'music louder', 'music up')) { o.music = 'high'; n = 'Louder music'; }
    const musicCtx = /\b(music|song|songs|beat|beats|tune|track|bgm|soundtrack)\b/.test(t); // mood words only count when about music
    if (has(t, 'lofi', 'lo-fi') || (musicCtx && has(t, 'chill', 'calm', 'relaxing', 'peaceful', 'soothing', 'soft'))) { o.mood = 'calm'; n = (n ? n + ', ' : '') + 'calm music'; }
    else if (has(t, 'upbeat') || (musicCtx && has(t, 'happy', 'cheerful', 'fun', 'celebrat', 'party'))) { o.mood = 'upbeat'; n = (n ? n + ', ' : '') + 'upbeat music'; }
    else if (musicCtx && has(t, 'epic', 'dramatic', 'emotional', 'cinematic', 'inspiring')) { o.mood = 'cinematic'; n = (n ? n + ', ' : '') + 'cinematic music'; }
    else if (has(t, /\bedm\b/, 'beat drop') || (musicCtx && has(t, 'energetic', 'electronic', 'hype', 'workout'))) { o.mood = 'energetic'; n = (n ? n + ', ' : '') + 'energetic music'; }
    else if (has(t, 'corporate music', 'background music', 'soft background')) { o.mood = o.mood || 'subtle'; n = n || 'Subtle background music'; }
    return n;
  },
  // original audio
  (t, c, o) => {
    if (has(t, 'mute original', 'no original audio', 'remove original audio', 'remove my voice', 'mute the video', 'mute audio')) { o.orig = 'none'; return 'Original audio muted'; }
    if (has(t, 'speech only', 'only speech', 'only my voice', 'keep my voice only')) { o.orig = 'speech'; return 'Speech only from the original'; }
    if (has(t, 'keep original audio', 'keep all original audio', 'keep the sound', 'keep ambient', 'original sound')) { o.orig = 'all'; return 'All original audio kept'; }
    if (has(t, /keep (all )?(of )?(my |the )?(speech|talking|words|voice)/, "don't cut speech", 'do not cut speech', "don't cut my")) { o.keepAllSpeech = true; return 'All speech kept'; }
    return null;
  },
  // colour grade
  (t, c, o) => {
    if (has(t, 'black and white', 'black & white', 'b&w', 'monochrome', 'grayscale', 'greyscale')) { o.grade = 'mono'; return 'Black & white'; }
    if (has(t, 'warm', 'golden', 'sunset look', 'cozy', 'cosy')) { o.grade = 'warm'; return 'Warm colour grade'; }
    if (has(t, 'vibrant', 'colorful', 'colourful', 'saturated', 'pop colors', 'pop colours', 'bright colors', 'bright colours')) { o.grade = 'vibrant'; return 'Vibrant colours'; }
    if (has(t, 'punchy', 'contrast', 'bold colors', 'bold colours')) { o.grade = 'punchy'; return 'Punchy contrast'; }
    if (has(t, 'moody', 'teal', 'dark look', 'film grade', 'cinematic color', 'cinematic colour')) { o.grade = 'cinematic'; return 'Moody cinematic grade'; }
    if (has(t, 'natural color', 'natural colour', 'true colors', 'true colours', 'no filter', 'no grade')) { o.grade = 'natural'; return 'Natural colours'; }
    return null;
  },
  // stabilisation
  (t, c, o) => {
    if (has(t, 'no stabil', 'without stabil', 'stabilisation off', 'stabilization off')) { o.stabilize = 'off'; return 'No stabilisation'; }
    if (has(t, 'stabil', 'shaky', 'smooth the camera', 'steady')) { o.stabilize = 'on'; return 'Stabilisation on'; }
    return null;
  },
  // title / name / role (all three can appear in one sentence)
  (t, c, o) => {
    const notes = [];
    const title = quoted(c, 'title|heading|headline|text|called|named|caption it');
    if (title && !/name|role/.test(t.split(/["“']/)[0].slice(-12))) { o.title = title.slice(0, 80); notes.push(`Title “${o.title}”`); }
    const name = quoted(c, 'my name|speaker name|name|presenter') || (c.match(/(?:[Mm]y name(?: is)?|I am|I'm|[Nn]ame:?)\s+([A-Z][\p{L}.'-]+(?:\s+[A-Z][\p{L}.'-]+){0,2})/u) || [])[1];
    if (name) { o.speakerName = name.replace(/\s+(And|With|For)$/u, '').slice(0, 40); notes.push(`Name lower-third “${o.speakerName}”`); }
    const role = quoted(c, 'role|designation|position');
    if (role) { o.speakerRole = role.slice(0, 50); notes.push(`Role “${o.speakerRole}”`); }
    return notes.length ? notes.join(' · ') : null;
  },
  // quality / language
  (t, c, o) => {
    if (has(t, /\b720\s*p?\b/, /\bhd ready\b/, 'lower resolution', 'low resolution')) { o.resolution = 720; return 'Export 720p (renders about twice as fast)'; }
    if (has(t, /\b(4k|2160p?|uhd)\b/)) { o.quality = 'high'; o.resolution = 1080; return 'Highest export here is 1080p (4K is not supported in the browser) — using 1080p, high quality'; }
    if (has(t, 'high quality', 'best quality', 'max quality', /\b(full )?hd\b/, '1080')) { o.quality = 'high'; o.resolution = 1080; return 'High quality export (1080p)'; }
    if (has(t, 'small file', 'smaller file', 'compress', 'low size', 'whatsapp')) { o.quality = 'small'; return 'Smaller file size'; }
    if (has(t, 'faster', 'quick render', 'fast render', 'speed up the render')) { o.fast = true; return 'Fast mode (720p, faster speech model)'; }
    for (const [k, v] of Object.entries(LANGS)) if (new RegExp(`\\b(in|language|speaking|spoken)\\s+${k}\\b|\\b${k}\\s+(video|speech|language|captions|subtitles)\\b`).test(t)) { o.language = v; return `Speech language: ${k[0].toUpperCase() + k.slice(1)}`; }
    return null;
  },
];

export function interpretVideoPrompt(text) { return runRules(text, VIDEO_RULES); }
export { clauses as splitClauses };

// ---------------- photos (Mode 1) ----------------
const IMAGE_RULES = [
  (t, c, o) => {
    if (has(t, 'black and white', 'black & white', 'b&w', 'monochrome', 'grayscale', 'greyscale')) { o.style = 'mono'; return 'Black & white'; }
    if (has(t, 'cinematic', 'film look', 'movie look', 'filmic')) { o.style = 'cinematic'; return 'Cinematic look'; }
    if (has(t, 'product', 'catalog', 'catalogue', 'ecommerce', 'e-commerce', 'amazon', 'flipkart')) { o.style = 'product'; return 'Product style'; }
    if (has(t, 'travel', 'landscape photo', 'scenery')) { o.style = 'travel'; return 'Travel style'; }
    if (has(t, 'portrait', 'skin', 'headshot', 'linkedin photo', 'profile photo')) { o.style = 'portrait'; return 'Portrait style'; }
    if (has(t, 'instagram look', 'social', 'insta look')) { o.style = 'social'; return 'Social-media style'; }
    return null;
  },
  (t, c, o) => { if (has(t, 'warm', 'golden', 'sunset', 'cozy', 'cosy')) { o.temp = 0.35; return 'Warmer tones'; } if (has(t, 'cool', 'cold', 'blue tone', 'icy')) { o.temp = -0.35; return 'Cooler tones'; } return null; },
  (t, c, o) => { if (has(t, 'brighter', 'bright', 'lighter', 'more light', 'too dark')) { o.exposure = 0.18; return 'Brighter'; } if (has(t, 'darker', 'moody', 'dramatic', 'too bright')) { o.exposure = -0.12; o.contrast = 0.12; return 'Moodier, more contrast'; } return null; },
  (t, c, o) => { if (has(t, 'vibrant', /\bpop\b/, 'colorful', 'colourful', 'saturated', 'vivid')) { o.vibrance = 0.2; return 'More vibrant colour'; } if (has(t, 'muted', 'desaturated', 'pastel', 'faded')) { o.vibrance = -0.25; return 'Muted colour'; } return null; },
  (t, c, o) => { if (has(t, 'subtle', 'natural', 'light touch', 'less edit', 'slight')) { o.intensity = 0.6; return 'Lighter touch'; } if (has(t, 'strong', 'heavy', 'more edit', 'dramatic edit')) { o.intensity = 1.35; return 'Stronger edit'; } return null; },
  (t, c, o) => { if (has(t, 'sharp', 'crisp', 'detail', 'clear')) { o.sharpen = 0.25; return 'Extra sharpness'; } if (has(t, 'soft', 'dreamy', 'smooth skin', 'smooth')) { o.sharpen = -0.2; o.fade = 0.04; return 'Softer look'; } return null; },
  // background
  (t, c, o) => {
    if (!has(t, 'background', /\bbg\b/, 'cut out', 'cutout', 'transparent')) return null;
    if (has(t, 'remove', 'transparent', 'cut out', 'cutout', 'no background', 'erase', 'delete')) { o.bg = 'transparent'; return 'Background removed (transparent PNG)'; }
    if (has(t, 'blur')) { o.bg = 'blur'; return 'Blurred background'; }
    if (has(t, 'studio', 'professional background')) { o.bg = 'studio'; return 'Studio background'; }
    const col = colorIn(t);
    if (col && col.name === 'white') { o.bg = 'white'; return 'Clean white background'; }
    if (col) { o.bg = 'color'; o.bgColor = col.hex; return `${col.name[0].toUpperCase() + col.name.slice(1)} background`; }
    if (has(t, 'change', 'replace', 'new')) { o.bg = 'studio'; return 'Background replaced (studio) — upload your own image under Background for a custom one'; }
    return null;
  },
  // designs
  (t, c, o, full) => {
    let n = null;
    if (has(t, 'thumbnail', 'youtube cover')) { o.design = 'youtube'; n = 'YouTube thumbnail'; }
    else if (has(t, /\bstory (cover|design|image|post)\b/, /\b(insta(gram)?|whatsapp) (story|status)\b/, 'reel cover')) { o.design = 'story'; n = 'Story / Reel cover'; }
    else if (has(t, 'instagram post', 'insta post', 'poster', 'post design', 'flyer', 'social post')) { o.design = 'post'; n = 'Instagram post'; }
    const title = quoted(full, 'title|heading|headline|text|saying|that says|with');
    if (title && (o.design || has(t, 'title', 'heading', 'headline', 'text'))) { o.designTitle = title.slice(0, 70); if (!o.design) { o.design = 'youtube'; n = 'YouTube thumbnail'; } n += ` with “${o.designTitle}”`; }
    const col = has(t, 'accent', 'highlight', 'text colo') ? colorIn(t) : null;
    if (col && o.design) { o.designAccent = col.hex; n = (n || 'Design') + `, ${col.name} accent`; }
    return n;
  },
  (t, c, o) => {
    if (/\b(as|in|to|export|save|download)\b.*\bpng\b|\bpng (file|format)\b/.test(t) && !o.bg) { o.format = 'image/png'; return 'PNG download'; }
    if (/\bwebp\b/.test(t)) { o.format = 'image/webp'; return 'WebP download'; }
    if (/\b(jpe?g)\b/.test(t)) { o.format = 'image/jpeg'; return 'JPEG download'; }
    return null;
  },
  // crop (only when no design was requested in this clause)
  (t, c, o) => {
    if (o.design && has(t, 'thumbnail', 'post', 'story', 'cover', 'poster')) return null;
    if (has(t, 'square', '1:1')) { o.aspect = '1:1'; return 'Square crop'; }
    if (has(t, '9:16', 'vertical')) { o.aspect = '9:16'; return 'Vertical 9:16 crop'; }
    if (has(t, '4:5', 'portrait crop')) { o.aspect = '4:5'; return '4:5 crop'; }
    if (has(t, '16:9', 'widescreen', 'landscape crop')) { o.aspect = '16:9'; return '16:9 crop'; }
    return null;
  },
];

export function interpretImagePrompt(text) {
  const r = runRules(text, IMAGE_RULES);
  // keep the shape expected by image-engine (mod.* + mod.notes)
  return { ...r.o, notes: r.notes, understood: r.understood, notUnderstood: r.notUnderstood, parts: r.parts };
}

// one-line summary for toasts / reports
export function promptSummary(r) {
  const a = r.understood.length ? 'Applied: ' + r.understood.join(' · ') : 'No instruction recognised — automatic edit kept';
  const b = r.notUnderstood.length ? ` — Not understood: “${r.notUnderstood.slice(0, 3).join('”, “')}”${r.notUnderstood.length > 3 ? '…' : ''}` : '';
  const c = r.cannot && r.cannot.length ? ` — Cannot do: ${r.cannot.join('; ')}` : '';
  return a + b + c;
}
