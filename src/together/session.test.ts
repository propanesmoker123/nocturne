import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  toasts: [] as { text: string; action?: { label: string } }[],
  guard: null as ((intent: string) => boolean) | null,
}))

vi.mock('../player/store', async () => {
  const { create } = await import('zustand')
  const allow = (intent: string) => !h.guard || h.guard(intent)
  interface P {
    current: Track | null
    isPlaying: boolean
    isLoading: boolean
    position: number
    playList(tracks: Track[], i: number, opts?: { startAt?: number; paused?: boolean }): void
    play(): void
    pause(): void
    seek(s: number): void
    next(manual?: boolean): void
  }
  const usePlayer = create<P>((set) => ({
    current: null,
    isPlaying: false,
    isLoading: false,
    position: 0,
    playList(tracks, _i, opts) {
      if (!allow('pick')) return
      h.calls.push(`playList ${tracks[0].key} at=${Math.round(opts?.startAt ?? 0)} ${opts?.paused ? 'paused' : 'playing'}`)
      set({ current: tracks[0], isPlaying: !opts?.paused, position: opts?.startAt ?? 0 })
    },
    play() {
      if (!allow('resume')) return
      h.calls.push('play')
      set({ isPlaying: true })
    },
    pause() {
      if (!allow('pause')) return
      h.calls.push('pause')
      set({ isPlaying: false })
    },
    seek(s) {
      if (!allow('seek')) return
      h.calls.push(`seek ${Math.round(s)}`)
      set({ position: s })
    },
    next() {
      if (!allow('skip')) return
      h.calls.push('next')
    },
  }))
  return {
    usePlayer,
    setPlayerGuard: (g: typeof h.guard) => void (h.guard = g),
    livePosition: () => usePlayer.getState().position,
  }
})
vi.mock('../app/session', () => ({ useSession: { getState: () => ({ user: { id: 1, name: 'Дима Иванов' } }) } }))
vi.mock('../app/toast', () => ({ toast: (text: string, _icon?: string, action?: { label: string }) => void h.toasts.push({ text, action }) }))
vi.mock('../lib/journal', () => ({ journal: () => {} }))
vi.mock('../vk/api', () => ({
  getByIds: async ([w]: { ownerId: number; id: number }[]) => [trackOf(w.ownerId, w.id)],
  searchTracks: async () => ({ count: 0, items: [] }),
}))

function trackOf(owner: number, id: number): Track {
  return {
    id,
    ownerId: owner,
    key: `${owner}_${id}`,
    artist: 'Северный ветер',
    title: 'Ночной город',
    duration: 214,
    url: 'https://example/x.m3u8',
    urlFetchedAt: 1,
    explicit: false,
    artists: [],
    playable: true,
    hasLyrics: false,
    liked: false,
  }
}

const { usePlayer } = await import('../player/store')
const { joinSession, leaveSession, setTransportFactory, startHosting, useTogether } = await import('./session')
type Events = Parameters<Parameters<typeof setTransportFactory>[0]>[1]

let ev: Events
let sent: { msg: { type: string } & Record<string, unknown>; to?: string }[]
let kicked: string[]
let left: boolean
let relays: boolean

beforeEach(() => {
  vi.useFakeTimers()
  h.calls.length = 0
  h.toasts.length = 0
  sent = []
  kicked = []
  left = false
  relays = true
  usePlayer.setState({ current: null, isPlaying: false, isLoading: false, position: 0 })
  setTransportFactory(async (_opts, events) => {
    ev = events
    return {
      send: (msg, to) => void sent.push({ msg: msg as never, to }),
      relaysUp: async () => relays,
      kick: (peer) => void kicked.push(peer),
      leave: () => void (left = true),
    }
  })
})

afterEach(() => {
  leaveSession()
  useTogether.setState({ error: null })
  vi.useRealTimers()
})

const sentTo = (peer: string, type: string) => sent.filter((s) => s.to === peer && s.msg.type === type).map((s) => s.msg)
const sentAll = (type: string) => sent.filter((s) => !s.to && s.msg.type === type).map((s) => s.msg)
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(1)
}

