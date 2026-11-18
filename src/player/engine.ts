import Hls, { type ErrorData } from 'hls.js'
import { journal } from '../lib/journal'
import { invoke, isTauri } from '../lib/tauri'
import { volumeToGain } from './logic'
import { takePreloadedBlobUrl } from './preload'
import { TauriLoader } from './tauriLoader'
import { drmConfig, type ScPlaybackSource } from '../sc/playback'

export interface StreamOptions extends Pick<ScPlaybackSource, 'drm' | 'waveformUrl'> {
  spotifyContextUri?: string
  spotifyAlbumId?: string
  spotifyUid?: string
  spotifyTitle?: string
  spotifyDuration?: number
}
export interface EngineSource extends Pick<ScPlaybackSource, 'drm' | 'waveformUrl'> { url: string; rawUrl?: string; hls: Hls | null }

export type EngineEvent = 'time' | 'state' | 'ended' | 'error' | 'loading' | 'buffered'

type Listener = () => void
type AudioLoad = { autoplay: boolean; ready: boolean }
const SPOTIFY_START_TIMEOUT_MS = 25_000

/** Owns the single <audio> element and the hls.js instance for the current stream. */
class Engine {
  audio: HTMLAudioElement
  private audioLoad: AudioLoad | null = null
  private hls: Hls | null = null
  private listeners = new Map<EngineEvent, Set<Listener>>()
  private recovered = false
  private fullBufferEmitted = false
  private objectUrl: string | null = null
  private baseVolume = 0.8
  private isMuted = false
  private preFadeFactor = 1
  private fadingOut: { audio: HTMLAudioElement; hls: Hls | null; objectUrl: string | null; startVolume: number } | null = null
  private fadeTimer: ReturnType<typeof setInterval> | null = null
  private fadeWaitCleanup: (() => void) | null = null
  private pendingCrossfadeSec = 0
  private audioSeekAt = 0
  private audioSeekTarget: number | null = null
  private audioSeekSrc = ''
  private audioSeekTimer: ReturnType<typeof setTimeout> | null = null
  private audioSeekingPending = false
  private spotifyTrackId: string | null = null
  private spotifyContextUri: string | undefined = undefined
  private spotifyAlbumId: string | undefined = undefined
  private spotifyUid: string | undefined = undefined
  private spotifyExpectedTitle = ''
  private spotifyExpectedDuration = 0
  private spotifyRetriedWithContext = false
  private spotifyMismatchLogged = false
  private spotifyLastLoggedErr = ''
  private spotifyPos = 0
  private spotifyDur = 0
  private spotifyBuffered = 0
  private spotifyPlaying = false
  private spotifyWaiting = false
  private spotifyStarted = false
  private spotifyConfirmedPlaying = false
  private spotifyUserPaused = false
  private spotifyUnexpectedPauseCount = 0
  private spotifyAutoResumeTried = false
  private spotifyLastPlaybackErr = ''
  private spotifyPlayGen = 0
  private spotifyActualId: string | null = null
  private spotifyPlayStartedAt = 0
  private spotifyLastPollAt = 0
  private spotifyEndStallAt = 0
  private spotifyEndStallPos = -1
  private spotifySeekTarget: number | null = null
  private spotifySeekBackward = false
  private spotifySeekAt = 0
  private spotifyLastTickAt = 0
  seekSerial = 0
  private spotifyPoll: ReturnType<typeof setInterval> | null = null
  private spotifyTick: ReturnType<typeof setInterval> | null = null
  private spotifyVolumeTimer: ReturnType<typeof setTimeout> | null = null
  private spotifyLastVolumeSentAt = 0
  private spotifySeekTimer: ReturnType<typeof setTimeout> | null = null
  private spotifyLastSeekSentAt = 0
  private spotifyPolling: number | null = null
  lastError = ''
  lastErrorKind: 'media' | 'blocked' = 'media'
  /** Told about every new source, so the waveform can tap the same stream. */
  onSource: ((src: EngineSource) => void) | null = null
  /** Called when Spotify started playing a different track than requested (e.g. Free shuffle/pick cap). */
  onSpotifyMismatch: ((info: { requestedId: string; actualId: string }) => void) | null = null

  constructor() {
    this.audio = this.createAudio()
  }

