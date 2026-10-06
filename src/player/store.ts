import { create } from 'zustand'
import { toast } from '../app/toast'
import { debouncedSaver, loadJSON } from '../lib/persist'
import * as vk from '../vk/api'
import type { Track } from '../vk/models'
import { engine } from './engine'
import { dedupeAppend, needsFreshUrl, prevAction } from './logic'
import * as Q from './queue'

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

  playList(tracks: Track[], index: number, opts?: { shuffle?: boolean; source?: QueueSource }): void
  playMix(): Promise<void>
  toggle(): void
  play(): void
  pause(): void
  next(manual?: boolean): void
  prev(): void
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
  jumpTo(orderPos: number): void
  updateTrack(key: string, patch: Partial<Track>): void
}

const isPlayable = (t: Track) => t.playable
let loadToken = 0
let loadedKey: string | null = null
let consecutiveFailures = 0
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

  const loadCurrent = async (autoplay: boolean, startAt = 0) => {
    const q = get().queue
    const t = q && Q.current(q)
    const token = ++loadToken
    if (!t) {
      engine.stop()
      loadedKey = null
      set({ current: null, isPlaying: false, isLoading: false })
      return
    }
    set({ current: t, position: startAt, duration: t.duration, buffered: 0, isLoading: autoplay })
    let track = t
    if (needsFreshUrl(t, Date.now())) {
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
    loadedKey = track.key
    engine.load(track.url, startAt, autoplay)
    void extendMixIfNeeded()
  }

  const onFailure = (t: Track, reason?: string) => {
    consecutiveFailures++
    if (consecutiveFailures >= 5) {
      consecutiveFailures = 0
      engine.stop()
      loadedKey = null
      set({ isPlaying: false, isLoading: false })
      toast('VK не отдаёт треки. Проверьте интернет и подписку', 'error')
      return
    }
    toast(reason ?? `Не получилось включить «${t.title}»`, 'error')
    get().next(true)
  }

  // Engine → store
  engine.on('time', () => set({ position: engine.position, duration: engine.duration || get().current?.duration || 0, buffered: engine.buffered }))
  engine.on('state', () => set({ isPlaying: engine.playing }))
  engine.on('loading', () => {
    const waiting = engine.waiting
    set({ isLoading: waiting })
    const cur = get().current
    if (!waiting && engine.playing && cur) {
      consecutiveFailures = 0
      const history = [cur, ...get().history.filter((h) => h.key !== cur.key)].slice(0, 200)
      if (get().history[0]?.key !== cur.key) {
        set({ history })
        historySaver.save(history)
      }
    }
  })
  engine.on('ended', () => get().next(false))
  engine.on('error', () => {
    const t = get().current
    if (!t) return
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

    playList(tracks, index, opts) {
      if (!tracks.length) return
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
      void loadCurrent(true)
    },

    async playMix() {
      try {
        const tracks = await vk.getStreamMix(20)
        get().playList(tracks, 0, { shuffle: false, source: { kind: 'mix', label: 'VK Микс' } })
      } catch (e) {
        const { describeError } = await import('../vk/errors')
        toast(describeError(e), 'error')
      }
    },

    toggle() {
      const cur = get().current
      if (!cur) return
      if (loadedKey !== cur.key) {
        void loadCurrent(true, get().position)
        return
      }
      if (engine.playing) engine.pause()
      else engine.play()
    },

    play() {
      const cur = get().current
      if (!cur) return
      if (loadedKey !== cur.key) void loadCurrent(true, get().position)
      else engine.play()
    },

    pause() {
      engine.pause()
    },

    next(manual = true) {
      const q = get().queue
      if (!q) return
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

    prev() {
      const q = get().queue
      if (!q) return
      if (prevAction(engine.position) === 'restart') {
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
      const cur = get().current
      if (!cur) return
      if (loadedKey !== cur.key) {
        set({ position: sec })
        return
      }
      engine.seek(sec)
      set({ position: sec })
    },

    seekBy(delta) {
      const d = get().duration || get().current?.duration || 0
      get().seek(Math.min(Math.max(0, engine.position + delta), Math.max(0, d - 1)))
    },

    setVolume(v) {
      const volume = Math.min(1, Math.max(0, v))
      set({ volume, muted: volume === 0 ? get().muted : false })
      engine.setVolume(volume, get().muted)
    },

    nudgeVolume(delta) {
      get().setVolume(get().volume + delta)
    },

    toggleMute() {
      const muted = !get().muted
      set({ muted })
      engine.setVolume(get().volume, muted)
    },

    toggleShuffle() {
      const shuffle = !get().shuffle
      const q = get().queue
      set({ shuffle, queue: q ? Q.setShuffle(q, shuffle) : q })
    },

    cycleRepeat() {
      const order: Q.RepeatMode[] = ['off', 'all', 'one']
      const repeat = order[(order.indexOf(get().repeat) + 1) % order.length]
      const q = get().queue
      set({ repeat, queue: q ? { ...q, repeat } : q })
    },

    playNext(tracks) {
      const q = get().queue
      if (!q) return get().playList(tracks, 0)
      set({ queue: Q.insertNext(q, tracks) })
      toast(tracks.length > 1 ? `${tracks.length} треков будут следующими` : 'Будет следующим', 'queue')
    },

    addToQueue(tracks) {
      const q = get().queue
      if (!q) return get().playList(tracks, 0)
      set({ queue: Q.append(q, tracks) })
      toast('Добавлено в очередь', 'queue')
    },

    removeFromQueue(orderPos) {
      const q = get().queue
      if (!q) return
      const wasCurrent = orderPos === q.pos
      const n = Q.removeAt(q, orderPos)
      set({ queue: n })
      if (wasCurrent) void loadCurrent(engine.playing)
    },

    moveInQueue(from, to) {
      const q = get().queue
      if (q) set({ queue: Q.move(q, from, to) })
    },

    jumpTo(orderPos) {
      const q = get().queue
      if (!q || orderPos < 0 || orderPos >= q.order.length) return
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
