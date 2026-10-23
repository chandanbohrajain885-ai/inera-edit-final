# Inera Edit Flow — AI Photo, Video & Avatar Studio (v2)

Upload raw media → the app watches, listens and edits it → preview → download.
**Free. No sign-up, no API keys, no paid services, no server.** Everything runs in the visitor's
browser; media never leaves their device.

| Mode | Input | Output |
|---|---|---|
| 1. Image Editor | 1–20 JPG/PNG/WebP photos | Enhanced photos (before/after, versions, ZIP) + **background removal / replacement** + **YouTube thumbnail, Instagram post, Story designs** |
| 2. Video Editor (AI) | 1 video, **1 second to 3 hours** (desktop Chrome/Edge) | Edited video with **word-timed captions**, retakes/fillers/silences cut, **topic visuals for what you talk about**, number pops, subscribe button, chapters, hook opening, original music with ducking, SFX, colour grade — plus **SRT, VTT, transcript, description with chapters + hashtags + credits** |
| 3. Image → Video | 1–30 photos | Animated slideshow with camera moves and music |
| 4. Video → Images | 1 video (up to 3 h in Chrome/Edge) | Best still frames, ZIP |
| 5. Avatar Studio | A script, **or your recorded / uploaded voice** | 3D presenter with lip-sync, blinks, eye contact, head nods, hand gestures and emotions, then auto-edited (captions, visuals, music). **Real-face** lip-sync of your own face via the included free Google Colab notebook |

---

## 1. Deploy to Vercel — no build step

This is a static site: no `package.json`, no install, no build. Nothing can fail to build.

1. Put **all 70 files** at the **root** of a GitHub repository (`index.html` must be at the top level,
   not inside a folder). Total ≈ 30 MB; the largest file is 9.9 MB. Big assets are stored
   gzip-compressed (`*.dat`) and unpacked by the browser. **Follow `UPLOAD-STEPS.txt`** — GitHub's
   web uploader fails on large single commits, so upload in 3 batches or use GitHub Desktop.
2. Vercel → **Add New → Project → Import** the repository.
3. Framework Preset **Other**; leave Build, Output and Install commands **empty**.
4. **Deploy**. Then open `https://<your-app>.vercel.app/self-test.html` once and press
   **Full AI test** — it checks codecs, disk storage, model downloads and web images on that computer.

`vercel.json` sets the headers the app needs: Content-Security-Policy (only the site itself,
Hugging Face for the one-time model downloads, Wikimedia Commons and Openverse for free images),
cross-origin isolation (multi-threaded AI), microphone allowed for this site only.

### Run locally (optional)
Must be served over http (not `file://`). For multi-threading, serve the `vercel.json` headers;
plain `python3 -m http.server` works but AI runs single-threaded.

## 2. What visitors need

| | Recommended | Works, with limits |
|---|---|---|
| Browser | **Desktop Chrome or Edge** (latest) | Firefox, Safari, mobile browsers |
| Long videos (5 min – 3 h) | Chrome/Edge: decode + encode with WebCodecs, output streamed to disk | Others: classic real-time editor, max 5 min / 400 MB, no captions/visuals |
| Output format | MP4 (H.264 + AAC) on Windows/macOS Chrome/Edge | WebM (VP9 + Opus) where H.264 encoding is unavailable (e.g. many Linux builds) |
| First run | Internet for the one-time downloads: speech model ~160 MB (Whisper base) or ~100 MB (tiny), voice model ~90 MB | Then cached; works offline except web images |
| Hardware | 8 GB+ RAM, any GPU with hardware acceleration on | Low-end laptops are slower (time left is shown) |

## 3. How it works

```
Video → demux (mp4box / own WebM parser) → WebCodecs decode (frame-accurate, unlimited length)
      → WATCH: faces, motion, shake, sharpness, exposure, scene cuts
      → LISTEN: audio to disk (OPFS), voice activity, loudness
      → Whisper speech-to-text (ONNX Runtime Web, multi-threaded) → words with timings
      → UNDERSTAND: sentences, topics, questions, numbers, lists, calls-to-action, retakes, fillers, hook, chapters
      → DIRECT: cut list, captions, B-roll plan, graphics, grade, music mood, SFX (every decision explained)
      → VISUALS: your clips → Wikimedia/Openverse (CC0 · PD · CC BY only) → offline illustration
      → RENDER: WebGL compositor + canvas graphics → WebCodecs encode → MP4/WebM streamed to disk
      → VERIFY: output re-opened and checked (duration, video, audio) → preview, downloads, Recent Projects
```