  private createAudio(): HTMLAudioElement {
    const a = new Audio()
    a.preload = 'auto'
    const active = () => this.audio === a && this.audioLoad !== null
    a.addEventListener('timeupdate', () => active() && this.emit('time'))
    a.addEventListener('durationchange', () => active() && this.emit('time'))
    a.addEventListener('progress', () => {
      if (!active()) return
      this.emit('time')
      this.maybeEmitBuffered()
    })
    a.addEventListener('canplaythrough', () => active() && this.maybeEmitBuffered())
    a.addEventListener('play', () => active() && this.emit('state'))
    a.addEventListener('pause', () => active() && this.emit('state'))
    a.addEventListener('seeking', () => {
      if (!active()) return
      if (this.audioSeekTarget !== null && a.src === this.audioSeekSrc) this.audioSeekingPending = true
    })
    a.addEventListener('seeked', () => {
      if (!active()) return
      this.audioSeekingPending = false
      this.emit('time')
    })
    a.addEventListener('playing', () => active() && this.emit('loading'))
    a.addEventListener('waiting', () => active() && this.emit('loading'))
    a.addEventListener('canplay', () => active() && this.emit('loading'))
    a.addEventListener('ended', () => active() && a.ended && this.emit('ended'))
    a.addEventListener('error', () => {
      if (active() && !this.hls && a.error) this.fail(a.error.message || 'media error')
    })
    return a
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

  private fail(message: string, kind: 'media' | 'blocked' = 'media') {
    if (this.lastError) return
    this.lastError = message
    this.lastErrorKind = kind
    this.emit('error')
  }

  private playAudio(load: AudioLoad) {
    if (!load.autoplay || !load.ready) return
    const a = this.audio
    void a.play().catch((error: unknown) => {
      if (this.audioLoad !== load || !load.autoplay) return
      const name = error instanceof Error ? error.name : ''
      if (name === 'AbortError') return
      if (name === 'NotAllowedError') {
        load.autoplay = false
        this.fail('WebView blocked automatic playback', 'blocked')
      } else {
        this.fail(a.error?.message || name || 'media error')
      }
    })
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
        (this.spotifyPlaying &&
          !this.spotifyWaiting &&
          (this.spotifyBuffered >= Math.min(dur - 1, this.spotifyPos + 8) ||
            (this.spotifyConfirmedPlaying && this.spotifyPos >= 2)))
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

  setPreFade(factor: number) {
    const clamped = Math.min(1, Math.max(0.15, Number.isFinite(factor) ? factor : 1))
    this.preFadeFactor = clamped
    if (!this.fadeTimer && !this.fadingOut && !this.spotifyTrackId) {
      this.audio.volume = volumeToGain(this.baseVolume) * this.preFadeFactor
    }
  }

  prepareCrossfade(seconds: number) {
    const clamped = Math.min(12, Math.max(0.5, seconds))
    if (!this.spotifyTrackId && !this.audio.paused && (this.audio.currentTime || 0) > 0) {
      this.pendingCrossfadeSec = clamped
    }
  }

  private stopCrossfade(restoreMainVolume = true) {
    if (this.fadeWaitCleanup) {
      this.fadeWaitCleanup()
      this.fadeWaitCleanup = null
    }
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
    this.pendingCrossfadeSec = 0
    this.preFadeFactor = 1
    if (this.fadingOut) {
      const old = this.fadingOut
      this.fadingOut = null
      old.audio.pause()
      if (old.hls) old.hls.destroy()
      if (old.objectUrl) URL.revokeObjectURL(old.objectUrl)
      old.audio.removeAttribute('src')
      old.audio.load()
    }
    if (restoreMainVolume) {
      this.audio.volume = volumeToGain(this.baseVolume)
      this.audio.muted = this.isMuted
    }
  }

  private startCrossfadeRamp(fadeSec: number) {
    if (this.fadeWaitCleanup) {
      this.fadeWaitCleanup()
      this.fadeWaitCleanup = null
    }
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
    const fading = this.fadingOut
    if (!fading) {
      this.audio.volume = volumeToGain(this.baseVolume)
      this.audio.muted = this.isMuted
      return
    }
    const startMs = Date.now()
    const totalMs = Math.max(200, fadeSec * 1000)
    const startOutVol = Math.max(0.05, fading.startVolume)
    const tick = () => {
      if (!this.fadingOut || this.fadingOut !== fading) {
        if (this.fadeTimer) {
          clearInterval(this.fadeTimer)
          this.fadeTimer = null
        }
        return
      }
      const p = Math.min(1, (Date.now() - startMs) / totalMs)
      // Hermite S-curve (zero slope at start and end) so incoming audio enters imperceptibly
      const smooth = p * p * (3 - 2 * p)
      const outCurve = (1 - p) * (1 - smooth)
      const targetGain = volumeToGain(this.baseVolume)
      this.audio.volume = targetGain * smooth
      this.audio.muted = this.isMuted
      fading.audio.volume = Math.min(targetGain, startOutVol) * outCurve
      fading.audio.muted = this.isMuted
      if (p >= 1) {
        this.stopCrossfade(true)
      }
    }
    tick()
    this.fadeTimer = setInterval(tick, 32)
  }

  private scheduleCrossfadeWhenPlaying(fadeSec: number) {
    if (this.fadeWaitCleanup) {
      this.fadeWaitCleanup()
      this.fadeWaitCleanup = null
    }
    const a = this.audio
    if (!a.paused) {
      this.startCrossfadeRamp(fadeSec)
      return
    }
    let started = false
    const begin = () => {
      if (started) return
      started = true
      cleanup()
      if (this.audio === a && this.fadingOut) {
        this.startCrossfadeRamp(fadeSec)
      }
    }
    const timer = setTimeout(begin, 450)
    const cleanup = () => {
      clearTimeout(timer)
      a.removeEventListener?.('play', begin)
      a.removeEventListener?.('playing', begin)
      if (this.fadeWaitCleanup === cleanup) this.fadeWaitCleanup = null
    }
    this.fadeWaitCleanup = cleanup
    a.addEventListener('play', begin, { once: true })
    a.addEventListener('playing', begin, { once: true })
  }

  private teardown(keepSpotify = false, crossfadeSec = 0) {
    this.audioLoad = null
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

    const canCrossfade = crossfadeSec > 0 && !keepSpotify && !this.spotifyTrackId && !this.audio.paused
    if (canCrossfade) {
      const currentVol = this.audio.volume || volumeToGain(this.baseVolume)
      this.stopCrossfade(false)
      this.fadingOut = { audio: this.audio, hls: this.hls, objectUrl: this.objectUrl, startVolume: currentVol }
      this.hls = null
      this.objectUrl = null
      this.audio = this.createAudio()
      this.audio.muted = this.isMuted
      this.audio.volume = 0
    } else {
      this.stopCrossfade(false)
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl)
        this.objectUrl = null
      }
    }

    this.fullBufferEmitted = false
    this.audioSeekAt = 0
    this.audioSeekTarget = null
    this.audioSeekingPending = false
    this.spotifyTrackId = null
    this.spotifyContextUri = undefined
    this.spotifyAlbumId = undefined
    this.spotifyUid = undefined
    this.spotifyExpectedTitle = ''
    this.spotifyExpectedDuration = 0
    this.spotifyRetriedWithContext = false
    this.spotifyMismatchLogged = false
    this.spotifyLastLoggedErr = ''
    this.spotifyPos = 0
    this.spotifyDur = 0
    this.spotifyBuffered = 0
    this.spotifyPlaying = false
    this.spotifyWaiting = false
    this.spotifyStarted = false
    this.spotifyConfirmedPlaying = false
    this.spotifyUserPaused = false
    this.spotifyUnexpectedPauseCount = 0
    this.spotifyAutoResumeTried = false
    this.spotifyLastPlaybackErr = ''
    this.spotifyPlayGen += 1
    this.spotifyActualId = null
    this.spotifyPlayStartedAt = 0
    this.spotifyLastPollAt = 0
    this.spotifyEndStallAt = 0
    this.spotifyEndStallPos = -1
    this.spotifySeekTarget = null
    this.spotifySeekBackward = false
    this.spotifySeekAt = 0
    this.spotifyLastTickAt = 0
    this.spotifyPolling = null
    if (!canCrossfade) {
      const hls = this.hls
      this.hls = null
      hls?.destroy()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio.volume = volumeToGain(this.baseVolume)
      this.audio.muted = this.isMuted
    }
  }