describe('hosting', () => {
  test('a listener who says hello gets a welcome and the current state', async () => {
    usePlayer.setState({ current: trackOf(-2001, 5123), isPlaying: true, position: 30 })
    await startHosting()
    expect(useTogether.getState()).toMatchObject({ phase: 'live', role: 'host' })
    expect(useTogether.getState().code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    expect(ev.admit('p1', { role: 'listener', full: false })).toBe('accept')
    ev.onPeerJoin('p1')
    ev.onMessage({ v: 1, type: 'hello', name: 'Саша' }, 'p1')
    expect(sentTo('p1', 'welcome')).toEqual([{ v: 1, type: 'welcome', host: 'Дима', listeners: 1 }])
    expect(sentTo('p1', 'state')[0]).toMatchObject({ track: { owner: -2001, id: 5123, title: 'Ночной город' }, position: 30, playing: true })
    expect(useTogether.getState().listeners).toEqual([{ peer: 'p1', name: 'Саша', state: 'connecting' }])
    ev.onMessage({ v: 1, type: 'status', state: 'listening' }, 'p1')
    expect(useTogether.getState().listeners[0].state).toBe('listening')
  })

  test('the sixth listener is turned away and a flood gets its sender dropped', async () => {
    await startHosting()
    for (let i = 1; i <= 5; i++) {
      expect(ev.admit(`p${i}`, { role: 'listener', full: false })).toBe('accept')
      ev.onPeerJoin(`p${i}`)
    }
    expect(ev.admit('p6', { role: 'listener', full: false })).toBe('full')
    expect(ev.admit('h2', { role: 'host', full: false })).toBe('reject')
    for (let i = 0; i < 25; i++) ev.onMessage({ v: 1, type: 'ping', t0: i }, 'p1')
    expect(kicked).toContain('p1')
    expect(sentTo('p1', 'pong').length).toBe(20)
  })

  test('changes on the host player go out to everyone; finishing says goodbye', async () => {
    usePlayer.setState({ current: trackOf(-2001, 1), isPlaying: true, position: 10 })
    await startHosting()
    usePlayer.setState({ current: trackOf(-2001, 2), position: 0 })
    expect(sentAll('state').at(-1)).toMatchObject({ track: { id: 2 } })
    usePlayer.setState({ position: 95 })
    expect(sentAll('state').at(-1)).toMatchObject({ position: 95 })
    usePlayer.setState({ isPlaying: false })
    expect(sentAll('state').at(-1)).toMatchObject({ playing: false })
    leaveSession()
    expect(sentAll('bye').length).toBe(1)
    expect(left).toBe(true)
    expect(useTogether.getState().phase).toBe('idle')
  })
})

describe('listening', () => {
  const state = (seq: number, p: Record<string, unknown> = {}) => ({
    v: 1,
    type: 'state',
    seq,
    track: { owner: -2001, id: 5123, title: 'Ночной город', artist: 'Северный ветер', duration: 214 },
    position: 40,
    playing: true,
    at: Date.now(),
    ...p,
  })

  async function connected() {
    await joinSession('K7QM-2XFD-9WRA-HT4C')
    expect(ev.admit('h1', { role: 'host', full: false })).toBe('accept')
    ev.onPeerJoin('h1')
    await flush()
    ev.onMessage({ v: 1, type: 'welcome', host: 'Дима', listeners: 1 }, 'h1')
  }

  test('says hello, then plays the host track from the host position', async () => {
    await connected()
    expect(sentTo('h1', 'hello')).toEqual([{ v: 1, type: 'hello', name: 'Дима' }])
    ev.onMessage(state(1), 'h1')
    await flush()
    expect(h.calls).toContain('playList -2001_5123 at=40 playing')
    expect(useTogether.getState()).toMatchObject({ phase: 'live', role: 'listener', hostName: 'Дима' })
  })

  test('words from anyone but the host, and states older than the last one, are ignored', async () => {
    await connected()
    expect(ev.admit('h2', { role: 'host', full: false })).toBe('reject')
    ev.onMessage(state(5), 'x9')
    ev.onMessage(state(2), 'h1')
    await flush()
    ev.onMessage(state(1, { track: { owner: -2001, id: 999, title: 'Другой', artist: 'X', duration: 100 } }), 'h1')
    await flush()
    expect(h.calls.filter((c) => c.startsWith('playList'))).toEqual(['playList -2001_5123 at=40 playing'])
  })

  test('the listener pause stays theirs, and play catches up with the host', async () => {
    await connected()
    ev.onMessage(state(1), 'h1')
    await flush()
    usePlayer.getState().pause()
    expect(h.calls.at(-1)).toBe('pause')
    expect(sentTo('h1', 'status').at(-1)).toMatchObject({ state: 'paused' })
    vi.setSystemTime(Date.now() + 20_000)
    ev.onMessage(state(2, { position: 60, at: Date.now() - 20_000 }), 'h1')
    await flush()
    expect(h.calls.at(-1)).toBe('pause')
    usePlayer.getState().play()
    await flush()
    expect(h.calls.slice(-2)).toEqual(['seek 80', 'play'])
    expect(sentTo('h1', 'status').at(-1)).toMatchObject({ state: 'listening' })
  })

  test('seeking and skipping are refused with a hint; picking other music leaves with a way back', async () => {
    await connected()
    ev.onMessage(state(1), 'h1')
    await flush()
    usePlayer.getState().next(true)
    usePlayer.getState().seek(100)
    expect(h.calls.some((c) => c === 'next' || c === 'seek 100')).toBe(false)
    expect(h.toasts.at(-1)?.text).toContain('управляет Дима')
    usePlayer.getState().playList([trackOf(1, 77)], 0)
    await flush()
    expect(h.calls.at(-1)).toBe('playList 1_77 at=0 playing')
    expect(useTogether.getState().phase).toBe('idle')
    expect(sentTo('h1', 'bye').length).toBe(1)
    expect(h.toasts.at(-1)).toMatchObject({ text: 'Вы вышли из совместного прослушивания', action: { label: 'Вернуться' } })
  })

  /** The host plays on for `seconds`, saying where it is every 5 s; `heard` moves the listener's player like real sound would. */
  async function hostPlaysOn(seconds: number, heard: boolean) {
    const start = Date.now()
    for (let t = 1; t <= seconds; t++) {
      await vi.advanceTimersByTimeAsync(1000)
      if (heard && usePlayer.getState().isPlaying) usePlayer.setState({ position: usePlayer.getState().position + 1 })
      if (t % 5 === 0) ev.onMessage(state(100 + t, { position: 40 + (Date.now() - start) / 1000, at: Date.now() }), 'h1')
    }
    await flush()
  }
  const loads = () => h.calls.filter((c) => c.startsWith('playList')).length

  test('no sound while the host plays: the track loads again, three times at most, then waits for the next one', async () => {
    await connected()
    ev.onMessage(state(1), 'h1')
    await flush()
    expect(loads()).toBe(1)
    // the follow seeks move the timeline, but nothing is heard
    await hostPlaysOn(25, false)
    expect(loads()).toBe(2)
    await hostPlaysOn(75, false)
    expect(loads()).toBe(4)
    expect(useTogether.getState().unavailable).toBe(true)
    expect(sentTo('h1', 'status').at(-1)).toMatchObject({ state: 'unavailable' })
    expect(h.toasts.at(-1)?.text).toMatch(/не загружается/)
    // the host's next track is tried afresh
    ev.onMessage(state(500, { track: { owner: -2001, id: 777, title: 'Другой', artist: 'X', duration: 100 }, at: Date.now() }), 'h1')
    await flush()
    expect(loads()).toBe(5)
  })

  test('a listener whose sound plays is left alone', async () => {
    await connected()
    ev.onMessage(state(1), 'h1')
    await flush()
    await hostPlaysOn(60, true)
    expect(loads()).toBe(1)
  })

  test('goodbye from the host ends the session; music keeps playing', async () => {
    await connected()
    ev.onMessage(state(1), 'h1')
    await flush()
    ev.onMessage({ v: 1, type: 'bye' }, 'h1')
    expect(useTogether.getState().phase).toBe('idle')
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(h.toasts.at(-1)?.text).toBe('Ведущий завершил совместное прослушивание')
  })

  test('20 seconds without a host: a clear reason instead of silence', async () => {
    await joinSession('K7QM-2XFD-9WRA-HT4C')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useTogether.getState()).toMatchObject({ phase: 'idle', error: 'nobody' })
    relays = false
    await joinSession('K7QM-2XFD-9WRA-HT4C')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useTogether.getState().error).toBe('relays')
  })

  test('the host vanishing: 30 seconds of reconnecting, back if it returns, otherwise the end', async () => {
    await connected()
    ev.onPeerLeave('h1')
    expect(useTogether.getState().phase).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(10_000)
    ev.onPeerJoin('h1')
    await flush()
    expect(useTogether.getState().phase).toBe('live')
    ev.onPeerLeave('h1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(useTogether.getState().phase).toBe('idle')
    expect(h.toasts.at(-1)?.text).toBe('Связь с ведущим потеряна — совместное прослушивание закончилось')
  })

  test('a full room is said plainly', async () => {
    await joinSession('K7QM-2XFD-9WRA-HT4C')
    ev.onError('full')
    expect(useTogether.getState()).toMatchObject({ phase: 'idle', error: 'full' })
  })

  test('a code that is not one is refused before anything goes on the network', async () => {
    await joinSession('привет')
    expect(useTogether.getState()).toMatchObject({ phase: 'idle', error: 'code' })
    expect(sent.length).toBe(0)
  })
})
