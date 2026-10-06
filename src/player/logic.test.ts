import { describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import { createQueue } from './queue'
import { dedupeAppend, needsFreshUrl, prevAction, remainingSeconds, volumeToGain } from './logic'

const t = (id: number, over: Partial<Track> = {}): Track => ({
  id,
  ownerId: 1,
  key: `1_${id}`,
  artist: 'A',
  title: `T${id}`,
  duration: 100,
  url: 'https://cs1.vkuseraudio.ru/x/index.m3u8',
  urlFetchedAt: 1_000_000,
  explicit: false,
  artists: [{ name: 'A' }],
  playable: true,
  hasLyrics: false,
  liked: false,
  ...over,
})

describe('needsFreshUrl', () => {
  test('fresh urls are reused', () => {
    expect(needsFreshUrl(t(1), 1_000_000 + 60_000)).toBe(false)
  })

  test('urls older than two hours are refreshed', () => {
    expect(needsFreshUrl(t(1), 1_000_000 + 2 * 3600_000 + 1)).toBe(true)
  })

  test('tracks without a url are refreshed', () => {
    expect(needsFreshUrl(t(1, { url: undefined, urlFetchedAt: 0 }), 1_000_000)).toBe(true)
  })

  test('local blob urls never expire', () => {
    expect(needsFreshUrl(t(1, { url: 'blob:http://localhost/x', urlFetchedAt: 0 }), 9e12)).toBe(false)
  })
})

describe('prevAction', () => {
  test('restarts the track after 3 seconds, otherwise goes to the previous one', () => {
    expect(prevAction(3.5)).toBe('restart')
    expect(prevAction(2.9)).toBe('previous')
  })
})

describe('volumeToGain', () => {
  test('uses a perceptual square curve and clamps', () => {
    expect(volumeToGain(0.5)).toBeCloseTo(0.25)
    expect(volumeToGain(1.4)).toBe(1)
    expect(volumeToGain(-1)).toBe(0)
  })
})

describe('dedupeAppend', () => {
  test('appends only tracks whose key is not present yet', () => {
    const out = dedupeAppend([t(1), t(2)], [t(2), t(3), t(3)])
    expect(out.map((x) => x.id)).toEqual([3])
  })
})

describe('remainingSeconds', () => {
  test('counts the rest of the current track plus every upcoming track', () => {
    const q = createQueue([t(1, { duration: 200 }), t(2, { duration: 180 }), t(3, { duration: 60 })], 0, false, 'off')
    expect(remainingSeconds(q, 50)).toBe(150 + 180 + 60)
  })

  test('is zero without a queue', () => {
    expect(remainingSeconds(null, 0)).toBe(0)
  })
})
