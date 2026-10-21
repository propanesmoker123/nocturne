import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const calls = { load: [] as string[], stream: [] as number[], protection: [] as unknown[], autoplay: [] as boolean[] }
  const engine = {
    lastError: '',
    onSource: null,
    on(ev: string, fn: () => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(fn)
      return () => listeners.get(ev)!.delete(fn)
    },
    load(url: string, _start?: number, play?: boolean, protection?: unknown) {
      calls.load.push(url)
      calls.protection.push(protection)
      calls.autoplay.push(play ?? true)
    },
    stop() {},
    play() {},
    pause() {},
    seek() {},
    setVolume() {},
    position: 0,
    duration: 0,
    buffered: 0,
    playing: false,
    waiting: true,
  }
  const toasts: string[] = []
  const sc = { fail: null as unknown, failOnce: false, drm: undefined as unknown, pending: null as Promise<void> | null }
  return { engine, calls, toasts, sc, fire: (ev: string) => listeners.get(ev)?.forEach((f) => f()) }
})

const LINK = 'https://playback.media-streaming.soundcloud.cloud/a/playlist.m3u8'

vi.mock('./engine', () => ({ engine: h.engine }))
vi.mock('./waveform', () => ({ beginWaveform: () => {}, captureSource: () => {} }))
vi.mock('../app/toast', () => ({ toast: (m: string) => void h.toasts.push(m) }))
vi.mock('../lib/journal', () => ({ journal: () => {} }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => null, saveJSON: async () => {}, debouncedSaver: () => ({ save() {}, flush() {} }) }))
vi.mock('../vk/api', () => ({ getByIds: async (ts: Track[]) => ts, getStreamMix: async () => [] }))
vi.mock('../sc/api', () => ({
  streamSource: async (t: Track) => {
    h.calls.stream.push(t.id)
    if (h.sc.pending) await h.sc.pending
    if (h.sc.fail) {
      const e = h.sc.fail
      if (h.sc.failOnce) h.sc.fail = null
      throw e
    }
    return { url: LINK, drm: h.sc.drm }
  },
}))

const { usePlayer } = await import('./store')
const { SC_UNREACHABLE, ScApiError } = await import('../sc/errors')

const sc = (id: number, over: Partial<Track> = {}) =>
  ({ service: 'sc', id, ownerId: 5, key: `sc_${id}`, artist: 'A', title: `S${id}`, duration: 100, urlFetchedAt: 0, explicit: false, artists: [{ name: 'A' }], playable: true, hasLyrics: false, liked: false, ...over }) as Track
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  h.calls.load.length = 0
  h.calls.stream.length = 0
  h.calls.protection.length = 0
  h.calls.autoplay.length = 0
  h.toasts.length = 0
  h.sc.fail = null
  h.sc.failOnce = false
  h.sc.drm = undefined
  h.sc.pending = null
  h.engine.playing = false
  h.engine.waiting = true
  usePlayer.setState({ queue: null, current: null, isPlaying: false, repeat: 'off', shuffle: false })
})

afterEach(() => vi.useRealTimers())

