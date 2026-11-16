import Hls, { type BufferAppendingData } from 'hls.js'
import { journal } from '../lib/journal'
import { invoke, isTauri } from '../lib/tauri'
import {
  accumulateBeatPcm,
  createBeatAcc,
  finalizeBeatEnvelope,
  finalizeVocalEnvelope,
  type BeatAcc,
} from '../lyrics/beats'
import { accumulate, isComplete, newAcc, toPeaks, type PeakAcc } from './peaks'
import { takePreloadedBlobBytes } from './preload'
import { useWaveform } from './waveformStore'
import type { EngineSource } from './engine'
import { providerPeaks } from '../sc/playback'
import { fetchSpotifyWaveform, structuralPeaks } from '../spotify/api'

/**
 * Real waveform of the current track. hls.js already downloads, decrypts and remuxes the
 * stream for playback; we copy each appended audio fragment, decode it off the main path at
 * a low sample rate and fold its loudness into time bins. Nothing is downloaded twice.
 */
export { useWaveform }

/**
 * A whole file's bytes. In the app it comes through the app (as HLS fragments do): the page may
 * not fetch VK's servers itself, and they do not answer pages from other origins.
 */
export async function readWhole(url: string, rawUrl?: string): Promise<ArrayBuffer> {
  if (url.startsWith('blob:')) {
    const preloaded = takePreloadedBlobBytes(url)
    if (preloaded) return preloaded
    try {
      return await (await fetch(url)).arrayBuffer()
    } catch (e) {
      if (rawUrl && isTauri()) return invoke<ArrayBuffer>('proxy_fetch', { url: rawUrl })
      throw e
    }
  }
  if (isTauri()) return invoke<ArrayBuffer>('proxy_fetch', { url })
  return (await fetch(url)).arrayBuffer()
}

/**
 * Detects pure ISO BMFF init segments (`ftyp`/`moov` with no `moof`/`mdat` sample boxes).
 * `hls.js` emits `BUFFER_APPENDING` for the init segment with the same `frag.cc:frag.sn` as the
 * first media fragment — ignoring it prevents both a decode failure and dropping `0:0`.
 */
export function isMp4InitOnly(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8) return false
  let off = 0
  let hasInit = false
  let hasMedia = false
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (off + 8 <= bytes.byteLength) {
    let size = dv.getUint32(off)
    const t0 = bytes[off + 4]
    const t1 = bytes[off + 5]
    const t2 = bytes[off + 6]
    const t3 = bytes[off + 7]
    if (t0 < 0x20 || t0 > 0x7e || t1 < 0x20 || t1 > 0x7e || t2 < 0x20 || t2 > 0x7e || t3 < 0x20 || t3 > 0x7e) {
      return false
    }
    const type = String.fromCharCode(t0, t1, t2, t3)
    if (size === 0) {
      size = bytes.byteLength - off
    } else if (size === 1) {
      if (off + 16 > bytes.byteLength) return false
      size = Number((BigInt(dv.getUint32(off + 8)) << 32n) | BigInt(dv.getUint32(off + 12)))
    }
    if (size < 8 || off + size > bytes.byteLength) return false
    if (type === 'ftyp' || type === 'moov') hasInit = true
    else if (type === 'moof' || type === 'mdat') hasMedia = true
    off += size
  }
  return hasInit && !hasMedia
}

interface CachedWave {
  peaks: Float32Array
  beats: Float32Array | null
  vocal: Float32Array | null
}

const CACHE_SIZE = 40
const cache = new Map<string, CachedWave>()
let decoderCtx8k: OfflineAudioContext | null = null
let decoderCtx44k: OfflineAudioContext | null = null
const decoder = (sr: 8000 | 44100 = 8000) => {
  if (sr === 44100) {
    if (!decoderCtx44k || !(decoderCtx44k instanceof OfflineAudioContext)) {
      decoderCtx44k = new OfflineAudioContext(1, 1, 44100)
    }
    return decoderCtx44k
  }
  if (!decoderCtx8k || !(decoderCtx8k instanceof OfflineAudioContext)) {
    decoderCtx8k = new OfflineAudioContext(1, 1, 8000)
  }
  return decoderCtx8k
}

interface InitTrack {
  initSegment?: Uint8Array
  container?: string
}

const MAX_RAW_CHUNK_BYTES = 14 * 1024 * 1024

class Capture {
  private acc: PeakAcc = newAcc()
  private beatAcc: BeatAcc
  init: Uint8Array | null = null
  container = 'audio/mp4'
  private seen = new Set<string>()
  rawSegments = new Map<string, { start: number; bytes: Uint8Array }>()
  private rawBytes = 0
  private chain: Promise<void> = Promise.resolve()
  private failures = 0
  alive = true

  constructor(
    readonly key: string,
    readonly duration: number,
    readonly decodePeaks = true,
  ) {
    this.beatAcc = createBeatAcc(duration)
  }