  private async startSpotifyTrack(id: string, startAt: number, preferContext = false) {
    if (!isTauri() || this.spotifyTrackId !== id) return
    const gen = ++this.spotifyPlayGen
    this.spotifyWaiting = true
    this.spotifyConfirmedPlaying = false
    this.spotifyUserPaused = false
    this.spotifyUnexpectedPauseCount = 0
    this.spotifyAutoResumeTried = false
    this.spotifyLastPlaybackErr = ''
    this.spotifyActualId = null
    this.spotifyPlayStartedAt = Date.now()
    this.spotifyLastTickAt = Date.now()
    this.spotifyEndStallAt = 0
    this.spotifyEndStallPos = -1
    this.spotifySeekTarget = startAt > 0 ? startAt : null
    this.spotifySeekBackward = false
    this.spotifySeekAt = startAt > 0 ? Date.now() : 0
    this.emit('loading')
    try {
      const res = await invoke<{ ok?: boolean }>('spotify_status', {
        request: {
          kind: 'play',
          id,
          startAt,
          volume: this.audio.volume,
          muted: this.audio.muted,
          ...(this.spotifyContextUri ? { contextUri: this.spotifyContextUri } : {}),
          ...(this.spotifyAlbumId ? { albumId: this.spotifyAlbumId } : {}),
          ...(this.spotifyUid ? { trackUid: this.spotifyUid } : {}),
          ...(preferContext ? { preferContext: true } : {}),
        },
      })
      if (this.spotifyTrackId !== id || this.spotifyPlayGen !== gen) return
      if (res?.ok !== true) {
        this.failSpotify('Spotify не принял команду воспроизведения')
        return
      }
      this.spotifyPlaying = true
      this.spotifyStarted = true
      this.spotifyPlayStartedAt = Date.now()
      this.spotifyLastTickAt = Date.now()
      this.emit('state')
    } catch (e) {
      if (this.spotifyTrackId !== id || this.spotifyPlayGen !== gen) return
      this.failSpotify(typeof e === 'string' ? e : 'Не удалось запустить трек в Spotify')
    }
  }

