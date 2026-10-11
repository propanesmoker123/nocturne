import { describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import { OWN_LIMIT, VK_LIMIT, quickResults, toQuickTrack } from './results'

const track = (n: number, over: Partial<Track> = {}): Track => ({
  id: n,
  ownerId: 1,
  key: `1_${n}`,
  accessKey: 'secret-access',
  artist: 'Artist',
  title: `Song ${n}`,
  duration: 180 + n,
  url: 'https://cs1.vkuseraudio.net/s/v1/ac/secret/index.m3u8?extra=token',
  urlFetchedAt: 1,
  cover: { s: 'https://img/s.jpg', m: 'https://img/m.jpg', l: 'https://img/l.jpg' },
  album: { id: 5, ownerId: 1, accessKey: 'album-secret', title: 'Album' },
  explicit: false,
  artists: [{ name: 'Artist' }],
  playable: true,
  hasLyrics: false,
  liked: true,
  ...over,
})

describe('quick search results', () => {
  test('only display fields leave the main window: no stream links, no access keys', () => {
    const q = toQuickTrack(track(1, { subtitle: 'Remix' }))
    expect(q).toEqual({ key: '1_1', title: 'Song 1', subtitle: 'Remix', artist: 'Artist', cover: 'https://img/s.jpg', duration: 181, explicit: false, playable: true })
    expect(JSON.stringify(q)).not.toMatch(/secret|token|m3u8/)
  })

  test('own tracks first, VK results without the songs already found there, both capped', () => {
    const library = Array.from({ length: 20 }, (_, i) => track(i, { title: `Night ${i}` }))
    const global = [track(100, { ownerId: 2, key: '2_100', title: 'Night 3', duration: 183 }), ...Array.from({ length: 60 }, (_, i) => track(200 + i, { ownerId: 3, key: `3_${i}`, title: `Night city ${i}` }))]
    const { own, others } = quickResults(library, global, 'night')
    expect(own.length).toBe(OWN_LIMIT)
    expect(others.length).toBe(VK_LIMIT)
    expect(others.some((t) => t.key === '2_100')).toBe(false)
  })

  test('a blank query finds nothing', () => {
    expect(quickResults([track(1)], [track(2)], '  ')).toEqual({ own: [], others: [] })
  })
})