  onInit(tracks: Record<string, InitTrack | undefined>) {
    const t = tracks.audio ?? tracks.audiovideo
    if (t?.initSegment?.length) this.init = t.initSegment.slice()
    if (t?.container) this.container = t.container
  }

  onAppend(d: BufferAppendingData) {
    if (d.type !== 'audio' && d.type !== 'audiovideo') return
    if (isMp4InitOnly(d.data)) {
      if (!this.init) this.init = d.data.slice()
      return
    }
    const id = `${d.frag.cc}:${d.frag.sn}`
    if (this.seen.has(id)) return
    this.seen.add(id)
    const bytes = d.data.slice()
    const start = d.frag.start
    if (this.rawBytes + bytes.byteLength <= MAX_RAW_CHUNK_BYTES) {
      this.rawSegments.set(id, { start, bytes })
      this.rawBytes += bytes.byteLength
    }
    if (this.decodePeaks) this.enqueue(() => this.decode(bytes, start))
  }

  /** Demo mode / non-HLS sources (VK's mp3 links): decode the whole file at once. */
  fromFile(url: string, rawUrl?: string) {
    if (!this.decodePeaks) return
    this.container = 'file'
    this.enqueue(async () => this.decode(new Uint8Array(await readWhole(url, rawUrl)), 0))
  }

  /** Decodes one chunk at a time; a failed chunk never blocks the ones after it. */
  private enqueue(job: () => Promise<void>) {
    this.chain = this.chain.then(job).catch((e: unknown) => {
      if (this.failures++ === 0) journal('player', `waveform: could not decode audio (${this.container}): ${String(e)}`)
    })
  }

