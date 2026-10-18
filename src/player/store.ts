import { create } from 'zustand'
import { toast } from '../app/toast'
import { journal } from '../lib/journal'
import { debouncedSaver, loadJSON } from '../lib/persist'
import * as sc from '../sc/api'
import { describeScError, SC_UNREACHABLE, ScApiError } from '../sc/errors'
import * as vk from '../vk/api'
import { serviceOf, type Track } from '../vk/models'
import { engine } from './engine'
import { dedupeAppend, heardBetween, heardEnough, needsFreshUrl, prevAction } from './logic'
import * as Q from './queue'
import { beginWaveform, captureSource } from './waveform'

export interface QueueSource {
  kind: 'list' | 'mix'
  label?: string
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
  playMix(): Promise<void>
  toggle(): void
  play(): void
  pause(): void
  next(manual?: boolean): void
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
  return current && loadedKey === current.key ? engine.position : position
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
    loadToken++
    loadedKey = null
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

/** Warm the image cache for the next track so the queue card and player swap covers instantly. */
function preloadCovers(t: Track | undefined) {
  if (typeof Image === 'undefined' || !t?.cover) return
  for (const src of [t.cover.m, t.cover.l]) if (src) new Image().src = src
}
let loadToken = 0
let loadedKey: string | null = null
/** Without a VPN, SoundCloud's stream hosts in Russia take the connection and send nothing. */
export const SC_START_TIMEOUT_MS = 15_000
let scWatch: ReturnType<typeof setTimeout> | undefined
const stopScWatch = () => clearTimeout(scWatch)
let consecutiveFailures = 0
/** How much of the current load was really heard: it reaches «Недавние» only past half. */
let heard = { key: '', seconds: 0, last: 0, recorded: false }
const retried = new Set<string>()
const sessionSaver = debouncedSaver('session', 1200)
const historySaver = debouncedSaver('history', 2000)

export const usePlayer = create<PlayerState>((set, get) => {
  const replaceTrack = (track: Track) => {
    const q = get().queue
    if (!q) return
    const items = q.items.map((t) => (t.key === track.key ? track : t))
    const cur = get().current
    set({ queue: { ...q, items }, current: cur && cur.key === track.key ? track : cur })
  }

  const extendMixIfNeeded = async () => {
    const { source, queue } = get()
    if (source?.kind !== 'mix' || !queue || Q.upcoming(queue).length > 3) return
    try {
      const more = dedupeAppend(queue.items, await vk.getStreamMix(20))
      const q = get().queue
      if (q && more.length) set({ queue: Q.append(q, more) })
    } catch {
      // the mix simply ends when VK stops answering
    }
  }

  /** A SoundCloud stream that has not started this long after loading is not going to. */
  const watchScStart = (token: number, t: Track) => {
    stopScWatch()
    scWatch = setTimeout(() => {
      if (token !== loadToken || remote || get().current?.key !== t.key) return
      journal('player', 'soundcloud stream did not start')
      engine.stop()
      loadedKey = null
      onFailure(t, SC_UNREACHABLE)
    }, SC_START_TIMEOUT_MS)
  }

  /** Why a SoundCloud track got no stream link, in the person's words. */
  const scLinkFailure = (e: unknown): string => {
    const err = ScApiError.from(e)
    if (err.kind === 'signedOut') return 'Войдите в SoundCloud, чтобы слушать этот трек'
    if (err.kind === 'invalid') return 'Доступно только в SoundCloud'
    if (err.kind === 'http') return describeScError(err)
    return SC_UNREACHABLE
  }

  const loadCurrent = async (autoplay: boolean, startAt = 0) => {
    const q = get().queue
    const t = q && Q.current(q)
    const token = ++loadToken
    stopScWatch()
    if (!t) {
      engine.stop()
      loadedKey = null
      set({ current: null, isPlaying: false, isLoading: false })
      return
    }
    set({ current: t, position: startAt, duration: t.duration, buffered: 0, isLoading: autoplay })
    heard = { key: t.key, seconds: 0, last: startAt, recorded: false }
    preloadCovers(Q.upcoming(q)[0])
    let track = t
    if (needsFreshUrl(t, Date.now()) && serviceOf(t) === 'sc') {
      try {
        const url = await sc.streamUrl(t)
        if (token !== loadToken) return
        track = { ...t, url, urlFetchedAt: Date.now() }
        replaceTrack(track)
      } catch (e) {
        if (token !== loadToken) return
        onFailure(t, scLinkFailure(e))
        return
      }
    } else if (needsFreshUrl(t, Date.now())) {
      try {
        const [fresh] = await vk.getByIds([t])
        if (token !== loadToken) return
        if (fresh) {
          track = { ...t, url: fresh.url, urlFetchedAt: fresh.urlFetchedAt, playable: fresh.playable, liked: fresh.liked || t.liked }
          replaceTrack(track)
        }
      } catch {
        if (token !== loadToken) return
      }
    }
    if (!track.url || !track.playable) {
      onFailure(track, 'Трек недоступен в вашем регионе или удалён')
      return
    }
    if (remote) return
    loadedKey = track.key
    beginWaveform(track.key, track.duration)
    engine.load(track.url, startAt, autoplay)
    if (autoplay && serviceOf(track) === 'sc') watchScStart(token, track)
    void extendMixIfNeeded()
  }

  const onFailure = (t: Track, reason?: string) => {
    consecutiveFailures++
    if (consecutiveFailures >= 5) {
      journal('player', 'five tracks in a row failed, stopping')
      consecutiveFailures = 0
      engine.stop()
      loadedKey = null
      set({ isPlaying: false, isLoading: false })
      toast(serviceOf(t) === 'sc' ? 'SoundCloud не отдаёт звук — без VPN он в России не играет' : 'VK не отдаёт треки. Проверьте интернет и подписку', 'error')
      return
    }
    toast(reason ?? `Не получилось включить «${t.title}»`, 'error')
    get().next(true)
  }

  // Engine → store
  engine.onSource = captureSource
  const addToHistory = (t: Track) => {
    if (get().history[0]?.key === t.key) return
    const history = [t, ...get().history.filter((h) => h.key !== t.key)].slice(0, 200)
    set({ history })
    historySaver.save(history)
  }

  engine.on('time', () => {
    if (remote) return
    const position = engine.position
    const duration = engine.duration || get().current?.duration || 0
    set({ position, duration, buffered: engine.buffered })
    const cur = get().current
    if (!cur || cur.key !== heard.key) return
    if (engine.playing) heard.seconds += heardBetween(heard.last, position)
    heard.last = position
    if (!heard.recorded && heardEnough(heard.seconds, duration)) {
      heard.recorded = true
      addToHistory(cur)
    }
  })
  engine.on('state', () => !remote && set({ isPlaying: engine.playing }))
  engine.on('loading', () => {
    if (remote) return
    const waiting = engine.waiting
    set({ isLoading: waiting })
    const cur = get().current
    if (!waiting && engine.playing && cur) {
      consecutiveFailures = 0
      stopScWatch()
    }
  })
  engine.on('ended', () => !remote && get().next(false))
  engine.on('error', () => {
    if (remote) return
    const t = get().current
    if (!t) return
    journal('player', `playback error: ${engine.lastError || 'unknown'}${retried.has(t.key) ? ', skipping track' : ', retrying with a fresh link'}`)
    if (!retried.has(t.key)) {
      retried.add(t.key)
      replaceTrack({ ...t, urlFetchedAt: 0 })
      void loadCurrent(true, engine.position)
      return
    }
    onFailure(t)
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
      const queue = Q.createQueue(tracks, start, shuffle, get().repeat)
      consecutiveFailures = 0
      set({ queue, shuffle, source: opts?.source ?? { kind: 'list' } })
      const first = Q.current(queue)
      if (first && !first.playable) {
        const n = Q.next(queue, isPlayable, true)
        if (!n) {
          toast('В этом списке нет доступных треков', 'error')
          return
        }
        set({ queue: n })
      }
      void loadCurrent(!opts?.paused, opts?.startAt ?? 0)
    },

    async playMix() {
      if (remote) return remote.playMix()
      try {
        const tracks = await vk.getStreamMix(20)
        get().playList(tracks, 0, { shuffle: false, source: { kind: 'mix', label: 'VK Микс' } })
      } catch (e) {
        const { describeError } = await import('../vk/errors')
        toast(describeError(e), 'error')
      }
    },

    toggle() {
      if (remote) return remote.toggle()
      const cur = get().current
      if (!cur) return
      if (!allow(loadedKey === cur.key && engine.playing ? 'pause' : 'resume')) return
      if (loadedKey !== cur.key) {
        void loadCurrent(true, get().position)
        return
      }
      if (engine.playing) {
        stopScWatch()
        engine.pause()
      } else engine.play()
    },

    play() {
      if (remote) return remote.play()
      const cur = get().current
      if (!cur || !allow('resume')) return
      if (loadedKey !== cur.key) void loadCurrent(true, get().position)
      else engine.play()
    },

    pause() {
      if (remote) return remote.pause()
      if (!allow('pause')) return
      stopScWatch()
      engine.pause()
    },

    next(manual = true) {
      if (remote) return remote.next()
      const q = get().queue
      if (!q || (manual && !allow('skip'))) return
      const n = Q.next(q, isPlayable, manual)
      if (!n) {
        if (get().source?.kind === 'mix') {
          void extendMixIfNeeded().then(() => {
            const q2 = get().queue
            const n2 = q2 && Q.next(q2, isPlayable, true)
            if (n2) {
              set({ queue: n2 })
              void loadCurrent(true)
            }
          })
          return
        }
        engine.pause()
        engine.seek(0)
        return
      }
      if (n === q) {
        engine.seek(0)
        engine.play()
        return
      }
      set({ queue: n })
      void loadCurrent(true)
    },

    prev(always = false) {
      if (remote) return remote.prev(always)
      const q = get().queue
      if (!q || !allow('skip')) return
      if (!always && prevAction(engine.position) === 'restart') {
        engine.seek(0)
        return
      }
      const p = Q.prev(q, isPlayable)
      if (!p) {
        engine.seek(0)
        return
      }
      set({ queue: p })
      void loadCurrent(true)
    },

    seek(sec) {
      if (remote) {
        set({ position: sec })
        return remote.seek(sec)
      }
      const cur = get().current
      if (!cur || !allow('seek')) return
      if (loadedKey !== cur.key) {
        set({ position: sec })
        return
      }
      engine.seek(sec)
      set({ position: sec })
    },

    seekBy(delta) {
      const d = get().duration || get().current?.duration || 0
      get().seek(Math.min(Math.max(0, livePosition() + delta), Math.max(0, d - 1)))
    },

    setVolume(v) {
      const volume = Math.min(1, Math.max(0, v))
      if (remote) {
        set({ volume })
        return remote.setVolume(volume)
      }
      set({ volume, muted: volume === 0 ? get().muted : false })
      engine.setVolume(volume, get().muted)
    },

    nudgeVolume(delta) {
      get().setVolume(get().volume + delta)
    },

    toggleMute() {
      if (remote) return
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
    },

    cycleRepeat() {
      if (remote) return remote.cycleRepeat()
      if (!allow('mode')) return
      const order: Q.RepeatMode[] = ['off', 'all', 'one']
      const repeat = order[(order.indexOf(get().repeat) + 1) % order.length]
      const q = get().queue
      set({ repeat, queue: q ? { ...q, repeat } : q })
    },

    playNext(tracks) {
      if (remote) return toast('Очередь на другом устройстве отсюда пока не меняется', 'info')
      const q = get().queue
      if (!q) return get().playList(tracks, 0)
      set({ queue: Q.insertNext(q, tracks) })
      toast(tracks.length > 1 ? `${tracks.length} треков будут следующими` : 'Будет следующим', 'queue')
    },

    addToQueue(tracks) {
      if (remote) return toast('Очередь на другом устройстве отсюда пока не меняется', 'info')
      const q = get().queue
      if (!q) return get().playList(tracks, 0)
      set({ queue: Q.append(q, tracks) })
      toast('Добавлено в очередь', 'queue')
    },

    removeFromQueue(orderPos) {
      if (remote) return
      const q = get().queue
      if (!q) return
      const wasCurrent = orderPos === q.pos
      const n = Q.removeAt(q, orderPos)
      set({ queue: n })
      if (wasCurrent) void loadCurrent(engine.playing)
    },

    moveInQueue(from, to) {
      if (remote) return
      const q = get().queue
      if (q) set({ queue: Q.move(q, from, to) })
    },

    playNextFromQueue(orderPos) {
      if (remote) return
      const q = get().queue
      if (!q || orderPos === q.pos) return
      set({ queue: Q.moveNext(q, orderPos) })
      toast('Будет следующим', 'queue')
    },

    jumpTo(orderPos) {
      if (remote) return
      const q = get().queue
      if (!q || orderPos < 0 || orderPos >= q.order.length || !allow('pick')) return
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

/** Restores the last session (paused) and starts persisting changes. Call once. */
export async function initPlayer() {
  const [saved, history] = await Promise.all([loadJSON<SavedSession>('session'), loadJSON<Track[]>('history')])
  const st = usePlayer.getState()
  if (history?.length) usePlayer.setState({ history })
  if (saved?.tracks?.length) {
    const queue = Q.createQueue(saved.tracks, saved.pos, false, saved.repeat)
    usePlayer.setState({
      queue: { ...queue, shuffle: saved.shuffle },
      current: Q.current(queue),
      position: saved.position,
      duration: Q.current(queue)?.duration ?? 0,
      volume: saved.volume,
      muted: saved.muted,
      shuffle: saved.shuffle,
      repeat: saved.repeat,
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
    const important = s.current?.key !== lastKey || s.isPlaying !== prev.isPlaying || s.queue !== prev.queue || s.volume !== prev.volume || s.repeat !== prev.repeat
    if (important || now - lastSave > 15000) {
      lastKey = s.current?.key ?? ''
      lastSave = now
      const snap = snapshot()
      if (snap) sessionSaver.save(snap)
    }
  })
  window.addEventListener('beforeunload', () => {
    const snap = snapshot()
    if (snap) sessionSaver.save(snap)
    sessionSaver.flush()
    historySaver.flush()
  })
}
