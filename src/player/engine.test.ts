import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => {
  const hlsConfigs: unknown[] = []
  const hlsHandlers = new Map<string, ((ev: string, data?: unknown) => void)[]>()
  const invoke = vi.fn(async (cmd: string, args?: { request?: { kind?: string } }) => {
    if (cmd === 'spotify_status') {
      if (args?.request?.kind === 'play') return { ok: true }
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
    removeEventListener(ev: string, fn: () => void) {
      this.ls.get(ev)?.delete(fn)
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
  test('does not start an HLS stream if paused before its manifest arrives', () => {
    engine.load('https://cdn.example/song/playlist.m3u8', 0, true)
    const audio = engine.audio as unknown as InstanceType<typeof h.MockAudio>
    audio.play.mockClear()
    engine.pause()
    h.hlsHandlers.get('hlsManifestParsed')?.forEach((fn) => fn('hlsManifestParsed'))

    expect(audio.play).not.toHaveBeenCalled()
    expect(engine.waiting).toBe(false)
    engine.play()
    expect(audio.play).toHaveBeenCalledOnce()
  })

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

test('does not restart or report mismatch when Spotify plays a relinked track matching linkedFromTrackId or title+duration', async () => {
  const playRequests: Array<Record<string, unknown>> = []
  const invokeMock = h.invoke as unknown as {
    getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
    mockImplementation: (fn: (...a: unknown[]) => unknown) => void
  }
  const origImpl = invokeMock.getMockImplementation()
  invokeMock.mockImplementation(async (cmd: unknown, args?: unknown) => {
    if (cmd === 'spotify_status') {
      const req = (args as { request?: Record<string, unknown> } | undefined)?.request
      if (req?.kind === 'play') {
        playRequests.push(req)
        return { ok: true }
      }
      return {
        open: true,
        phase: 'ready',
        playing: true,
        startPending: false,
        lastPlayMethod: 'playerApi.play',
        lastShuffle: false,
        capped: false,
        nowPlaying: {
          trackId: '6RR877GSV9KPdtlXVRLOnz',
          linkedFromTrackId: '5rGvxjwi9MfQS3e1Oayh94',
          isAd: false,
          paused: false,
          title: 'Broken',
          artist: 'Rayo Oscuro',
          album: 'Broken',
          position: 4.1,
          duration: 165,
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
    engine.load('spotify:track:5rGvxjwi9MfQS3e1Oayh94', 0, true, {
      spotifyContextUri: 'spotify:playlist:0llppLP4LD7nTuEm9vXmtY',
      spotifyAlbumId: '1111111111111111111111',
      spotifyTitle: 'Broken',
      spotifyDuration: 165,
    })
    await vi.advanceTimersByTimeAsync(6000)
    expect(playRequests.length).toBe(1)
    expect(mismatches).toEqual([])
    expect(engine.position).toBeGreaterThanOrEqual(4)
  } finally {
    engine.onSpotifyMismatch = prevCb
    engine.stop()
    if (origImpl) invokeMock.mockImplementation(origImpl)
  }
})

describe('Engine crossfade', () => {
  test('smoothly ramps outgoing track volume down and incoming track volume up, then cleans up outgoing track', () => {
    engine.setVolume(1, false)
    engine.load('https://cdn.example/one.mp3', 0, true)
    const audio1 = engine.audio as unknown as InstanceType<typeof h.MockAudio>
    audio1.paused = false
    audio1.currentTime = 116
    engine.setPreFade(0.6)
    expect(audio1.volume).toBeCloseTo(0.6, 2)

    engine.prepareCrossfade(4)
    engine.load('https://cdn.example/two.mp3', 0, true)
    const audio2 = engine.audio as unknown as InstanceType<typeof h.MockAudio>

    expect(audio2).not.toBe(audio1)
    expect(audio1.pause).not.toHaveBeenCalled()
    expect(audio2.volume).toBeCloseTo(0, 2)
    expect(audio1.volume).toBeCloseTo(0.6, 2)

    vi.advanceTimersByTime(2000)
    expect(audio2.volume).toBeGreaterThan(0.45)
    expect(audio2.volume).toBeLessThan(0.6)
    expect(audio1.volume).toBeGreaterThan(0.1)
    expect(audio1.volume).toBeLessThan(0.3)

    vi.advanceTimersByTime(2100)
    expect(audio1.pause).toHaveBeenCalledTimes(1)
    expect(audio2.volume).toBeCloseTo(1, 2)
  })

  test('pausing mid-crossfade stops the fading-out track immediately', () => {
    engine.setVolume(1, false)
    engine.load('https://cdn.example/one.mp3', 0, true)
    const audio1 = engine.audio as unknown as InstanceType<typeof h.MockAudio>
    audio1.paused = false
    audio1.currentTime = 116

    engine.prepareCrossfade(4)
    engine.load('https://cdn.example/two.mp3', 0, true)
    vi.advanceTimersByTime(800)
    engine.pause()

    expect(audio1.pause).toHaveBeenCalledTimes(1)
    expect(engine.audio.volume).toBeCloseTo(1, 2)
  })

  const withInvokeMock = async (
    impl: (cmd: unknown, payload?: unknown) => Promise<unknown>,
    run: () => Promise<void>,
  ) => {
    const invokeMock = h.invoke as unknown as {
      getMockImplementation: () => ((...a: unknown[]) => unknown) | undefined
      mockImplementation: (fn: (...a: unknown[]) => unknown) => void
    }
    const origImpl = invokeMock.getMockImplementation()
    invokeMock.mockImplementation(impl)
    try {
      await run()
    } finally {
      if (origImpl) invokeMock.mockImplementation(origImpl)
    }
  }

  test('emits buffered for Spotify when confirmed playing past 2s even with small MSE buffer window', async () => {
    const onBuffered = vi.fn()
    const off = engine.on('buffered', onBuffered)
    try {
      await withInvokeMock(async (cmd, payload) => {
        const req = (payload as { request?: { kind?: string } } | undefined)?.request
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
              position: 4,
              duration: 180,
              buffered: 7,
            },
          }
        }
        return true
      }, async () => {
        engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
        await vi.advanceTimersByTimeAsync(950)
        expect(onBuffered).toHaveBeenCalledTimes(1)
      })
    } finally {
      off()
    }
  })

  test('emits ended when Spotify finishes a track and snaps position back to 0', async () => {
    let pos = 178
    let paused = false
    const onEnded = vi.fn()
    const off = engine.on('ended', onEnded)
    try {
      await withInvokeMock(async (cmd, payload) => {
        const req = (payload as { request?: { kind?: string } } | undefined)?.request
        if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
        if (cmd === 'spotify_status') {
          return {
            open: true,
            phase: 'ready',
            playing: !paused,
            nowPlaying: {
              trackId: '4cOdK2wGLETKBW3PvgPWqT',
              isAd: false,
              paused,
              title: 'Song',
              artist: 'Artist',
              position: pos,
              duration: 180,
              buffered: paused ? 0 : 180,
            },
          }
        }
        return true
      }, async () => {
        engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
        await vi.advanceTimersByTimeAsync(950)
        expect(onEnded).not.toHaveBeenCalled()

        pos = 0
        paused = true
        await vi.advanceTimersByTimeAsync(950)
        expect(onEnded).toHaveBeenCalledTimes(1)
      })
    } finally {
      off()
    }
  })

  test('pausing a Spotify track near the end does not advance it', async () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT'
    let paused = false
    const onEnded = vi.fn()
    const off = engine.on('ended', onEnded)
    try {
      await withInvokeMock(async (cmd, payload) => {
        if (cmd === 'spotify_status' && payload) return { ok: true }
        if (cmd === 'spotify_control') {
          if ((payload as { action?: string }).action === 'pause') paused = true
          return true
        }
        return { playing: !paused, nowPlaying: { trackId: id, position: 178, duration: 180, paused } }
      }, async () => {
        engine.load(`spotify:track:${id}`, 0, true)
        await vi.advanceTimersByTimeAsync(950)
        engine.pause()
        await vi.advanceTimersByTimeAsync(950)

        expect(engine.playing).toBe(false)
        expect(onEnded).not.toHaveBeenCalled()
      })
    } finally {
      off()
    }
  })

  test('resumes the selected Spotify track from a seek made while paused', async () => {
    const id = '4cOdK2wGLETKBW3PvgPWqT'
    const starts: number[] = []
    await withInvokeMock(async (cmd, payload) => {
      const request = (payload as { request?: { kind: string; startAt: number } } | undefined)?.request
      if (cmd === 'spotify_status' && request?.kind === 'play') {
        starts.push(request.startAt)
        return { ok: true }
      }
      if (cmd === 'spotify_control') return true
      return { playing: true, nowPlaying: { trackId: id, position: 36, duration: 180, paused: false } }
    }, async () => {
      engine.load(`spotify:track:${id}`, 0, true)
      await vi.advanceTimersByTimeAsync(950)
      engine.pause()
      engine.seek(175)
      await vi.advanceTimersByTimeAsync(3000)
      engine.play()
      await vi.advanceTimersByTimeAsync(0)

      expect(starts).toEqual([0, 175])
    })
  })

  test('reports a rejected Spotify start as a playback error', async () => {
    const onError = vi.fn()
    const off = engine.on('error', onError)
    try {
      await withInvokeMock(async () => ({ ok: false }), async () => {
        engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
        await vi.advanceTimersByTimeAsync(0)
        expect(onError).toHaveBeenCalledOnce()
        expect(engine.waiting).toBe(false)
      })
    } finally {
      off()
    }
  })

  test('attempts auto-resume on unexpected mid-track Spotify pause while respecting manual pause', async () => {
    let paused = false
    const controls: string[] = []
    await withInvokeMock(async (cmd, payload) => {
      const req = (payload as { request?: { kind?: string } } | undefined)?.request
      if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
      if (cmd === 'spotify_control') {
        const action = String((payload as { action?: string } | undefined)?.action ?? '')
        controls.push(action)
        if (action === 'play') paused = false
        return true
      }
      if (cmd === 'spotify_status') {
        return {
          open: true,
          phase: 'ready',
          playing: !paused,
          nowPlaying: {
            trackId: '4cOdK2wGLETKBW3PvgPWqT',
            isAd: false,
            paused,
            title: 'Song',
            artist: 'Artist',
            position: 42,
            duration: 180,
            buffered: 60,
          },
        }
      }
      return true
    }, async () => {
      engine.load('spotify:track:4cOdK2wGLETKBW3PvgPWqT', 0, true)
      await vi.advanceTimersByTimeAsync(950)
      expect(engine.playing).toBe(true)

      // Unexpected WebView pause mid-track without user action triggers auto-resume on 2nd poll.
      paused = true
      await vi.advanceTimersByTimeAsync(1900)
      expect(controls).toContain('play')
      expect(paused).toBe(false)

      // Manual pause disables auto-resume.
      controls.length = 0
      engine.pause()
      paused = true
      await vi.advanceTimersByTimeAsync(2800)
      expect(controls.filter((a) => a === 'play')).toHaveLength(0)
    })
  })

  test('emits ended when Spotify auto-advances to another track with endedTrackId even 6s before nominal duration', async () => {
    const idA = '13qpCQkqSTI37Um7UyOBBt'
    const idBleed = '9999999999999999999999'
    let currentNp: Record<string, unknown> = {
      trackId: idA,
      isAd: false,
      paused: false,
      title: 'My Roots',
      artist: 'Lil Bo Weep',
      position: 292,
      duration: 298,
      buffered: 298,
    }
    let endedTrackId: string | null = null
    const onEnded = vi.fn()
    const onMismatch = vi.fn()
    const offEnded = engine.on('ended', onEnded)
    const prevMismatch = engine.onSpotifyMismatch
    engine.onSpotifyMismatch = onMismatch
    try {
      await withInvokeMock(async (cmd, payload) => {
        const req = (payload as { request?: { kind?: string } } | undefined)?.request
        if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
        if (cmd === 'spotify_status') {
          return {
            open: true,
            phase: 'ready',
            playing: !(currentNp.paused as boolean),
            endedTrackId,
            nowPlaying: currentNp,
          }
        }
        return true
      }, async () => {
        engine.load(`spotify:track:${idA}`, 0, true)
        await vi.advanceTimersByTimeAsync(950)
        expect(engine.playing).toBe(true)

        currentNp = {
          trackId: idBleed,
          isAd: false,
          paused: true,
          trackEnded: true,
          endedTrackId: idA,
          title: 'Guitar Bleed',
          artist: 'Other',
          position: 0.1,
          duration: 190,
          buffered: 0,
        }
        endedTrackId = idA
        await vi.advanceTimersByTimeAsync(950)
        expect(onEnded).toHaveBeenCalledTimes(1)
        expect(onMismatch).not.toHaveBeenCalled()
      })
    } finally {
      offEnded()
      engine.onSpotifyMismatch = prevMismatch
      engine.stop()
    }
  })

  test('advances position smoothly on next Spotify track after brief pause during handoff', async () => {
    const idB = '612QrhJo7loQ6s7qC7dMdF'
    let pollStep = 0
    await withInvokeMock(async (cmd, payload) => {
      const req = (payload as { request?: { kind?: string } } | undefined)?.request
      if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
      if (cmd === 'spotify_status') {
        pollStep += 1
        if (pollStep === 1) {
          return {
            open: true,
            phase: 'ready',
            playing: false,
            nowPlaying: {
              trackId: idB,
              isAd: false,
              paused: true,
              title: 'With Me',
              artist: 'weeklyn, Jaysset',
              position: 0,
              duration: 202,
              buffered: 10,
            },
          }
        }
        return {
          open: true,
          phase: 'ready',
          playing: true,
          nowPlaying: {
            trackId: idB,
            isAd: false,
            paused: false,
            title: 'With Me',
            artist: 'weeklyn, Jaysset',
            position: 0.9 + (pollStep - 2) * 0.9,
            duration: 202,
            buffered: 30,
          },
        }
      }
      return true
    }, async () => {
      engine.load(`spotify:track:${idB}`, 0, true, { spotifyTitle: 'With Me', spotifyDuration: 202 })
      await vi.advanceTimersByTimeAsync(950)
      expect(engine.waiting).toBe(true)

      await vi.advanceTimersByTimeAsync(1900)
      expect(engine.waiting).toBe(false)
      expect(engine.playing).toBe(true)
      expect(engine.position).toBeGreaterThan(1.5)
    })
    engine.stop()
  })

  test('emits ended when Spotify stops in the final second or stalls at the end boundary without resetting to 0', async () => {
    const idA = '13qpCQkqSTI37Um7UyOBBt'
    let paused = false
    let pos = 297.6
    let trackEnded = false
    const onEnded = vi.fn()
    const offEnded = engine.on('ended', onEnded)
    try {
      await withInvokeMock(async (cmd, payload) => {
        const req = (payload as { request?: { kind?: string } } | undefined)?.request
        if (cmd === 'spotify_status' && req?.kind === 'play') return { ok: true }
        if (cmd === 'spotify_status') {
          return {
            open: true,
            phase: 'ready',
            playing: !paused,
            nowPlaying: {
              trackId: idA,
              isAd: false,
              paused,
              trackEnded,
              title: 'My Roots',
              artist: 'Lil Bo Weep',
              position: pos,
              duration: 298,
              buffered: 298,
            },
          }
        }
        return true
      }, async () => {
        // Case 1: WebView stalls at 297.6 / 298 (4:57 / -0:00) with paused=false and no trackEnded flag.
        engine.load(`spotify:track:${idA}`, 296, true, { spotifyTitle: 'My Roots', spotifyDuration: 298 })
        await vi.advanceTimersByTimeAsync(950)
        expect(onEnded).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(2500)
        expect(onEnded).toHaveBeenCalledTimes(1)

        // Case 2: WebView pauses cleanly at 297.5 / 298 without snapping position back to 0.
        onEnded.mockClear()
        pos = 297.5
        paused = false
        trackEnded = false
        engine.load(`spotify:track:${idA}`, 296, true, { spotifyTitle: 'My Roots', spotifyDuration: 298 })
        await vi.advanceTimersByTimeAsync(950)
        paused = true
        await vi.advanceTimersByTimeAsync(950)
        expect(onEnded).toHaveBeenCalledTimes(1)

        // Case 3: trackEnded=true ends immediately even if paused lags false.
        onEnded.mockClear()
        pos = 297.8
        paused = false
        trackEnded = false
        engine.load(`spotify:track:${idA}`, 296, true, { spotifyTitle: 'My Roots', spotifyDuration: 298 })
        await vi.advanceTimersByTimeAsync(950)
        trackEnded = true
        await vi.advanceTimersByTimeAsync(400)
        expect(onEnded).toHaveBeenCalledTimes(1)
      })
    } finally {
      offEnded()
      engine.stop()
    }
  })
})