  private finishSpotifyPlayback() {
    this.spotifyPlayGen++
    this.spotifyUserPaused = true
    this.spotifyStarted = false
    this.spotifyConfirmedPlaying = false
    this.spotifyPlaying = false
    this.spotifyWaiting = false
    this.emit('state')
    this.emit('loading')
  }

  private failSpotify(message: string) {
    this.finishSpotifyPlayback()
    this.fail(message)
  }

  private reportSpotifyMismatch(id: string, actualId: string) {
    if (this.spotifyMismatchLogged) return
    this.spotifyMismatchLogged = true
    journal('spotify', 'the web player started a different track')
    this.finishSpotifyPlayback()
    this.onSpotifyMismatch?.({ requestedId: id, actualId })
  }

  private tickSpotify() {
    const startTimedOut = this.spotifyTrackId && !this.spotifyUserPaused && this.spotifyWaiting &&
      !this.spotifyConfirmedPlaying && Date.now() - this.spotifyPlayStartedAt >= SPOTIFY_START_TIMEOUT_MS
    if (startTimedOut) {
      this.failSpotify('Spotify не начал воспроизведение за отведённое время')
      return
    }
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
    const pollDur = this.spotifyDur > 0 ? this.spotifyDur : this.spotifyExpectedDuration
    if (
      this.spotifyConfirmedPlaying &&
      pollDur > 5 &&
      pollDur - this.spotifyPos <= 3.0 &&
      now - this.spotifyLastPollAt >= 300
    ) {
      void this.pollSpotify()
    }
  }

  private checkSpotifyEndStall(
    rawPlaying: boolean,
    sameOrCleared: boolean,
    startPending: boolean,
    effectiveDur: number,
    rawPos: number,
  ): boolean {
    if (
      !this.spotifyConfirmedPlaying ||
      !this.spotifyStarted ||
      this.spotifyUserPaused ||
      startPending ||
      this.spotifySeekTarget !== null ||
      !rawPlaying ||
      !sameOrCleared ||
      effectiveDur <= 15 ||
      rawPos < effectiveDur - 1.5
    ) {
      this.spotifyEndStallAt = 0
      this.spotifyEndStallPos = -1
      return false
    }
    const now = Date.now()
    if (this.spotifyEndStallAt === 0 || rawPos > this.spotifyEndStallPos + 0.08) {
      this.spotifyEndStallAt = now
      this.spotifyEndStallPos = rawPos
      return false
    }
    if (now - this.spotifyEndStallAt >= 2200) {
      journal('spotify', 'ending stalled track at duration boundary')
      return true
    }
    return false
  }

