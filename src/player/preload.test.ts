import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LoaderContextType } from 'hls.js'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => {
  const fetchCalls: string[] = []
  const fetchRanges: (readonly [number, number] | undefined)[] = []
  const vkCalls: number[] = []
  const scCalls: number[] = []
  const spotifyWaveCalls: string[] = []
  const scWaveCalls: string[] = []
  const pending = new Map<string, { resolve: (b: ArrayBuffer) => void; reject: (e: unknown) => void }>()
  let files = new Map<string, ArrayBuffer>()
  let vkUrl = 'https://cdn.example/track/playlist.m3u8'
  let scUrl = 'https://playback.media-streaming.soundcloud.cloud/s/playlist.m3u8'
  let scDrm: unknown = undefined
  let scWaveformUrl: string | undefined = undefined

  const proxyFetch = vi.fn((url: string, range?: readonly [number, number]) => {
    fetchCalls.push(url)
    fetchRanges.push(range)
    const immediate = files.get(url)
    if (immediate) return Promise.resolve(range ? immediate.slice(...range) : immediate)
    return new Promise<ArrayBuffer>((resolve, reject) => {
      pending.set(url, { resolve, reject })
    })
  })

  return {
    fetchCalls,
    fetchRanges,
    vkCalls,
    scCalls,
    spotifyWaveCalls,
    scWaveCalls,
    pending,
    setFile(url: string, data: string | ArrayBuffer) {
      const buf = typeof data === 'string' ? new TextEncoder().encode(data).buffer : data
      files.set(url, buf)
      return buf
    },
    setVkUrl(u: string) { vkUrl = u },
    setScSource(url: string, drm?: unknown, waveformUrl?: string) {
      scUrl = url
      scDrm = drm
      scWaveformUrl = waveformUrl
    },
    reset() {
      fetchCalls.length = 0
      fetchRanges.length = 0
      vkCalls.length = 0
      scCalls.length = 0
      spotifyWaveCalls.length = 0
      scWaveCalls.length = 0
      pending.clear()
      files = new Map()
      vkUrl = 'https://cdn.example/track/playlist.m3u8'
      scUrl = 'https://playback.media-streaming.soundcloud.cloud/s/playlist.m3u8'
      scDrm = undefined
      scWaveformUrl = undefined
      proxyFetch.mockClear()
    },
    proxyFetch,
    get vkUrl() { return vkUrl },
    get scUrl() { return scUrl },
    get scDrm() { return scDrm },
    get scWaveformUrl() { return scWaveformUrl },
  }
})

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  invoke: (_cmd: string, args?: { url?: string; range?: readonly [number, number] }) => h.proxyFetch(args?.url ?? '', args?.range),
}))

vi.mock('../vk/api', () => ({
  getByIds: async (tracks: Track[]) => {
    h.vkCalls.push(...tracks.map((t) => t.id))
    return tracks.map((t) => ({ ...t, url: h.vkUrl, urlFetchedAt: Date.now() }))
  },
}))

vi.mock('../sc/api', () => ({
  streamSource: async (t: Track) => {
    h.scCalls.push(t.id)
    return { url: h.scUrl, drm: h.scDrm, waveformUrl: h.scWaveformUrl }
  },
}))

vi.mock('./waveform', () => ({
  warmSpotifyWaveform: async (_key: string, id: string) => { h.spotifyWaveCalls.push(id) },
  warmProviderWaveform: async (_key: string, url: string) => { h.scWaveCalls.push(url) },
}))

const spWarmCalls = vi.hoisted(() => [] as string[])
vi.mock('../spotify/api', () => ({
  warmSpotifyTrack: async (id: string) => { spWarmCalls.push(id) },
}))

const lyricsMock = vi.hoisted(() => {
  const calls: string[] = []
  let resolver: ((t: Track) => Promise<{ synced: boolean; lines: { text: string }[] } | null>) | null = null
  return {
    calls,
    setHandler(fn: ((t: Track) => Promise<{ synced: boolean; lines: { text: string }[] } | null>) | null) {
      resolver = fn
    },
    reset() {
      calls.length = 0
      resolver = null
    },
    prefetchLyrics: async (t: Track) => {
      calls.push(t.key)
      if (resolver) return resolver(t)
      return { synced: true, lines: [{ text: `Lyrics for ${t.title}` }] }
    },
  }
})
vi.mock('../app/lyrics', () => ({
  prefetchLyrics: lyricsMock.prefetchLyrics,
}))

const { queryClient } = await import('../app/queryClient')

