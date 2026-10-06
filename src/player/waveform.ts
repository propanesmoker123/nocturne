import Hls, { type BufferAppendingData } from 'hls.js'
import { create } from 'zustand'
import { journal } from '../lib/journal'
import { accumulate, isComplete, newAcc, toPeaks, type PeakAcc } from './peaks'

/**
 * Real waveform of the current track. hls.js already downloads, decrypts and remuxes the
 * stream for playback; we copy each appended audio fragment, decode it off the main path at
 * a low sample rate and fold its loudness into time bins. Nothing is downloaded twice.
 */
interface WaveformState {
  key: string | null
  peaks: Float32Array | null
}

export const useWaveform = create<WaveformState>(() => ({ key: null, peaks: null }))

const CACHE_SIZE = 40
const cache = new Map<string, Float32Array>()
let decoderCtx: OfflineAudioContext | null = null
const decoder = () => (decoderCtx ??= new OfflineAudioContext(1, 1, 8000))

interface InitTrack {
  initSegment?: Uint8Array
  container?: string
}

class Capture {
  private acc: PeakAcc = newAcc()
  private init: Uint8Array | null = null
  private container = 'audio/mp4'
  private seen = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  private failures = 0
  alive = true

  constructor(
    readonly key: string,
    readonly duration: number,
  ) {}

  onInit(tracks: Record<string, InitTrack | undefined>) {
    const t = tracks.audio ?? tracks.audiovideo
    if (t?.initSegment?.length) this.init = t.initSegment.slice()
    if (t?.container) this.container = t.container
  }

  onAppend(d: BufferAppendingData) {
    if (d.type !== 'audio' && d.type !== 'audiovideo') return
    const id = `${d.frag.cc}:${d.frag.sn}`
    if (this.seen.has(id)) return
    this.seen.add(id)
    const bytes = d.data.slice()
    const start = d.frag.start
    this.enqueue(() => this.decode(bytes, start))
  }

  /** Demo mode / non-HLS sources: decode the whole file at once. */
  fromFile(url: string) {
    this.container = 'file'
    this.enqueue(async () => this.decode(new Uint8Array(await (await fetch(url)).arrayBuffer()), 0))
  }

  /** Decodes one chunk at a time; a failed chunk never blocks the ones after it. */
  private enqueue(job: () => Promise<void>) {
    this.chain = this.chain.then(job).catch((e: unknown) => {
      if (this.failures++ === 0) journal('player', `waveform: could not decode audio (${this.container}): ${String(e)}`)
    })
  }

  private async decode(bytes: Uint8Array, start: number) {
    if (!this.alive) return
    const whole = this.container === 'audio/mp4' && this.init ? concat(this.init, bytes) : bytes
    const audio = await decoder().decodeAudioData(whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.byteLength) as ArrayBuffer)
    if (!this.alive) return
    const channels = Array.from({ length: Math.min(audio.numberOfChannels, 2) }, (_, i) => audio.getChannelData(i))
    accumulate(this.acc, channels, audio.sampleRate, start, this.duration)
    const peaks = toPeaks(this.acc)
    useWaveform.setState({ key: this.key, peaks })
    if (isComplete(this.acc)) {
      remember(this.key, peaks)
      if (import.meta.env.DEV) journal('player', `waveform complete (${this.container})`)
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function remember(key: string, peaks: Float32Array) {
  cache.delete(key)
  cache.set(key, peaks)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
}

let current: Capture | null = null

/** Called right before a track starts loading. */
export function beginWaveform(key: string, duration: number) {
  if (current) current.alive = false
  const cached = cache.get(key)
  current = cached ? null : new Capture(key, duration)
  useWaveform.setState({ key, peaks: cached ?? null })
}

/** Hooks the capture into the stream the engine just created. */
export function captureSource(src: { url: string; hls: Hls | null }) {
  const cap = current
  if (!cap || typeof OfflineAudioContext === 'undefined') return
  if (!src.hls) {
    cap.fromFile(src.url)
    return
  }
  src.hls.on(Hls.Events.FRAG_PARSING_INIT_SEGMENT, (_e, data) => cap.alive && cap.onInit((data as unknown as { tracks: Record<string, InitTrack> }).tracks))
  src.hls.on(Hls.Events.BUFFER_APPENDING, (_e, data) => cap.alive && cap.onAppend(data))
}
