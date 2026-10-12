import { describe, expect, test } from 'vitest'
import { DRIFT_LIMIT, decide, expectedPosition, sameSongAs, type HostState, type LocalState } from './follow'

const track = { owner: -2001, id: 5123, title: 'Ночной город', artist: 'Северный ветер', duration: 214 }
const NOW = 1_000_000
const host = (p: Partial<HostState> = {}): HostState => ({ seq: 1, track, position: 40, playing: true, at: NOW - 2000, ...p })
const local = (p: Partial<LocalState> = {}): LocalState => ({
  followingKey: '-2001_5123',
  position: 42,
  playing: true,
  loading: false,
  localPaused: false,
  ...p,
})

describe('where the host is now', () => {
  test('a playing host moved on since the message was sent; a paused one did not', () => {
    expect(expectedPosition(host(), NOW, 0)).toBe(42)
    expect(expectedPosition(host({ playing: false }), NOW, 0)).toBe(40)
    // the host clock is 500 ms ahead of ours
    expect(expectedPosition(host(), NOW, 500)).toBe(42.5)
    expect(expectedPosition(host({ position: 213.5 }), NOW, 0)).toBe(214)
  })
})

describe('what the listener player does', () => {
  test('a new track starts at the host position, or waits paused while the listener paused themselves', () => {
    expect(decide(host(), local({ followingKey: 'other' }), NOW, 0)).toEqual([{ kind: 'load', track, at: 42, play: true }])
    expect(decide(host(), local({ followingKey: null, localPaused: true }), NOW, 0)).toEqual([{ kind: 'load', track, at: 42, play: false }])
    expect(decide(host({ playing: false }), local({ followingKey: 'other' }), NOW, 0)).toEqual([{ kind: 'load', track, at: 40, play: false }])
  })

  test('small drift is left alone, bigger drift is corrected by a seek', () => {
    expect(decide(host(), local({ position: 42 + DRIFT_LIMIT - 0.05 }), NOW, 0)).toEqual([])
    expect(decide(host(), local({ position: 42 - DRIFT_LIMIT - 0.05 }), NOW, 0)).toEqual([{ kind: 'seek', to: 42 }])
  })

  test('the host pauses and resumes everyone', () => {
    expect(decide(host({ playing: false, at: NOW }), local({ position: 40.2 }), NOW, 0)).toEqual([{ kind: 'pause' }])
    expect(decide(host({ playing: false, at: NOW }), local({ position: 45 }), NOW, 0)).toEqual([{ kind: 'pause' }, { kind: 'seek', to: 40 }])
    expect(decide(host(), local({ playing: false, position: 40 }), NOW, 0)).toEqual([{ kind: 'seek', to: 42 }, { kind: 'play' }])
  })

  test('a listener on their own pause stays paused until they press play themselves', () => {
    expect(decide(host(), local({ localPaused: true, playing: false, position: 10 }), NOW, 0)).toEqual([])
    expect(decide(host(), local({ localPaused: true, playing: true }), NOW, 0)).toEqual([{ kind: 'pause' }])
  })

  test('nothing is touched while the track is still loading, and a host with no track pauses the listener', () => {
    expect(decide(host(), local({ loading: true, position: 0 }), NOW, 0)).toEqual([])
    expect(decide(host({ track: null }), local(), NOW, 0)).toEqual([{ kind: 'pause' }])
    expect(decide(host({ track: null }), local({ playing: false }), NOW, 0)).toEqual([])
  })
})

describe('the same song elsewhere in VK', () => {
  test('title and artist match ignoring case and «ё», duration within 3 seconds', () => {
    expect(sameSongAs({ title: 'НОЧНОЙ ГОРОД', artist: 'Cеверный ветер'.replace('C', 'С'), duration: 216 }, track)).toBe(true)
    expect(sameSongAs({ title: 'Ёлка', artist: 'Ёж', duration: 100 }, { ...track, title: 'Елка', artist: 'Еж', duration: 103 })).toBe(true)
    expect(sameSongAs({ title: 'Ночной город', artist: 'Северный ветер', duration: 218 }, track)).toBe(false)
    expect(sameSongAs({ title: 'Ночной город (Remix)', artist: 'Северный ветер', duration: 214 }, track)).toBe(false)
  })
})
