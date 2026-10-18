import { describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import {
  addTracks,
  between,
  bucketOf,
  BUCKETS,
  deleteAlbum,
  liveEntries,
  MAX_TRACKS,
  mergeAlbum,
  moveEntry,
  newAlbum,
  removeEntry,
  renameAlbum,
  sameDoc,
  snapshot,
  toTrack,
  type AlbumDoc,
} from './model'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'

const vk = (id: number, over: Partial<Track> = {}): Track => ({
  id,
  ownerId: 100,
  key: `100_${id}`,
  accessKey: 'acc',
  artist: 'Artist',
  title: `Song ${id}`,
  duration: 180,
  urlFetchedAt: 5,
  url: 'https://cdn/x.m3u8',
  cover: { s: 'https://sun9-1.userapi.com/s.jpg', m: 'https://sun9-1.userapi.com/m.jpg', l: 'https://sun9-1.userapi.com/l.jpg' },
  explicit: true,
  artists: [{ id: 'a1', name: 'Artist' }],
  playable: true,
  hasLyrics: true,
  liked: true,
  ...over,
})
const sc = (id: number): Track => ({ ...vk(id), service: 'sc', ownerId: 501, key: `sc_${id}`, accessKey: undefined, permalink: `https://soundcloud.com/x/${id}` })

const titles = (d: AlbumDoc) => liveEntries(d).map((e) => e.track!.title)

describe('positions and buckets', () => {
  test('between gives a key strictly inside and keeps working 50 times on the same side', () => {
    expect(between(undefined, undefined)).not.toBe('')
    const a = between(undefined, undefined)
    const b = between(a, undefined)
    const mid = between(a, b)
    expect(a < mid && mid < b).toBe(true)
    let first = a
    for (let i = 0; i < 50; i++) {
      const k = between(undefined, first)
      expect(k < first).toBe(true)
      first = k
    }
    let hi = b
    for (let i = 0; i < 50; i++) {
      const k = between(a, hi)
      expect(a < k && k < hi).toBe(true)
      hi = k
    }
    expect(first.length).toBeLessThanOrEqual(40)
    expect(hi.length).toBeLessThanOrEqual(40)
  })

  test('bucketOf is stable and spread', () => {
    expect(bucketOf('0123456789abcdef')).toBe(bucketOf('0123456789abcdef'))
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) seen.add(bucketOf(Math.random().toString(16).slice(2, 18)))
    expect(seen.size).toBe(BUCKETS)
  })
})

describe('album operations', () => {
  test('addTracks appends in order and skips duplicates of the same track', () => {
    let d = newAlbum('Mix', 1, A)
    d = addTracks(d, [vk(1), sc(2), vk(3)], 2, A).doc
    expect(titles(d)).toEqual(['Song 1', 'Song 2', 'Song 3'])
    const again = addTracks(d, [vk(1)], 3, A)
    expect(again.added).toBe(0)
    d = addTracks(d, [vk(9)], 4, A, 1).doc
    expect(titles(d)).toEqual(['Song 1', 'Song 9', 'Song 2', 'Song 3'])
  })

  test('a full album takes no more', () => {
    let d = newAlbum('Big', 1, A)
    d = addTracks(d, Array.from({ length: MAX_TRACKS - 1 }, (_, i) => vk(i + 1)), 2, A).doc
    const r = addTracks(d, [vk(5000), vk(5001)], 3, A)
    expect(r.added).toBe(1)
    expect(r.skipped).toBe('full')
    expect(liveEntries(r.doc).length).toBe(MAX_TRACKS)
  })

  test('removeEntry leaves only a marker', () => {
    let d = addTracks(newAlbum('Mix', 1, A), [vk(1), vk(2)], 2, A).doc
    const eid = liveEntries(d)[0].eid
    d = removeEntry(d, eid, 7, A)
    expect(d.entries[eid].track).toBeUndefined()
    expect(d.entries[eid]).toMatchObject({ removedAt: 7, updatedAt: 7 })
    expect(titles(d)).toEqual(['Song 2'])
  })

  test("moveEntry changes only the moved entry's pos", () => {
    let d = addTracks(newAlbum('Mix', 1, A), [vk(1), vk(2), vk(3)], 2, A).doc
    const [one, two, three] = liveEntries(d)
    d = moveEntry(d, three.eid, 0, 5, A)
    expect(titles(d)).toEqual(['Song 3', 'Song 1', 'Song 2'])
    expect(d.entries[one.eid].pos).toBe(one.pos)
    expect(d.entries[two.eid].pos).toBe(two.pos)
    expect(d.entries[three.eid].updatedAt).toBe(5)
  })
})

