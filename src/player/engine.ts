import Hls, { type ErrorData } from 'hls.js'
import { invoke, isTauri } from '../lib/tauri'
import { volumeToGain } from './logic'
import { takePreloadedBlobUrl } from './preload'
import { TauriLoader } from './tauriLoader'
import { drmConfig, type ScPlaybackSource } from '../sc/playback'

export type StreamOptions = Pick<ScPlaybackSource, 'drm' | 'waveformUrl'>
export interface EngineSource extends StreamOptions { url: string; rawUrl?: string; hls: Hls | null }

export type EngineEvent = 'time' | 'state' | 'ended' | 'error' | 'loading' | 'buffered'

type Listener = () => void

/** Owns the single <audio> element and the hls.js instance for the current stream. */
class Engine {
  readonly audio: HTMLAudioElement
  private hls: Hls | null = null
  private listeners = new Map<EngineEvent, Set<Listener>>()
  private recovered = false
  private fullBufferEmitted = false
  private objectUrl: string | null = null
  private audioSeekAt = 0
  private audioSeekTarget: number | null = null
  private audioSeekSrc = ''
  private audioSeekTimer: ReturnType<typeof setTimeout> | null = null
  private audioSeekingPending = false
  private spotifyTrackId: string | null = null
  private spotifyPos = 0
  private spotifyDur = 0
  private spotifyBuffered = 0
  private spotifyPlaying = false
  private spotifyWaiting = false
  private spotifyStarted = false
  private spotifyConfirmedPlaying = false
  private spotifyPlayGen = 0
  private spotifyMatchedId = false
  private spotifyActualId: string | null = null
  private spotifyPlayStartedAt = 0
  private spotifySeekTarget: number | null = null
  private spotifySeekAt = 0
  private spotifyLastTickAt = 0
  seekSerial = 0
  private spotifyPoll: ReturnType<typeof setInterval> | null = null
  private spotifyTick: ReturnType<typeof setInterval> | null = null
  private spotifyVolumeTimer: ReturnType<typeof setTimeout> | null = null
  private spotifyLastVolumeSentAt = 0
  private spotifySeekTimer: ReturnType<typeof setTimeout> | null = null
  private spotifyLastSeekSentAt = 0
  private spotifyPolling = false
  lastError = ''
  /** Told about every new source, so the waveform can tap the same stream. */
  onSource: ((src: EngineSource) => void) | null = null

  constructor() {
    this.audio = new Audio()
    this.audio.preload = 'auto'
    const a = this.audio
    a.addEventListener('timeupdate', () => !this.spotifyTrackId && this.emit('time'))
    a.addEventListener('durationchange', () => !this.spotifyTrackId && this.emit('time'))
    a.addEventListener('progress', () => {
      if (this.spotifyTrackId) return
      this.emit('time')
      this.maybeEmitBuffered()
    })
    a.addEventListener('canplaythrough', () => !this.spotifyTrackId && this.maybeEmitBuffered())
    a.addEventListener('play', () => !this.spotifyTrackId && this.emit('state'))
    a.addEventListener('pause', () => !this.spotifyTrackId && this.emit('state'))
    a.addEventListener('seeking', () => {
      if (this.spotifyTrackId) return
      if (this.audioSeekTarget !== null && a.src === this.audioSeekSrc) this.audioSeekingPending = true
    })
    a.addEventListener('seeked', () => {
      if (this.spotifyTrackId) return
      this.audioSeekingPending = false
      this.emit('time')
    })
    a.addEventListener('playing', () => !this.spotifyTrackId && this.emit('loading'))
    a.addEventListener('waiting', () => !this.spotifyTrackId && this.emit('loading'))
    a.addEventListener('canplay', () => !this.spotifyTrackId && this.emit('loading'))
    a.addEventListener('ended', () => !this.spotifyTrackId && this.emit('ended'))
    a.addEventListener('error', () => {
      if (this.hls || this.spotifyTrackId) return
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

  private isBufferedAt(sec: number): boolean {
    const b = this.audio.buffered
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) - 0.5 <= sec && sec <= b.end(i) + 0.5) return true
    }
    return false
  }

  private maybeEmitBuffered(force = false) {
    if (this.fullBufferEmitted) return
    if (this.spotifyTrackId) {
      const dur = this.spotifyDur
      if (dur <= 1) return
      const settled =
        this.spotifyBuffered >= dur - 1 ||
        (this.spotifyPlaying && !this.spotifyWaiting && this.spotifyBuffered >= Math.min(dur - 1, this.spotifyPos + 15))
      if (force || settled) {
        this.fullBufferEmitted = true
        this.emit('buffered')
      }
      return
    }
    const dur = this.duration
    if (dur <= 1) return
    if (force || this.buffered >= dur - 1) {
      this.fullBufferEmitted = true
      this.emit('buffered')
    }
  }

