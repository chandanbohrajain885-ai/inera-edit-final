// Inera Edit Flow — offline (faster-than-real-time) encoder: WebCodecs VideoEncoder + AudioEncoder,
// muxed with mp4-muxer / webm-muxer (MIT) and streamed to disk (browser OPFS), so output length is
// not limited by memory. MP4 = H.264 (+ AAC where available, else Opus); fallback WebM = VP9 + Opus.
import { Mp4Muxer, WebmMuxer } from './media-libs.js';
import { checkAbort, AbortError, clamp } from './utils.js';

export const QUALITY = {
  high: { label: 'High quality', bpp: 0.16, audio: 192000 },
  balanced: { label: 'Balanced', bpp: 0.1, audio: 160000 },
  small: { label: 'Smaller file', bpp: 0.06, audio: 128000 },
};

function avcLevel(W, H, fps) {
  const mbs = Math.ceil(W / 16) * Math.ceil(H / 16) * fps;
  if (mbs <= 245760 && W * H <= 2097152) return '28'; // 4.0 (1080p30)
  if (mbs <= 522240) return '32'; // 4.2 (1080p60)
  if (W * H <= 8912896 && mbs <= 983040) return '33'; // 5.1? (approx)
  return '34';
}

export async function chooseCodecs(W, H, fps, bitrate, force) {
  if (typeof VideoEncoder === 'undefined') return null;
  const lvl = avcLevel(W, H, fps);
  let vcands = [
    { codec: `avc1.6400${lvl}`, mux: 'avc', container: 'mp4', label: 'H.264 High' },
    { codec: `avc1.4d00${lvl}`, mux: 'avc', container: 'mp4', label: 'H.264 Main' },
    { codec: `avc1.4200${lvl}`, mux: 'avc', container: 'mp4', label: 'H.264 Baseline' },
    { codec: 'vp09.00.40.08', mux: 'V_VP9', container: 'webm', label: 'VP9' },
    { codec: 'vp8', mux: 'V_VP8', container: 'webm', label: 'VP8' },
  ];
  if (force === 'mp4-vp9') vcands = [{ codec: 'vp09.00.40.08', mux: 'vp9', container: 'mp4', label: 'VP9' }]; // test hook
  let video = null;
  for (const c of vcands) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      // VP9/VP8 are usually software encoders: 'realtime' is measured 1.6x faster at the same size
      const cfg = { codec: c.codec, width: W, height: H, bitrate, framerate: fps, hardwareAcceleration: hw, latencyMode: c.mux === 'avc' ? 'quality' : 'realtime', bitrateMode: 'variable' };
      if (c.mux === 'avc') cfg.avc = { format: 'avc' };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) { video = { ...c, config: cfg }; break; } } catch (e) { /* next */ }
    }
    if (video) break;
  }
  if (!video) return null;
  let audio = null;
  if (typeof AudioEncoder !== 'undefined') {
    const acands = video.container === 'mp4'
      ? [{ codec: 'mp4a.40.2', mux: 'aac', label: 'AAC' }, { codec: 'opus', mux: 'opus', label: 'Opus' }]
      : [{ codec: 'opus', mux: 'A_OPUS', label: 'Opus' }];
    for (const c of acands) {
      const cfg = { codec: c.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 };
      try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) { audio = { ...c, config: cfg }; break; } } catch (e) { /* next */ }
    }
  }
  return { video, audio };
}

// Disk-backed output (OPFS). Falls back to memory for short outputs when OPFS writing is unavailable.
async function openOutput(name) {
  try {
    const dir = await navigator.storage.getDirectory();
    const handle = await dir.getFileHandle(name, { create: true });
    const writer = await handle.createWritable();
    let chain = Promise.resolve(); let err = null;
    return {
      onDisk: true,
      write: (data, position) => { const copy = data.slice(); chain = chain.then(() => writer.write({ type: 'write', position, data: copy })).catch((e) => { err = e; }); },
      async close() { await chain; if (err) throw err; await writer.close(); return handle.getFile(); },
      async abort() { try { await chain; await writer.abort(); } catch (e) { /* ignore */ } try { await dir.removeEntry(name); } catch (e) { /* ignore */ } },
    };
  } catch (e) {
    return null;
  }
}

export async function listRenderFiles() {
  try { const dir = await navigator.storage.getDirectory(); const out = []; for await (const [name, h] of dir.entries()) out.push({ name, handle: h }); return out; } catch (e) { return []; }
}
export async function getRenderFile(name) {
  try { const dir = await navigator.storage.getDirectory(); const h = await dir.getFileHandle(name); return await h.getFile(); } catch (e) { return null; }
}
export async function deleteRenderFile(name) {
  try { const dir = await navigator.storage.getDirectory(); await dir.removeEntry(name); } catch (e) { /* gone */ }
}

/**
 * Encode a timeline.
 * renderFrame(t, n): draw frame for time t into `canvas` (async allowed)
 * audioBlock(t0, t1): returns [L, R] Float32Array at 48 kHz (or null for silence)
 */