Avatar Studio: Kokoro-82M voice (or your recording + Whisper) → word timings → TalkingHead 3D
presenter (visemes, blinks, nods, gestures, moods) recorded in real time → the same director/renderer.

Projects persist in the browser (IndexedDB + Origin Private File System for large videos). There
are no accounts, so nobody is ever "signed out". Settings → *Keep my projects* asks the browser not
to evict storage.

## 4. Prompts

Every mode works with **no prompt** (fully automatic). If you type one, it **overrides the dropdowns**.
While you type, green chips show exactly what will be applied and yellow chips show what was not
understood (and will be ignored) — nothing is silently dropped. Examples that work:

- Video: *"Make a 30-second Reel, viral style with a hook, big yellow captions at the top, more topic
  images, calm lofi music, warm colours, title "3 Pizza Secrets", my name is Priya Sharma"*,
  *"keep all my speech, no zoom, smooth transitions, black and white, mute original audio"*,
  *"hindi video, clean subtitles at the bottom, small file"*.
- Photos: *"warmer and brighter, square crop"*, *"remove background"*, *"white background for Amazon
  product"*, *"blue background"*, *"YouTube thumbnail with title "Best Gadget 2026""*,
  *"Instagram story cover saying "New drop", export as PNG"*.

Understanding works in two layers, both on the device: exact rules (numbers, titles, colours,
positions) and meaning matching with a small language model (all-MiniLM-L6-v2, 23 MB, downloaded once
from Hugging Face). So simple wording works: *"make it professional for LinkedIn with subtitles"*,
*"it's a wedding video, make it emotional and remove the boring parts"*, *"I need this for my Amazon
store"*. Requests the editor cannot do (*"remove background noise"*, *"make me look younger"*,
*"add a dancing cat"*) are answered with "not possible here" instead of being ignored. It is not a
chatbot: it maps your words onto the editor's real settings; it cannot invent new content.

## 5. Speed — what was done and what to expect

**The AI starts the moment you drop a video.** Listening, watching and speech-to-text run in the
background while you read the options or type a prompt; the likely topic pictures are searched and
downloaded too. When you press *AI auto edit*, the edit usually starts straight at rendering.

Measured on the build machine with a 33-second 1080p H.264 talking-head video (2 CPU cores and **no
graphics card** — software graphics, so rendering here is far slower than on a normal laptop):

| Step | Time on the build machine |
|---|---|
| Listening + watching + speech-to-text (in the background after upload) | ~15 s |
| Finding topic visuals (pre-fetched in the background) | 0–7 s |
| Rendering 1080p / 720p | ~2.5 min / ~1.3 min (software graphics; a laptop GPU is much faster — not measured here) |

**Never stuck.** Every step has a safety limit:
- If the computer's hardware video decoder freezes (a known problem with some Windows graphics
  drivers), the app switches that video to the software decoder within ~4 seconds and carries on.
- The video scan has a time budget; on a slow computer it samples the rest of the video from
  keyframes instead of decoding every frame.
- Each piece of speech has a time limit; a stuck speech engine is stopped and another one takes the
  piece. If speech truly cannot be transcribed in time, the edit still finishes (that part simply has
  no captions, and the talk is never cut blindly).
- Each running step shows its elapsed time every second, so a long step never looks frozen.

Other speed facts:
- Speech-to-text uses several **single-threaded** engines in parallel (one per spare CPU core). They
  cannot starve the rest of the page the way one big multi-threaded engine can on a busy laptop.
- **Auto speech model:** fast *tiny* for English, accurate *base* for other languages.
- Captions and graphics are only redrawn when they change (not on every frame).
- Models download once (~100 MB for English) and are cached. **Use one fixed address** (your
  production `…vercel.app` domain): each new preview URL is a new website to the browser and downloads
  the models again.
- Every result shows **"Time taken"** per step and a render breakdown — send that line if something
  is slow.
- Export 720p (Customize → Resolution, or the prompt "make it 720p") roughly halves rendering time.

## 6. Honest limits — read before promising features to users

- **Speed:** depends on the computer, mostly on its graphics card for rendering. Analysis starts at
  upload and runs while you choose options. A 1-hour edit still takes a long time in a browser
  (tens of minutes). Every step shows its running time, and every result shows where the time went.
- **Captions** use Whisper *tiny* for English (fast) and *base* for other languages: very good on
  clear speech; names, brand terms and heavy background noise need checking. Topic understanding
  (visuals, title, chapters) is English-first.
- **Topic visuals** are real free photos or illustrations, not generated images. Abstract words
  ("success", "mindset") get illustrations, never random photos. Quality depends on what Wikimedia
  and Openverse have for that keyword. Users' own B-roll (named by topic) always wins.
