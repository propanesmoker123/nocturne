import { create } from 'zustand'
import { toast } from '../app/toast'
import { journal } from '../lib/journal'
import { debouncedSaver, loadJSON } from '../lib/persist'
import { useSettings } from '../lib/settings'
import * as sc from '../sc/api'
import type { ScPlaybackSource } from '../sc/playback'
import { describeScError, SC_UNREACHABLE, ScApiError } from '../sc/errors'
import * as vk from '../vk/api'
import { serviceOf, type Track } from '../vk/models'
import { engine } from './engine'
import { dedupeAppend, heardBetween, heardEnough, needsFreshUrl, prevAction } from './logic'
import { clearPreload, clearPreloadExcept, syncNextPreload, takePreloadedSource } from './preload'
import * as Q from './queue'
import { beginWaveform, captureSource } from './waveform'

export interface QueueSource {
  kind: 'list' | 'mix'
  label?: string
  service?: 'vk' | 'sc' | 'spotify'
  seed?: string
  contextUri?: string
}

interface SavedSession {
  tracks: Track[]
  pos: number
  position: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: Q.RepeatMode
  source: QueueSource | null
}

export interface PlayListOptions {
  shuffle?: boolean
  source?: QueueSource
  startAt?: number
  paused?: boolean
}

export interface PlayerState {
  queue: Q.QueueState<Track> | null
  current: Track | null
  source: QueueSource | null
  isPlaying: boolean
  isLoading: boolean
  position: number
  duration: number
  buffered: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: Q.RepeatMode
  history: Track[]
  /** Remote mode: the device this player steers, or null while it plays itself. */
  remoteName: string | null
  /** Remote mode: the tracks before and after the one that plays there (when that device says). */
  remoteNear: RemoteNear | null

  /** `startAt` (seconds) and `paused` start the first track somewhere other than the top, or without playing. */
  playList(tracks: Track[], index: number, opts?: PlayListOptions): void
  playMix(service?: 'vk' | 'spotify'): Promise<void>
  playRadio(track: Track): Promise<void>
  toggle(): void
  play(): void
  pause(): void
  /** `autoplay` false: the next track is loaded paused (the person had paused the one that failed). */
  next(manual?: boolean, autoplay?: boolean): void
  /** `always`: the previous track even late in this one (a swipe), not a restart. */
  prev(always?: boolean): void
  seek(sec: number): void
  seekBy(delta: number): void
  setVolume(v: number): void
  nudgeVolume(delta: number): void
  toggleMute(): void
  toggleShuffle(): void
  cycleRepeat(): void
  playNext(tracks: Track[]): void
  addToQueue(tracks: Track[]): void
  removeFromQueue(orderPos: number): void
  moveInQueue(from: number, to: number): void
  /** Plays the queue entry at `orderPos` right after the current track (moved, not copied). */
  playNextFromQueue(orderPos: number): void
  jumpTo(orderPos: number): void
  updateTrack(key: string, patch: Partial<Track>): void
}

const isPlayable = (t: Track) => t.playable

/** What a press on the player means to someone else steering it (listening together). */
export type PlayerIntent = 'pick' | 'skip' | 'seek' | 'mode' | 'pause' | 'resume'
let guard: ((intent: PlayerIntent) => boolean) | null = null

/**
 * Lets the listen-together session see, refuse or reroute what the person does with the player:
 * a listener's seeks and skips are refused, their pause stays theirs, play catches up with the host,
 * and picking other music ends the session. `null` removes it.
 */
export function setPlayerGuard(g: ((intent: PlayerIntent) => boolean) | null) {
  guard = g
}
const allow = (intent: PlayerIntent) => !guard || guard(intent)

/** The position the audio is really at, without waiting for the next time update. */
export function livePosition(): number {
  const { current, position } = usePlayer.getState()
  // in remote mode this engine may still hold the same track, paused somewhere else
  if (remote) return position
  return activeLoad?.attached && activeLoad.key === current?.key ? engine.position : position
}

/** Whether `engine` is currently attached to `trackKey` (as opposed to still holding an outgoing track during load). */
export function isEngineAttachedTo(trackKey: string): boolean {
  const { current } = usePlayer.getState()
  return !remote && Boolean(activeLoad?.attached && activeLoad.key === trackKey && current?.key === trackKey)
}