describe('merging copies', () => {
  test('concurrent adds both survive the merge', () => {
    const base = newAlbum('Mix', 1, A)
    const a = addTracks(base, [vk(1)], 5, A).doc
    const b = addTracks(base, [sc(2)], 6, B).doc
    const ab = mergeAlbum(a, b)
    const ba = mergeAlbum(b, a)
    expect(titles(ab).sort()).toEqual(['Song 1', 'Song 2'])
    expect(sameDoc(ab, ba)).toBe(true)
  })

  test('an old replica does not bring a removed track back', () => {
    const x = addTracks(newAlbum('Mix', 1, A), [vk(1), vk(2)], 2, A).doc
    const gone = liveEntries(x)[0].eid
    const y = removeEntry(x, gone, 9, B)
    expect(titles(mergeAlbum(x, y))).toEqual(['Song 2'])
    expect(titles(mergeAlbum(y, x))).toEqual(['Song 2'])
  })

  test('a tie goes to the larger device id', () => {
    const base = addTracks(newAlbum('Mix', 1, A), [vk(1)], 2, A).doc
    const eid = liveEntries(base)[0].eid
    const byA = moveEntry(base, eid, 0, 9, A)
    const byB = moveEntry(base, eid, 0, 9, B)
    expect(mergeAlbum(byA, byB).entries[eid].by).toBe(B)
    expect(mergeAlbum(byB, byA).entries[eid].by).toBe(B)
  })

  test('merge is idempotent', () => {
    const d = addTracks(newAlbum('Mix', 1, A), [vk(1), sc(2)], 2, A).doc
    expect(sameDoc(mergeAlbum(d, d), d)).toBe(true)
  })

  test('rename and delete are last-writer-wins', () => {
    const base = newAlbum('Mix', 1, A)
    const deleted = deleteAlbum(base, 5, A)
    const renamed = renameAlbum(base, 'New', 6, B)
    expect(mergeAlbum(deleted, renamed).meta).toMatchObject({ name: 'New' })
    expect(mergeAlbum(deleted, renamed).meta.deletedAt).toBeUndefined()
    const lateDelete = deleteAlbum(base, 7, A)
    expect(mergeAlbum(renamed, lateDelete).meta.deletedAt).toBe(7)
  })
})

describe('snapshots', () => {
  test('snapshot keeps only what is needed to play and show', () => {
    expect(snapshot(vk(1))).toEqual({ id: 1, ownerId: 100, accessKey: 'acc', title: 'Song 1', artist: 'Artist', duration: 180, cover: 'https://sun9-1.userapi.com/m.jpg' })
    expect(snapshot(sc(2))).toEqual({ service: 'sc', id: 2, ownerId: 501, title: 'Song 2', artist: 'Artist', duration: 180, cover: 'https://sun9-1.userapi.com/m.jpg', permalink: 'https://soundcloud.com/x/2' })
    const d = addTracks(newAlbum('Mix', 1, A), [vk(1), sc(2)], 2, A).doc
    const [v, s] = liveEntries(d).map(toTrack)
    expect(v).toMatchObject({ key: '100_1', accessKey: 'acc', urlFetchedAt: 0, playable: true, liked: false })
    expect(s).toMatchObject({ key: 'sc_2', service: 'sc', permalink: 'https://soundcloud.com/x/2', urlFetchedAt: 0 })
    expect(s.cover?.l).toBe('https://sun9-1.userapi.com/m.jpg')
  })
})

describe('positions over a long life', () => {
  test('positions stay short: 1000 adds one by one, then 1000 moves to the top', () => {
    let d = newAlbum('Длинный', 1, A)
    for (let i = 0; i < 1000; i++) d = addTracks(d, [vk(i + 1)], 2 + i, A).doc
    const order = liveEntries(d).map((e) => e.track!.id)
    expect(order).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1))
    for (let i = 0; i < 1000; i++) d = moveEntry(d, liveEntries(d).at(-1)!.eid, 0, 5000 + i, A)
    const live = liveEntries(d)
    expect(live.map((e) => e.track!.id)).toEqual(order)
    expect(Math.max(...live.map((e) => e.pos.length))).toBeLessThanOrEqual(8)
  })

  test('between stays in order and never ends a key in 0, wherever things go', () => {
    const keys: string[] = []
    let seed = 7
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
    for (let i = 0; i < 3000; i++) {
      const at = rnd(keys.length + 1)
      const k = between(keys[at - 1], keys[at])
      expect(k > (keys[at - 1] ?? '') && (keys[at] === undefined || k < keys[at])).toBe(true)
      expect(k).toMatch(/[1-9a-z]$/)
      keys.splice(at, 0, k)
    }
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(64)
  })

  test('a removed track stays removed when a later move from an old copy arrives', () => {
    const base = addTracks(newAlbum('М', 1, A), [vk(1), vk(2)], 2, A).doc
    const [first] = liveEntries(base)
    const removed = removeEntry(base, first.eid, 10, A)
    const moved = moveEntry(base, first.eid, 1, 20, B)
    expect(liveEntries(mergeAlbum(removed, moved)).map((e) => e.track!.id)).toEqual([2])
    expect(liveEntries(mergeAlbum(moved, removed)).map((e) => e.track!.id)).toEqual([2])
  })
})
