import { beforeEach, expect, test, vi } from 'vitest'
import type { PlayerCommand } from '../lib/events'

const h = vi.hoisted(() => {
  const listeners = new Set<(state: { isPlaying: boolean }, previous: { isPlaying: boolean }) => void>()
  const player = { current: null as { service: 'spotify' } | null, isPlaying: false, toggle: vi.fn(), play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), seekBy: vi.fn(), nudgeVolume: vi.fn() }
  const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => true)
  return { player, listeners, invoke }
})
vi.mock('../player/store', () => ({ usePlayer: { getState: () => h.player, subscribe: (callback: (state: { isPlaying: boolean }, previous: { isPlaying: boolean }) => void) => { h.listeners.add(callback); return () => h.listeners.delete(callback) } } }))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, invoke: h.invoke }))
import { claimSpotifyPlayback, readSpotifyTrack, releaseSpotifyPlayback, spotifyOwnsPlayback, spotifyPosition, spotifyStatus, startSpotifyBridge, useSpotify } from './runtime'
import { runCommand } from '../player/commands'

beforeEach(() => { vi.useFakeTimers(); vi.clearAllTimers(); releaseSpotifyPlayback(); h.listeners.clear(); h.player.current = null; h.player.isPlaying = false; vi.clearAllMocks() })
test('all shared transport commands target the active Spotify player, including after browsing away', () => {
  claimSpotifyPlayback()
  expect(spotifyOwnsPlayback()).toBe(true)
  const actions = { toggleLike: vi.fn(), showWindow: vi.fn() }
  for (const type of ['toggle', 'play', 'pause', 'next', 'prev'] as const) runCommand({ type }, actions)
  expect(h.invoke.mock.calls).toEqual(['toggle', 'play', 'pause', 'next', 'previous'].map(action => ['spotify_control', { action }]))
  expect(h.player.toggle).not.toHaveBeenCalled()
  expect(h.player.next).not.toHaveBeenCalled()
  runCommand({ type: 'showWindow' }, actions)
  expect(actions.showWindow).toHaveBeenCalledOnce()
})
test('every shared command reaches Spotify, never the previous VK or SoundCloud track', () => {
  claimSpotifyPlayback()
  useSpotify.setState({ track: { title: 'Song', artist: 'Band', album: '', position: 30, duration: 200, liked: false, shuffle: false, repeat: 'off', volume: 0.5 }, playing: false, at: Date.now() })
  const actions = { toggleLike: vi.fn(), showWindow: vi.fn() }
  for (const cmd of [{ type: 'toggleLike' }, { type: 'toggleShuffle' }, { type: 'cycleRepeat' }, { type: 'toggleMute' }, { type: 'seekBy', value: 10 }, { type: 'seek', value: 500 }, { type: 'volumeBy', value: .1 }, { type: 'volume', value: 2 }] as PlayerCommand[]) runCommand(cmd, actions)
  expect(actions.toggleLike).not.toHaveBeenCalled()
  expect(h.player.seekBy).not.toHaveBeenCalled()
  expect(h.player.nudgeVolume).not.toHaveBeenCalled()
  expect(h.invoke.mock.calls.map(call => (call as unknown[])[1])).toEqual([
    { action: 'like' }, { action: 'shuffle' }, { action: 'repeat' }, { action: 'mute' },
    { action: 'seek', value: 40 }, { action: 'seek', value: 200 }, { action: 'volume', value: 0.6 }, { action: 'volume', value: 1 },
  ])
})
test('Next uses the app queue when a native Spotify track was selected after web playback', () => {
  claimSpotifyPlayback()
  h.player.current = { service: 'spotify' }
  runCommand({ type: 'next' }, { toggleLike() {}, showWindow() {} })

  expect(h.player.next).toHaveBeenCalledOnce()
  expect(h.invoke).not.toHaveBeenCalled()
})
test('the page is a remote site: only well-formed display fields and Spotify artwork are kept', () => {
  expect(readSpotifyTrack({ title: '  Song\n name ', artist: 'Band', cover: 'https://i.scdn.co/image/ab67', coverLarge: 'https://evil.test/x.jpg', position: 400, duration: 200, buffered: 250, liked: 'yes', repeat: 'one', shuffle: 1, volume: 7 })).toEqual({
    title: 'Song name', artist: 'Band', album: '', cover: 'https://i.scdn.co/image/ab67', coverLarge: 'https://i.scdn.co/image/ab67', position: 200, duration: 200, buffered: 200, liked: null, shuffle: false, repeat: 'one', volume: 1,
  })
  for (const raw of [null, 'x', {}, { title: '' }, { title: 5 }]) expect(readSpotifyTrack(raw)).toBeNull()
  expect(readSpotifyTrack({ title: 'x', cover: 'http://i.scdn.co/a', position: -1, duration: Infinity, buffered: -5 })).toMatchObject({ cover: undefined, position: 0, duration: 0, buffered: undefined })
})
test('the position moves on from the last reading only while playing', () => {
  const track = { title: 'Song', artist: '', album: '', position: 10, duration: 60, liked: null, shuffle: false, repeat: 'off' as const, volume: null }
  expect(spotifyPosition({ track, playing: true, at: 1000 }, 6000)).toBe(15)
  expect(spotifyPosition({ track, playing: false, at: 1000 }, 6000)).toBe(10)
  expect(spotifyPosition({ track, playing: true, at: 0 }, 1e9)).toBe(60)
  expect(spotifyPosition({ track: null, playing: true, at: 0 }, 1)).toBe(0)
})
test('starting VK or SoundCloud takes ownership and pauses Spotify; closing restores ordinary commands', () => {
  const off = startSpotifyBridge()
  claimSpotifyPlayback()
  h.listeners.forEach(listener => listener({ isPlaying: true }, { isPlaying: false }))
  expect(spotifyOwnsPlayback()).toBe(false)
  expect(h.invoke).toHaveBeenCalledWith('spotify_control', { action: 'pause' })
  runCommand({ type: 'toggle' }, { toggleLike() {}, showWindow() {} })
  expect(h.player.toggle).toHaveBeenCalledOnce()
  claimSpotifyPlayback(); releaseSpotifyPlayback()
  expect(spotifyOwnsPlayback()).toBe(false)
  off()
  expect(h.listeners.size).toBe(0)
})