const {
  MAX_PRELOAD_BYTES,
  clearPreload,
  clearPreloadExcept,
  getPreloadDebugState,
  parseHlsManifest,
  syncNextPreload,
  takePreloadedBlobUrl,
  takePreloadedSource,
} = await import('./preload')
const { TauriLoader } = await import('./tauriLoader')

const vkTrack = (id: number, over: Partial<Track> = {}): Track => ({
  service: 'vk',
  id,
  ownerId: 1,
  key: `1_${id}`,
  artist: 'Artist',
  title: `Track ${id}`,
  duration: 180,
  urlFetchedAt: 0,
  explicit: false,
  artists: [{ name: 'Artist' }],
  playable: true,
  hasLyrics: false,
  liked: false,
  ...over,
})

const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}

beforeEach(() => {
  h.reset()
  clearPreload()
})

afterEach(() => {
  clearPreload()
})

describe('preload', () => {
  test('parses master variants, audio renditions, keys, maps, and relative segments cleanly', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",DEFAULT=YES,URI="audio/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=128000',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=320000',
      'high/index.m3u8',
    ].join('\n')
    const m = parseHlsManifest(master, 'https://cdn.example/base/master.m3u8')
    expect(m.variants).toEqual([
      'https://cdn.example/base/high/index.m3u8',
      'https://cdn.example/base/low/index.m3u8',
    ])
    expect(m.media).toEqual(['https://cdn.example/base/audio/index.m3u8'])

    const media = [
      '#EXTM3U',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fairplay-ignored"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4.0,',
      'seg1.ts',
      '#EXTINF:4.0,',
      'seg1.ts',
      '#EXTINF:4.0,',
      '../other/seg2.ts?tok=1',
    ].join('\n')
    const p = parseHlsManifest(media, 'https://cdn.example/base/high/index.m3u8')
    expect(p.variants).toEqual([])
    expect(p.initAndKeys).toEqual([
      'https://cdn.example/base/high/key.bin',
      'https://cdn.example/base/high/init.mp4',
    ])
    expect(p.segments).toEqual([
      'https://cdn.example/base/high/seg1.ts',
      'https://cdn.example/base/other/seg2.ts?tok=1',
    ])
  })

  test('preloads master -> variant -> key/segments and serves TauriLoader without duplicate proxy_fetch calls', async () => {
    h.setVkUrl('https://cdn.example/t2/master.m3u8')
    h.setFile('https://cdn.example/t2/master.m3u8', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=256000\nindex.m3u8')
    h.setFile('https://cdn.example/t2/index.m3u8', '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.key"\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nseg1.ts')
    h.setFile('https://cdn.example/t2/k.key', '16-byte-key-here')
    const seg0Buf = h.setFile('https://cdn.example/t2/seg0.ts', new Uint8Array([1, 2, 3, 4]).buffer)

    syncNextPreload(vkTrack(2))
    await flush()

    // seg1.ts left pending in-flight to verify TauriLoader also awaits shared inflight requests.
    expect(h.fetchCalls).toEqual([
      'https://cdn.example/t2/master.m3u8',
      'https://cdn.example/t2/index.m3u8',
      'https://cdn.example/t2/k.key',
      'https://cdn.example/t2/seg0.ts',
      'https://cdn.example/t2/seg1.ts',
    ])

    const source = takePreloadedSource(vkTrack(2))
    expect(source?.url).toBe('https://cdn.example/t2/master.m3u8')

    // TauriLoader hits seg0 from bytesCache with 0 extra proxy_fetch calls.
    const loader0 = new TauriLoader({})
    const ok0 = await new Promise<{ data: unknown; code: number }>((resolve) => {
      loader0.load(
        { type: LoaderContextType.MEDIA_FRAGMENT, url: 'https://cdn.example/t2/seg0.ts', responseType: 'arraybuffer', rangeStart: 0, rangeEnd: 0 },
        {} as never,
        {
          onSuccess: (res: { data: unknown; code?: number }) => resolve({ data: res.data, code: res.code ?? 0 }),
          onError: () => {},
          onTimeout: () => {},
        } as never,
      )
    })
    expect(ok0.code).toBe(200)
    expect((ok0.data as ArrayBuffer).byteLength).toBe(seg0Buf.byteLength)
    expect(h.fetchCalls).toHaveLength(5)

    // TauriLoader awaits in-flight seg1 cleanly without starting a second fetch.
    const loader1 = new TauriLoader({})
    const ok1Promise = new Promise<{ data: unknown }>((resolve) => {
      loader1.load(
        { url: 'https://cdn.example/t2/seg1.ts', responseType: 'arraybuffer' } as never,
        {} as never,
        {
          onSuccess: (res: { data: unknown }) => resolve({ data: res.data }),
          onError: () => {},
          onTimeout: () => {},
        } as never,
      )
    })
    expect(h.fetchCalls).toHaveLength(5)
    h.pending.get('https://cdn.example/t2/seg1.ts')?.resolve(new Uint8Array([9, 8]).buffer)
    const ok1 = await ok1Promise
    expect(new Uint8Array(ok1.data as ArrayBuffer)).toEqual(new Uint8Array([9, 8]))
  })

  test('does not preload the full file behind HLS byte ranges and requests the exact segment', async () => {
    const manifest = 'https://cdn.example/range/index.m3u8'
    const segment = 'https://cdn.example/range/audio.mp4'
    h.setVkUrl(manifest)
    h.setFile(manifest, '#EXTM3U\n#EXT-X-MAP:URI="audio.mp4",BYTERANGE="2@0"\n#EXTINF:4,\n#EXT-X-BYTERANGE:3@2\naudio.mp4')
    h.setFile(segment, new Uint8Array([0, 1, 2, 3, 4, 5]).buffer)
    syncNextPreload(vkTrack(2))
    await flush()
    expect(h.fetchCalls).toEqual([manifest])

    const loader = new TauriLoader({})
    const onSuccess = vi.fn()
    loader.load({ type: LoaderContextType.MEDIA_FRAGMENT, url: segment, responseType: 'arraybuffer', rangeStart: 2, rangeEnd: 5 }, {} as never, {
      onSuccess, onError: vi.fn(), onTimeout: vi.fn(),
    })
    await flush()
    expect(h.fetchRanges.at(-1)).toEqual([2, 5])
    expect(new Uint8Array(onSuccess.mock.calls[0]?.[0].data)).toEqual(new Uint8Array([2, 3, 4]))
  })

  test('aborts a fragment load and ignores its response when a replacement request has started', async () => {
    const loader = new TauriLoader({})
    const first = 'https://cdn.example/old.ts'
    const second = 'https://cdn.example/new.ts'
    const old = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn() }
    const current = { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() }
    loader.load({ type: LoaderContextType.MEDIA_FRAGMENT, url: first, responseType: 'arraybuffer' }, {} as never, old)
    loader.abort()
    loader.load({ type: LoaderContextType.MEDIA_FRAGMENT, url: second, responseType: 'arraybuffer' }, {} as never, current)

    h.pending.get(first)?.resolve(new ArrayBuffer(2))
    h.pending.get(second)?.resolve(new ArrayBuffer(4))
    await flush()
    expect(old.onAbort).toHaveBeenCalledOnce()
    expect(old.onSuccess).not.toHaveBeenCalled()
    expect(current.onSuccess).toHaveBeenCalledOnce()
  })

  test('cancels in-flight preload and evicts previous track bytes immediately when the next track changes', async () => {
    h.setVkUrl('https://cdn.example/a/index.m3u8')
    h.setFile('https://cdn.example/a/index.m3u8', '#EXTM3U\n#EXTINF:4,\nsegA0.ts\n#EXTINF:4,\nsegA1.ts')
    h.setFile('https://cdn.example/a/segA0.ts', new Uint8Array([1, 2, 3]).buffer)

    syncNextPreload(vkTrack(10))
    await flush()
    expect(getPreloadDebugState().cachedBytes).toBeGreaterThan(0)
    expect(h.pending.has('https://cdn.example/a/segA1.ts')).toBe(true)

    // Switching next target to track 11 immediately evicts track 10 bytes and ignores late responses.
    h.setVkUrl('https://cdn.example/b/index.m3u8')
    h.setFile('https://cdn.example/b/index.m3u8', '#EXTM3U\n#EXTINF:4,\nsegB0.ts')
    syncNextPreload(vkTrack(11))
    expect(getPreloadDebugState().activeKey).toBe('1_11')
    expect(getPreloadDebugState().cachedBytes).toBe(0)

    // Late resolution of old segA1 must not re-enter bytesCache.
    h.pending.get('https://cdn.example/a/segA1.ts')?.resolve(new Uint8Array(100).buffer)
    await flush()
    expect(takePreloadedSource(vkTrack(10))).toBeNull()
    expect(getPreloadDebugState().activeKey).toBe('1_11')

    // Jumping manually to another key clears unmatched preload, but matching key preserves bytes.
    clearPreloadExcept('1_11')
    expect(getPreloadDebugState().activeKey).toBe('1_11')
    clearPreloadExcept('1_99')
    expect(getPreloadDebugState().activeKey).toBeNull()
    expect(getPreloadDebugState().cachedBytes).toBe(0)
  })

  test('enforces byte budget ceiling and supports direct non-HLS blob URLs and Spotify/SC DRM waveforms', async () => {
    h.setVkUrl('https://cdn.example/big/index.m3u8')
    h.setFile('https://cdn.example/big/index.m3u8', '#EXTM3U\n#EXTINF:4,\nbig1.ts\n#EXTINF:4,\nbig2.ts')
    h.setFile('https://cdn.example/big/big1.ts', new ArrayBuffer(MAX_PRELOAD_BYTES - 1024))
    h.setFile('https://cdn.example/big/big2.ts', new ArrayBuffer(5000))

    syncNextPreload(vkTrack(20))
    await flush()
    expect(getPreloadDebugState().cachedBytes).toBeLessThanOrEqual(MAX_PRELOAD_BYTES)

    // Direct non-HLS audio creates object URL once downloaded cleanly.
    const createObjSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock/direct-mp3')
    try {
      h.setVkUrl('https://cdn.example/direct/song.mp3')
      h.setFile('https://cdn.example/direct/song.mp3', new Uint8Array([0xff, 0xfb]).buffer)
      syncNextPreload(vkTrack(21))
      await flush()
      expect(takePreloadedBlobUrl('https://cdn.example/direct/song.mp3')).toBe('blob:mock/direct-mp3')
      expect(takePreloadedBlobUrl('https://cdn.example/direct/song.mp3')).toBeNull()
    } finally {
      createObjSpy.mockRestore()
    }

    // Spotify preload warms artwork + waveform + player track without streaming API side effects.
    spWarmCalls.length = 0
    syncNextPreload({
      ...vkTrack(22),
      service: 'spotify',
      key: 'sp_4cOdK2wGLETKBW3PvgPWqT',
      spotifyId: '4cOdK2wGLETKBW3PvgPWqT',
      url: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
    })
    await flush()
    expect(h.spotifyWaveCalls).toEqual(['4cOdK2wGLETKBW3PvgPWqT'])
    expect(spWarmCalls).toEqual(['4cOdK2wGLETKBW3PvgPWqT'])

    // SC DRM preload warms provider waveform as well.
    h.setScSource('https://cdn.example/sc/drm.m3u8', { system: 'widevine' }, 'https://wave.sndcdn.com/w.json')
    h.setFile('https://cdn.example/sc/drm.m3u8', '#EXTM3U')
    syncNextPreload({ ...vkTrack(23), service: 'sc', key: 'sc_23' })
    await flush()
    expect(h.scWaveCalls).toEqual(['https://wave.sndcdn.com/w.json'])
  })

  test('prefetches next-track lyrics into React Query for Spotify, VK, and SC and respects cancellation', async () => {
    lyricsMock.reset()
    queryClient.clear()

    // Spotify next track preloads lyrics alongside waveform and metadata
    syncNextPreload({
      ...vkTrack(30),
      service: 'spotify',
      key: 'sp_4cOdK2wGLETKBW3PvgPWqT',
      spotifyId: '4cOdK2wGLETKBW3PvgPWqT',
      url: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
      title: 'Spotify Next',
    })
    await flush()
    expect(lyricsMock.calls).toContain('sp_4cOdK2wGLETKBW3PvgPWqT')
    expect(queryClient.getQueryData(['lyrics', 'sp_4cOdK2wGLETKBW3PvgPWqT'])).toEqual({
      synced: true,
      lines: [{ text: 'Lyrics for Spotify Next' }],
    })

    // Cancelled/stale in-flight lyrics prefetch must not write into query cache for superseded track
    let resolveSlow!: (v: { synced: boolean; lines: { text: string }[] } | null) => void
    lyricsMock.setHandler(
      (t) =>
        t.key === '1_31'
          ? new Promise((r) => { resolveSlow = r })
          : Promise.resolve({ synced: true, lines: [{ text: `Lyrics for ${t.title}` }] }),
    )
    h.setVkUrl('https://cdn.example/c/index.m3u8')
    h.setFile('https://cdn.example/c/index.m3u8', '#EXTM3U')

    syncNextPreload(vkTrack(31))
    await flush()
    syncNextPreload(vkTrack(32))
    resolveSlow({ synced: true, lines: [{ text: 'Stale 31' }] })
    await flush()

    expect(queryClient.getQueryData(['lyrics', '1_31'])).toBeUndefined()
    expect(queryClient.getQueryData(['lyrics', '1_32'])).toEqual({
      synced: true,
      lines: [{ text: 'Lyrics for Track 32' }],
    })
  })
})
