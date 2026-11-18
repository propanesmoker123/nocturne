import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => {
  const listeners = new Map<string, () => void>()
  const fire = (event: string) => listeners.get(event)?.()
  const loads: [string, boolean][] = []
  const starts: number[] = []
  const engine = {
    on(event: string, handler: () => void) { listeners.set(event, handler) },
    load(url: string, startAt: number, autoplay: boolean) {
      loads.push([url, autoplay])
      starts.push(startAt)
      this.playing = autoplay
      fire('state')
    },
    play() { this.playing = true; fire('state') },
    pause() { this.playing = false; fire('state') },
    stop() { this.pause() },
    seek: vi.fn(),
    seeking: undefined as number | undefined,
    position: 0,
    playing: false,
  }
  return {
    engine, fire, loads, starts,
    toast: vi.fn(),
    getByIds: vi.fn<(tracks: Track[]) => Promise<Track[]>>(),
    getStreamMix: vi.fn<() => Promise<Track[]>>(),
    getSpotifyMix: vi.fn<() => Promise<Track[]>>(),
    getTrackRadio: vi.fn<(seed: string) => Promise<Track[]>>(),
  }
})

vi.mock('./engine', () => ({ engine: h.engine }))
vi.mock('./waveform', () => ({ beginWaveform() {}, captureSource() {} }))
vi.mock('../app/toast', () => ({ toast: h.toast }))
vi.mock('../lib/journal', () => ({ journal() {} }))
vi.mock('../lib/persist', () => ({ debouncedSaver: () => ({ save() {}, flush() {} }) }))
vi.mock('../vk/api', () => ({ getByIds: h.getByIds, getStreamMix: h.getStreamMix }))
vi.mock('../spotify/api', () => ({ getSpotifyMix: h.getSpotifyMix, getTrackRadio: h.getTrackRadio }))

const { usePlayer } = await import('./store')
const player = usePlayer.getState
const track = (id: number, patch: Partial<Track> = {}): Track => ({
  id, ownerId: 1, key: `1_${id}`, title: `Track ${id}`, artist: 'Artist', artists: [{ name: 'Artist' }],
  duration: 100, url: `https://cdn/${id}`, urlFetchedAt: Date.now(), playable: true,
  explicit: false, hasLyrics: false, liked: false, ...patch,
})
const mix = { kind: 'mix', service: 'vk' } as const
const queueKeys = () => player().queue?.items.map((t) => t.key)
const flush = () => vi.advanceTimersByTimeAsync(0)

function pendingTracks() {
  let resolve!: (tracks: Track[]) => void
  const promise = new Promise<Track[]>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  h.loads.length = 0
  h.starts.length = 0
  h.engine.seeking = undefined
  h.engine.playing = false
  h.engine.seek.mockClear()
  h.toast.mockClear()
  h.getByIds.mockReset().mockImplementation(async (tracks) => tracks)
  h.getStreamMix.mockReset().mockResolvedValue([])
  h.getSpotifyMix.mockReset().mockResolvedValue([])
  h.getTrackRadio.mockReset().mockResolvedValue([])
  usePlayer.setState({ queue: null, current: null, source: null, isPlaying: false, isLoading: false, repeat: 'off', shuffle: false })
})

afterEach(() => vi.useRealTimers())

