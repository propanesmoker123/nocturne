import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => {
  const hlsConfigs: unknown[] = []
  const hlsHandlers = new Map<string, ((ev: string, data?: unknown) => void)[]>()
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'spotify_status') {
      return {
        open: true,
        phase: 'ready',
        playing: true,
        nowPlaying: {
          trackId: '4cOdK2wGLETKBW3PvgPWqT',
          isAd: false,
          paused: false,
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          position: 4,
          duration: 180,
          buffered: 20.5,
        },
      }
    }
    return true
  })

  class MockAudio {
    private ls = new Map<string, Set<() => void>>()
    preload = 'auto'
    src = ''
    volume = 1
    muted = false
    paused = false
    currentTime = 0
    duration = 120
    readyState = 4
    seeking = false
    error: { message: string } | null = null
    buffered = {
      length: 1,
      start: (_i: number) => 0,
      end: (_i: number) => 0,
    }
    addEventListener(ev: string, fn: () => void) {
      if (!this.ls.has(ev)) this.ls.set(ev, new Set())
      this.ls.get(ev)!.add(fn)
    }
    fire(ev: string) {
      this.ls.get(ev)?.forEach((f) => f())
    }
    play = vi.fn(async () => { this.paused = false; this.fire('play') })
    pause = vi.fn(() => { this.paused = true; this.fire('pause') })
    removeAttribute() {}
    load() {}
  }

  class MockHls {
    static isSupported() { return true }
    static Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      BUFFER_EOS: 'hlsBufferEos',
      FRAG_BUFFERED: 'hlsFragBuffered',
      ERROR: 'hlsError',
    }
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' }
    static DefaultConfig = { loader: class {} }
    constructor(cfg: unknown) {
      hlsConfigs.push(cfg)
      hlsHandlers.clear()
    }
    on(ev: string, fn: (ev: string, data?: unknown) => void) {
      if (!hlsHandlers.has(ev)) hlsHandlers.set(ev, [])
      hlsHandlers.get(ev)!.push(fn)
    }
    loadSource() {}
    attachMedia() {}
    destroy() {}
    recoverMediaError() {}
  }

  return { hlsConfigs, hlsHandlers, invoke, MockAudio, MockHls }
})

vi.mock('hls.js', () => ({ default: h.MockHls }))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, invoke: h.invoke }))
vi.mock('./preload', () => ({
  getPreloadedResource: () => null,
  takePreloadedBlobUrl: () => null,
}))

;(globalThis as Record<string, unknown>).Audio = h.MockAudio
const { engine } = await import('./engine')

beforeEach(() => {
  vi.useFakeTimers()
  h.hlsConfigs.length = 0
  h.hlsHandlers.clear()
  h.invoke.mockClear()
  engine.stop()
})

afterEach(() => {
  engine.stop()
  vi.useRealTimers()
})