- **Avatar:** one built-in CC0 presenter; users can load their own `.glb` with ARKit + Oculus
  viseme blend shapes. Script voices are **English only** (6 voices); other languages work with a
  recorded voice. The avatar records in real time and the tab must stay visible.
- **Real face** (your own face lip-synced): runs in the included **Colab notebook** (LatentSync 1.5 on
  a free T4 GPU). It follows LatentSync's official scripts, but **was not executed on a GPU during
  development** — its preparation/labelling steps were tested; inference was not. LatentSync uses
  InsightFace face models that are **non-commercial** — see THIRD_PARTY_NOTICES.md.
- **Not included:** separating music from speech (stem removal), text-to-image or generative video,
  gimbal-grade stabilisation (light, translation-only).
- **Testing done here** (Linux, 2 CPU cores, **no graphics card**): every mode in headless Chromium,
  and your own 33-second 1080p **H.264/AAC** talking-head video end to end in a Chromium 140 build
  with H.264 (Electron), including a simulated frozen hardware decoder and a simulated too-slow speech
  engine (both recover and finish). **Not testable here:** real GPU speed on Windows/Mac, real
  hardware decoders, and live downloads from Hugging Face/Wikimedia/Openverse (blocked in the build
  sandbox — the self-test page checks them on your machine).

## 7. Files

| File | Role |
|---|---|
| `index.html`, `styles.css`, `app.js` | UI, routing, jobs, stage tracker with time left, projects, downloads, settings, help |
| `self-test.html`, `self-test.js` | Device self-test page |
| `utils.js`, `store.js` | Validation, probing, verification, ZIP; IndexedDB + on-disk project storage |
| `image-worker.js`, `image-engine.js` | Photo analysis and enhancement |
| `segment-worker.js`, `u2netp.onnx`, `design.js` | Subject cut-out, background replacement, thumbnail/post/story designer |
| `media-demux.js`, `media-decode.js`, `media-encode.js`, `media-source.js`, `media-libs.js` | MP4/WebM demux, WebCodecs decode, PCM store, encoder + muxers |
| `asr.js`, `asr-worker.js` | Whisper speech-to-text: VAD chunking, parallel engines (one worker each), word timing |
| `analysis.js`, `understand.js`, `visual-lexicon.dat` | Watch + listen pass; transcript understanding; keyword → illustration lexicon |
| `director.js`, `graphics.js`, `visuals.js`, `render-engine.js`, `compositor.js`, `music.js` | Edit director, captions/graphics, B-roll sourcing, renderer, WebGL compositor, music & SFX |
| `video-analyzer.js`, `video-editor.js`, `slideshow.js`, `frame-extractor.js` | Analysis helpers, classic editor (fallback), Mode 3, Mode 4 |
| `tts.js`, `tts-worker.js`, `headtts-*` (dictionary: `headtts-dict-en-us.dat`) | Kokoro text-to-speech with English phonemiser |
| `avatar.js`, `avatar-lib.js`, `avatar-female.glb.dat`, `lipsync-*.mjs`, `playback-worklet.js` | 3D presenter |
| `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-runtime.wasm.dat`, `ort-loader.js`, `gz.js` | ONNX Runtime Web, processor build (14.2 MB WebAssembly stored gzip-compressed as 3.7 MB, size-checked and cached by `ort-loader.js`); `gz.js` unpacks every `.dat` file |
| `prompt.js`, `prompt-ai.js`, `prompt-intents.js`, `nlu-worker.js`, `nlu-tokenizer.js`, `nlu-vocab.dat` | Prompt understanding: exact rules + meaning matching (MiniLM sentence model) against a library of intents, with honest "not possible" answers |
| `inera-realface-lipsync.ipynb` | Free Colab notebook for real-face lip-sync |

## 8. Security & privacy

- Files validated by content (magic bytes) and dimensions before decoding.
- No server: no uploads, no server-side code, no secrets in the code.
- Strict CSP: scripts only from this site; network only to the site, Hugging Face (model files),
  Wikimedia Commons and Openverse (keyword searches, no user media). Web images can be switched off.
- All user text is escaped; on-video text is drawn on canvas.
- Microphone is used only when the user presses Record in Avatar Studio.
- Real-face notebook requires explicit consent and labels output "AI-generated".

## 9. Licences

Original code © INERA GROUP (Inera Software Pvt. Ltd.). Third-party components, models and data
(all commercial-use compatible, with the InsightFace note for the Colab notebook) are listed in
`THIRD_PARTY_NOTICES.md`.