  private teardown(keepSpotify = false) {
    if (this.spotifyPoll) {
      clearInterval(this.spotifyPoll)
      this.spotifyPoll = null
    }
    if (this.spotifyTick) {
      clearInterval(this.spotifyTick)
      this.spotifyTick = null
    }
    if (this.spotifyVolumeTimer) {
      clearTimeout(this.spotifyVolumeTimer)
      this.spotifyVolumeTimer = null
    }
    if (this.spotifySeekTimer) {
      clearTimeout(this.spotifySeekTimer)
      this.spotifySeekTimer = null
    }
    if (this.audioSeekTimer) {
      clearTimeout(this.audioSeekTimer)
      this.audioSeekTimer = null
    }
    if (this.spotifyTrackId && !keepSpotify && isTauri()) {
      void invoke('spotify_control', { action: 'pause', value: null }).catch(() => {})
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.fullBufferEmitted = false
    this.audioSeekAt = 0
    this.audioSeekTarget = null
    this.audioSeekingPending = false
    this.spotifyTrackId = null
    this.spotifyPos = 0
    this.spotifyDur = 0
    this.spotifyBuffered = 0
    this.spotifyPlaying = false
    this.spotifyWaiting = false
    this.spotifyStarted = false
    this.spotifyConfirmedPlaying = false
    this.spotifyPlayGen += 1
    this.spotifyMatchedId = false
    this.spotifyActualId = null
    this.spotifyPlayStartedAt = 0
    this.spotifySeekTarget = null
    this.spotifySeekAt = 0
    this.spotifyLastTickAt = 0
    this.spotifyPolling = false
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  private async startSpotifyTrack(id: string, startAt: number) {
    if (!isTauri() || this.spotifyTrackId !== id) return
    const gen = ++this.spotifyPlayGen
    this.spotifyWaiting = true
    this.spotifyConfirmedPlaying = false
    this.spotifyMatchedId = false
    this.spotifyActualId = null
    this.spotifyPlayStartedAt = Date.now()
    this.spotifyLastTickAt = Date.now()
    if (startAt > 0) {
      this.spotifySeekTarget = startAt
      this.spotifySeekAt = Date.now()
    }
    this.emit('loading')
    try {
      const res = await invoke<{ ok?: boolean }>('spotify_status', {
        request: {
          kind: 'play',
          id,
          startAt,
          volume: this.audio.volume,
          muted: this.audio.muted,
        },
      })
      if (this.spotifyTrackId !== id || this.spotifyPlayGen !== gen) return
      if (res?.ok) {
        this.spotifyPlaying = true
        this.spotifyStarted = true
        this.spotifyLastTickAt = Date.now()
        this.emit('state')
        this.emit('loading')
      }
    } catch (e) {
      if (this.spotifyTrackId !== id || this.spotifyPlayGen !== gen) return
      this.spotifyWaiting = false
      this.emit('loading')
      this.fail(typeof e === 'string' ? e : 'Не удалось запустить трек в Spotify')
    }
  }

  private tickSpotify() {
    if (!this.spotifyTrackId || !this.spotifyPlaying || this.spotifyWaiting) {
      this.spotifyLastTickAt = Date.now()
      return
    }
    const now = Date.now()
    if (this.spotifySeekTarget !== null && now - this.spotifySeekAt < 280) {
      this.spotifyLastTickAt = now
      return
    }
    const dt = (now - (this.spotifyLastTickAt || now)) / 1000
    this.spotifyLastTickAt = now
    if (dt > 0 && dt < 1.5) {
      const next = this.spotifyPos + dt
      this.spotifyPos = this.spotifyDur > 0 ? Math.min(this.spotifyDur, next) : next
      this.emit('time')
    }
  }

  private async pollSpotify() {
    const id = this.spotifyTrackId
    if (!id || !isTauri() || this.spotifyPolling) return
    this.spotifyPolling = true
    try {
      const raw = await invoke<Record<string, unknown>>('spotify_status')
      if (this.spotifyTrackId !== id) return
      const np = raw?.nowPlaying && typeof raw.nowPlaying === 'object' ? (raw.nowPlaying as Record<string, unknown>) : null
      const startPending = raw?.startPending === true
      const startAge = Date.now() - this.spotifyPlayStartedAt
      const isAd = np?.isAd === true
      const prevPlaying = this.spotifyPlaying
      const prevWaiting = this.spotifyWaiting

      if (isAd) {
        this.spotifyWaiting = true
        this.spotifyPlaying = false
        if (prevPlaying !== this.spotifyPlaying) this.emit('state')
        if (prevWaiting !== this.spotifyWaiting) this.emit('loading')
        return
      }

      const npTrackId = typeof np?.trackId === 'string' ? np.trackId : null
      // While switching tracks or connecting the Spotify web device, ignore stale metadata from the previous track.
      const staleSwitch = !this.spotifyConfirmedPlaying && npTrackId !== null && npTrackId !== id && (startPending || startAge < 3500)
      const activeNp = staleSwitch ? null : np
      const rawPlaying = activeNp ? activeNp.paused === false : (staleSwitch ? false : raw?.playing === true)

      if (npTrackId === id || (!staleSwitch && rawPlaying && !startPending && npTrackId && startAge > 3500 && !this.spotifyActualId)) {
        this.spotifyMatchedId = true
        this.spotifyActualId = npTrackId
      }
      if (this.spotifyMatchedId && this.spotifyActualId && npTrackId && npTrackId !== this.spotifyActualId && this.spotifyDur > 15 && this.spotifyPos >= this.spotifyDur - 8) {
        this.spotifyStarted = false
        this.emit('ended')
        return
      }

      if (activeNp) {
        const pos = Number(activeNp.position)
        const dur = Number(activeNp.duration)
        if (Number.isFinite(dur) && dur >= 15) this.spotifyDur = dur
        const buf = Number(activeNp.buffered)
        if (Number.isFinite(buf) && buf >= 0) {
          this.spotifyBuffered = this.spotifyDur > 0 ? Math.min(this.spotifyDur, buf) : buf
        }
        if (Number.isFinite(pos) && pos >= 0) {
          const now = Date.now()
          const seekTarget = this.spotifySeekTarget
          const seekAge = now - this.spotifySeekAt
          if (seekTarget !== null && seekAge < 2400) {
            if (seekAge >= 250 && pos >= seekTarget - 0.04 && pos <= seekTarget + 1.25) {
              this.spotifySeekTarget = null
              this.spotifyPos = Math.max(seekTarget, this.spotifyPos - 0.05, pos)
              this.spotifyLastTickAt = now
            } else if (seekAge >= 250 && pos >= seekTarget - 0.35 && pos < seekTarget - 0.04) {
              this.spotifyPos = Math.max(seekTarget, this.spotifyPos)
              this.spotifyLastTickAt = now
            }
          } else {
            this.spotifySeekTarget = null
            if (!rawPlaying) {
              this.spotifyPos = pos
              this.spotifyLastTickAt = now
            } else {
              const dt =
                !this.spotifyWaiting && this.spotifyLastTickAt > 0
                  ? Math.min(1.2, Math.max(0, (now - this.spotifyLastTickAt) / 1000))
                  : 0
              const expected = this.spotifyPos + dt
              const diff = pos - expected
              if (this.spotifyLastTickAt === 0 || diff > 1.2 || diff < -1.8) {
                this.spotifyPos = pos
                this.spotifyLastTickAt = now
              } else if (diff > 0.55) {
                // Smooth fast forward catch-up instead of snapping across short lyric lines
                this.spotifyPos = expected + diff * 0.65
                this.spotifyLastTickAt = now
              } else if (diff >= 0.04) {
                this.spotifyPos = expected + diff * 0.5
                this.spotifyLastTickAt = now
              } else if (diff < -0.22) {
                this.spotifyPos = Math.max(0, expected + Math.max(-0.35, diff * 0.65))
                this.spotifyLastTickAt = now
              } else if (diff < -0.14) {
                this.spotifyPos = Math.max(0, expected + Math.max(-0.04, diff * 0.2))
                this.spotifyLastTickAt = now
              }
            }
          }
        }
      }

      const graceMs = startPending ? 12_000 : 6000
      const inStartGrace = !this.spotifyConfirmedPlaying && startAge < graceMs
      if (rawPlaying) {
        this.spotifyConfirmedPlaying = true
        this.spotifyStarted = true
        this.spotifyWaiting = false
        this.spotifyPlaying = true
      } else if (this.spotifyPlaying && inStartGrace) {
        this.spotifyWaiting = true
      } else {
        this.spotifyPlaying = false
        this.spotifyWaiting = false
      }
      this.emit('time')
      if (prevPlaying !== this.spotifyPlaying) this.emit('state')
      if (prevWaiting !== this.spotifyWaiting) this.emit('loading')
      this.maybeEmitBuffered()

      if (this.spotifyConfirmedPlaying && this.spotifyStarted && !rawPlaying && this.spotifyDur > 15 && this.spotifyPos >= this.spotifyDur - 1.5) {
        this.spotifyStarted = false
        this.emit('ended')
      }
    } catch {
      // ignore transient eval timeouts while the hidden webview navigates
    } finally {
      this.spotifyPolling = false
    }
  }

  /** Loads a stream URL (HLS through the Rust proxy, Spotify via hidden webview, anything else directly). */
  load(url: string, startAt = 0, autoplay = true, options?: StreamOptions) {
    const isSpotify = url.startsWith('spotify:track:')
    this.teardown(isSpotify)
    this.recovered = false
    this.lastError = ''
    if (isSpotify) {
      const id = url.slice('spotify:track:'.length).trim()
      this.spotifyTrackId = id
      this.spotifyPos = startAt
      this.spotifyWaiting = autoplay
      this.onSource?.({ url, hls: null, ...options })
      this.emit('loading')
      this.emit('time')
      if (isTauri()) {
        if (autoplay) void this.startSpotifyTrack(id, startAt)
        this.spotifyPoll = setInterval(() => void this.pollSpotify(), 900)
        this.spotifyTick = setInterval(() => this.tickSpotify(), 200)
      }
      return
    }
    const a = this.audio
    if (url.includes('.m3u8') && Hls.isSupported()) {
      const hls = new Hls({
        ...(options?.drm ? drmConfig(options.drm) : {}),
        loader: isTauri() ? TauriLoader : Hls.DefaultConfig.loader,
        enableWorker: true,
        startPosition: startAt > 0 ? startAt : -1,
        // A song is a few MB: keep it whole in both directions, so seeking is instant and the waveform fills in.
        maxBufferLength: 600,
        maxMaxBufferLength: 600,
        backBufferLength: 600,
        startFragPrefetch: true,
        maxBufferHole: 0.25,
      })
      this.hls = hls
      this.onSource?.({ url, hls, ...options })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (autoplay) void a.play().catch(() => {})
      })
      hls.on(Hls.Events.BUFFER_EOS, () => {
        if (this.hls === hls) this.maybeEmitBuffered(true)
      })
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (this.hls === hls) this.maybeEmitBuffered()
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
      const blobUrl = isTauri() ? takePreloadedBlobUrl(url) : null
      if (blobUrl) this.objectUrl = blobUrl
      const playUrl = blobUrl ?? url
      this.onSource?.({ url: playUrl, rawUrl: url, hls: null, ...options })
      a.src = playUrl
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
    if (this.spotifyTrackId) {
      const id = this.spotifyTrackId
      if (!this.spotifyStarted || !this.spotifyConfirmedPlaying) {
        void this.startSpotifyTrack(id, this.spotifyPos)
      } else {
        this.spotifyPlaying = true
        this.spotifyPlayStartedAt = Date.now()
        this.emit('state')
        if (isTauri()) {
          void invoke<boolean>('spotify_control', { action: 'play', value: null })
            .then((ok) => { if (!ok && this.spotifyTrackId === id) void this.startSpotifyTrack(id, this.spotifyPos) })
            .catch(() => {})
        }
      }
      return
    }
    void this.audio.play().catch(() => {})
  }

  pause() {
    if (this.spotifyTrackId) {
      this.spotifyPlayGen += 1
      this.spotifyPlaying = false
      this.spotifyWaiting = false
      this.emit('state')
      this.emit('loading')
      if (isTauri()) void invoke('spotify_control', { action: 'pause', value: null }).catch(() => {})
      return
    }
    this.audio.pause()
  }

  seek(sec: number) {
    if (!Number.isFinite(sec)) return
    this.seekSerial += 1
    const target = Math.max(0, sec)
    if (this.spotifyTrackId) {
      this.spotifyPos = target
      this.spotifySeekTarget = target
      this.spotifySeekAt = Date.now()
      this.spotifyLastTickAt = Date.now()
      if (this.spotifyBuffered > 0 && target > this.spotifyBuffered + 0.5) {
        this.spotifyBuffered = 0
      }
      this.emit('time')
      if (isTauri()) {
        const sendSeek = () => {
          this.spotifySeekTimer = null
          this.spotifyLastSeekSentAt = Date.now()
          void invoke('spotify_control', { action: 'seek', value: this.spotifySeekTarget ?? target }).catch(() => {})
        }
        const elapsed = Date.now() - this.spotifyLastSeekSentAt
        if (elapsed >= 45 && !this.spotifySeekTimer) {
          sendSeek()
        } else if (!this.spotifySeekTimer) {
          this.spotifySeekTimer = setTimeout(sendSeek, Math.max(16, 45 - elapsed))
        }
      }
      return
    }
    this.audioSeekAt = Date.now()
    this.audioSeekTarget = target
    this.audioSeekSrc = this.audio.src
    this.audioSeekingPending = true
    if (this.audioSeekTimer) clearTimeout(this.audioSeekTimer)
    this.audioSeekTimer = setTimeout(() => {
      this.audioSeekTimer = null
      this.emit('loading')
    }, 360)
    this.audio.currentTime = target
    this.emit('time')
  }

  setVolume(v: number, muted: boolean) {
    const gain = volumeToGain(v)
    this.audio.volume = gain
    this.audio.muted = muted
    if (this.spotifyTrackId && isTauri()) {
      const sendVolume = () => {
        this.spotifyVolumeTimer = null
        this.spotifyLastVolumeSentAt = Date.now()
        void invoke('spotify_status', {
          request: { kind: 'volume', volume: this.audio.volume, muted: this.audio.muted },
        }).catch(() => {})
      }
      const elapsed = Date.now() - this.spotifyLastVolumeSentAt
      if (elapsed >= 50 && !this.spotifyVolumeTimer) {
        sendVolume()
      } else if (!this.spotifyVolumeTimer) {
        this.spotifyVolumeTimer = setTimeout(sendVolume, Math.max(16, 50 - elapsed))
      }
    }
  }

  get isRemoteClock(): boolean {
    return Boolean(this.spotifyTrackId)
  }

  private effectiveAudioPosition(): number {
    const raw = this.audio.currentTime || 0
    const target = this.audioSeekTarget
    if (target === null) return raw
    if (this.audio.src !== this.audioSeekSrc || this.audioSeekAt === 0) {
      this.audioSeekTarget = null
      this.audioSeekingPending = false
      return raw
    }
    const age = Date.now() - this.audioSeekAt
    const dur = this.duration
    if (!this.audio.seeking && !this.audioSeekingPending && dur > 0 && target >= dur - 0.5) {
      this.audioSeekTarget = null
      return raw
    }
    if (!this.audio.seeking && age >= 120 && raw >= target - 0.025) {
      this.audioSeekingPending = false
      this.audioSeekTarget = null
      return raw
    }
    if (this.audio.seeking || this.audioSeekingPending) {
      if (age > 3500) {
        this.audioSeekTarget = null
        this.audioSeekingPending = false
        return raw
      }
      return target
    }
    if (this.audio.paused) {
      if (raw < target && Math.abs(raw - target) <= 0.85) return target
      if (age >= 150) this.audioSeekTarget = null
      return raw
    }
    if (raw < target - 0.025 && age < 2200) {
      return target
    }
    this.audioSeekTarget = null
    return raw
  }

  get position() {
    if (this.spotifyTrackId) return this.spotifyPos
    return this.effectiveAudioPosition()
  }

  /** Sub-millisecond playback timestamp in ms, avoiding Zustand store polling jitter. */
  getPlaybackPositionMs(): number {
    if (this.spotifyTrackId) {
      let pos = this.spotifyPos
      const seekHold = this.spotifySeekTarget !== null && Date.now() - this.spotifySeekAt < 280
      if (this.spotifyPlaying && !this.spotifyWaiting && !seekHold && this.spotifyLastTickAt > 0) {
        const dt = (Date.now() - this.spotifyLastTickAt) / 1000
        if (dt > 0 && dt < 1.2) {
          pos += dt
          if (this.spotifyDur > 0 && pos > this.spotifyDur) pos = this.spotifyDur
        }
      }
      return Math.max(0, pos * 1000)
    }
    return Math.max(0, this.effectiveAudioPosition() * 1000)
  }

  get duration() {
    if (this.spotifyTrackId) return this.spotifyDur
    const d = this.audio.duration
    return Number.isFinite(d) ? d : 0
  }

  get buffered() {
    if (this.spotifyTrackId) return this.spotifyBuffered
    const b = this.audio.buffered
    const t = this.audio.currentTime
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i)
    return 0
  }

  get playing() {
    if (this.spotifyTrackId) return this.spotifyPlaying
    return !this.audio.paused
  }

  get waiting() {
    if (this.spotifyTrackId) return this.spotifyWaiting
    if (this.audio.readyState < 3 && !this.audio.paused) {
      // Suppress transient Play/Pause loading flicker while seeking inside a buffered range.
      if (Date.now() - this.audioSeekAt < 350 && this.isBufferedAt(this.audio.currentTime)) return false
      return true
    }
    return false
  }
}

export const engine = new Engine()