  private async pollSpotify() {
    const id = this.spotifyTrackId
    const gen = this.spotifyPlayGen
    if (!id || !isTauri() || this.spotifyUserPaused || this.spotifyPolling === gen) return
    this.spotifyPolling = gen
    this.spotifyLastPollAt = Date.now()
    try {
      const raw = await invoke<Record<string, unknown>>('spotify_status')
      if (this.spotifyPlayGen !== gen) return
      const np = raw?.nowPlaying && typeof raw.nowPlaying === 'object' ? (raw.nowPlaying as Record<string, unknown>) : null
      const startPending = raw?.startPending === true
      const startAge = Date.now() - this.spotifyPlayStartedAt
      const isAd = np?.isAd === true
      const prevPlaying = this.spotifyPlaying
      const prevWaiting = this.spotifyWaiting

      if (isAd) {
        this.spotifyPlayStartedAt = Date.now()
        this.spotifyWaiting = true
        this.spotifyPlaying = false
        if (prevPlaying !== this.spotifyPlaying) this.emit('state')
        if (prevWaiting !== this.spotifyWaiting) this.emit('loading')
        return
      }

      const npTrackId =
        typeof np?.trackId === 'string' && np.trackId
          ? np.trackId
          : typeof raw?.actualTrackId === 'string' && raw.actualTrackId
            ? raw.actualTrackId
            : null
      const npLinkedFromId = typeof np?.linkedFromTrackId === 'string' ? np.linkedFromTrackId : null
      const npTitle = typeof np?.title === 'string' ? np.title.replace(/\s+/g, ' ').trim().toLowerCase() : ''
      const npDuration = Number(np?.duration) || 0
      const stripTag = (s: string) => s.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s*\[[^\]]*\]\s*/g, ' ').replace(/\s+/g, ' ').trim()
      const titleMatched =
        Boolean(npTitle && this.spotifyExpectedTitle) &&
        (npTitle === this.spotifyExpectedTitle ||
          (stripTag(npTitle) !== '' && stripTag(npTitle) === stripTag(this.spotifyExpectedTitle)))
      const relinkedTitleMatch =
        titleMatched &&
        this.spotifyExpectedDuration > 0 &&
        npDuration > 0 &&
        Math.abs(npDuration - this.spotifyExpectedDuration) <= 6
      const matchesRequested = npTrackId === id || npLinkedFromId === id || relinkedTitleMatch
      const rawPlaying = np ? np.paused === false : raw?.playing === true
      const rawEnded = np?.trackEnded === true || raw?.trackEnded === true
      const endedTrackId =
        typeof np?.endedTrackId === 'string' && np.endedTrackId
          ? np.endedTrackId
          : typeof raw?.endedTrackId === 'string' && raw.endedTrackId
            ? raw.endedTrackId
            : null
      const endedMatchesCurrent = rawEnded && (!endedTrackId || endedTrackId === id || endedTrackId === this.spotifyActualId)
      const prevPos = this.spotifyPos

      const playErr = typeof raw?.lastPlayError === 'string' && raw.lastPlayError ? raw.lastPlayError : ''
      if (!startPending && playErr && playErr !== this.spotifyLastLoggedErr) {
        this.spotifyLastLoggedErr = playErr
        journal('spotify', `playback warning: ${playErr}`)
      }
      const playbackErr = typeof raw?.lastPlaybackError === 'string' && raw.lastPlaybackError ? raw.lastPlaybackError : ''
      if (!startPending && playbackErr && playbackErr !== this.spotifyLastPlaybackErr) {
        this.spotifyLastPlaybackErr = playbackErr
        journal('spotify', `web player playback error: ${playbackErr}`)
      } else if (!playbackErr && rawPlaying) {
        this.spotifyLastPlaybackErr = ''
      }