describe('Engine seek and buffering', () => {
  test('configures Hls to keep full back/forward buffer and emits buffered on BUFFER_EOS', () => {
    const audio = engine.audio as unknown as InstanceType<typeof h.MockAudio>
    audio.duration = 200
    audio.buffered = { length: 1, start: () => 0, end: () => 40 }

    let bufferedCount = 0
    const off = engine.on('buffered', () => { bufferedCount++ })
    try {
      engine.load('https://cdn.example/song/playlist.m3u8', 0, true)
      expect(h.hlsConfigs[0]).toMatchObject({
        backBufferLength: 600,
        maxBufferLength: 600,
        startFragPrefetch: true,
        maxBufferHole: 0.25,
      })

      // Not full yet at 40 / 200.
      h.hlsHandlers.get('hlsFragBuffered')?.forEach((fn) => fn('hlsFragBuffered'))
      expect(bufferedCount).toBe(0)

      // BUFFER_EOS signals complete load once per track.
      h.hlsHandlers.get('hlsBufferEos')?.forEach((fn) => fn('hlsBufferEos'))
      h.hlsHandlers.get('hlsBufferEos')?.forEach((fn) => fn('hlsBufferEos'))
      expect(bufferedCount).toBe(1)
    } finally {
      off()
    }
  })

  test('suppresses transient waiting spinner within 350ms when seeking inside buffered audio, then restores it if still unready', () => {
    const audio = engine.audio as unknown as InstanceType<typeof h.MockAudio>
    audio.duration = 180
    audio.paused = false
    audio.readyState = 4
    audio.buffered = { length: 1, start: () => 0, end: () => 90 }

    let loadingEvents = 0
    const off = engine.on('loading', () => { loadingEvents++ })
    try {
      engine.load('https://cdn.example/track.mp3', 0, true)
      audio.readyState = 1
      engine.seek(30)
      expect(engine.waiting).toBe(false)

      // After the 350ms seek grace window, still unready audio accurately reports waiting.
      vi.advanceTimersByTime(360)
      expect(engine.waiting).toBe(true)
      expect(loadingEvents).toBeGreaterThanOrEqual(2)
    } finally {
      off()
    }
  })

  test('tracks real Spotify buffered range instead of faking duration and triggers buffered once lookahead settles', async () => {
    let bufferedCount = 0
    const off = engine.on('buffered', () => { bufferedCount++ })
    try {
      engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
      await vi.advanceTimersByTimeAsync(950)
      expect(engine.duration).toBe(180)
      expect(engine.buffered).toBe(20.5)
      expect(bufferedCount).toBe(1)
    } finally {
      off()
    }
  })
})

test('short Spotify seek holds seek target smoothly until settled within 0.85s after 120ms', async () => {
  let reportedPos = 10
  const invokeMock = h.invoke as unknown as {
    getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
    mockImplementation: (fn: (...a: unknown[]) => unknown) => void
  }
  const origImpl = invokeMock.getMockImplementation()
  invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
    const req = (args as { request?: { kind?: string } } | undefined)?.request
    if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
    if (cmd === 'spotify_status') {
      return {
        open: true,
        phase: 'ready',
        playing: true,
        nowPlaying: {
          trackId: '4cOdK2wGLETKBW3PvgPWqT',
          isAd: false,
          paused: false,
          title: 'Song',
          artist: 'Artist',
          album: 'Album',
          position: reportedPos,
          duration: 180,
          buffered: 25,
        },
      }
    }
    return true
  })

  try {
    engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
    await vi.advanceTimersByTimeAsync(950)
    expect(engine.position).toBeGreaterThanOrEqual(10)

    // Align right before the next 900ms poll (t = 1800ms) so the poll sees seekAge = 50ms < 120ms.
    await vi.advanceTimersByTimeAsync(800)
    engine.seek(10.6)
    expect(engine.position).toBe(10.6)

    // Stale pre-seek position (10.0) is within 0.85s of 10.6, yet seekAge < 120ms prevents snap-back.
    await vi.advanceTimersByTimeAsync(60)
    expect(engine.position).toBeGreaterThanOrEqual(10.6)

    // Once seekAge >= 120ms and Spotify reports a settled position within 0.85s of target, seek settles cleanly.
    reportedPos = 11.2
    await vi.advanceTimersByTimeAsync(900)
    expect(engine.position).toBeGreaterThanOrEqual(11.2)
    expect(engine.position).toBeLessThan(12.2)
  } finally {
    engine.stop()
    if (origImpl) invokeMock.mockImplementation(origImpl)
  }
})

test('holds seek target during async <audio> seeking or pre-keyframe snapback, then follows playback', () => {
  const audio = engine.audio as unknown as InstanceType<typeof h.MockAudio>
  audio.duration = 180
  audio.paused = false
  audio.readyState = 4
  audio.currentTime = 12

  engine.load('https://cdn.example/track.mp3', 0, true)
  audio.seeking = true
  engine.seek(50.085)
  // Browser briefly reports pre-seek currentTime while still seeking.
  audio.currentTime = 12
  expect(engine.getPlaybackPositionMs()).toBe(50085)

  // Decoder finishes seeking on an earlier AAC keyframe (-90ms).
  audio.seeking = false
  audio.currentTime = 49.995
  expect(engine.getPlaybackPositionMs()).toBe(50085)

  // Once playback crosses target - 40ms, engine follows real audio clock cleanly.
  vi.advanceTimersByTime(150)
  audio.currentTime = 50.12
  expect(engine.getPlaybackPositionMs()).toBe(50120)
})