  private async decodeBuf(whole: Uint8Array, allowHighRateRetry: boolean): Promise<AudioBuffer> {
    const ab = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength) as ArrayBuffer
    try {
      return await decoder(8000).decodeAudioData(ab)
    } catch (e) {
      if (!allowHighRateRetry) throw e
      const retryAb = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength) as ArrayBuffer
      return decoder(44100).decodeAudioData(retryAb)
    }
  }

  private applyDecoded(audio: AudioBuffer, start: number, resetAccumulators: boolean) {
    if (!this.alive) return
    const channels = Array.from({ length: Math.min(audio.numberOfChannels, 2) }, (_, i) => audio.getChannelData(i))
    const effectiveDur = this.container === 'file' ? audio.duration : this.duration
    if (resetAccumulators) {
      this.acc = newAcc()
      this.beatAcc = createBeatAcc(effectiveDur)
    }
    // A whole file knows its own length better than the track metadata does
    accumulate(this.acc, channels, audio.sampleRate, start, effectiveDur)
    if (this.beatAcc.bins === 0 && effectiveDur > 0) this.beatAcc = createBeatAcc(effectiveDur)
    accumulateBeatPcm(this.beatAcc, channels, audio.sampleRate, start)
    const peaks = toPeaks(this.acc)
    const beats = this.beatAcc.bins > 0 ? finalizeBeatEnvelope(this.beatAcc) : null
    const vocal = this.beatAcc.bins > 0 ? finalizeVocalEnvelope(this.beatAcc) : null
    useWaveform.setState({ key: this.key, peaks, beats, vocal })
    if (isComplete(this.acc)) {
      remember(this.key, peaks, beats, vocal)
      if (import.meta.env.DEV) journal('player', `waveform complete (${this.container})`)
    }
  }

  private async decode(bytes: Uint8Array, start: number) {
    if (!this.alive) return
    const whole = this.container === 'audio/mp4' && this.init ? concat(this.init, bytes) : bytes
    try {
      const audio = await this.decodeBuf(whole, this.rawSegments.size <= 1)
      this.applyDecoded(audio, start, false)
      return
    } catch (firstErr) {
      if (this.container !== 'audio/mp4' || this.rawSegments.size <= 1) throw firstErr
    }

    // Fallback for fMP4 streams whose isolated middle fragments lack priming frames without preceding segments.
    const ordered = [...this.rawSegments.values()].sort((a, b) => a.start - b.start)
    if (!ordered.length) return
    const parts = this.init ? [this.init, ...ordered.map((s) => s.bytes)] : ordered.map((s) => s.bytes)
    const audio = await this.decodeBuf(concatMany(parts), true)
    this.applyDecoded(audio, ordered[0]!.start, true)
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function concatMany(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function remember(key: string, peaks: Float32Array, beats: Float32Array | null, vocal: Float32Array | null = null) {
  cache.delete(key)
  cache.set(key, { peaks, beats, vocal })
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
}

let current: Capture | null = null
let activeSourceMeta: { key: string; url: string; hls: Hls | null; drm: boolean } | null = null

export function getActiveAudioCapture(trackKey: string): {
  url: string
  drm: boolean
  isHls: boolean
  hls: Hls | null
  container: string
  init: Uint8Array | null
  segments: Array<{ start: number; bytes: Uint8Array }>
} | null {
  if (!activeSourceMeta || activeSourceMeta.key !== trackKey) return null
  const cap = current?.key === trackKey ? current : null
  return {
    url: activeSourceMeta.url,
    drm: activeSourceMeta.drm,
    isHls: Boolean(activeSourceMeta.hls),
    hls: activeSourceMeta.hls,
    container: cap?.container ?? 'audio/mp4',
    init: cap?.init ?? null,
    segments: cap ? [...cap.rawSegments.values()] : [],
  }
}

/** Warms cached Spotify peaks for the next track without overwriting what is currently shown. */
export async function warmSpotifyWaveform(trackKey: string, spotifyId: string, duration: number): Promise<void> {
  if (!spotifyId || !/^[A-Za-z0-9]{22}$/.test(spotifyId) || cache.get(trackKey)) return
  try {
    const res = await fetchSpotifyWaveform(spotifyId, duration)
    if (!res.peaks) return
      const beats = res.beats ?? null
      remember(trackKey, res.peaks, beats, null)
      if (useWaveform.getState().key === trackKey) {
        useWaveform.setState({ key: trackKey, peaks: res.peaks, beats, vocal: null })
      }
  } catch {}
}

/** Warms cached SoundCloud provider peaks for a DRM track in the background. */
export async function warmProviderWaveform(trackKey: string, waveformUrl: string): Promise<void> {
  if (!waveformUrl || cache.get(trackKey)) return
  try {
    const data = await readWhole(waveformUrl)
    const peaks = providerPeaks(JSON.parse(new TextDecoder().decode(data)))
    if (!peaks) return
      remember(trackKey, peaks, null, null)
      if (useWaveform.getState().key === trackKey) {
        useWaveform.setState({ key: trackKey, peaks, beats: null, vocal: null })
      }
    } catch {}
}

/** Called right before a track starts loading. */
export function beginWaveform(key: string, duration: number) {
  if (current) {
    current.alive = false
    current.rawSegments.clear()
  }
  activeSourceMeta = null
  const cached = cache.get(key)
  current = new Capture(key, duration, !cached)
  useWaveform.setState({ key, peaks: cached?.peaks ?? null, beats: cached?.beats ?? null, vocal: cached?.vocal ?? null })
}

export function ensureSpotifyWaveform(trackKey: string, seedOrId: string, duration: number) {
  const cached = cache.get(trackKey)
  if (cached) {
    useWaveform.setState({ key: trackKey, peaks: cached.peaks, beats: cached.beats, vocal: cached.vocal })
    return
  }
  const initial = structuralPeaks(seedOrId)
  useWaveform.setState({ key: trackKey, peaks: initial, beats: null, vocal: null })
  if (!/^[A-Za-z0-9]{22}$/.test(seedOrId)) {
    remember(trackKey, initial, null, null)
    return
  }
  const cap = current?.key === trackKey ? current : new Capture(trackKey, duration)
  if (!current || current.key !== trackKey) {
    if (current) current.alive = false
    current = cap
  }
  setTimeout(() => {
    if (!cap.alive) return
    void fetchSpotifyWaveform(seedOrId, duration)
      .then((res) => {
        if (!cap.alive) return
        if (res.peaks) {
          const beats = res.beats ?? null
          useWaveform.setState({ key: trackKey, peaks: res.peaks, beats, vocal: null })
          remember(trackKey, res.peaks, beats, null)
        } else if (res.previewUrl && typeof OfflineAudioContext !== 'undefined') {
          cap.fromFile(res.previewUrl)
        }
      })
      .catch(() => {})
  }, 350)
}

/** Hooks the capture into the stream the engine just created. */
export function captureSource(src: EngineSource) {
  const cap = current
  if (!cap) return
  activeSourceMeta = {
    key: cap.key,
    url: src.url,
    hls: src.hls,
    drm: Boolean(src.drm),
  }
  if (src.url.startsWith('spotify:track:')) {
    const spotifyId = src.url.slice('spotify:track:'.length).trim()
    ensureSpotifyWaveform(cap.key, spotifyId, cap.duration)
    return
  }
  if (src.drm) {
    if (src.waveformUrl) void readWhole(src.waveformUrl).then((data) => {
      const peaks = providerPeaks(JSON.parse(new TextDecoder().decode(data)))
      if (peaks && cap.alive) {
        useWaveform.setState({ key: cap.key, peaks, beats: null, vocal: null })
        remember(cap.key, peaks, null, null)
      }
    }).catch(() => {})
    return
  }
  if (typeof OfflineAudioContext === 'undefined') return
  if (!src.hls) {
    cap.fromFile(src.url, src.rawUrl)
    return
  }
  src.hls.on(Hls.Events.FRAG_PARSING_INIT_SEGMENT, (_e, data) => cap.alive && cap.onInit((data as unknown as { tracks: Record<string, InitTrack> }).tracks))
  src.hls.on(Hls.Events.BUFFER_APPENDING, (_e, data) => cap.alive && cap.onAppend(data))
}
