# Third-party notices — Inera Edit Flow

Everything not listed here (UI, image pipeline, video analysis, transcript understanding, edit
director, graphics, music composer, mixer, WebGL compositor, encoder pipeline, ZIP writer) is
original code in this project.

All components below allow **commercial use**. Where attribution is required, it is given here and,
for images placed into your videos, in the exported credits file.

## Code bundled in this app

| Component | Files | Licence | Copyright |
|---|---|---|---|
| pico / picojs (face detection) | `face-detect.js`, `facefinder.bin` | MIT | © 2013 Nenad Markus |
| ONNX Runtime Web 1.30 | `ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-runtime.wasm.dat` (the original `ort-wasm-simd-threaded.wasm`, gzip-compressed, unmodified) | MIT | © Microsoft Corporation |
| mp4box.js (MP4 reading) | inside `media-libs.js` | BSD-3-Clause | © 2012–2024 Telecom Paris, Cyril Concolato and contributors |
| mp4-muxer / webm-muxer | inside `media-libs.js` | MIT | © 2023 Vanilagy |
| TalkingHead (3D presenter, lip-sync rules) | inside `avatar-lib.js`, `lipsync-*.mjs`, `playback-worklet.js` — see `talkinghead-LICENSE.txt` | MIT | © 2024 Mika Suominen |
| three.js r180 | inside `avatar-lib.js` | MIT | © 2010–2025 three.js authors |
| HeadTTS English text-to-phoneme | `headtts-*.mjs`, `headtts-dict-en-us.dat` — see `headtts-LICENSE.txt` | MIT | © 2025 Mika Suominen |
| CMU Pronouncing Dictionary 0.7b (data inside the dictionary file) | `headtts-dict-en-us.dat` | BSD-2-Clause style | © 1993–2015 Carnegie Mellon University |
| emojilib (keyword → emoji map) | inside `visual-lexicon.dat` | MIT | © 2014 Mu-An Chiou |

## Data and models bundled in this app

| Item | File | Licence | Source / copyright |
|---|---|---|---|
| Twemoji graphics (offline illustrations) | inside `visual-lexicon.dat` | **CC BY 4.0** — attribution required | © Twitter, Inc. and other contributors — https://github.com/jdecked/twemoji. Credits are added automatically to the exported credits file whenever a graphic is used in a video. |
| U²-Net small (`u2netp`) subject segmentation | `u2netp.onnx` | Apache-2.0 | © Xuebin Qin et al., https://github.com/xuebinqin/U-2-Net (ONNX export distributed by rembg, MIT, © 2020 Daniel Gatis) |
| Presenter avatar | `avatar-female.glb.dat` | CC0 1.0 (public domain) | MakeHuman / MPFB character, as distributed with TalkingHead (`mpfb.glb`); textures compressed for the web |

## Models downloaded on first use (from huggingface.co, then cached by the browser)

| Model | Licence | Source |
|---|---|---|
| Whisper base / tiny (speech recognition) | MIT (© OpenAI) | ONNX int8 export by k2-fsa/sherpa-onnx (Apache-2.0): `csukuangfj/sherpa-onnx-whisper-base`, `-tiny` |
| Kokoro-82M v1.0 (text to speech) and its voices | Apache-2.0 (© hexgrad) | ONNX export: `onnx-community/Kokoro-82M-v1.0-ONNX` |
| all-MiniLM-L6-v2 (prompt understanding) | Apache-2.0 (© sentence-transformers / Microsoft MiniLM) | ONNX int8 export: `Xenova/all-MiniLM-L6-v2`; vocabulary bundled as `nlu-vocab.dat` |

## Web images (optional, when "Free web images" is on)

Images are searched on **Wikimedia Commons** and **Openverse**. Only images whose licence is CC0,
Public Domain, or CC BY (any version) are accepted — share-alike (BY-SA) and non-commercial (NC)
licences are rejected. The title, author, licence and link of every image used are written to the
credits text that comes with your video. **Keep those credits in your video description** — CC BY
requires it.

## Music

All background music and sound effects are synthesised at render time by `music.js` (Web Audio
oscillators, filters and noise). No recordings or songs by other artists are included or
downloaded. The generated tracks are original: royalty-free, commercial use allowed, no attribution
required.

## Real-face notebook (runs in Google Colab, not in this app)

`inera-realface-lipsync.ipynb` installs and runs **LatentSync 1.5** (© ByteDance, Apache-2.0) with
Whisper tiny (MIT) and `stabilityai/sd-vae-ft-mse` (MIT). LatentSync downloads **InsightFace
"buffalo_l"** face-detection models, which InsightFace releases for **non-commercial research use
only** — get a commercial licence from InsightFace before using real-face output in paid work.

## Logo

`logo.png`, `logo-mark.png` and `favicon.png` are derived only from the INERA logo supplied by the
owner (background made transparent, emblem cropped). No other logos are used.

## MIT licence text (applies to every component marked MIT above)

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0 · BSD-3-Clause:
https://opensource.org/license/bsd-3-clause · CC BY 4.0: https://creativecommons.org/licenses/by/4.0/