test('stale in-flight spotifyStatus poll does not steal ownership or pause a newly started VK/SC track', async () => {
  const off = startSpotifyBridge()
  let resolvePoll: ((v: unknown) => void) | undefined
  h.invoke.mockImplementationOnce(() => new Promise((r) => { resolvePoll = r }))
  const pending = spotifyStatus()

  // VK/SC starts playing while spotify_status is still in flight
  h.player.isPlaying = true
  h.listeners.forEach((listener) => listener({ isPlaying: true }, { isPlaying: false }))
  h.player.pause.mockClear()

  resolvePoll?.({
    open: true,
    phase: 'ready',
    account: 'in',
    playing: true,
    nowPlaying: { title: 'Stale', artist: 'Spotify', album: '', position: 5, duration: 120, liked: false, shuffle: false, repeat: 'off', volume: 0.8 },
  })
  await pending

  expect(spotifyOwnsPlayback()).toBe(false)
  expect(h.player.pause).not.toHaveBeenCalled()
  off()
})

test('hidden Spotify ad or rogue background playback NEVER hijacks VK, pauses VK, or renders an ad track, and is actively paused', async () => {
  const off = startSpotifyBridge()
  h.player.current = { key: '1_1', service: 'vk' } as unknown as { service: 'spotify' }
  h.player.isPlaying = true

  // Background Spotify poll reports an active 29s muted ad ("Реклама") while user is listening to VK
  h.invoke.mockResolvedValueOnce({
    open: true,
    phase: 'ready',
    account: 'in',
    playing: true,
    nowPlaying: {
      isAd: true,
      title: 'Реклама',
      artist: '',
      album: '',
      position: 2,
      duration: 29,
      liked: null,
      shuffle: false,
      repeat: 'off',
      volume: 0,
    },
  })
  await spotifyStatus()

  expect(spotifyOwnsPlayback()).toBe(false)
  expect(useSpotify.getState().owner).toBe(false)
  expect(useSpotify.getState().track).toBeNull()
  expect(h.player.pause).not.toHaveBeenCalled()
  expect(h.invoke).toHaveBeenCalledWith('spotify_control', { action: 'pause' })

  // Even a non-ad rogue stream in the hidden WebView never hijacks VK and gets silenced after throttle window
  vi.advanceTimersByTime(1600)
  h.invoke.mockClear()
  h.invoke.mockResolvedValueOnce({
    open: true,
    phase: 'ready',
    account: 'in',
    playing: true,
    nowPlaying: {
      isAd: false,
      title: 'Rogue Song',
      artist: 'Someone',
      album: '',
      position: 5,
      duration: 180,
      liked: false,
      shuffle: false,
      repeat: 'off',
      volume: 0.8,
    },
  })
  await spotifyStatus()

  expect(spotifyOwnsPlayback()).toBe(false)
  expect(useSpotify.getState().owner).toBe(false)
  expect(useSpotify.getState().track).toBeNull()
  expect(h.player.pause).not.toHaveBeenCalled()
  expect(h.invoke).toHaveBeenCalledWith('spotify_control', { action: 'pause' })

  // readSpotifyTrack rejects ads unconditionally
  expect(readSpotifyTrack({ isAd: true, title: 'Реклама', artist: '', duration: 29, position: 2 })).toBeNull()
  off()
})

test('switching directly from a playing Spotify track to a playing VK track clears ownership and pauses hidden Spotify', () => {
  const off = startSpotifyBridge()
  claimSpotifyPlayback()
  h.invoke.mockClear()
  h.listeners.forEach((listener) =>
    (listener as unknown as (s: unknown, p: unknown) => void)(
      { current: { key: '1_42', service: 'vk' }, isPlaying: true },
      { current: { key: 'sp_1', service: 'spotify' }, isPlaying: true },
    ),
  )
  expect(spotifyOwnsPlayback()).toBe(false)
  expect(h.invoke).toHaveBeenCalledWith('spotify_control', { action: 'pause' })
  off()
})