      // The status can still describe the outgoing track while the web player connects.
      if (!this.spotifyConfirmedPlaying && !matchesRequested) {
        if (!rawPlaying || startPending || !npTrackId || startAge < 3500) return
        if (typeof raw?.expectedTrackId === 'string' && raw.expectedTrackId && raw.expectedTrackId !== id) return
        if ((this.spotifyContextUri || this.spotifyAlbumId) && !this.spotifyRetriedWithContext) {
          this.spotifyRetriedWithContext = true
          journal('spotify', 'retrying playback with context after track mismatch')
          void this.startSpotifyTrack(id, this.spotifyPos, true)
        } else {
          this.reportSpotifyMismatch(id, npTrackId)
        }
        return
      }
      if (this.spotifyConfirmedPlaying && this.spotifyActualId && npTrackId && npTrackId !== this.spotifyActualId && !matchesRequested) {
        if (startPending || (this.spotifySeekTarget !== null && Date.now() - this.spotifySeekAt < 2400)) return
        if (
          this.spotifyStarted &&
          (endedMatchesCurrent || (this.spotifyDur > 0 && prevPos >= this.spotifyDur - Math.min(8, this.spotifyDur / 2)))
        ) {
          this.finishSpotifyPlayback()
          this.emit('ended')
        } else {
          this.reportSpotifyMismatch(id, npTrackId)
        }
        return
      }
      if (matchesRequested && rawPlaying) this.spotifyActualId = npTrackId ?? id

