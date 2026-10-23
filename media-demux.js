// Inera Edit Flow — container demuxing for unlimited-length media.
// MP4 / MOV: mp4box.js (BSD-3) fed only with metadata boxes (media data is never loaded).
// WebM / Matroska: own streaming EBML parser (handles MediaRecorder unknown-size clusters & lacing).
// Result: compact sample tables + WebCodecs decoder configs. Sample bytes are read on demand.
import { createFile, DataStream, Log } from './media-libs.js';
// mp4box logs benign parse warnings (unknown user-data boxes) to the console; keep the console clean
try { Log.error = () => {}; Log.warn = () => {}; } catch (e) { /* logger API differs */ }
import { checkAbort } from './utils.js';

const td = new TextDecoder();
const str4 = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);

// ---------- sample table ----------
class SampleTable {
  constructor() { this.off = []; this.size = []; this.pts = []; this.dur = []; this.key = []; }
  push(off, size, pts, dur, key) { this.off.push(off); this.size.push(size); this.pts.push(pts); this.dur.push(dur); this.key.push(key ? 1 : 0); }
  finish() {
    const n = this.off.length;
    this.n = n;
    this.off = Float64Array.from(this.off); this.size = Uint32Array.from(this.size);
    this.pts = Float64Array.from(this.pts); this.dur = Float64Array.from(this.dur); this.key = Uint8Array.from(this.key);
    // presentation-order index (for B-frames) and keyframe list (decode order)
    const order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => this.pts[a] - this.pts[b]);
    this.byPts = order;
    const keys = []; for (let i = 0; i < n; i++) if (this.key[i]) keys.push(i);
    if (!keys.length && n) keys.push(0);
    this.keys = Uint32Array.from(keys);
    return this;
  }
  // decode-order index of the sample presented at (or just before) time t
  indexAt(t) {
    const o = this.byPts; let lo = 0, hi = o.length - 1;
    if (!o.length) return -1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pts[o[mid]] <= t + 1e-6) lo = mid; else hi = mid - 1; }
    return o[lo];
  }
  // keyframe (decode order) at or before decode index i
  keyBefore(i) {
    const k = this.keys; let lo = 0, hi = k.length - 1, best = k[0] ?? 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (k[mid] <= i) { best = k[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }
}

// ---------- chunked file reader (serves many small sample reads from one large slice) ----------
export class FileReaderCache {
  constructor(file, window = 8 * 1024 * 1024) { this.file = file; this.win = window; this.start = -1; this.buf = null; }
  async read(off, size) {
    if (size > this.win) return new Uint8Array(await this.file.slice(off, off + size).arrayBuffer());
    if (!this.buf || off < this.start || off + size > this.start + this.buf.length) {
      this.start = off;
      this.buf = new Uint8Array(await this.file.slice(off, Math.min(this.file.size, off + this.win)).arrayBuffer());
    }
    return this.buf.subarray(off - this.start, off - this.start + size);
  }
}

// ================= MP4 / MOV =================
async function demuxMp4(file, signal) {
  const mp4 = createFile();
  let info = null;
  mp4.onReady = (i) => { info = i; };
  let parseError = null;
  mp4.onError = (mod, msg) => { parseError = msg; }; // benign errors are tolerated; fatal ones leave info empty
  let off = 0;
  let moovBytes = null;
  const head = async (o, n) => new Uint8Array(await file.slice(o, Math.min(file.size, o + n)).arrayBuffer());
  while (off < file.size - 8) {
    checkAbort(signal);
    const h = await head(off, 16);
    let size = (h[0] * 2 ** 24) + (h[1] << 16) + (h[2] << 8) + h[3];
    const type = str4(h, 4);
    let hdr = 8;
    if (size === 1) { size = Number(new DataView(h.buffer).getBigUint64(8)); hdr = 16; }
    else if (size === 0) size = file.size - off;
    if (size < hdr || !/^[\x20-\x7e]{4}$/.test(type)) throw new Error('This MP4/MOV file appears to be damaged (invalid box structure).');
    if (type !== 'mdat' && type !== 'free' && type !== 'skip' && type !== 'wide') {
      if (size > 512 * 1024 * 1024) throw new Error('MP4 metadata box too large.');
      const buf = await file.slice(off, off + size).arrayBuffer();
      if (type === 'moov' && !moovBytes) moovBytes = new Uint8Array(buf.slice(0));
      buf.fileStart = off;
      mp4.appendBuffer(buf);
    } else {
      // give the parser only the box header so it can account for the skipped media data
      const buf = h.slice(0, hdr).buffer;
      buf.fileStart = off;
      mp4.appendBuffer(buf);
    }
    off += size;
  }
  mp4.flush();
  if (!info) throw new Error('No playable tracks found in this MP4/MOV file (the file may be incomplete)' + (parseError ? ': ' + parseError : '.'));
  const out = { container: 'mp4', duration: info.duration / info.timescale || 0 };
  const descOf = (trak) => {
    for (const e of trak.mdia.minf.stbl.stsd.entries) {
      const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
      if (box) { const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); box.write(s); return new Uint8Array(s.buffer, 8); }
    }
    return undefined;
  };
  const audioDesc = (trak) => {
    for (const e of trak.mdia.minf.stbl.stsd.entries) {
      try { const d = e.esds && e.esds.esd.descs[0].descs[0].data; if (d) return new Uint8Array(d); } catch (err) { /* ignore */ }
    }
    return undefined;
  };
  // Edit list: media_time says which media timestamp is shown at presentation time 0;
  // an initial empty edit (media_time = -1) delays the track. Players (and ffmpeg) honour this.
  const editShift = (trak) => {
    try {
      const entries = trak.edts && trak.edts.elst && trak.edts.elst.entries;
      if (!entries || !entries.length) return 0;
      const mdTs = trak.mdia.mdhd.timescale, mvTs = info.timescale || mp4.moov.mvhd.timescale;
      let delay = 0, start = 0;
      for (const e of entries) {
        if (e.media_time === -1) delay += e.segment_duration / mvTs;
        else { start = e.media_time / mdTs; break; }
      }
      return delay - start;
    } catch (e) { return 0; }
  };
  const build = (t) => {
    const samples = mp4.getTrackSamplesInfo(t.id) || [];
    const shift = editShift(mp4.getTrackById(t.id));
    const tab = new SampleTable();
    for (const s of samples) tab.push(s.offset, s.size, s.cts / s.timescale + shift, s.duration / s.timescale, s.is_sync);
    return tab.finish();
  };
  const vt = info.videoTracks && info.videoTracks[0];
  if (vt) {
    const trak = mp4.getTrackById(vt.id);
    const m = vt.matrix || [];
    let rotation = 0;
    if (m.length >= 4) { const a = m[0] / 65536, b = m[1] / 65536; rotation = Math.round(Math.atan2(b, a) * 180 / Math.PI); rotation = ((rotation % 360) + 360) % 360; }
    out.video = {
      codec: vt.codec, description: descOf(trak), codedWidth: vt.video.width, codedHeight: vt.video.height,
      rotation, samples: build(vt),
    };
  }
  const at = info.audioTracks && info.audioTracks[0];
  if (at) {
    let codec = at.codec;
    if (/^opus$/i.test(codec)) codec = 'opus';
    if (/^mp4a$/i.test(codec)) codec = 'mp4a.40.2';
    const trak = mp4.getTrackById(at.id);
    let description = audioDesc(trak);
    const samples = build(at);
    if (codec === 'opus') {
      // 'dOps' (OpusSpecificBox) is not parsed by mp4box: read it from the moov bytes
      const i = moovBytes ? findFourcc(moovBytes, 'dOps') : -1;
      if (i > 0) {
        const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset + i + 4);
        const dops = { OutputChannelCount: dv.getUint8(1), PreSkip: dv.getUint16(2), InputSampleRate: dv.getUint32(4), OutputGain: dv.getInt16(8) };
        const o = opusHeadFromDops(dops, at.audio.channel_count); description = o.head; shiftTable(samples, -o.preskip / 48000);
      }
    }
    out.audio = { codec, description, sampleRate: at.audio.sample_rate, channels: at.audio.channel_count, samples };
  }
  if (!out.duration) out.duration = Math.max(out.video ? lastEnd(out.video.samples) : 0, out.audio ? lastEnd(out.audio.samples) : 0);
  return out;
}
// Opus encoders prepend "pre-skip" priming samples that players drop; shift timestamps accordingly.
function opusHeadFromDops(dops, channels) {
  const pre = dops.PreSkip ?? dops.pre_skip ?? 0, rate = dops.InputSampleRate ?? dops.input_sample_rate ?? 48000;
  const gain = dops.OutputGain ?? dops.output_gain ?? 0, ch = dops.OutputChannelCount ?? dops.output_channel_count ?? channels;
  const b = new Uint8Array(19); b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, ch], 0);
  const dv = new DataView(b.buffer); dv.setUint16(10, pre, true); dv.setUint32(12, rate, true); dv.setInt16(16, gain, true); b[18] = 0;
  return { head: b, preskip: pre };
}
function findFourcc(u8, cc) { const a = cc.charCodeAt(0), b = cc.charCodeAt(1), c = cc.charCodeAt(2), d = cc.charCodeAt(3); for (let i = 0; i < u8.length - 4; i++) if (u8[i] === a && u8[i + 1] === b && u8[i + 2] === c && u8[i + 3] === d) return i; return -1; }
function shiftTable(tab, d) { for (let i = 0; i < tab.n; i++) tab.pts[i] += d; }
function lastEnd(tab) { let m = 0; for (let i = 0; i < tab.n; i++) m = Math.max(m, tab.pts[i] + tab.dur[i]); return m; }