describe('SoundCloud tracks in the player', () => {
  test('pausing while a protected source is pending keeps it paused when it arrives', async () => {
    let resolve!: () => void
    h.sc.pending = new Promise<void>((done) => { resolve = done })
    h.sc.drm = { licenseToken: 'temporary', appId: '46941' }
    usePlayer.getState().playList([sc(11)], 0)
    usePlayer.getState().pause()
    resolve()
    await flush()
    expect(h.calls.autoplay).toEqual([false])
    expect(usePlayer.getState().isLoading).toBe(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.toasts).toEqual([])
  })

  test('a pause while a source is pending holds when that source fails: the next track waits too', async () => {
    let resolve!: () => void
    h.sc.pending = new Promise<void>((done) => { resolve = done })
    h.sc.fail = ScApiError.from({ kind: 'network', message: 'x' })
    h.sc.failOnce = true
    usePlayer.getState().playList([sc(21), sc(22)], 0)
    usePlayer.getState().pause()
    resolve()
    for (let i = 0; i < 4; i++) await flush()
    expect(h.calls.stream).toEqual([21, 22])
    expect(h.calls.autoplay).toEqual([false])
  })

  test('toggling a pending source pauses and resumes the same request', async () => {
    let resolve!: () => void
    h.sc.pending = new Promise<void>((done) => { resolve = done })
    usePlayer.getState().playList([sc(12)], 0)
    usePlayer.getState().toggle()
    usePlayer.getState().toggle()
    resolve()
    await flush()
    expect(h.calls.stream).toEqual([12])
    expect(h.calls.autoplay).toEqual([true])
  })

  test('play resumes a paused restore while its source is pending without another request', async () => {
    let resolve!: () => void
    h.sc.pending = new Promise<void>((done) => { resolve = done })
    usePlayer.getState().playList([sc(13)], 0, { paused: true })
    usePlayer.getState().play()
    resolve()
    await flush()
    expect(h.calls.stream).toEqual([13])
    expect(h.calls.autoplay).toEqual([true])
  })

  test('a protected source reaches the engine without storing its license in the track', async () => {
    h.sc.drm = { licenseToken: 'temporary', appId: '46941' }
    usePlayer.getState().playList([sc(1, { url: LINK, urlFetchedAt: Date.now() })], 0)
    await flush()
    expect(h.calls.stream).toEqual([1])
    expect(h.calls.protection).toEqual([{ drm: h.sc.drm, waveformUrl: undefined }])
    expect(JSON.stringify(usePlayer.getState().queue)).not.toContain('temporary')
  })

  test('a SoundCloud track gets its stream link when it starts', async () => {
    usePlayer.getState().playList([sc(1)], 0)
    await flush()
    expect(h.calls.stream).toEqual([1])
    expect(h.calls.load).toEqual([LINK])
  })

  test('a restored SoundCloud track gets a fresh link', async () => {
    usePlayer.getState().playList([sc(1, { url: 'https://old/playlist.m3u8', urlFetchedAt: 1 })], 0, { paused: true })
    await flush()
    expect(h.calls.stream).toEqual([1])
    expect(h.calls.load).toEqual([LINK])
  })

  test('a SoundCloud track that never starts is skipped with the VPN hint after 15 s', async () => {
    usePlayer.getState().playList([sc(1), sc(2)], 0)
    await flush()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.toasts).toContain(SC_UNREACHABLE)
    expect(usePlayer.getState().current?.key).toBe('sc_2')
    expect(h.calls.load).toEqual([LINK, LINK])
  })

  test('a SoundCloud track that starts in time is left alone', async () => {
    usePlayer.getState().playList([sc(1), sc(2)], 0)
    await flush()
    h.engine.playing = true
    h.engine.waiting = false
    h.fire('loading')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.toasts).toEqual([])
    expect(usePlayer.getState().current?.key).toBe('sc_1')
  })

  test('a paused restore does not start the watchdog', async () => {
    usePlayer.getState().playList([sc(1), sc(2)], 0, { paused: true })
    await flush()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.toasts).toEqual([])
  })

  test('signed out of SoundCloud: the track says so and the player moves on', async () => {
    h.sc.fail = ScApiError.from({ kind: 'signedOut' })
    usePlayer.getState().playList([sc(1), sc(2)], 0)
    await flush()
    expect(h.toasts[0]).toBe('Войдите в SoundCloud, чтобы слушать этот трек')
    expect(h.calls.stream).toContain(2)
  })

  test('five SoundCloud failures in a row stop the player with the SoundCloud message', async () => {
    h.sc.fail = ScApiError.from({ kind: 'network', message: 'x' })
    usePlayer.getState().playList([sc(1), sc(2), sc(3), sc(4), sc(5), sc(6)], 0)
    for (let i = 0; i < 8; i++) await flush()
    expect(h.toasts.at(-1)).toBe('SoundCloud не отдаёт звук — без VPN он в России не играет')
    expect(usePlayer.getState().isPlaying).toBe(false)
  })
})