      if (np) {
        const pos = Number(np.position)
        const dur = Number(np.duration)
        if (Number.isFinite(dur) && dur > 0) this.spotifyDur = dur
        const buf = Number(np.buffered)
        if (Number.isFinite(buf) && buf >= 0) {
          this.spotifyBuffered = this.spotifyDur > 0 ? Math.min(this.spotifyDur, buf) : buf
        }
        if (Number.isFinite(pos) && pos >= 0) {
          const now = Date.now()
          const seekTarget = this.spotifySeekTarget
          const seekAge = now - this.spotifySeekAt
          const seekUpper = Math.min(2.5, Math.max(1.25, seekAge / 1000 + 0.4))
          if (seekTarget !== null && seekAge < 2400) {
            if (seekAge >= 250 && pos >= seekTarget - 0.04 && (!this.spotifySeekBackward || pos <= seekTarget + seekUpper)) {
              this.spotifySeekTarget = null
              this.spotifySeekBackward = false
              this.spotifyPos = Math.max(seekTarget, this.spotifyPos - 0.05, pos)
              this.spotifyLastTickAt = now
            } else if (seekAge >= 250 && pos >= seekTarget - 0.35 && pos < seekTarget - 0.04) {
              this.spotifyPos = Math.max(seekTarget, this.spotifyPos)
              this.spotifyLastTickAt = now
            }
          } else {
            this.spotifySeekTarget = null
            this.spotifySeekBackward = false
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

      const dur = this.spotifyDur
      const effectiveDur = dur > 0 ? dur : this.spotifyExpectedDuration
      const sameTrack = matchesRequested || (npTrackId !== null && npTrackId === this.spotifyActualId)
      const rawPos = np && Number.isFinite(Number(np.position)) ? Number(np.position) : this.spotifyPos
      const nearEndStopped =
        !rawPlaying &&
        !this.spotifyUserPaused &&
        sameTrack &&
        effectiveDur > 15 &&
        rawPos >= effectiveDur - 1.5 &&
        prevPos >= effectiveDur - 3
      const nearEndStalled = this.checkSpotifyEndStall(
        rawPlaying,
        sameTrack || (np === null && npTrackId === null && effectiveDur > 15 && prevPos >= effectiveDur - 1.5),
        startPending,
        effectiveDur,
        rawPos,
      )
      const finishEnded =
        this.spotifyConfirmedPlaying &&
        this.spotifyStarted &&
        !startPending &&
        this.spotifySeekTarget === null &&
        (endedMatchesCurrent ||
          nearEndStalled ||
          (!rawPlaying &&
            sameTrack &&
            (nearEndStopped || (dur > 0 && prevPos >= dur - Math.min(3, dur / 2) && this.spotifyPos <= 1.5))))
      if (finishEnded) {
        this.finishSpotifyPlayback()
        this.emit('ended')
        return
      }

      if (rawPlaying) {
        this.spotifyConfirmedPlaying = true
        this.spotifyStarted = true
        this.spotifyWaiting = false
        this.spotifyPlaying = true
        this.spotifyUnexpectedPauseCount = 0
        this.spotifyAutoResumeTried = false
      } else if (!this.spotifyConfirmedPlaying) {
        this.spotifyWaiting = true
      } else {
        if (this.spotifyConfirmedPlaying && this.spotifyStarted && !this.spotifyUserPaused) {
          this.spotifyUnexpectedPauseCount += 1
          if (this.spotifyUnexpectedPauseCount >= 2 && !this.spotifyAutoResumeTried) {
            this.spotifyAutoResumeTried = true
            const posNow = this.spotifyPos || 0
            journal('spotify', 'resuming after unexpected pause')
            void invoke<boolean>('spotify_control', { action: 'play', value: null })
              .then((ok) => {
                if (!ok && this.spotifyPlayGen === gen) {
                  void this.startSpotifyTrack(id, posNow)
                }
              })
              .catch(() => {})
          } else if (this.spotifyAutoResumeTried && this.spotifyUnexpectedPauseCount >= 6) {
            this.failSpotify(this.spotifyLastPlaybackErr || 'Воспроизведение Spotify прервалось')
            return
          }
        }
        this.spotifyPlaying = false
        this.spotifyWaiting = false
      }
      this.emit('time')
      if (prevPlaying !== this.spotifyPlaying) this.emit('state')
      if (prevWaiting !== this.spotifyWaiting) this.emit('loading')
      this.maybeEmitBuffered()
    } catch {
      // ignore transient eval timeouts while the hidden webview navigates
    } finally {
      if (this.spotifyPolling === gen) this.spotifyPolling = null
    }
  }

  /** Loads a stream URL (HLS through the Rust proxy, Spotify via hidden webview, anything else directly). */
  load(url: string, startAt = 0, autoplay = true, options?: StreamOptions) {
    const isSpotify = url.startsWith('spotify:track:')
    const fadeSec = !isSpotify && autoplay ? this.pendingCrossfadeSec : 0
    this.pendingCrossfadeSec = 0
    this.teardown(isSpotify, fadeSec)
    this.recovered = false
    this.lastError = ''
    this.lastErrorKind = 'media'
    if (isSpotify) {
      const id = url.slice('spotify:track:'.length).trim()
      this.spotifyTrackId = id
      this.spotifyContextUri = options?.spotifyContextUri
      this.spotifyAlbumId = options?.spotifyAlbumId
      this.spotifyUid = options?.spotifyUid
      this.spotifyExpectedTitle = options?.spotifyTitle ? options.spotifyTitle.replace(/\s+/g, ' ').trim().toLowerCase() : ''
      this.spotifyExpectedDuration = options?.spotifyDuration ?? 0
      this.spotifyPos = startAt
      this.spotifyWaiting = autoplay
      this.spotifyUserPaused = !autoplay
      this.onSource?.({ url, hls: null, drm: options?.drm, waveformUrl: options?.waveformUrl })
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
    const load = { autoplay, ready: true }
    this.audioLoad = load
    if (url.includes('.m3u8') && Hls.isSupported()) {
      load.ready = false
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
        if (this.hls !== hls || this.audioLoad !== load) return
        load.ready = true
        this.playAudio(load)
      })
      hls.on(Hls.Events.BUFFER_EOS, () => {
        if (this.hls === hls) this.maybeEmitBuffered(true)
      })
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (this.hls === hls) this.maybeEmitBuffered()
      })
      hls.on(Hls.Events.ERROR, (_e, data: ErrorData) => {
        if (this.hls !== hls || !data.fatal) return
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
      if (startAt > 0) a.currentTime = startAt
      this.playAudio(load)
    }
    if (fadeSec > 0 && this.fadingOut) {
      this.scheduleCrossfadeWhenPlaying(fadeSec)
    }
    this.emit('loading')
  }

  stop() {
    this.teardown()
    this.emit('state')
  }

