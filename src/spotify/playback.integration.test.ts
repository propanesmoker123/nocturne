/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const filterSource = readFileSync(new URL('../../src-tauri/src/spotify/filter.js', import.meta.url), 'utf8')

interface LabHandle {
  configure(enabled: boolean): void
  stats(): Record<string, unknown>
  playing(): boolean | null
  nowPlaying(): Record<string, unknown> | null
  account(): string | null
  playTrack(id: string, startAt?: number, vol?: number, muted?: boolean, ctx?: unknown): boolean
  setVolume(vol: number, muted?: boolean): boolean
  control(action: string, value?: number): boolean
}

class LiveMockAudio extends EventTarget {
  _vol = 1
  _muted = false
  paused = true
  ended = false
  loop = false
  isConnected = true
  tagName = 'AUDIO'
  currentTime = 0
  duration = 180
  playbackRate = 1
  readyState = 4
  mediaKeys: object | null = {}
  bufEnd = 180
  nativePlayCalls = 0
  pauseCalls = 0
  src = ''
  preload = 'auto'
  seeking = false
  error: { message: string } | null = null
  get buffered() {
    return { length: this.bufEnd > 0 ? 1 : 0, start: () => 0, end: () => this.bufEnd }
  }
  get volume() { return this._vol }
  set volume(v: number) { this._vol = v }
  get muted() { return this._muted }
  set muted(m: boolean) { this._muted = m }
  play() {
    this.nativePlayCalls++
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  pause() {
    this.pauseCalls++
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  removeAttribute() {}
  load() {}
}

class MainWindowAudio extends EventTarget {
  volume = 1
  muted = false
  paused = true
  ended = false
  currentTime = 0
  duration = 139
  readyState = 4
  preload = 'auto'
  src = ''
  seeking = false
  error: { message: string } | null = null
  buffered = { length: 1, start: () => 0, end: () => 139 }
  play() {
    this.paused = false
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  pause() {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  removeAttribute() {}
  load() {}
}

function createSpotifyVm() {
  class SpotifyMediaElement extends LiveMockAudio {}
  class SliderInput extends EventTarget {
    min = '0'
    max = '180000'
    step = '1000'
    disabled = false
    _value = '0'
    get value() { return this._value }
    set value(v: string) { this._value = v }
  }
  class Socket extends EventTarget {
    static OPEN = 1
    readonly url: string
    constructor(url: string) { super(); this.url = url }
    send() {}
  }
  const slider = new SliderInput()
  const audioEl = new SpotifyMediaElement()
  const adAudioEl = new SpotifyMediaElement()
  adAudioEl.mediaKeys = null
  adAudioEl.duration = 29
  adAudioEl.bufEnd = 29
  let activeEls: LiveMockAudio[] = [audioEl]
  let widgetLabel = ''
  let widgetTitle = ''
  let posText = '0:00'
  let durText = '3:00'
  const mediaSession = {
    playbackState: 'paused',
    metadata: { title: '', artist: '', album: '', artwork: [] as unknown[] },
  }
  const widget = {
    getAttribute: (name: string) => (name === 'aria-label' ? widgetLabel : null),
    querySelector: (sel: string) => (sel === '[data-testid="context-item-info-title"]' ? { textContent: widgetTitle } : null),
    querySelectorAll: () => [],
  }
  const doc = {
    querySelector: (sel: string) => {
      if (sel === '[data-testid="playback-progressbar"]') return { querySelector: () => slider }
      if (sel === '[data-testid="playback-position"]') return { textContent: posText }
      if (sel === '[data-testid="playback-duration"]') return { textContent: durText }
      if (sel === '[data-testid="now-playing-widget"]') return widget
      return null
    },
    querySelectorAll: (sel: string) => (sel.replace(/\s+/g, '') === 'audio,video' ? activeEls : []),
    createElement: (tag: string) => {
      const m = new SpotifyMediaElement()
      m.tagName = tag.toUpperCase()
      return m
    },
  }
  const win = {
    location: { origin: 'https://open.spotify.com', pathname: '/' },
    fetch: async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    WebSocket: Socket,
    document: doc,
    navigator: { mediaSession },
    HTMLMediaElement: SpotifyMediaElement,
    HTMLInputElement: SliderInput,
  } as unknown as Window & { __nocturneSpotifyLab: LabHandle }

  const intervals: Array<ReturnType<typeof setInterval>> = []
  const trackedSetInterval = (fn: () => void, ms?: number) => {
    const id = setInterval(fn, ms)
    intervals.push(id)
    return id
  }

  runInNewContext(filterSource, {
    window: win,
    document: doc,
    navigator: win.navigator,
    HTMLMediaElement: SpotifyMediaElement,
    HTMLInputElement: SliderInput,
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    MessageEvent,
    Event,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval: trackedSetInterval,
    clearInterval,
  })

  const lab = win.__nocturneSpotifyLab
  const listeners = new Map<string, Array<(ev: unknown) => void>>()
  const playCalls: Array<{ uri: string; opts: Record<string, unknown> }> = []
  let pauseCalls = 0
  let nextCalls = 0
  const hState: {
    duration: number
    position: number
    timestamp: number
    paused: boolean
    loading: boolean
    playback_speed: number
    track_window: {
      current_track: { uri: string; name: string; artists?: Array<{ name: string }> } | null
      previous_tracks: Array<{ uri: string }>
    }
  } = {
    duration: 180000,
    position: 0,
    timestamp: Date.now(),
    paused: true,
    loading: false,
    playback_speed: 1,
    track_window: { current_track: null, previous_tracks: [] },
  }

  let onPlayUri: ((uri: string, opts: Record<string, unknown>) => Promise<void> | void) | null = null
  const host = Object.create(Object.getPrototypeOf(lab.stats())) as Record<string, unknown>
  host._harmony = {
    playTracks: async () => {},
    playURI: async (uri: string, _dev: unknown, opts: Record<string, unknown>) => {
      playCalls.push({ uri, opts })
      if (onPlayUri) await onPlayUri(uri, opts)
    },
    pause: () => {
      pauseCalls++
      hState.paused = true
      audioEl.paused = true
    },
    resume: () => {
      hState.paused = false
      audioEl.paused = false
    },
    nextTrack: () => {
      nextCalls++
    },
    seek: (ms: number) => {
      hState.position = ms
      hState.timestamp = Date.now()
    },
    addListener: (ev: string, fn: (e: unknown) => void) => {
      const list = listeners.get(ev) ?? []
      list.push(fn)
      listeners.set(ev, list)
    },
    _controller: {
      _state: hState,
      playURI: async (uri: string, _dev: unknown, opts: Record<string, unknown>) => {
        playCalls.push({ uri, opts })
        if (onPlayUri) await onPlayUri(uri, opts)
      },
      pause: () => {
        pauseCalls++
        hState.paused = true
        audioEl.paused = true
      },
      seek: (ms: number) => {
        hState.position = ms
        hState.timestamp = Date.now()
      },
    },
  }

  const emit = (ev: string, payload: unknown) => {
    for (const fn of listeners.get(ev) ?? []) fn(payload)
  }

  return {
    lab,
    hState,
    slider,
    audioEl,
    adAudioEl,
    mediaSession,
    playCalls,
    get pauseCalls() { return pauseCalls },
    get nextCalls() { return nextCalls },
    setActiveEls(list: LiveMockAudio[]) { activeEls = list },
    setDomMeta(opts: { label?: string; title?: string; pos?: string; dur?: string; sliderMs?: number }) {
      if (opts.label !== undefined) widgetLabel = opts.label
      if (opts.title !== undefined) widgetTitle = opts.title
      if (opts.pos !== undefined) posText = opts.pos
      if (opts.dur !== undefined) durText = opts.dur
      if (opts.sliderMs !== undefined) slider.value = String(opts.sliderMs)
    },
    setOnPlayUri(fn: ((uri: string, opts: Record<string, unknown>) => Promise<void> | void) | null) {
      onPlayUri = fn
    },
    emitState() {
      emit('state_changed', { data: { state: hState } })
    },
    emitError(code: string, message: string) {
      emit('error', { data: { error: { code, message } } })
    },
    dispose() {
      for (const id of intervals) clearInterval(id)
    },
    buildStatus() {
      return {
        open: true,
        phase: 'ready',
        drm: true,
        account: 'in',
        playing: lab.playing(),
        nowPlaying: lab.nowPlaying(),
        ...lab.stats(),
      }
    },
  }
}

const harness = vi.hoisted(() => ({
  vm: null as ReturnType<typeof createSpotifyVm> | null,
}))

vi.mock('../lib/tauri', () => ({
  isTauri: () => true,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    const vm = harness.vm
    if (!vm) return cmd === 'spotify_control' ? false : { open: false }
    if (cmd === 'spotify_control') {
      return vm.lab.control(String(args?.action ?? ''), typeof args?.value === 'number' ? args.value : undefined)
    }
    if (cmd === 'spotify_status') {
      const req = args?.request as Record<string, unknown> | undefined
      if (req?.kind === 'play') {
        const ok = vm.lab.playTrack(
          String(req.id ?? ''),
          Number(req.startAt) || 0,
          typeof req.volume === 'number' ? req.volume : undefined,
          typeof req.muted === 'boolean' ? req.muted : undefined,
          { contextUri: req.contextUri, albumId: req.albumId, trackUid: req.trackUid, preferContext: req.preferContext },
        )
        return { ok }
      }
      if (req?.kind === 'volume') {
        return { ok: vm.lab.setVolume(Number(req.volume) || 0, Boolean(req.muted)) }
      }
      if (req?.kind === 'warm') {
        const id = typeof req.id === 'string' && req.id ? req.id : null
        return { ok: (vm.lab as unknown as { warmNextTrack: (id: string | null) => boolean }).warmNextTrack(id) }
      }
      return vm.buildStatus()
    }
    return true
  },
}))
vi.mock('hls.js', () => ({ default: { isSupported: () => false, Events: {}, ErrorTypes: {}, DefaultConfig: { loader: class {} } } }))
vi.mock('../player/preload', () => ({
  clearPreload() {},
  clearPreloadExcept() {},
  syncNextPreload() {},
  takePreloadedSource: () => null,
  takePreloadedBlobUrl: () => null,
}))
vi.mock('../player/waveform', () => ({ beginWaveform() {}, captureSource() {}, clearWaveformCapture() {} }))
vi.mock('../app/toast', () => ({ toast: vi.fn() }))
vi.mock('../lib/journal', () => ({ journal: vi.fn() }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => null, saveJSON: async () => {}, debouncedSaver: () => ({ save() {}, flush() {} }) }))
vi.mock('../vk/api', () => ({ getByIds: async (ts: Track[]) => ts, getStreamMix: async () => [] }))

;(globalThis as Record<string, unknown>).Audio = MainWindowAudio

const { engine } = await import('../player/engine')
const { usePlayer, livePlaybackPositionMs } = await import('../player/store')
const { releaseSpotifyPlayback, spotifyOwnsPlayback, spotifyStatus, startSpotifyBridge, useSpotify } = await import('./runtime')

const spTrack = (spotifyId: string, title: string, duration = 180): Track => ({
  id: Number.parseInt(spotifyId.slice(0, 6), 36),
  ownerId: 0,
  key: `sp_${spotifyId}`,
  service: 'spotify',
  spotifyId,
  title,
  artist: 'Artist',
  artists: [{ name: 'Artist' }],
  duration,
  url: `spotify:track:${spotifyId}`,
  urlFetchedAt: Date.now(),
  playable: true,
  explicit: false,
  hasLyrics: true,
  liked: false,
})

const vkTrack = (id: number, title: string): Track => ({
  id,
  ownerId: 1,
  key: `1_${id}`,
  service: 'vk',
  title,
  artist: 'Ny.Daad',
  artists: [{ name: 'Ny.Daad' }],
  duration: 139,
  url: `https://cdn.vk.test/${id}.mp3`,
  urlFetchedAt: Date.now(),
  playable: true,
  explicit: false,
  hasLyrics: false,
  liked: false,
})

let stopBridge: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  releaseSpotifyPlayback()
  harness.vm = createSpotifyVm()
  engine.stop()
  usePlayer.setState({ queue: null, current: null, source: null, isPlaying: false, isLoading: false, position: 0, duration: 0, buffered: 0 })
  stopBridge = startSpotifyBridge()
})

