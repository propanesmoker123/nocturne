import Hls, { type ErrorData } from 'hls.js'
import { isTauri } from '../lib/tauri'
import { volumeToGain } from './logic'
import { TauriLoader } from './tauriLoader'

export type EngineEvent = 'time' | 'state' | 'ended' | 'error' | 'loading'

type Listener = () => void

/** Owns the single <audio> element and the hls.js instance for the current stream. */
class Engine {
  readonly audio: HTMLAudioElement
  private hls: Hls | null = null
  private listeners = new Map<EngineEvent, Set<Listener>>()
  private recovered = false
  lastError = ''

  constructor() {
    this.audio = new Audio()
    this.audio.preload = 'auto'
    const a = this.audio
    a.addEventListener('timeupdate', () => this.emit('time'))
    a.addEventListener('durationchange', () => this.emit('time'))
    a.addEventListener('progress', () => this.emit('time'))
    a.addEventListener('play', () => this.emit('state'))
    a.addEventListener('pause', () => this.emit('state'))
    a.addEventListener('playing', () => this.emit('loading'))
    a.addEventListener('waiting', () => this.emit('loading'))
    a.addEventListener('canplay', () => this.emit('loading'))
    a.addEventListener('ended', () => this.emit('ended'))
    a.addEventListener('error', () => {
      if (this.hls) return
      this.fail(a.error?.message || 'media error')
    })
  }

  on(ev: EngineEvent, fn: Listener): () => void {
    let set = this.listeners.get(ev)
    if (!set) this.listeners.set(ev, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  private emit(ev: EngineEvent) {
    this.listeners.get(ev)?.forEach((fn) => fn())
  }

  private fail(message: string) {
    this.lastError = message
    this.emit('error')
  }

  private teardown() {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  /** Loads a stream URL (HLS through the Rust proxy, anything else directly). */
  load(url: string, startAt = 0, autoplay = true) {
    this.teardown()
    this.recovered = false
    this.lastError = ''
    const a = this.audio
    if (url.includes('.m3u8') && Hls.isSupported()) {
      const hls = new Hls({
        loader: isTauri() ? TauriLoader : Hls.DefaultConfig.loader,
        enableWorker: true,
        startPosition: startAt > 0 ? startAt : -1,
        maxBufferLength: 40,
        backBufferLength: 30,
      })
      this.hls = hls
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (autoplay) void a.play().catch(() => {})
      })
      hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.recovered) {
          this.recovered = true
          hls.recoverMediaError()
          return
        }
        this.fail(`${data.type}: ${data.details}`)
      })
      hls.loadSource(url)
      hls.attachMedia(a)
    } else {
      a.src = url
      if (startAt > 0) a.addEventListener('loadedmetadata', () => (a.currentTime = startAt), { once: true })
      if (autoplay) void a.play().catch(() => {})
    }
    this.emit('loading')
  }

  stop() {
    this.teardown()
    this.emit('state')
  }

  play() {
    void this.audio.play().catch(() => {})
  }

  pause() {
    this.audio.pause()
  }

  seek(sec: number) {
    if (Number.isFinite(sec)) this.audio.currentTime = Math.max(0, sec)
  }

  setVolume(v: number, muted: boolean) {
    this.audio.volume = volumeToGain(v)
    this.audio.muted = muted
  }

  get position() {
    return this.audio.currentTime || 0
  }

  get duration() {
    const d = this.audio.duration
    return Number.isFinite(d) ? d : 0
  }

  get buffered() {
    const b = this.audio.buffered
    const t = this.audio.currentTime
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i)
    return 0
  }

  get playing() {
    return !this.audio.paused
  }

  get waiting() {
    return this.audio.readyState < 3 && !this.audio.paused
  }
}

export const engine = new Engine()