export async function encodeTimeline({ canvas, W, H, fps = 30, duration, renderFrame, audioBlock, quality = 'high', name, signal, onProgress, forceCodec }) {
  const Q = QUALITY[quality] || QUALITY.high;
  const bitrate = Math.round(clamp(W * H * fps * Q.bpp, 1_500_000, 40_000_000));
  const codecs = await chooseCodecs(W, H, fps, bitrate, forceCodec);
  if (!codecs) throw new Error('This browser has no video encoder available (WebCodecs). Please use the latest Chrome or Edge.');
  const { video, audio } = codecs;
  const ext = video.container === 'mp4' ? 'mp4' : 'webm';
  const fileName = `${name || 'render'}-${Date.now().toString(36)}.${ext}`;
  let out = await openOutput(fileName);
  let memTarget = null;
  if (!out) {
    if (duration > 20 * 60) throw new Error('This browser cannot write large files to disk. Use desktop Chrome or Edge for videos longer than 20 minutes.');
    memTarget = video.container === 'mp4' ? new Mp4Muxer.ArrayBufferTarget() : new WebmMuxer.ArrayBufferTarget();
  }
  const target = memTarget || (video.container === 'mp4'
    ? new Mp4Muxer.StreamTarget({ onData: (d, p) => out.write(d, p), chunked: true, chunkSize: 8 * 1024 * 1024 })
    : new WebmMuxer.StreamTarget({ onData: (d, p) => out.write(d, p), chunked: true, chunkSize: 8 * 1024 * 1024 }));
  const muxer = video.container === 'mp4'
    ? new Mp4Muxer.Muxer({ target, video: { codec: video.mux, width: W, height: H, frameRate: fps }, audio: audio ? { codec: audio.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined, fastStart: memTarget ? 'in-memory' : false, firstTimestampBehavior: 'offset' })
    : new WebmMuxer.Muxer({ target, video: { codec: video.mux, width: W, height: H, frameRate: fps }, audio: audio ? { codec: 'A_OPUS', numberOfChannels: 2, sampleRate: 48000 } : undefined, firstTimestampBehavior: 'offset' });
  let encErr = null;
  const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  venc.configure(video.config);
  let aenc = null;
  if (audio) {
    aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { encErr = e; } });
    aenc.configure({ ...audio.config, bitrate: Q.audio });
  }
  const frames = Math.max(1, Math.round(duration * fps));
  const gop = Math.round(fps * 2);
  let audioT = 0;
  const ABLK = 0.5;
  const pushAudio = async (until) => {
    if (!aenc) return;
    while (audioT < Math.min(until, duration) - 1e-9) {
      const t1 = Math.min(duration, audioT + ABLK);
      const n = Math.round((t1 - audioT) * 48000);
      if (n <= 0) break;
      const blk = audioBlock ? await audioBlock(audioT, t1) : null;
      const data = new Float32Array(n * 2);
      if (blk) { data.set(blk[0].subarray(0, n), 0); data.set((blk[1] || blk[0]).subarray(0, n), n); }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(audioT * 1e6), data });
      aenc.encode(ad); ad.close();
      audioT = t1;
      while (aenc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
    }
  };
  const waitQueue = async () => {
    while (venc.encodeQueueSize > 6) {
      await new Promise((r) => { const done = () => { venc.removeEventListener?.('dequeue', done); r(); }; venc.addEventListener?.('dequeue', done); setTimeout(done, 20); });
    }
  };
  const t0 = performance.now();
  const perf = { render: 0, frame: 0, wait: 0 };
  try {
    for (let n = 0; n < frames; n++) {
      checkAbort(signal);
      if (encErr) throw new Error('Encoder error: ' + (encErr.message || encErr));
      const t = n / fps;
      let q = performance.now();
      await renderFrame(t, n);
      perf.render += performance.now() - q; q = performance.now();
      const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
      perf.frame += performance.now() - q; q = performance.now();
      venc.encode(vf, { keyFrame: n % gop === 0 });
      vf.close();
      await waitQueue();
      perf.wait += performance.now() - q;
      await pushAudio(t + 1 / fps + 0.25);
      if (onProgress && (n % 5 === 0 || n === frames - 1)) {
        const el = (performance.now() - t0) / 1000;
        onProgress((n + 1) / frames, { fps: (n + 1) / Math.max(0.001, el), eta: el / ((n + 1) / frames) - el });
      }
    }
    await pushAudio(duration);
    await venc.flush();
    if (aenc) await aenc.flush();
    if (encErr) throw new Error('Encoder error: ' + (encErr.message || encErr));
    muxer.finalize();
  } catch (e) {
    try { venc.close(); } catch (x) { /* closed */ }
    try { aenc && aenc.close(); } catch (x) { /* closed */ }
    if (out) await out.abort();
    throw e instanceof AbortError ? e : e;
  }
  try { venc.close(); } catch (x) { /* closed */ }
  try { aenc && aenc.close(); } catch (x) { /* closed */ }
  let file;
  const mime = video.container === 'mp4' ? 'video/mp4' : 'video/webm';
  if (memTarget) file = new File([memTarget.buffer], fileName, { type: mime });
  else { const f = await out.close(); file = new File([f], fileName, { type: mime }); file.opfsName = fileName; }
  return {
    file, mime, fileName, onDisk: !memTarget,
    label: `${video.container.toUpperCase()} (${video.label}${audio ? ' + ' + audio.label : ', no audio'})`,
    videoBitrate: bitrate, elapsed: (performance.now() - t0) / 1000,
    perf: { renderMs: Math.round(perf.render), captureMs: Math.round(perf.frame), encoderWaitMs: Math.round(perf.wait), hardware: video.config.hardwareAcceleration, codec: video.config.codec },
  };
}
