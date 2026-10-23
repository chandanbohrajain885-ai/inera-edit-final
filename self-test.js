// Inera Edit Flow — on-device self-test: browser features, codecs, storage, model hosting, web images, AI round trip.
import { chooseCodecs, encodeTimeline, deleteRenderFile } from './media-encode.js';
import { verifyVideoBlob, fmtBytes } from './utils.js';
import { defaultModelBase, transcribe, asrPlan } from './asr.js';
import { ttsUrls, speakScript } from './tts.js';
import { nluModelUrl } from './prompt-ai.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const results = [];
function row(name) {
  const el = document.createElement('div'); el.className = 'st-row run';
  el.innerHTML = `<span class="st-dot"></span><div><b>${esc(name)}</b><small>Checking…</small></div>`;
  $('#stList').appendChild(el);
  return {
    set(state, text) { el.className = 'st-row ' + state; el.querySelector('small').textContent = text; results.push({ name, state, text }); },
    note(text) { el.querySelector('small').textContent = text; },
  };
}
async function check(name, fn) {
  const r = row(name);
  try { const [state, text] = await fn((t) => r.note(t)); r.set(state, text); }
  catch (e) { r.set('bad', String(e && e.message || e)); }
}
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

// every file the app ships with (a missing one = incomplete GitHub upload)
const APP_FILES = ["README.md", "THIRD_PARTY_NOTICES.md", "UPLOAD-STEPS.txt", "analysis.js", "app.js", "asr-worker.js", "asr.js", "avatar-female.glb.dat", "avatar-lib.js", "avatar.js", "compositor.js", "design.js", "director.js", "face-detect.js", "facefinder.bin", "favicon.png", "frame-extractor.js", "graphics.js", "gz.js", "headtts-LICENSE.txt", "headtts-dict-en-us.dat", "headtts-language-en-us.mjs", "headtts-language.mjs", "headtts-utils.mjs", "image-engine.js", "image-worker.js", "index.html", "inera-realface-lipsync.ipynb", "lipsync-de.mjs", "lipsync-en.mjs", "lipsync-fi.mjs", "lipsync-fr.mjs", "lipsync-lt.mjs", "logo-mark.png", "logo.png", "media-decode.js", "media-demux.js", "media-encode.js", "media-libs.js", "media-source.js", "music.js", "nlu-tokenizer.js", "nlu-vocab.dat", "nlu-worker.js", "ort-loader.js", "ort-runtime.wasm.dat", "ort-wasm-simd-threaded.mjs", "ort.wasm.min.mjs", "playback-worklet.js", "prompt-ai.js", "prompt-intents.js", "prompt.js", "render-engine.js", "segment-worker.js", "self-test.html", "self-test.js", "slideshow.js", "store.js", "styles.css", "talkinghead-LICENSE.txt", "tts-worker.js", "tts.js", "u2netp.onnx", "understand.js", "utils.js", "vercel.json", "video-analyzer.js", "video-editor.js", "visual-lexicon.dat", "visuals.js"];
async function quick() {
  $('#stList').innerHTML = ''; results.length = 0; $('#stSum').hidden = true;
  await check('App files on the server', async (note) => {
    const missing = [];
    let done = 0;
    await Promise.all(APP_FILES.map(async (f) => {
      try { const r = await fetch(f, { method: 'HEAD', cache: 'no-store' }); if (!r.ok) missing.push(f); } catch (e) { missing.push(f); }
      note(`Checking ${++done} of ${APP_FILES.length}…`);
    }));
    return missing.length ? ['bad', `${missing.length} missing: ${missing.sort().join(', ')} — upload these to the repository root and redeploy.`] : ['ok', `All ${APP_FILES.length} files present.`];
  });
  await check('Browser', async () => {
    const ua = navigator.userAgent;
    const name = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown';
    const mobile = /Mobi|Android|iPhone|iPad/.test(ua);
    return [name === 'Chrome' || name === 'Edge' ? (mobile ? 'warn' : 'ok') : 'warn', `${name}${mobile ? ' (mobile)' : ''} · ${navigator.hardwareConcurrency || '?'} CPU threads${navigator.deviceMemory ? ` · ~${navigator.deviceMemory} GB RAM` : ''}${name === 'Chrome' || name === 'Edge' ? '' : ' — desktop Chrome or Edge is recommended for long videos'}`];
  });
  await check('Multi-threading (cross-origin isolation)', async () => self.crossOriginIsolated ? ['ok', `On — ${navigator.hardwareConcurrency || '?'} cores. Speech-to-text runs ${asrPlan('tiny').engines} engine(s) in parallel × ${asrPlan('tiny').threads} thread(s).`] : ['warn', 'Off — AI runs single-threaded (slower). Check that vercel.json headers are deployed.']);
  await check('WebGL (rendering, 3D presenter)', async () => {
    const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return ['bad', 'Not available — video rendering and the avatar will not work. Enable hardware acceleration in browser settings.'];
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'GPU';
    return [/swiftshader|llvmpipe|software/i.test(r) ? 'warn' : 'ok', `${gl instanceof WebGL2RenderingContext ? 'WebGL 2' : 'WebGL 1'} · ${r}${/swiftshader|llvmpipe|software/i.test(r) ? ' (software — slow; enable hardware acceleration)' : ''}`];
  });
  await check('Video decoding (WebCodecs)', async () => {
    if (typeof VideoDecoder === 'undefined') return ['warn', 'Not available — the classic editor (max 5 min) will be used.'];
    const tests = [['H.264', 'avc1.64001f'], ['HEVC', 'hvc1.1.6.L93.B0'], ['VP9', 'vp09.00.10.08'], ['AV1', 'av01.0.04M.08']];
    const ok = [];
    for (const [n, c] of tests) { try { if ((await VideoDecoder.isConfigSupported({ codec: c, codedWidth: 1280, codedHeight: 720 })).supported) ok.push(n); } catch (e) { /* no */ } }
    return [ok.includes('H.264') ? 'ok' : 'warn', `Can read: ${ok.join(', ') || 'none'}${ok.includes('HEVC') ? '' : ' — iPhone HEVC videos must be exported as "Most Compatible" (H.264)'}`];
  });
  await check('Video encoding (export format)', async () => {
    const c = await chooseCodecs(1920, 1080, 30, 8_000_000);
    if (!c) return ['warn', 'No WebCodecs encoder — the classic real-time editor will be used (WebM/MP4 via MediaRecorder).'];
    const fmt = `${c.video.container.toUpperCase()} · ${c.video.label}${c.audio ? ' + ' + c.audio.label : ' (no audio encoder!)'}`;
    return [c.video.container === 'mp4' && c.audio ? 'ok' : 'warn', fmt + (c.video.container === 'mp4' ? '' : ' — MP4/H.264 is not available here, output will be WebM (plays in browsers, YouTube accepts it; some phones/editors may not)')];
  });
  await check('Disk storage for long renders (OPFS)', async () => {
    const dir = await navigator.storage.getDirectory();
    const h = await dir.getFileHandle('selftest.tmp', { create: true });
    if (!h.createWritable) { await dir.removeEntry('selftest.tmp'); return ['warn', 'Streaming writes not supported — outputs are kept in memory (long videos limited to ~20 minutes).']; }
    const w = await h.createWritable(); await w.write(new Uint8Array(1024 * 1024)); await w.close();
    const f = await h.getFile(); await dir.removeEntry('selftest.tmp');
    const est = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    return [f.size === 1048576 ? 'ok' : 'bad', `Write/read OK · ${fmtBytes(est.quota - est.usage)} free for this site${persisted ? ' · persistent' : ''}`];
  });
  await check('Real export test (2-second video with sound)', async (note) => {
    if (typeof VideoEncoder === 'undefined') return ['warn', 'Skipped — no WebCodecs encoder.'];
    const W = 640, H = 360; const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = cv.getContext('2d');
    const t0 = performance.now();
    const res = await encodeTimeline({ canvas: cv, W, H, fps: 30, duration: 2, name: 'selftest',
      renderFrame: (t) => { x.fillStyle = `hsl(${t * 180},70%,45%)`; x.fillRect(0, 0, W, H); x.fillStyle = '#fff'; x.font = 'bold 48px sans-serif'; x.fillText('Inera ' + t.toFixed(2), 40, 200); },
      audioBlock: (a, b) => { const n = Math.round((b - a) * 48000); const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = 0.2 * Math.sin(2 * Math.PI * 440 * (a + i / 48000)); return [L, L]; },
      onProgress: (p) => note(`Encoding… ${Math.round(p * 100)}%`) });
    const chk = await verifyVideoBlob(res.file, { expectedDuration: 2, expectAudio: true });
    if (res.onDisk) await deleteRenderFile(res.fileName);
    if (!chk.ok) return ['bad', 'Export failed verification: ' + chk.error];
    return ['ok', `${res.label} · ${chk.duration.toFixed(2)}s${chk.hasAudio ? ' with audio' : ''} · encoded in ${((performance.now() - t0) / 1000).toFixed(1)}s`];
  });
  await check('Microphone (Avatar Studio recording)', async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return ['warn', 'Not available in this browser/context.'];
    let st = 'prompt'; try { st = (await navigator.permissions.query({ name: 'microphone' })).state; } catch (e) { /* not supported */ }
    return [st === 'denied' ? 'warn' : 'ok', st === 'granted' ? 'Allowed' : st === 'denied' ? 'Blocked for this site — allow it in the address bar to record your voice' : 'Will ask for permission when you press Record'];
  });
  const head = async (url) => {
    try { const r = await withTimeout(fetch(url, { headers: { Range: 'bytes=0-1023' }, mode: 'cors', credentials: 'omit' }), 15000); return r.status; }
    catch (e) { throw new Error(`Could not reach ${new URL(url).host} (${e.message}). A firewall, ad-blocker or school/office network may block it — AI models cannot download on this network.`); }
  };
  await check('Speech model hosting (Hugging Face)', async () => {
    const st = await head(defaultModelBase('base') + 'base-tokens.txt');
    return [st === 200 || st === 206 ? 'ok' : 'bad', st === 200 || st === 206 ? 'Reachable — Whisper downloads once and is cached.' : `HTTP ${st} — speech recognition cannot download. A network filter may block huggingface.co.`];
  });
  await check('Voice model hosting (Hugging Face)', async () => {
    const u = ttsUrls(); const st = await head(u.voices + 'af_heart.bin');
    return [st === 200 || st === 206 ? 'ok' : 'bad', st === 200 || st === 206 ? 'Reachable — Kokoro voice downloads once and is cached.' : `HTTP ${st} — script-to-voice cannot download.`];
  });
  await check('Prompt language model hosting (Hugging Face)', async () => {
    const st = await head(nluModelUrl());
    return [st === 200 || st === 206 ? 'ok' : 'warn', st === 200 || st === 206 ? 'Reachable — simple-language prompts are understood (23 MB, once).' : `HTTP ${st} — prompts fall back to exact phrases only.`];
  });
  await check('Free web images (Wikimedia Commons / Openverse)', async () => {
    let a = 'blocked', b = 'blocked';
    try { const r = await withTimeout(fetch('https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=pizza&srnamespace=6&srlimit=1', { credentials: 'omit' }), 12000); if (r.ok) a = 'OK'; } catch (e) { /* blocked */ }
    try { const r = await withTimeout(fetch('https://api.openverse.org/v1/images/?q=pizza&page_size=1', { credentials: 'omit' }), 12000); if (r.ok) b = 'OK'; } catch (e) { /* blocked */ }
    return [a === 'OK' || b === 'OK' ? 'ok' : 'warn', `Wikimedia: ${a} · Openverse: ${b}${a !== 'OK' && b !== 'OK' ? ' — topic visuals will use offline illustrations' : ''}`];
  });
  summary();
}
async function full() {
  await quick();
  await check('AI round trip: script → voice → speech-to-text', async (note) => {
    const text = 'Hello from Inera. Pizza is ready in ten minutes.';
    const t0 = performance.now();
    const v = await speakScript(text, { voice: 'af_heart', onDownload: (m) => m.total && note(`Downloading voice model ${fmtBytes(m.loaded)} / ${fmtBytes(m.total)}`) });
    note('Voice OK — transcribing…');
    const n16 = Math.floor(v.audio.length / 1.5); const p16 = new Float32Array(n16);
    for (let i = 0; i < n16; i++) { const a = i * 1.5; const k = Math.floor(a); p16[i] = (v.audio[k] + (v.audio[k + 1] || 0)) / 2; }
    const tr = await transcribe(p16, { model: 'base', onDownload: (m) => m.total && note(`Downloading speech model ${fmtBytes(m.loaded)} / ${fmtBytes(m.total)}`) });
    const heard = tr.segments.map((s) => s.text).join(' ').trim();
    const ok = /pizza/i.test(heard) && /inera|in era|inara/i.test(heard);
    return [ok ? 'ok' : 'warn', `Heard: “${heard}” · ${((performance.now() - t0) / 1000).toFixed(1)}s total`];
  });
  summary();
}
function summary() {
  const bad = results.filter((r) => r.state === 'bad').length, warn = results.filter((r) => r.state === 'warn').length;
  const el = $('#stSum'); el.hidden = false;
  el.innerHTML = bad ? `<b class="st-bad">${bad} problem${bad > 1 ? 's' : ''}</b> — see the red rows. Everything else still works.` : warn ? `<b class="st-warn">Works, with ${warn} limitation${warn > 1 ? 's' : ''}</b> — see the yellow rows.` : '<b class="st-ok">All checks passed.</b> This browser supports every feature.';
}
$('#stQuick').addEventListener('click', quick);
$('#stFull').addEventListener('click', full);
quick();