afterEach(() => {
  stopBridge?.()
  stopBridge = null
  engine.stop()
  releaseSpotifyPlayback()
  harness.vm?.dispose()
  harness.vm = null
  vi.useRealTimers()
})

describe('Live E2E Spotify playback integration (filter.js + engine + runtime + store)', () => {
  test('switching from m3 killa laharl at 90s to next Spotify track NEVER jumps lyrics or progress to 90s even with lagging DOM + Harmony frame', async () => {
    const vm = harness.vm!
    const idA = '1111111111111111111111'
    const idB = '2222222222222222222222'
    const trackA = spTrack(idA, 'm3 killa laharl', 180)
    const trackB = spTrack(idB, 'Next Song', 200)

    vm.setOnPlayUri((uri) => {
      if (uri.endsWith(idA)) {
        vm.hState.track_window.current_track = { uri, name: 'm3 killa laharl', artists: [{ name: 'Artist' }] }
        vm.hState.position = 90_000
        vm.hState.duration = 180_000
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.audioEl.currentTime = 90.2
        vm.setDomMeta({ title: 'm3 killa laharl', pos: '1:30', dur: '3:00', sliderMs: 90_000 })
        vm.mediaSession.playbackState = 'playing'
        vm.mediaSession.metadata.title = 'm3 killa laharl'
        vm.emitState()
      } else if (uri.endsWith(idB)) {
        // Simulate real hidden 2x2 WebView: Harmony updates URI to Track B while DOM slider/mediaSession STILL lag at Track A's 90s!
        vm.hState.track_window.current_track = { uri, name: 'Next Song', artists: [{ name: 'Artist' }] }
        vm.hState.position = 90_000 // First transition frame even carries Track A's 90s!
        vm.hState.duration = 200_000
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.audioEl.currentTime = 90.3
        vm.emitState()
      }
    })

    usePlayer.getState().playList([trackA, trackB], 0)
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().current?.key).toBe(trackA.key)
    expect(livePlaybackPositionMs(trackA.key)).toBeGreaterThanOrEqual(89_000)

    // User clicks Next -> Track B!
    usePlayer.getState().next(true)
    expect(usePlayer.getState().current?.key).toBe(trackB.key)
    expect(livePlaybackPositionMs(trackB.key)).toBe(0)

    // Poll 1: Harmony had stale 90s frame + DOM slider stuck at 90s -> lyrics/progress MUST stay at 0 (never jump to middle!)
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().position).toBeLessThan(2)
    expect(livePlaybackPositionMs(trackB.key)).toBeLessThan(2000)

    // Harmony resets to 0.3s while hidden DOM slider STILL lags at 90s -> still stays near 0.3s!
    vm.hState.position = 300
    vm.hState.timestamp = Date.now()
    vm.emitState()
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().position).toBeGreaterThanOrEqual(0.2)
    expect(usePlayer.getState().position).toBeLessThan(2.5)
    expect(livePlaybackPositionMs(trackB.key)).toBeLessThan(2500)
  })

  test('switching from Spotify to VK suppresses rogue Spotify ad completely: VK keeps playing, zero ad audio, no SpotifyMiniPlayer hijack', async () => {
    const vm = harness.vm!
    const idA = '1111111111111111111111'
    const trackA = spTrack(idA, 'Spotify Song', 180)
    const vkSong = vkTrack(101, 'Алексей Воробьёв - Сумасшедшая')

    vm.setOnPlayUri((uri) => {
      vm.hState.track_window.current_track = { uri, name: 'Spotify Song' }
      vm.hState.position = 12_000
      vm.hState.timestamp = Date.now()
      vm.hState.paused = false
      vm.audioEl.paused = false
      vm.emitState()
    })

    // 1. User listens to Spotify
    usePlayer.getState().playList([trackA], 0)
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().isPlaying).toBe(true)

    // 2. User switches to VK playlist and plays a VK track
    usePlayer.getState().playList([vkSong], 0)
    await vi.advanceTimersByTimeAsync(50)
    expect(usePlayer.getState().current?.key).toBe(vkSong.key)
    expect(usePlayer.getState().isPlaying).toBe(true)

    // 3. Hidden Spotify WebView tries to start a 29-second ad ("Реклама") in the background
    vm.setActiveEls([vm.audioEl, vm.adAudioEl])
    vm.setDomMeta({ label: 'Реклама', title: 'Реклама', pos: '0:02', dur: '0:29', sliderMs: 2000 })
    vm.hState.track_window.current_track = { uri: 'spotify:ad:advert123', name: 'Реклама' }
    vm.hState.duration = 29_000
    vm.hState.position = 2000
    vm.hState.paused = false
    vm.adAudioEl.nativePlayCalls = 0
    await vm.adAudioEl.play()
    vm.emitState()

    // 4. Even if background spotifyStatus() polls right now, VK stays playing and SpotifyMiniPlayer NEVER appears!
    await spotifyStatus()
    expect(vm.adAudioEl.nativePlayCalls).toBe(0)
    expect(vm.adAudioEl._muted).toBe(true)
    expect(vm.adAudioEl._vol).toBe(0)
    expect(vm.nextCalls).toBe(0)
    expect(spotifyOwnsPlayback()).toBe(false)
    expect(useSpotify.getState().owner).toBe(false)
    expect(useSpotify.getState().track).toBeNull()
    expect(usePlayer.getState().current?.key).toBe(vkSong.key)
    expect(usePlayer.getState().isPlaying).toBe(true)
  })

  test('post-roll ad advances Nocturne queue cleanly, pre-roll ad fast-forwards safely, and Track B unmutes in 0ms despite lagging DOM ad label', async () => {
    const vm = harness.vm!
    const idA = '1111111111111111111111'
    const idB = '2222222222222222222222'
    const trackA = spTrack(idA, 'Song A', 180)
    const trackB = spTrack(idB, 'Song B', 200)
    let forcePreRollAd = true

    vm.setOnPlayUri((uri) => {
      if (uri.endsWith(idA)) {
        vm.hState.track_window = {
          current_track: { uri, name: 'Song A' },
          previous_tracks: [],
        }
        vm.hState.duration = 180_000
        vm.hState.position = 177_000
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.audioEl.currentTime = 177
        vm.emitState()
      } else if (uri.endsWith(idB)) {
        if (forcePreRollAd) {
          // Server forces a pre-roll ad first
          vm.hState.track_window = { current_track: { uri: 'spotify:ad:preroll', name: 'Реклама' }, previous_tracks: [] }
          vm.hState.duration = 30_000
          vm.hState.position = 500
          vm.hState.timestamp = Date.now()
          vm.hState.paused = false
          vm.audioEl.duration = 30
          vm.audioEl.currentTime = 0.5
          vm.audioEl.bufEnd = 30
          vm.audioEl.readyState = 4
          vm.audioEl.paused = false
          vm.setDomMeta({ label: 'Реклама', title: 'Реклама' })
          vm.mediaSession.metadata.title = 'Реклама'
          vm.emitState()
        } else {
          // Real Track B starts while DOM & mediaSession STILL lag on "Реклама"
          vm.hState.track_window = { current_track: { uri, name: 'Song B' }, previous_tracks: [] }
          vm.hState.duration = 200_000
          vm.hState.position = 200
          vm.hState.timestamp = Date.now()
          vm.hState.paused = false
          vm.audioEl.duration = 200
          vm.audioEl.currentTime = 0.2
          vm.audioEl.paused = false
          vm.emitState()
        }
      }
    })

    usePlayer.getState().setVolume(0.8)
    usePlayer.getState().playList([trackA, trackB], 0)
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().current?.key).toBe(trackA.key)

    // Track A ends and Spotify enters post-roll ad -> Nocturne advances immediately to Track B
    vm.hState.track_window = {
      current_track: { uri: 'spotify:ad:postroll', name: 'Реклама' },
      previous_tracks: [{ uri: `spotify:track:${idA}` }],
    }
    vm.hState.duration = 30_000
    vm.hState.position = 100
    vm.emitState()
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().current?.key).toBe(trackB.key)

    // During pre-roll ad, audio is muted and safely fast-forwarded at rate=4 (never 16)
    await vi.advanceTimersByTimeAsync(950)
    expect(vm.audioEl._muted).toBe(true)
    expect(vm.audioEl.playbackRate).toBe(4)
    expect(vm.audioEl.currentTime).toBeCloseTo(29.9, 2)
    expect(vm.nextCalls).toBe(0)

    // Ad clears -> Spotify drops to paused on wrong track -> Engine automatically restarts Track B!
    forcePreRollAd = false
    vm.hState.track_window = { current_track: { uri: 'spotify:track:9999999999999999999999', name: 'Random' }, previous_tracks: [] }
    vm.hState.paused = true
    vm.audioEl.paused = true
    vm.emitState()
    await vi.advanceTimersByTimeAsync(950)

    // Track B starts -> audio unmutes and restores playbackRate=1 in 0ms despite stale DOM "Реклама"!
    await vi.advanceTimersByTimeAsync(950)
    expect(vm.audioEl._muted).toBe(false)
    expect(vm.audioEl.playbackRate).toBe(1)
    expect(usePlayer.getState().current?.key).toBe(trackB.key)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().isLoading).toBe(false)
  })

  test('Harmony MEDIA_NOT_SUPPORTED Format error triggers immediate recovery to playing instead of 25s stall', async () => {
    const vm = harness.vm!
    const id = '4cOdK2wGLETKBW3PvgPWqT'
    const tr = spTrack(id, 'Recovered Track', 180)
    let attempt = 0

    vm.setOnPlayUri((uri) => {
      attempt++
      if (attempt === 1) {
        vm.hState.track_window = { current_track: { uri, name: 'Recovered Track' }, previous_tracks: [] }
        vm.hState.paused = true
        vm.audioEl.paused = true
        vm.emitError('MEDIA_NOT_SUPPORTED', 'Media not supported. (MEDIA_ELEMENT_ERROR: Format error)')
        vm.emitState()
      } else {
        vm.hState.track_window = { current_track: { uri, name: 'Recovered Track' }, previous_tracks: [] }
        vm.hState.position = 400
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.emitState()
      }
    })

    usePlayer.getState().playList([tr], 0)
    await vi.advanceTimersByTimeAsync(950)
    expect(attempt).toBe(2)

    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().isLoading).toBe(false)
  })

  test('rapid Next-Next-Next -> Pause -> Resume -> VK switch with rogue ad -> back to Spotify stays completely consistent', async () => {
    const vm = harness.vm!
    const tracks = [
      spTrack('1111111111111111111111', 'Track 1', 180),
      spTrack('2222222222222222222222', 'Track 2', 190),
      spTrack('3333333333333333333333', 'Track 3', 200),
      spTrack('4444444444444444444444', 'Track 4', 210),
    ]
    const vkSong = vkTrack(202, 'VK Track')

    vm.setOnPlayUri((uri) => {
      const id = uri.split(':').pop() ?? ''
      const found = tracks.find((t) => t.spotifyId === id)
      vm.hState.track_window = { current_track: { uri, name: found?.title ?? 'Song' }, previous_tracks: [] }
      vm.hState.duration = (found?.duration ?? 180) * 1000
      vm.hState.position = 250
      vm.hState.timestamp = Date.now()
      vm.hState.paused = false
      vm.audioEl.paused = false
      vm.audioEl.currentTime = 0.25
      vm.emitState()
    })

    // Rapid skips: Track 1 -> 2 -> 3 -> 4
    usePlayer.getState().playList(tracks, 0)
    usePlayer.getState().next(true)
    usePlayer.getState().next(true)
    usePlayer.getState().next(true)
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().current?.key).toBe(tracks[3].key)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().position).toBeLessThan(2)

    // Pause Spotify -> hardPaused silences & pauses audio
    usePlayer.getState().pause()
    await vi.advanceTimersByTimeAsync(50)
    expect(usePlayer.getState().isPlaying).toBe(false)
    expect(vm.audioEl._muted).toBe(true)
    expect(vm.audioEl.paused).toBe(true)

    // Resume Spotify -> unmutes & resumes Track 4 cleanly
    usePlayer.getState().play()
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(vm.audioEl._muted).toBe(false)

    // Switch to VK -> Spotify pauses; rogue Spotify ad fails to play or hijack VK
    usePlayer.getState().playList([vkSong], 0)
    await vi.advanceTimersByTimeAsync(50)
    vm.setActiveEls([vm.audioEl, vm.adAudioEl])
    vm.hState.track_window.current_track = { uri: 'spotify:ad:sneaky', name: 'Реклама' }
    vm.hState.paused = false
    vm.adAudioEl.nativePlayCalls = 0
    await vm.adAudioEl.play()
    vm.emitState()
    await spotifyStatus()
    expect(vm.adAudioEl.nativePlayCalls).toBe(0)
    expect(useSpotify.getState().owner).toBe(false)
    expect(usePlayer.getState().current?.key).toBe(vkSong.key)
    expect(usePlayer.getState().isPlaying).toBe(true)

    // Switch back to Spotify Track 1 -> plays cleanly unmuted at start
    usePlayer.getState().playList(tracks, 0)
    await vi.advanceTimersByTimeAsync(950)
    expect(usePlayer.getState().current?.key).toBe(tracks[0].key)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(vm.audioEl._muted).toBe(false)
    expect(usePlayer.getState().position).toBeLessThan(2)
  })

  test('m3 killa laharl -> Icalled5times: warmNextTrack enables gapless adoption and 250ms confirmation without start micro-pause', async () => {
    const vm = harness.vm!
    const idA = '1111111111111111111111'
    const idB = '3KVOuPRavcPzqbKd6yJig7'
    const trackA = spTrack(idA, 'm3 killa laharl', 180)
    const trackB = spTrack(idB, 'Icalled5times', 172)
    const playHistory: string[] = []

    vm.setOnPlayUri((uri) => {
      playHistory.push(uri)
      if (uri.endsWith(idA)) {
        vm.hState.track_window = { current_track: { uri, name: 'm3 killa laharl', artists: [{ name: 'Artist' }] }, previous_tracks: [] }
        vm.hState.position = 178_500
        vm.hState.duration = 180_000
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.audioEl.currentTime = 178.5
        vm.emitState()
      }
    })

    usePlayer.getState().playList([trackA, trackB], 0)
    await vi.advanceTimersByTimeAsync(300)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().isLoading).toBe(false)

    // Register Icalled5times as the preloaded next track in filter.js
    ;(vm.lab as unknown as { warmNextTrack: (id: string | null) => boolean }).warmNextTrack(idB)

    // m3 killa laharl finishes and Harmony transitions seamlessly into Icalled5times
    playHistory.length = 0
    vm.hState.track_window = {
      current_track: { uri: `spotify:track:${idB}`, name: 'Icalled5times', artists: [{ name: 'Lil Yung Pharaoh' }] },
      previous_tracks: [{ uri: `spotify:track:${idA}` }],
    }
    vm.hState.position = 150
    vm.hState.duration = 172_000
    vm.hState.timestamp = Date.now()
    vm.hState.paused = false
    vm.audioEl.paused = false
    vm.audioEl.currentTime = 0.15
    vm.emitState()

    // End-of-track fast poll detects completion in <= 250ms, adopts Icalled5times seamlessly with 0 restarts, and confirms playing in <= 300ms!
    await vi.advanceTimersByTimeAsync(600)
    expect(usePlayer.getState().current?.key).toBe(trackB.key)
    expect(usePlayer.getState().isPlaying).toBe(true)
    expect(usePlayer.getState().isLoading).toBe(false)
    expect(playHistory).toHaveLength(0)
    expect(vm.audioEl._muted).toBe(false)
    expect(vm.audioEl.paused).toBe(false)
  })

  test('finished 30s ad element and 2-ad break never cascade-skip upcoming tracks or restart the same track repeatedly', async () => {
    const vm = harness.vm!
    const t30 = spTrack('4m7862vHSGJ6gR0gygAhxB', 'HOLLOWS OF SORROWS', 183)
    const t31 = spTrack('6tN4klJcATg8aTSXkAsK6V', 'undøne', 188)
    const t32 = spTrack('6Cyqji1zNpQHkaHxfBRTVI', 'wish i was dead', 167)
    const playCalls: string[] = []

    vm.setOnPlayUri((uri) => {
      playCalls.push(uri)
      if (uri.endsWith(t30.spotifyId!)) {
        vm.hState.track_window = { current_track: { uri, name: t30.title }, previous_tracks: [] }
        vm.hState.position = 181_000
        vm.hState.duration = 183_000
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.audioEl.ended = false
        vm.audioEl.duration = 183
        vm.audioEl.currentTime = 181
        vm.emitState()
      } else if (uri.endsWith(t31.spotifyId!)) {
        // Spotify Free starts Track 31 after a 30s ad whose <audio> stays ended=true, duration=30 in media[]!
        vm.adAudioEl.duration = 30
        vm.adAudioEl.currentTime = 30
        vm.adAudioEl.ended = true
        vm.adAudioEl.paused = true
        vm.setActiveEls([vm.adAudioEl, vm.audioEl])
        vm.hState.track_window = { current_track: { uri, name: t31.title }, previous_tracks: [{ uri: `spotify:track:${t30.spotifyId}` }] }
        vm.hState.position = 300
        vm.hState.duration = 188_000
        vm.hState.timestamp = Date.now()
        vm.hState.paused = false
        vm.audioEl.paused = false
        vm.audioEl.ended = false
        vm.audioEl.duration = 188
        vm.audioEl.currentTime = 0.3
        vm.emitState()
      }
    })

    // 1. Track 30 plays near end, then finishes into a 30s post-roll ad
    usePlayer.getState().playList([t30, t31, t32], 0)
    await vi.advanceTimersByTimeAsync(350)
    expect(usePlayer.getState().current?.key).toBe(t30.key)

    vm.setActiveEls([vm.adAudioEl, vm.audioEl])
    vm.adAudioEl.duration = 30
    vm.adAudioEl.currentTime = 29.9
    vm.adAudioEl.paused = false
    vm.adAudioEl.ended = false
    vm.hState.track_window = {
      current_track: { uri: 'spotify:ad:postroll30', name: 'Реклама' },
      previous_tracks: [{ uri: `spotify:track:${t30.spotifyId}` }],
    }
    vm.hState.duration = 30_000
    vm.hState.position = 29_900
    vm.emitState()

    // Nocturne advances to Track 31 (undøne)
    await vi.advanceTimersByTimeAsync(500)
    expect(usePlayer.getState().current?.key).toBe(t31.key)
    expect(usePlayer.getState().isPlaying).toBe(true)

    // Now Track 31 briefly buffers (audioEl.paused=true for 1 poll) while adAudioEl STILL has ended=true, duration=30!
    vm.audioEl.paused = true
    vm.hState.paused = true
    vm.hState.position = 800
    vm.emitState()
    await vi.advanceTimersByTimeAsync(950)

    // MUST stay on Track 31 (undøne) — NEVER cascade-skip to Track 32!
    expect(usePlayer.getState().current?.key).toBe(t31.key)
    expect(playCalls.filter((u) => u.endsWith(t31.spotifyId!))).toHaveLength(1)
  })
})
