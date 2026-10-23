// Inera Edit Flow — unified media source.
// Fast path: demux + WebCodecs (frame-accurate, faster than real time, unlimited length).
// Fallback: <video> seeking + decodeAudioData (when the browser cannot WebCodecs-decode the codec).
import { demux } from './media-demux.js';
import { videoDecoderConfig, audioDecoderConfig, VideoFrameReader, decodeAudioTrack, PcmStore, hasWebCodecs } from './media-decode.js';
import { sniffType, createVideoEl, waitEvent, seekVideo, resolveDuration, checkAbort } from './utils.js';

class ElementFrameReader {
  constructor(url) { this.v = createVideoEl(url); this.ready = waitEvent(this.v, 'loadedmetadata', 20000); this.lastT = -1; }
  async frameAt(t) {
    await this.ready;
    const target = Math.min(Math.max(0, t), (this.v.duration || 0) - 0.01);
    if (Math.abs(this.lastT - target) > 1e-4) { await seekVideo(this.v, target, 15000); this.lastT = target; }
    return this.v;
  }
  close() { this.v.removeAttribute('src'); this.v.load(); }
}

export async function openSource(file, { signal } = {}) {
  const type = await sniffType(file);
  const url = URL.createObjectURL(file);
  const src = { file, type, url, kind: 'element', info: null };
  if (hasWebCodecs()) {
    try {
      const info = await demux(file, type, signal);
      const vcfg = await videoDecoderConfig(info.video);
      if (vcfg) {
        const acfg = info.audio ? await audioDecoderConfig(info.audio) : null;
        src.kind = 'webcodecs';
        src.info = info; src.vcfg = vcfg; src.acfg = acfg;
        const rot = info.video.rotation || 0;
        const w = info.video.codedWidth, h = info.video.codedHeight;
        src.width = rot === 90 || rot === 270 ? h : w; src.height = rot === 90 || rot === 270 ? w : h;
        src.rotation = rot; src.duration = info.duration; src.hasAudio = !!info.audio;
      }
    } catch (e) {
      checkAbort(signal);
      src.demuxError = e.message;
    }
  }
  if (src.kind === 'element') {
    const v = createVideoEl(url);
    try {
      await waitEvent(v, 'loadedmetadata', 20000);
      src.duration = await resolveDuration(v);
      src.width = v.videoWidth; src.height = v.videoHeight; src.rotation = 0;
      src.hasAudio = true; // verified when decoding audio
    } finally { v.removeAttribute('src'); v.load(); }
  }
  src.createFrameReader = () => (src.kind === 'webcodecs' ? new VideoFrameReader(file, src.info.video, src.vcfg) : new ElementFrameReader(url));
  src.decodeAudio = async ({ signal: sig, onProgress } = {}) => {
    if (src.kind === 'webcodecs' && src.info.audio && src.acfg) {
      return decodeAudioTrack(file, src.info.audio, src.acfg, src.duration, { signal: sig, onProgress });
    }
    // fallback: decode the whole file's audio (bounded by memory)
    if (file.size > 700 * 1024 * 1024) throw new Error('This browser cannot decode the audio of such a large file. Please use desktop Chrome or Edge.');
    let buf;
    try {
      const ab = await file.arrayBuffer();
      buf = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(ab);
    } catch (e) { src.hasAudio = false; return { pcm16: new Int16Array(Math.ceil(src.duration * 16000)), store: null }; }
    const n = buf.length, ch = buf.numberOfChannels;
    const L = buf.getChannelData(0), R = ch > 1 ? buf.getChannelData(1) : L;
    const pcm16 = new Int16Array(Math.floor(n / 3));
    for (let i = 0; i < pcm16.length; i++) { const a = (L[i * 3] + R[i * 3] + L[i * 3 + 1] + R[i * 3 + 1] + L[i * 3 + 2] + R[i * 3 + 2]) / 6; pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(a * 32767))); }
    const store = await PcmStore.create(src.duration);
    const CH = 48000 * 10;
    for (let o = 0; o < n; o += CH) {
      const m = Math.min(CH, n - o); const il = new Int16Array(m * 2);
      for (let i = 0; i < m; i++) { il[2 * i] = Math.max(-32768, Math.min(32767, Math.round(L[o + i] * 32767))); il[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(R[o + i] * 32767))); }
      await store.write(o, il);
      onProgress && onProgress(o / n);
    }
    await store.finish();
    return { pcm16, store };
  };
  src.dispose = () => { URL.revokeObjectURL(url); };
  return src;
}

// Draw a decoded frame upright (applies container rotation) into a 2D context.
export function drawUpright(ctx, frame, rotation, dw, dh) {
  if (!rotation) { ctx.drawImage(frame, 0, 0, dw, dh); return; }
  ctx.save();
  ctx.translate(dw / 2, dh / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const sw = rotation === 90 || rotation === 270 ? dh : dw, sh = rotation === 90 || rotation === 270 ? dw : dh;
  ctx.drawImage(frame, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
}