test('does not stop Spotify playback after 3.5s while startPending retries Connect device, then settles once playing', async () => {
  let playingNow = false
  let startPending = true
  let posNow = 0
  const invokeMock = h.invoke as unknown as {
    getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
    mockImplementation: (fn: (...a: unknown[]) => unknown) => void
  }
  const origImpl = invokeMock.getMockImplementation()
  invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
    const req = (args as { request?: { kind?: string } } | undefined)?.request
    if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
    if (cmd === 'spotify_status') {
      return {
        open: true,
        phase: 'ready',
        playing: playingNow,
        startPending,
        nowPlaying: {
          trackId: '4cOdK2wGLETKBW3PvgPWqT',
          isAd: false,
          paused: !playingNow,
          title: 'Righteous',
          artist: 'Mo Beats',
          album: 'Righteous',
          position: posNow,
          duration: 177,
          buffered: playingNow ? 20 : 0,
        },
      }
    }
    return true
  })

  try {
    engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
    // Even after 4.5s (> old 3.5s grace), startPending keeps the track alive & waiting instead of stopping.
    await vi.advanceTimersByTimeAsync(4600)
    expect(engine.playing).toBe(true)
    expect(engine.waiting).toBe(true)

    // Spotify Connect finishes device setup at ~5.4s.
    playingNow = true
    startPending = false
    posNow = 1.4
    await vi.advanceTimersByTimeAsync(1000)
    expect(engine.playing).toBe(true)
    expect(engine.waiting).toBe(false)
    expect(engine.position).toBeGreaterThanOrEqual(1.4)
  } finally {
    engine.stop()
    if (origImpl) invokeMock.mockImplementation(origImpl)
  }
})

test('switching Spotify tracks ignores stale near-end previous track before target track takes over', async () => {
  let currentId = '1111111111111111111111'
  let posNow = 176
  const invokeMock = h.invoke as unknown as {
    getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
    mockImplementation: (fn: (...a: unknown[]) => unknown) => void
  }
  const origImpl = invokeMock.getMockImplementation()
  invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
    const req = (args as { request?: { kind?: string } } | undefined)?.request
    if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
    if (cmd === 'spotify_status') {
      return {
        open: true,
        phase: 'ready',
        playing: true,
        startPending: currentId !== '2222222222222222222222',
        nowPlaying: {
          trackId: currentId,
          isAd: false,
          paused: false,
          title: currentId === '1111111111111111111111' ? 'Old' : 'New',
          artist: 'Artist',
          album: 'Album',
          position: posNow,
          duration: 180,
          buffered: 20,
        },
      }
    }
    return true
  })

  let endedCount = 0
  const off = engine.on('ended', () => { endedCount++ })
  try {
    engine.load('spotify:track:2222222222222222222222', 0, true)
    await vi.advanceTimersByTimeAsync(1900)
    // Stale near-end previous track must NOT overwrite new track's position or trigger premature stop/ended.
    expect(engine.position).toBeLessThan(5)
    expect(endedCount).toBe(0)
    // Switch completes to the requested track at t=2.7s — must NOT emit false 'ended' for the old track!
    currentId = '2222222222222222222222'
    posNow = 0.5
    await vi.advanceTimersByTimeAsync(1000)
    expect(endedCount).toBe(0)
    expect(engine.playing).toBe(true)
    expect(engine.position).toBeLessThan(5)
  } finally {
    off()
    engine.stop()
    if (origImpl) invokeMock.mockImplementation(origImpl)
  }
})