/** Sub-millisecond playback timestamp in ms, guarded against reading an outgoing track from `engine` during track switches. */
export function livePlaybackPositionMs(trackKey?: string): number {
  const { current, position } = usePlayer.getState()
  if (trackKey && current?.key !== trackKey) return 0
  if (remote) return Math.max(0, position * 1000)
  return activeLoad?.attached && activeLoad.key === current?.key ? engine.getPlaybackPositionMs() : Math.max(0, position * 1000)
}

/** What a press means when another device plays and this one is its remote. */
export interface PlayerRemote {
  toggle(): void
  play(): void
  pause(): void
  next(): void
  /** `always`: the previous track even late in this one, not a restart (a swipe). */
  prev(always?: boolean): void
  seek(sec: number): void
  setVolume(v: number): void
  toggleShuffle(): void
  cycleRepeat(): void
  playList(tracks: Track[], index: number, opts?: PlayListOptions): void
  playMix(): void
}

/** The tracks around the one that plays: what a swipe would go to. */
export interface RemoteNear {
  prev: Track | null
  next: Track | null
}

/** What the steered device plays, as this player shows it. */
export interface RemoteView {
  name: string
  track: Track | null
  near?: RemoteNear | null
  position: number
  duration: number
  playing: boolean
  volume: number
  shuffle: boolean
  repeat: Q.RepeatMode
}

let remote: PlayerRemote | null = null
let beforeRemote: Pick<PlayerState, 'queue' | 'current' | 'source' | 'position' | 'duration' | 'volume' | 'muted' | 'shuffle' | 'repeat'> | null = null

export const remoteActive = () => remote !== null

export function nextPreloadTarget(q: Q.QueueState<Track> | null): Track | null {
  if (!q || q.repeat === 'one') return null
  const cur = Q.current(q)
  const nextQ = Q.next(q, isPlayable, false)
  if (!nextQ || nextQ.pos === q.pos) return null
  const t = Q.current(nextQ)
  return t && t.key !== cur?.key ? t : null
}

/**
 * Remote mode: another device plays, every press goes to `r`, and the player shows that device
 * (`showRemote`). This device's own audio stops; null brings its player back exactly as it was.
 */
export function setPlayerRemote(r: PlayerRemote | null) {
  if (r && !remote) {
    const s = usePlayer.getState()
    beforeRemote = { queue: s.queue, current: s.current, source: s.source, position: s.position, duration: s.duration, volume: s.volume, muted: s.muted, shuffle: s.shuffle, repeat: s.repeat }
    remote = r
    stopScWatch()
    // a load still on its way never starts, and this device's own audio stops for good
    activeLoad = null
    selectionToken++
    queueSession++
    pendingAdvance = null
    extendInFlight = null
    currentFullyLoaded = false
    clearPreload()
    engine.stop()
  }
  if (!r && remote && beforeRemote) {
    usePlayer.setState({ ...beforeRemote, isPlaying: false, isLoading: false, remoteName: null, remoteNear: null })
    beforeRemote = null
  }
  remote = r
}

export function showRemote(v: RemoteView) {
  if (!remote) return
  usePlayer.setState({ remoteName: v.name, remoteNear: v.near ?? null, queue: null, current: v.track, position: v.position, duration: v.duration, isPlaying: v.playing, isLoading: false, volume: v.volume, shuffle: v.shuffle, repeat: v.repeat })
}

interface TrackLoad {
  key: string
  startAt: number
  autoplay: boolean
  retried: boolean
  attached: boolean
}

let activeLoad: TrackLoad | null = null
let queueSession = 0
let selectionToken = 0
let extendInFlight: { session: number; promise: Promise<void> } | null = null
let pendingAdvance: { session: number; manual: boolean; autoplay: boolean } | null = null
let currentFullyLoaded = false
/** Without a VPN, SoundCloud's stream hosts in Russia take the connection and send nothing. */
export const SC_START_TIMEOUT_MS = 15_000
let scWatch: ReturnType<typeof setTimeout> | undefined
function stopScWatch() {
  clearTimeout(scWatch)
  scWatch = undefined
}
let consecutiveFailures = 0
let volumeModified = false
/** How much of the current load was really heard: it reaches «Недавние» only past half. */
let heard = { key: '', seconds: 0, last: 0, recorded: false }
const sessionSaver = debouncedSaver('session', 1200)
const historySaver = debouncedSaver('history', 2000)