describe('player queue changes', () => {
  test('events from the outgoing stream cannot advance a track waiting on a fresh link', async () => {
    const fresh = pendingTracks()
    h.getByIds.mockReturnValueOnce(fresh.promise)
    player().playList([track(1), track(2, { urlFetchedAt: 0 }), track(3)], 0)
    player().next()

    h.engine.position = 100
    h.fire('time')
    h.fire('ended')
    h.fire('error')

    expect(player().current?.key).toBe('1_2')
    expect(player().position).toBe(0)
    expect(h.getByIds).toHaveBeenCalledTimes(1)
    fresh.resolve([track(2)])
    await flush()
    expect(h.loads).toEqual([['https://cdn/1', true], ['https://cdn/2', true]])
  })

  test('a seek during link resolution becomes the new stream start position', async () => {
    const fresh = pendingTracks()
    h.getByIds.mockReturnValueOnce(fresh.promise)
    player().playList([track(1, { urlFetchedAt: 0 })], 0)
    player().seek(30)

    fresh.resolve([track(1)])
    await flush()
    expect(h.starts).toEqual([30])
  })

  test('a new selection of the same track has its own retry', async () => {
    const first = track(1)
    player().playList([first, track(2)], 0)
    h.fire('error')
    await flush()
    h.fire('error')
    expect(player().current?.key).toBe('1_2')

    player().jumpTo(0)
    h.fire('error')
    await flush()
    expect(player().current?.key).toBe('1_1')
    expect(h.getByIds).toHaveBeenCalledTimes(2)
  })

  test('a failed Spotify start leaves the selection available to retry', async () => {
    const first = track(1, { service: 'spotify', spotifyId: '4cOdK2wGLETKBW3PvgPWqT' })
    player().playList([first, track(2)], 0)
    h.fire('error')
    h.fire('error')

    expect(player().current?.key).toBe('1_1')
    expect(player()).toMatchObject({ isPlaying: false, isLoading: false })
    player().play()
    expect(h.loads.at(-1)).toEqual(['spotify:track:4cOdK2wGLETKBW3PvgPWqT', true])
  })

  test('a mix can replenish at the end of its playable tracks', async () => {
    h.getStreamMix.mockResolvedValueOnce([track(6)])
    const unavailable = [2, 3, 4, 5].map((id) => track(id, { playable: false }))
    player().playList([track(1), ...unavailable], 0, { source: mix })
    player().next()
    await flush()

    expect(player().current?.key).toBe('1_6')
    expect(h.getStreamMix).toHaveBeenCalledTimes(1)
  })

  test('an unavailable list leaves the current selection and its pending stream load intact', async () => {
    const fresh = pendingTracks()
    h.getByIds.mockReturnValueOnce(fresh.promise)
    const source = { kind: 'list', label: 'Current list' } as const
    player().playList([track(1, { urlFetchedAt: 0 }), track(2)], 0, { source })

    player().playList([track(3, { playable: false })], 0, { shuffle: true })
    fresh.resolve([track(1)])
    await flush()

    expect(queueKeys()).toEqual(['1_1', '1_2'])
    expect(player()).toMatchObject({ source, shuffle: false })
    expect(h.loads).toEqual([['https://cdn/1', true]])
    expect(h.toast).toHaveBeenCalledWith(expect.any(String), 'error')
  })

  test('a recommendation reply leaves a replacement mix using the same source untouched', async () => {
    const fetched = pendingTracks()
    h.getStreamMix.mockReturnValue(fetched.promise)
    player().playList([track(1)], 0, { source: mix })
    player().next()
    player().playList([track(2), track(3), track(4), track(5), track(6)], 0, { source: mix })

    fetched.resolve([track(7)])
    await flush()

    expect(queueKeys()).toEqual(['1_2', '1_3', '1_4', '1_5', '1_6'])
    expect(player().current?.key).toBe('1_2')
  })

  test('an in-flight replenishment survives advancing and deduplicates against tracks queued meanwhile', async () => {
    const fetched = pendingTracks()
    h.getStreamMix.mockReturnValue(fetched.promise)
    player().playList([track(1), track(2)], 0, { source: mix })
    player().next()
    player().addToQueue([track(3)])

    fetched.resolve([track(3), track(4), track(4)])
    await flush()

    expect(queueKeys()).toEqual(['1_1', '1_2', '1_3', '1_4'])
    expect(h.getStreamMix).toHaveBeenCalledTimes(1)
  })

  test('rapid Next presses at the end of a mix advance once when more tracks arrive', async () => {
    const fetched = pendingTracks()
    h.getStreamMix.mockReturnValue(fetched.promise)
    player().playList([track(1)], 0, { source: mix })
    player().next()
    player().next()
    player().next()

    fetched.resolve([track(2), track(3), track(4), track(5), track(6)])
    await flush()

    expect(h.loads).toEqual([['https://cdn/1', true], ['https://cdn/2', true]])
  })

  test('pausing a pending Next keeps the following track paused even if the first track ends', async () => {
    const fetched = pendingTracks()
    h.getStreamMix.mockReturnValue(fetched.promise)
    player().playList([track(1)], 0, { source: mix })
    player().next()
    player().pause()
    h.fire('ended')

    fetched.resolve([track(2), track(3), track(4), track(5), track(6)])
    await flush()

    expect(h.loads).toEqual([['https://cdn/1', true], ['https://cdn/2', false]])
    expect(player().isPlaying).toBe(false)
  })

  test('an automatic advance honors repeat-one if enabled while the request is pending', async () => {
    const fetched = pendingTracks()
    h.getStreamMix.mockReturnValue(fetched.promise)
    player().playList([track(1)], 0, { source: mix })
    h.fire('ended')
    player().cycleRepeat()
    player().cycleRepeat()

    fetched.resolve([track(2)])
    await flush()

    expect(player().current?.key).toBe('1_1')
    expect(queueKeys()).toEqual(['1_1', '1_2'])
    expect(h.engine.seek).toHaveBeenCalledWith(0)
  })

  test.each(['VK Mix', 'Spotify Mix', 'Spotify Radio'])('a later list selection supersedes %s still loading', async (selection) => {
    const fetched = pendingTracks()
    h.getStreamMix.mockReturnValueOnce(fetched.promise)
    h.getSpotifyMix.mockReturnValueOnce(fetched.promise)
    h.getTrackRadio.mockReturnValueOnce(fetched.promise)
    const started = selection === 'Spotify Radio'
      ? player().playRadio(track(1, { service: 'spotify', spotifyId: 'seed' }))
      : player().playMix(selection === 'VK Mix' ? 'vk' : 'spotify')
    await vi.dynamicImportSettled()
    player().playList([track(2)], 0)

    fetched.resolve([track(3)])
    await started

    expect(queueKeys()).toEqual(['1_2'])
    expect(h.loads).toEqual([['https://cdn/2', true]])
  })
})