  play() {
    if (this.spotifyTrackId) {
      if (!this.spotifyUserPaused && (this.spotifyWaiting || this.spotifyPlaying)) return
      const id = this.spotifyTrackId
      const pendingSeek = this.spotifySeekTarget
      this.spotifyUserPaused = false
      this.spotifyUnexpectedPauseCount = 0
      this.spotifyAutoResumeTried = false
      this.spotifyEndStallAt = 0
      this.spotifyEndStallPos = -1
      this.spotifyLastPlaybackErr = ''
      this.lastError = ''
      if (!this.spotifyStarted || !this.spotifyConfirmedPlaying || pendingSeek !== null) {
        // A seek while paused may only have changed the web player's UI. Pair the position with the track ID on resume.
        void this.startSpotifyTrack(id, pendingSeek ?? this.spotifyPos)
      } else {
        const gen = ++this.spotifyPlayGen
        this.spotifyPlaying = true
        this.spotifyPlayStartedAt = Date.now()
        this.emit('state')
        if (isTauri()) {
          void invoke<boolean>('spotify_control', { action: 'play', value: null })
            .then((ok) => { if (!ok && this.spotifyPlayGen === gen) void this.startSpotifyTrack(id, this.spotifyPos) })
            .catch(() => {})
        }
      }
      return
    }
    if (this.audioLoad) {
      this.audioLoad.autoplay = true
      this.playAudio(this.audioLoad)
      this.emit('loading')
    }
  }

  pause() {
    this.stopCrossfade(true)
    if (this.spotifyTrackId) {
      this.spotifyUserPaused = true
      this.spotifyUnexpectedPauseCount = 0
      this.spotifyAutoResumeTried = false
      this.spotifyEndStallAt = 0
      this.spotifyEndStallPos = -1
      this.spotifyPlayGen += 1
      if (this.spotifySeekTimer) {
        clearTimeout(this.spotifySeekTimer)
        this.spotifySeekTimer = null
      }
      this.spotifyPlaying = false
      this.spotifyWaiting = false
      this.emit('state')
      this.emit('loading')
      if (isTauri()) void invoke('spotify_control', { action: 'pause', value: null }).catch(() => {})
      return
    }
    if (this.audioLoad) this.audioLoad.autoplay = false
    this.audio.pause()
    this.emit('loading')
  }

  seek(sec: number) {
    if (!Number.isFinite(sec)) return
    this.stopCrossfade(true)
    this.seekSerial += 1
    const target = Math.max(0, sec)
    if (this.spotifyTrackId) {
      this.spotifySeekBackward = target < this.spotifyPos - 0.5
      this.spotifyPos = target
      this.spotifySeekTarget = target
      this.spotifySeekAt = Date.now()
      this.spotifyLastTickAt = Date.now()
      this.spotifyUnexpectedPauseCount = 0
      this.spotifyAutoResumeTried = false
      this.spotifyEndStallAt = 0
      this.spotifyEndStallPos = -1
      if (this.spotifyBuffered > 0 && target > this.spotifyBuffered + 0.5) {
        this.spotifyBuffered = 0
      }
      this.emit('time')
      if (isTauri() && !this.spotifyUserPaused) {
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
    this.baseVolume = v
    this.isMuted = muted
    const gain = volumeToGain(v)
    if (!this.fadeTimer && !this.fadingOut) {
      this.audio.volume = gain * this.preFadeFactor
    }
    this.audio.muted = muted
    if (this.fadingOut) {
      this.fadingOut.audio.muted = muted
    }
    if (this.spotifyTrackId && isTauri()) {
      const sendVolume = () => {
        this.spotifyVolumeTimer = null
        this.spotifyLastVolumeSentAt = Date.now()
        void invoke('spotify_status', {
          request: { kind: 'volume', volume: gain, muted: this.audio.muted },
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
    return this.audioLoad !== null && !this.audio.paused
  }

  get waiting() {
    if (this.spotifyTrackId) return this.spotifyWaiting
    if (!this.audioLoad?.autoplay) return false
    if (!this.audioLoad.ready) return true
    if (this.audio.readyState < 3) {
      // Suppress transient Play/Pause loading flicker while seeking inside a buffered range.
      if (Date.now() - this.audioSeekAt < 350 && this.isBufferedAt(this.audio.currentTime)) return false
      return true
    }
    return false
  }
}

export const engine = new Engine()
