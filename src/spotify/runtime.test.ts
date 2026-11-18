import { beforeEach, expect, test, vi } from 'vitest'
import type { PlayerCommand } from '../lib/events'

const h = vi.hoisted(() => {
  const listeners = new Set<(state: { isPlaying: boolean }, previous: { isPlaying: boolean }) => void>()
  const player = { current: null as { service: 'spotify' } | null, isPlaying: false, toggle: vi.fn(), play: vi.fn(), pause: vi.fn(), next: vi.fn(), prev: vi.fn(), seekBy: vi.fn(), nudgeVolume: vi.fn() }
  const invoke = vi.fn(async () => true)
  return { player, listeners, invoke }
})
vi.mock('../player/store', () => ({ usePlayer: { getState: () => h.player, subscribe: (callback: (state: { isPlaying: boolean }, previous: { isPlaying: boolean }) => void) => { h.listeners.add(callback); return () => h.listeners.delete(callback) } } }))
vi.mock('../lib/tauri', () => ({ isTauri: () => true, invoke: h.invoke }))
import { claimSpotifyPlayback, readSpotifyTrack, releaseSpotifyPlayback, spotifyOwnsPlayback, spotifyPosition, startSpotifyBridge, useSpotify } from './runtime'
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
