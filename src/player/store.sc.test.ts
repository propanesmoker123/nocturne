import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => {
  const listeners = new Map<string, Set<() => void>>()
  const calls = { load: [] as string[], stream: [] as number[] }
  const engine = {
    lastError: '',
    onSource: null,
    on(ev: string, fn: () => void) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev)!.add(fn)
      return () => listeners.get(ev)!.delete(fn)
    },
    load(url: string) {
      calls.load.push(url)
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
  const sc = { fail: null as unknown }
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
  streamUrl: async (t: Track) => {
    h.calls.stream.push(t.id)
    if (h.sc.fail) throw h.sc.fail
    return LINK
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
  h.toasts.length = 0
  h.sc.fail = null
  h.engine.playing = false
  h.engine.waiting = true
  usePlayer.setState({ queue: null, current: null, isPlaying: false, repeat: 'off', shuffle: false })
})

afterEach(() => vi.useRealTimers())

describe('SoundCloud tracks in the player', () => {
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