test('does not let Spotify pre-target keyframe quantization snap lyric position backward onto previous line', async () => {
  let reportedPos = 15
  const invokeMock = h.invoke as unknown as {
    getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
    mockImplementation: (fn: (...a: unknown[]) => unknown) => void
  }
  const origImpl = invokeMock.getMockImplementation()
  invokeMock.mockImplementation(async (cmd: unknown, payload?: unknown) => {
    const req = (payload as { request?: { kind?: string } } | undefined)?.request
    if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
    if (cmd === 'spotify_status' && !payload) {
      return {
        phase: 'ready',
        account: 'in',
        playing: true,
        nowPlaying: {
          trackId: '4cOdK2wGLETKBW3PvgPWqT',
          isAd: false,
          paused: false,
          title: 'Track',
          artist: 'Artist',
          album: 'Album',
          position: reportedPos,
          duration: 180,
          buffered: 90,
        },
      }
    }
    return true
  })

  try {
    engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
    await vi.advanceTimersByTimeAsync(1100)
    // Click lyric line beginning at 40.000s (lineSeekSeconds -> 40.085s)
    engine.seek(40.085)
    // Decoder reports 39.96s (125ms earlier than target -> before 40.000s line begin!)
    reportedPos = 39.96
    await vi.advanceTimersByTimeAsync(900)
    expect(engine.getPlaybackPositionMs()).toBeGreaterThanOrEqual(40085)
  } finally {
    engine.stop()
    if (origImpl) invokeMock.mockImplementation(origImpl)
  }
})

test('does not drop <audio> position backward onto an earlier HLS keyframe around t=1s after seek', () => {
  const audio = engine.audio as unknown as InstanceType<typeof h.MockAudio>
  audio.duration = 180
  audio.paused = false
  audio.readyState = 4
  audio.currentTime = 85

  engine.load('https://cdn.example/track.mp3', 0, true)
  audio.seeking = true
  engine.seek(32.085)
  audio.currentTime = 31.45

  // Even at t=1100ms when decoder only reached 31.85s (still before 32.085 target), position must never snap backwards!
  vi.advanceTimersByTime(1100)
  audio.seeking = false
  audio.currentTime = 31.85
  expect(engine.getPlaybackPositionMs()).toBe(32085)

  // Once playback naturally advances past 32.085s, real clock resumes smoothly.
  vi.advanceTimersByTime(300)
  audio.currentTime = 32.15
  expect(engine.getPlaybackPositionMs()).toBe(32150)
})

test('retries Spotify track with contextUri on track mismatch and reports persistent mismatch once', async () => {
  const playRequests: Array<Record<string, unknown>> = []
  const invokeMock = h.invoke as unknown as {
    getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
    mockImplementation: (fn: (...a: unknown[]) => unknown) => void
  }
  const origImpl = invokeMock.getMockImplementation()
  invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
    const req = (args as { request?: Record<string, unknown> } | undefined)?.request
    if (cmd === 'spotify_status' && req?.kind === 'play') {
      playRequests.push(req)
      return { ok: true }
    }
    if (cmd === 'spotify_status') {
      return {
        open: true,
        phase: 'ready',
        playing: true,
        startPending: false,
        lastPlayMethod: 'harmony.playURI',
        lastShuffle: false,
        capped: false,
        nowPlaying: {
          trackId: '9999999999999999999999',
          isAd: false,
          paused: false,
          title: 'Random Song',
          artist: 'Someone',
          album: 'Radio',
          position: 4.2,
          duration: 190,
          buffered: 25,
        },
      }
    }
    return true
  })

  const mismatches: Array<{ requestedId: string; actualId: string }> = []
  const prevCb = engine.onSpotifyMismatch
  engine.onSpotifyMismatch = (info) => mismatches.push(info)
  try {
    engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true, {
      spotifyContextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
      spotifyAlbumId: '1111111111111111111111',
      spotifyUid: 'uid-1',
    })
    await vi.advanceTimersByTimeAsync(4600)
    expect(playRequests.length).toBe(2)
    expect(playRequests[0].preferContext).toBeUndefined()
    expect(playRequests[1]).toMatchObject({
      contextUri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
      trackUid: 'uid-1',
      preferContext: true,
    })

    await vi.advanceTimersByTimeAsync(4600)
    expect(mismatches).toEqual([{ requestedId: '4cOdK2wGLETKBW3PvgPWqT', actualId: '9999999999999999999999' }])
  } finally {
    engine.onSpotifyMismatch = prevCb
    engine.stop()
    if (origImpl) invokeMock.mockImplementation(origImpl)
  }
})