export const usePlayer = create<PlayerState>((set, get) => {
  const currentLoad = () => !remote && activeLoad?.key === get().current?.key ? activeLoad : null
  const engineLoad = () => {
    const load = currentLoad()
    return load?.attached ? load : null
  }

  const stopLoaded = () => {
    activeLoad = null
    pendingAdvance = null
    stopScWatch()
    currentFullyLoaded = false
    clearPreload()
    engine.stop()
    set({ isPlaying: false, isLoading: false })
  }

  const replaceTrack = (track: Track) => {
    const q = get().queue
    if (!q) return
    const items = q.items.map((t) => (t.key === track.key ? track : t))
    const cur = get().current
    set({ queue: { ...q, items }, current: cur && cur.key === track.key ? track : cur })
  }

  const syncPreload = () => {
    if (!remote && currentFullyLoaded) syncNextPreload(nextPreloadTarget(get().queue))
  }

  const extendMixIfNeeded = (): Promise<void> => {
    const { source, queue } = get()
    if (source?.kind !== 'mix' || !queue || Q.upcoming(queue).filter(isPlayable).length > 3) return Promise.resolve()
    if (extendInFlight && extendInFlight.session === queueSession) return extendInFlight.promise
    const session = queueSession
    let promise!: Promise<void>
    promise = (async () => {
      try {
        let incoming: Track[] = []
        if (source.service === 'spotify') {
          const sp = await import('../spotify/api')
          incoming = source.seed ? await sp.getTrackRadio(source.seed) : await sp.getSpotifyMix()
        } else {
          incoming = await vk.getStreamMix(20)
        }
        if (queueSession !== session) return
        const q = get().queue
        if (!q) return
        const more = dedupeAppend(q.items, incoming.filter(isPlayable))
        if (more.length) {
          set({ queue: Q.append(q, more) })
          syncPreload()
        }
        const adv = pendingAdvance
        if (adv && adv.session === session) {
          pendingAdvance = null
          const curQ = get().queue
          const n2 = curQ && Q.next(curQ, isPlayable, adv.manual)
          if (n2 === curQ && curQ) {
            engine.seek(0)
            setPlayback(adv.autoplay)
          } else if (n2) {
            set({ queue: n2 })
            void loadCurrent(adv.autoplay)
          } else {
            set({ isLoading: false })
          }
        }
      } catch {
        if (queueSession === session) journal('player', `${source.service ?? 'vk'} mix replenishment failed`)
        if (pendingAdvance?.session === session) {
          pendingAdvance = null
          set({ isLoading: false })
        }
        // the mix simply ends when upstream stops answering
      } finally {
        if (extendInFlight?.promise === promise) extendInFlight = null
      }
    })()
    extendInFlight = { session, promise }
    return promise
  }

  /** A SoundCloud stream that has not started this long after loading is not going to. */
  const watchScStart = (load: TrackLoad, t: Track) => {
    if (scWatch !== undefined || !load.autoplay || (engine.playing && !engine.waiting)) return
    scWatch = setTimeout(() => {
      scWatch = undefined
      if (engineLoad() !== load || !load.autoplay || (engine.playing && !engine.waiting)) return
      journal('player', 'sc: audio did not start within the loading timeout')
      onFailure(t, SC_UNREACHABLE, load.autoplay)
    }, SC_START_TIMEOUT_MS)
  }

  /** Why a SoundCloud track got no stream link, in the person's words. */
  const scLinkFailure = (e: unknown): string => {
    const err = ScApiError.from(e)
    if (err.kind === 'signedOut') return 'Войдите в SoundCloud, чтобы слушать этот трек'
    if (err.kind === 'invalid') return 'Доступно только в SoundCloud'
    if (err.kind === 'http') return describeScError(err)
    return describeScError(err)
  }

  const loadCurrent = async (autoplay: boolean, startAt = 0, retried = false, overlapSec = 0) => {
    const q = get().queue
    const t = q && Q.current(q)
    if (!t) {
      stopLoaded()
      set({ current: null, position: 0, duration: 0, buffered: 0 })
      return
    }
    const intent: TrackLoad = { key: t.key, startAt, autoplay, retried, attached: false }
    activeLoad = intent
    currentFullyLoaded = false
    stopScWatch()
    clearPreloadExcept(t.key)
    set({ current: t, position: startAt, duration: t.duration, buffered: 0, isPlaying: false, isLoading: autoplay })
    beginWaveform(t.key, t.duration)
    let track = t
    let scSource: ScPlaybackSource | undefined
    const service = serviceOf(t)
    const preloaded = service === 'spotify' || retried ? null : takePreloadedSource(t)
    // The outgoing stream only has a role during a deliberate crossfade.
    const needsVkLink = service === 'vk' && (retried || needsFreshUrl(t, Date.now()))
    if (overlapSec === 0 && ((service === 'sc' && !preloaded?.scSource) || (needsVkLink && !preloaded?.url))) engine.stop()
    if (service === 'spotify') {
      const spId = t.spotifyId || (t.url?.startsWith('spotify:track:') ? t.url.slice('spotify:track:'.length) : '')
      if (spId) track = { ...t, url: `spotify:track:${spId}`, urlFetchedAt: Date.now() }
    } else if (service === 'sc') {
      if (preloaded?.scSource) {
        scSource = preloaded.scSource
        track = { ...t, url: scSource.url, urlFetchedAt: preloaded.fetchedAt }
        replaceTrack(track)
      } else {
        try {
          scSource = await sc.streamSource(t)
          if (activeLoad !== intent) return
          track = { ...t, url: scSource.url, urlFetchedAt: Date.now() }
          replaceTrack(track)
        } catch (e) {
          if (activeLoad !== intent) return
          journal('player', `sc: stream lookup failed (${ScApiError.from(e).kind})`)
          onFailure(t, scLinkFailure(e), intent.autoplay)
          return
        }
      }
    } else if (needsVkLink) {
      if (preloaded?.url) {
        track = { ...t, url: preloaded.url, urlFetchedAt: preloaded.fetchedAt }
        replaceTrack(track)
      } else {
        try {
          const [fresh] = await vk.getByIds([t])
          if (activeLoad !== intent) return
          if (fresh) {
            track = { ...t, url: fresh.url, urlFetchedAt: fresh.urlFetchedAt, playable: fresh.playable, liked: fresh.liked || t.liked }
            replaceTrack(track)
          } else if (retried) {
            onFailure(t, undefined, intent.autoplay)
            return
          }
        } catch {
          if (activeLoad !== intent) return
          journal('player', 'vk: fresh link lookup failed')
          if (retried) {
            onFailure(t, undefined, intent.autoplay)
            return
          }
        }
      }
    }
    if (activeLoad !== intent) return
    if (!track.url || !track.playable) {
      journal('player', `${service}: no playable stream at queue position ${(q?.pos ?? 0) + 1}`)
      onFailure(track, 'Трек недоступен в вашем регионе или удалён', intent.autoplay)
      return
    }
    heard = { key: track.key, seconds: 0, last: intent.startAt, recorded: false }
    const src = get().source
    const spotifyOptions =
      service === 'spotify'
        ? {
            spotifyContextUri: src?.service === 'spotify' ? src.contextUri : undefined,
            spotifyAlbumId: track.album?.spotifyId,
            spotifyUid: track.spotifyUid,
            spotifyTitle: track.title,
            spotifyDuration: track.duration,
          }
        : undefined
    if (intent.autoplay && overlapSec > 0) engine.prepareCrossfade(overlapSec)
    intent.attached = true
    try {
      engine.load(track.url, intent.startAt, intent.autoplay, scSource ? { drm: scSource.drm, waveformUrl: scSource.waveformUrl } : spotifyOptions)
    } catch {
      if (activeLoad !== intent) return
      journal('player', `${service}: could not initialize audio source`)
      onFailure(track, undefined, intent.autoplay)
      return
    }
    if (activeLoad !== intent) return
    if (service === 'sc') watchScStart(intent, track)
    void extendMixIfNeeded()
  }

  /** `autoplay`: false when the person paused while it loaded — the next track waits too. */
  const onFailure = (t: Track, reason?: string, autoplay = true) => {
    stopLoaded()
    if (serviceOf(t) === 'spotify') {
      toast(reason ?? 'Spotify не запустил трек. Нажмите «Воспроизвести», чтобы повторить попытку.', 'error')
      return
    }
    consecutiveFailures++
    if (consecutiveFailures >= 5) {
      journal('player', 'five tracks in a row failed, stopping')
      consecutiveFailures = 0
      toast(
        serviceOf(t) === 'sc'
          ? 'SoundCloud не отдаёт звук — без VPN он в России не играет'
          : 'VK не отдаёт треки. Проверьте интернет и подписку',
        'error',
      )
      return
    }
    toast(reason ?? `Не получилось включить «${t.title}»`, 'error')
    advance(true, autoplay)
  }

  const setPlayback = (autoplay: boolean) => {
    const waitingNext = pendingAdvance?.session === queueSession ? pendingAdvance : null
    if (waitingNext) waitingNext.autoplay = autoplay
    const load = currentLoad()
    if (load) load.autoplay = autoplay
    if (!autoplay) {
      stopScWatch()
      engine.pause()
      set({ isLoading: false })
    } else if (load?.attached && (!waitingNext || engine.playing)) {
      engine.play()
      const cur = get().current
      if (cur && activeLoad === load && serviceOf(cur) === 'sc') watchScStart(load, cur)
    } else if ((load && !load.attached) || waitingNext) {
      set({ isLoading: true })
    } else {
      void loadCurrent(true, get().position)
    }
  }

  const advance = (manual: boolean, autoplay: boolean, overlapSec = 0) => {
    const q = get().queue
    if (!q || (manual && !allow('skip'))) return
    const n = Q.next(q, isPlayable, manual)
    if (!n) {
      if (get().source?.kind === 'mix') {
        if (!pendingAdvance || pendingAdvance.session !== queueSession) {
          pendingAdvance = { session: queueSession, manual, autoplay }
        } else {
          if (manual) pendingAdvance.manual = true
          if (!autoplay) pendingAdvance.autoplay = false
        }
        set({ isLoading: pendingAdvance.autoplay })
        void extendMixIfNeeded()
      } else if (engineLoad()) {
        setPlayback(false)
        engine.seek(0)
      }
      return
    }
    if (n === q) {
      engine.seek(0)
      setPlayback(autoplay)
      return
    }
    if (n.pos === q.pos && !engineLoad()) return
    pendingAdvance = null
    set({ queue: n })
    void loadCurrent(autoplay, 0, false, overlapSec)
  }

  // Engine → store
  engine.onSource = captureSource
  engine.onSpotifyMismatch = () => {
    if (!engineLoad()) return
    stopLoaded()
    toast('Spotify запустил другой трек. Нажмите «Воспроизвести», чтобы повторить попытку.', 'error')
  }
  const addToHistory = (t: Track) => {
    if (get().history[0]?.key === t.key) return
    const history = [t, ...get().history.filter((h) => h.key !== t.key)].slice(0, 200)
    set({ history })
    historySaver.save(history)
  }

  engine.on('time', () => {
    const load = engineLoad()
    if (!load) return
    const st = get()
    const position = engine.position
    const duration = engine.duration || st.current?.duration || 0
    const buffered = engine.buffered
    if (position !== st.position || duration !== st.duration || buffered !== st.buffered) {
      set({ position, duration, buffered })
    }
    const cur = st.current
    if (!cur || cur.key !== heard.key) return
    if (engine.playing) {
      heard.seconds += heardBetween(heard.last, position)
      if (load.retried && !engine.waiting && (heard.seconds > 2 || Math.abs(position - load.startAt) > 2)) {
        load.retried = false
      }
    }
    heard.last = position
    if (!heard.recorded && heardEnough(heard.seconds, duration)) {
      heard.recorded = true
      addToHistory(cur)
    }
    const crossfade = useSettings.getState().crossfade ?? 0
    const realDur = engine.duration
    if (
      crossfade > 0 &&
      load.autoplay &&
      engine.playing &&
      serviceOf(cur) !== 'spotify' &&
      get().repeat !== 'one' &&
      realDur >= Math.max(15, crossfade * 2)
    ) {
      const rem = realDur - position
      if (rem > 0.15 && rem <= crossfade) {
        const nextTrack = nextPreloadTarget(get().queue)
        if (nextTrack && serviceOf(nextTrack) !== 'spotify') {
          // Keep current track on screen during the initial pre-fade tail; switch UI only in the final ~1.2s
          const handoffSec = Math.min(1.5, Math.max(0.9, crossfade * 0.4))
          if (rem > handoffSec) {
            const t = Math.min(1, Math.max(0, (crossfade - rem) / Math.max(0.1, crossfade - handoffSec)))
            const smooth = t * t * (3 - 2 * t)
            engine.setPreFade?.(1 - smooth * 0.42)
          } else {
            const overlapSec = Math.min(2.4, Math.max(1.2, crossfade * 0.6))
            advance(false, true, Math.min(overlapSec, Math.max(0.4, rem)))
          }
        } else {
          engine.setPreFade?.(1)
        }
      } else {
        engine.setPreFade?.(1)
      }
    } else {
      engine.setPreFade?.(1)
    }
  })
  engine.on('state', () => {
    if (engineLoad()) set({ isPlaying: engine.playing })
  })
  engine.on('loading', () => {
    const load = engineLoad()
    if (!load) return
    const waiting = engine.waiting
    set({ isLoading: load.autoplay && waiting })
    const cur = get().current
    if (!waiting && engine.playing && cur) {
      consecutiveFailures = 0
      stopScWatch()
      if (load.retried && (heard.seconds > 2 || engine.position > load.startAt + 2)) {
        load.retried = false
      }
    }
  })
  engine.on('buffered', () => {
    if (!engineLoad()) return
    currentFullyLoaded = true
    syncPreload()
  })
  engine.on('ended', () => {
    if (!engineLoad()?.autoplay) return
    const { queue, source } = get()
    if (source?.kind === 'mix' && queue && !Q.next(queue, isPlayable, false)) {
      const wanted = pendingAdvance
      stopLoaded()
      set({ position: 0, buffered: 0 })
      pendingAdvance = wanted
    }
    advance(false, true)
  })
  engine.on('error', () => {
    const load = engineLoad()
    const t = get().current
    if (!t || !load) return
    const service = serviceOf(t)
    const detail = (engine.lastError || 'unknown').replace(/\b(?:https?|blob|data):\S+/gi, '[url]')
    const blocked = engine.lastErrorKind === 'blocked'
    const outcome = blocked || (load.retried && service === 'spotify') ? 'kept selection' : load.retried ? 'advance after failure' : 'retrying current track'
    journal('player', `${service}: playback error at queue position ${(get().queue?.pos ?? 0) + 1}: ${detail} (${outcome})`)
    if (blocked) {
      stopLoaded()
      toast('Воспроизведение не запустилось. Нажмите «Воспроизвести», чтобы повторить попытку.', 'error')
      return
    }
    if (!load.retried) {
      clearPreload()
      void loadCurrent(load.autoplay, engine.position, true)
      return
    }
    onFailure(t, undefined, load.autoplay)
  })

  return {
    queue: null,
    current: null,
    source: null,
    isPlaying: false,
    isLoading: false,
    position: 0,
    duration: 0,
    buffered: 0,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'off',
    history: [],
    remoteName: null,
    remoteNear: null,

    playList(tracks, index, opts) {
      if (remote) return remote.playList(tracks, index, opts)
      if (!tracks.length || !allow('pick')) return
      const shuffle = opts?.shuffle ?? get().shuffle
      const start = opts?.shuffle ? Math.floor(Math.random() * tracks.length) : index
      let queue = Q.createQueue(tracks, start, shuffle, get().repeat)
      const first = Q.current(queue)
      if (first && !first.playable) {
        const n = Q.next(queue, isPlayable, true) ?? Q.next({ ...queue, repeat: 'all' }, isPlayable, true)
        if (!n) {
          toast('В этом списке нет доступных треков', 'error')
          return
        }
        queue = { ...n, repeat: queue.repeat }
      }
      selectionToken++
      queueSession++
      pendingAdvance = null
      extendInFlight = null
      consecutiveFailures = 0
      set({ queue, shuffle, source: opts?.source ?? { kind: 'list' } })
      void loadCurrent(!opts?.paused, opts?.startAt ?? 0)
    },

    async playMix(service: 'vk' | 'spotify' = 'vk') {
      if (remote) return remote.playMix()
      const token = ++selectionToken
      if (service === 'spotify') {
        try {
          const sp = await import('../spotify/api')
          const tracks = await sp.getSpotifyMix()
          if (token !== selectionToken) return
          if (!tracks.length) {
            toast('Не удалось подобрать треки для Spotify Микс', 'error')
            return
          }
          get().playList(tracks, 0, { shuffle: false, source: { kind: 'mix', label: 'Spotify Микс', service: 'spotify' } })
        } catch (e) {
          if (token === selectionToken) toast(e instanceof Error ? e.message : 'Не удалось запустить Spotify Микс', 'error')
        }
        return
      }
      try {
        const tracks = await vk.getStreamMix(20)
        if (token !== selectionToken) return
        get().playList(tracks, 0, { shuffle: false, source: { kind: 'mix', label: 'VK Микс', service: 'vk' } })
      } catch (e) {
        if (token !== selectionToken) return
        const { describeError } = await import('../vk/errors')
        toast(describeError(e), 'error')
      }
    },

    async playRadio(track) {
      if (remote) return
      const id = track.spotifyId
      if (!id) {
        await get().playMix('vk')
        return
      }
      const token = ++selectionToken
      try {
        const sp = await import('../spotify/api')
        const radio = await sp.getTrackRadio(`spotify:track:${id}`)
        if (token !== selectionToken) return
        const list = dedupeAppend([track], radio)
        get().playList([track, ...list], 0, {
          shuffle: false,
          source: { kind: 'mix', label: `Радио · ${track.title}`, service: 'spotify', seed: `spotify:track:${id}` },
        })
      } catch (e) {
        if (token === selectionToken) toast(e instanceof Error ? e.message : 'Не удалось запустить радио по треку', 'error')
      }
    },

    toggle() {
      if (remote) return remote.toggle()
      if (!get().current) return
      const waitingNext = pendingAdvance?.session === queueSession ? pendingAdvance : null
      const playing = (waitingNext && !engine.playing ? waitingNext.autoplay : currentLoad()?.autoplay) ?? false
      if (allow(playing ? 'pause' : 'resume')) setPlayback(!playing)
    },

    play() {
      if (remote) return remote.play()
      if (get().current && allow('resume')) setPlayback(true)
    },

    pause() {
      if (remote) return remote.pause()
      if (allow('pause')) setPlayback(false)
    },

    next(manual = true, autoplay = true) {
      if (remote) return remote.next()
      advance(manual, autoplay)
    },

    prev(always = false) {
      if (remote) return remote.prev(always)
      const q = get().queue
      if (!q || !allow('skip')) return
      pendingAdvance = null
      if (!always && prevAction(livePosition()) === 'restart') {
        get().seek(0)
        return
      }
      const p = Q.prev(q, isPlayable)
      if (!p) {
        get().seek(0)
        return
      }
      set({ queue: p })
      void loadCurrent(true)
    },

    seek(sec) {
      if (!Number.isFinite(sec)) return
      sec = Math.max(0, sec)
      if (remote) {
        set({ position: sec })
        return remote.seek(sec)
      }
      const cur = get().current
      if (!cur || !allow('seek')) return
      const load = currentLoad()
      if (load?.attached) engine.seek(sec)
      else if (load) load.startAt = sec
      set({ position: sec })
    },

    seekBy(delta) {
      const d = get().duration || get().current?.duration || 0
      const target = Math.max(0, livePosition() + delta)
      get().seek(d > 0 ? Math.min(target, Math.max(0, d - 1)) : target)
    },

    setVolume(v) {
      if (!Number.isFinite(v)) return
      const volume = Math.min(1, Math.max(0, v))
      if (remote) {
        set({ volume })
        return remote.setVolume(volume)
      }
      volumeModified = true
      set({ volume, muted: volume === 0 ? get().muted : false })
      engine.setVolume(volume, get().muted)
    },

    nudgeVolume(delta) {
      get().setVolume(get().volume + delta)
    },

    toggleMute() {
      if (remote) return
      volumeModified = true
      const muted = !get().muted
      set({ muted })
      engine.setVolume(get().volume, muted)
    },

    toggleShuffle() {
      if (remote) return remote.toggleShuffle()
      if (!allow('mode')) return
      const shuffle = !get().shuffle
      const q = get().queue
      set({ shuffle, queue: q ? Q.setShuffle(q, shuffle) : q })
      syncPreload()
    },

    cycleRepeat() {
      if (remote) return remote.cycleRepeat()
      if (!allow('mode')) return
      const order: Q.RepeatMode[] = ['off', 'all', 'one']
      const repeat = order[(order.indexOf(get().repeat) + 1) % order.length]
      const q = get().queue
      set({ repeat, queue: q ? { ...q, repeat } : q })
      syncPreload()
    },

    playNext(tracks) {
      if (remote) return toast('Очередь на другом устройстве отсюда пока не меняется', 'info')
      const q = get().queue
      if (!q || !q.order.length) return get().playList(tracks, 0)
      set({ queue: Q.insertNext(q, tracks) })
      syncPreload()
      toast(tracks.length > 1 ? `${tracks.length} треков будут следующими` : 'Будет следующим', 'queue')
    },

    addToQueue(tracks) {
      if (remote) return toast('Очередь на другом устройстве отсюда пока не меняется', 'info')
      const q = get().queue
      if (!q || !q.order.length) return get().playList(tracks, 0)
      set({ queue: Q.append(q, tracks) })
      syncPreload()
      toast('Добавлено в очередь', 'queue')
    },

    removeFromQueue(orderPos) {
      if (remote) return
      const q = get().queue
      if (!q) return
      const wasCurrent = orderPos === q.pos
      const autoplay = currentLoad()?.autoplay ?? false
      const n = Q.removeAt(q, orderPos)
      set({ queue: n.order.length ? n : null })
      if (wasCurrent || !n.order.length) {
        pendingAdvance = null
        void loadCurrent(autoplay)
      }
      else syncPreload()
    },

    moveInQueue(from, to) {
      if (remote) return
      const q = get().queue
      if (q) {
        set({ queue: Q.move(q, from, to) })
        syncPreload()
      }
    },

    playNextFromQueue(orderPos) {
      if (remote) return
      const q = get().queue
      if (!q || orderPos === q.pos) return
      set({ queue: Q.moveNext(q, orderPos) })
      syncPreload()
      toast('Будет следующим', 'queue')
    },

    jumpTo(orderPos) {
      if (remote) return
      const q = get().queue
      if (!q || orderPos < 0 || orderPos >= q.order.length || !allow('pick')) return
      pendingAdvance = null
      set({ queue: { ...q, pos: orderPos } })
      void loadCurrent(true)
    },

    updateTrack(key, patch) {
      const q = get().queue
      const cur = get().current
      set({
        queue: q ? { ...q, items: q.items.map((t) => (t.key === key ? { ...t, ...patch } : t)) } : q,
        current: cur && cur.key === key ? { ...cur, ...patch } : cur,
        history: get().history.map((t) => (t.key === key ? { ...t, ...patch } : t)),
      })
    },
  }
})