// ================= WebM / Matroska =================
const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b, SeekHead: 0x114d9b74, Tags: 0x1254c367, Chapters: 0x1043a770, Attachments: 0x1941a469, Void: 0xec,
};
const TOP = new Set([ID.Cluster, ID.Cues, ID.SeekHead, ID.Tags, ID.Chapters, ID.Attachments, ID.Info, ID.Tracks]);

async function demuxWebm(file, signal) {
  const CH = 4 * 1024 * 1024;
  let bufStart = 0, buf = new Uint8Array(0);
  const ensure = async (pos, n) => {
    if (pos >= bufStart && pos + n <= bufStart + buf.length) return true;
    if (pos >= file.size) return false;
    bufStart = pos;
    buf = new Uint8Array(await file.slice(pos, Math.min(file.size, pos + Math.max(CH, n))).arrayBuffer());
    return pos + n <= bufStart + buf.length || bufStart + buf.length === file.size;
  };
  const byte = (p) => buf[p - bufStart];
  const readVint = (p, keepMarker) => {
    const b0 = byte(p);
    if (b0 === undefined || b0 === 0) return null;
    let len = 1; while (len <= 8 && !(b0 & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? b0 : b0 & (0xff >> len);
    let allOnes = (b0 & (0xff >> len)) === (0xff >> len);
    for (let i = 1; i < len; i++) { const b = byte(p + i); v = v * 256 + b; if (b !== 0xff) allOnes = false; }
    return { v, len, unknown: !keepMarker && allOnes };
  };
  const readUint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + byte(p + i); return v; };
  const readFloat = (p, n) => { const dv = new DataView(buf.buffer, buf.byteOffset + p - bufStart, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };
  const readBytes = (p, n) => buf.slice(p - bufStart, p - bufStart + n);

  let tcScale = 1e6, duration = 0;
  const tracks = new Map();
  let curTrack = null;
  let clusterTc = 0;
  const tables = new Map();
  const tab = (num) => { if (!tables.has(num)) tables.set(num, new SampleTable()); return tables.get(num); };

  const handleBlock = async (p, size, simple, groupHasRef) => {
    await ensure(p, Math.min(size, 64));
    const tn = readVint(p, false); if (!tn) return;
    const tcOff = p + tn.len;
    let rel = readUint(tcOff, 2); if (rel & 0x8000) rel -= 0x10000;
    const flags = byte(tcOff + 2);
    const tr = tracks.get(tn.v); if (!tr) return;
    const key = simple ? !!(flags & 0x80) : !groupHasRef;
    const lacing = (flags >> 1) & 3;
    const t = ((clusterTc + rel) * tcScale) / 1e9;
    let dataOff = tcOff + 3;
    const end = p + size;
    const defDur = tr.defaultDuration ? tr.defaultDuration / 1e9 : (tr.type === 2 ? 0.02 : 1 / 30);
    if (lacing === 0) { tab(tn.v).push(dataOff, end - dataOff, t, defDur, key || tr.type === 2); return; }
    await ensure(dataOff, Math.min(4096, end - dataOff));
    const count = byte(dataOff) + 1; dataOff += 1;
    const sizes = [];
    if (lacing === 1) { // Xiph
      for (let i = 0; i < count - 1; i++) { let s = 0, b; do { b = byte(dataOff++); s += b; } while (b === 255); sizes.push(s); }
    } else if (lacing === 3) { // EBML
      const first = readVint(dataOff, false); dataOff += first.len; sizes.push(first.v);
      for (let i = 1; i < count - 1; i++) {
        const d = readVint(dataOff, false); dataOff += d.len;
        const bias = Math.pow(2, 7 * d.len - 1) - 1;
        sizes.push(sizes[i - 1] + (d.v - bias));
      }
    }
    const used = sizes.reduce((a, b) => a + b, 0);
    if (lacing === 2) { const each = Math.floor((end - dataOff) / count); for (let i = 0; i < count; i++) sizes.push(each); }
    else sizes.push(end - dataOff - used);
    let o = dataOff;
    for (let i = 0; i < count; i++) { tab(tn.v).push(o, sizes[i], t + i * defDur, defDur, key || tr.type === 2); o += sizes[i]; }
  };

  // element walk (master elements recurse; clusters are parsed by walkCluster)
  const MASTER = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Video, ID.Audio]);
  const walk = async (start, end) => {
    let p = start;
    while (p < end) {
      checkAbort(signal);
      if (!(await ensure(p, 16))) break;
      const id = readVint(p, true); if (!id) break;
      const sz = readVint(p + id.len, false); if (!sz) break;
      const ds = p + id.len + sz.len;
      const de = sz.unknown ? end : Math.min(end, ds + sz.v);
      if (id.v === ID.Cluster) { const stop = await walkCluster(ds, de); p = sz.unknown ? stop : de; continue; }
      if (MASTER.has(id.v)) {
        if (id.v === ID.TrackEntry) curTrack = {};
        await walk(ds, de);
        if (id.v === ID.TrackEntry && curTrack && curTrack.num) tracks.set(curTrack.num, curTrack);
        p = de; continue;
      }
      if (sz.unknown) break; // unknown-size non-master element: cannot continue safely
      if (sz.v <= 1024 * 1024) await ensure(ds, sz.v);
      switch (id.v) {
        case ID.TimecodeScale: tcScale = readUint(ds, sz.v); break;
        case ID.Duration: duration = readFloat(ds, sz.v); break;
        case ID.TrackNumber: curTrack.num = readUint(ds, sz.v); break;
        case ID.TrackType: curTrack.type = readUint(ds, sz.v); break;
        case ID.CodecID: curTrack.codecId = td.decode(readBytes(ds, sz.v)).replace(/\0/g, ''); break;
        case ID.CodecPrivate: curTrack.priv = readBytes(ds, sz.v); break;
        case ID.DefaultDuration: curTrack.defaultDuration = readUint(ds, sz.v); break;
        case ID.PixelWidth: curTrack.width = readUint(ds, sz.v); break;
        case ID.PixelHeight: curTrack.height = readUint(ds, sz.v); break;
        case ID.SamplingFrequency: curTrack.rate = readFloat(ds, sz.v); break;
        case ID.Channels: curTrack.channels = readUint(ds, sz.v); break;
        default: break;
      }
      p = de;
    }
    return p;
  };
  const walkCluster = async (start, end) => {
    clusterTc = 0;
    let p = start;
    while (p < end) {
      checkAbort(signal);
      if (!(await ensure(p, 16))) return end;
      const id = readVint(p, true); if (!id) return end;
      if (TOP.has(id.v)) return p;
      const sz = readVint(p + id.len, false); if (!sz) return end;
      const ds = p + id.len + sz.len, de = sz.unknown ? end : ds + sz.v;
      if (id.v === ID.Timecode) { await ensure(ds, 8); clusterTc = readUint(ds, sz.v); }
      else if (id.v === ID.SimpleBlock) await handleBlock(ds, sz.v, true, false);
      else if (id.v === ID.BlockGroup) {
        let q = ds, ref = false, blk = null;
        while (q < de) {
          await ensure(q, 16);
          const cid = readVint(q, true), csz = readVint(q + cid.len, false);
          const cds = q + cid.len + csz.len;
          if (cid.v === ID.Block) blk = { p: cds, size: csz.v };
          if (cid.v === ID.ReferenceBlock) ref = true;
          q = cds + csz.v;
        }
        if (blk) await handleBlock(blk.p, blk.size, false, ref);
      }
      p = de;
    }
    return p;
  };

  await ensure(0, 64);
  const e0 = readVint(0, true);
  if (!e0 || e0.v !== ID.EBML) throw new Error('Not a valid WebM/Matroska file.');
  await walk(0, file.size);
  const out = { container: 'webm', duration: (duration * tcScale) / 1e9 };
  for (const [num, tr] of tracks) {
    const t = tables.get(num); if (!t) continue;
    t.finish();
    if (tr.type === 1 && !out.video) {
      const c = tr.codecId;
      let codec = null, description;
      if (c === 'V_VP9') codec = 'vp09.00.10.08'; // profile 0 / 8-bit; level is not needed by decoders
      else if (c === 'V_VP8') codec = 'vp8';
      else if (c === 'V_AV1') { codec = 'av01.0.08M.08'; description = tr.priv; }
      else if (c === 'V_MPEG4/ISO/AVC' && tr.priv) { const p = tr.priv; codec = 'avc1.' + [p[1], p[2], p[3]].map((x) => x.toString(16).padStart(2, '0')).join(''); description = p; }
      out.video = { codec, codecId: c, description, codedWidth: tr.width, codedHeight: tr.height, rotation: 0, samples: t };
    } else if (tr.type === 2 && !out.audio) {
      const c = tr.codecId;
      let codec = null;
      if (c === 'A_OPUS') {
        codec = 'opus';
        // Matroska Opus: the decoder applies the OpusHead pre-skip itself (verified against ffmpeg)
      } else if (c === 'A_VORBIS') codec = 'vorbis'; else if (c === 'A_AAC') codec = 'mp4a.40.2';
      out.audio = { codec, codecId: c, description: tr.priv, sampleRate: Math.round(tr.rate || 48000), channels: tr.channels || 1, samples: t };
    }
  }
  if (!out.duration) out.duration = Math.max(out.video ? lastEnd(out.video.samples) : 0, out.audio ? lastEnd(out.audio.samples) : 0);
  return out;
}

export async function demux(file, type, signal) {
  const info = type === 'webm' ? await demuxWebm(file, signal) : await demuxMp4(file, signal);
  if (!info.video || !info.video.samples || !info.video.samples.n) throw new Error('No video track was found in this file.');
  return info;
}