function snapshot(): SavedSession | null {
  const s = usePlayer.getState()
  const q = s.queue
  if (!q || !s.current) return null
  const from = Math.max(0, q.pos - 50)
  const ordered = q.order.slice(from, q.pos + 300).map((i) => q.items[i])
  return {
    tracks: ordered,
    pos: q.pos - from,
    position: s.position,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
    source: s.source,
  }
}

const isValidSavedTrack = (t: unknown): t is Track =>
  Boolean(t && typeof t === 'object' && typeof (t as Track).key === 'string' && typeof (t as Track).id === 'number')

/** Restores the last session (paused) and starts persisting changes. Call once. */
export async function initPlayer() {
  const [saved, history] = await Promise.all([loadJSON<SavedSession>('session'), loadJSON<Track[]>('history')])
  if (Array.isArray(history)) {
    const validHistory = history.filter(isValidSavedTrack)
    if (validHistory.length) {
      const existing = usePlayer.getState().history
      const seen = new Set(existing.map((h) => h.key))
      const merged = [...existing, ...validHistory.filter((h) => !seen.has(h.key))].slice(0, 200)
      usePlayer.setState({ history: merged })
    }
  }
  const restoredVolume = Number.isFinite(saved?.volume) ? Math.min(1, Math.max(0, saved!.volume)) : undefined
  const restoredMuted = typeof saved?.muted === 'boolean' ? saved.muted : undefined
  if (!volumeModified && !remote && (restoredVolume !== undefined || restoredMuted !== undefined)) {
    usePlayer.setState({
      ...(restoredVolume !== undefined ? { volume: restoredVolume } : {}),
      ...(restoredMuted !== undefined ? { muted: restoredMuted } : {}),
    })
  }
  const st = usePlayer.getState()
  const validTracks = Array.isArray(saved?.tracks) ? saved.tracks.filter(isValidSavedTrack) : []
  // The app can already accept playback commands while the persisted state is being read.
  if (!st.queue && !st.current && !remote && validTracks.length && saved) {
    const repeat = saved.repeat === 'one' || saved.repeat === 'all' ? saved.repeat : 'off'
    const index = Number.isFinite(saved.pos) ? Math.trunc(saved.pos) : 0
    const queue = Q.createQueue(validTracks, index, false, repeat)
    const track = Q.current(queue)
    usePlayer.setState({
      queue: { ...queue, shuffle: saved.shuffle === true },
      current: track,
      position: Number.isFinite(saved.position) ? Math.max(0, saved.position) : 0,
      duration: track?.duration ?? 0,
      shuffle: saved.shuffle === true,
      repeat,
      source: saved.source,
    })
  }
  engine.setVolume(usePlayer.getState().volume ?? st.volume, usePlayer.getState().muted)

  let lastKey = ''
  let lastSave = 0
  usePlayer.subscribe((s, prev) => {
    // what another device plays is never saved as this device's session
    if (remote) return
    const now = Date.now()
    const important = s.current?.key !== lastKey || s.isPlaying !== prev.isPlaying || s.queue !== prev.queue || s.volume !== prev.volume || s.muted !== prev.muted || s.repeat !== prev.repeat
    if (important || now - lastSave > 15000) {
      lastKey = s.current?.key ?? ''
      lastSave = now
      const snap = snapshot()
      if (snap || prev.current) sessionSaver.save(snap)
    }
  })
  window.addEventListener('beforeunload', () => {
    if (!remote) sessionSaver.save(snapshot())
    sessionSaver.flush()
    historySaver.flush()
  })
}
