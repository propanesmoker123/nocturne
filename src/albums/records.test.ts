import { describe, expect, test } from 'vitest'
import { generateCode } from '../together/code'
import type { Track } from '../vk/models'
import { addTracks, liveEntries, newAlbum, removeEntry, sameDoc, type AlbumDoc } from './model'
import { albumBase, albumCodeFromLink, albumKey, albumLink, albumTags, applyRecord, mergeList, openRecord, parseRecord, sealRecord, splitDoc, type ListEntry } from './records'

const DEV = 'aaaaaaaaaaaaaaaa'

const vk = (id: number): Track => ({
  id,
  ownerId: -123456789,
  key: `-123456789_${id}`,
  accessKey: '0123456789abcdef01',
  artist: 'Исполнитель с длинным именем',
  title: `Очень длинное название трека номер ${id} (Remix) feat. Кто-то ещё`.padEnd(60, '.'),
  duration: 215,
  urlFetchedAt: 0,
  cover: {
    s: 'x',
    m: `https://sun9-${id % 90}.userapi.com/impg/c858236/v858236117/1a2b3c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789.jpg?size=300x300&quality=96&sign=${'0123456789abcdef'.repeat(2)}&type=album`,
    l: 'x',
  },
  explicit: false,
  artists: [],
  playable: true,
  hasLyrics: false,
  liked: false,
})

describe('tags, keys and links', () => {
  test('tags and keys depend on the code only, never contain it', async () => {
    const code = generateCode()
    const base = await albumBase(code)
    expect(base).toBe(await albumBase(code.toLowerCase().replace(/-/g, ' ')))
    expect(base).toMatch(/^nocturne-a-[0-9a-f]{16}$/)
    expect(base).not.toContain(code.replace(/-/g, ''))
    expect(albumTags(base)).toHaveLength(17)
    expect(albumTags(base)[0]).toBe(`${base}:m`)
    expect(albumTags(base)[16]).toBe(`${base}:b15`)
    await expect(albumKey(code)).resolves.toBeDefined()
  })

  test('albumCodeFromLink refuses junk', () => {
    const code = generateCode()
    expect(albumCodeFromLink(albumLink(code))).toBe(code)
    expect(albumCodeFromLink(`  ${code.toLowerCase()}  `)).toBe(code)
    expect(albumCodeFromLink(`nocturne://link?code=${code}`)).toBeNull()
    expect(albumCodeFromLink(`https://evil/album?code=${code}`)).toBeNull()
    expect(albumCodeFromLink('ABCD-EFGH')).toBeNull()
    expect(albumCodeFromLink(`${code}X`)).toBeNull()
  })
})

describe('records', () => {
  const sample = (): AlbumDoc => {
    let d = addTracks(newAlbum('Микс', 1, DEV), [vk(1), vk(2), vk(3)], 2, DEV).doc
    d = removeEntry(d, liveEntries(d)[0].eid, 3, DEV)
    return d
  }

  test('a doc goes into 16 buckets and comes back the same', () => {
    const d = sample()
    const { meta, buckets } = splitDoc(d)
    expect(buckets).toHaveLength(16)
    let back: AlbumDoc | null = null
    for (const r of [...buckets, meta]) back = applyRecord(back, r)
    expect(sameDoc(back!, d)).toBe(true)
  })

  test('parseRecord keeps a good record and refuses a bad one', () => {
    const d = sample()
    const { meta, buckets } = splitDoc(d)
    const full = buckets.find((b) => b.entries.length > 0)!
    expect(parseRecord(JSON.parse(JSON.stringify(meta)))).toEqual(meta)
    expect(parseRecord({ ...full, extra: 1 })).toEqual(full)
    const entry = full.entries[0]
    expect(parseRecord({ ...full, entries: [{ ...entry, eid: undefined }] })).toBeNull()
    expect(parseRecord({ ...full, entries: [{ ...entry, pos: 5 }] })).toBeNull()
    expect(parseRecord({ ...full, bucket: 16 })).toBeNull()
    expect(parseRecord({ ...full, entries: [{ ...entry, track: { ...entry.track, title: 'x'.repeat(301) } }] })).toBeNull()
    expect(parseRecord({ ...full, entries: Array.from({ length: 2001 }, () => entry) })).toBeNull()
    expect(parseRecord({ ...full, bucket: (full.bucket + 1) % 16 })).toBeNull()
    expect(parseRecord('junk')).toBeNull()
  })

  test('1000 tracks fit: every sealed record ≤ 60 KB', async () => {
    let d = addTracks(newAlbum('Большой', 1, DEV), Array.from({ length: 1000 }, (_, i) => vk(i + 1)), 2, DEV).doc
    // 300 removal markers on top (removed, then the same number added back)
    for (const e of liveEntries(d).slice(0, 300)) d = removeEntry(d, e.eid, 3, DEV)
    d = addTracks(d, Array.from({ length: 300 }, (_, i) => vk(5000 + i)), 4, DEV).doc
    expect(liveEntries(d)).toHaveLength(1000)
    const key = await albumKey(generateCode())
    const { meta, buckets } = splitDoc(d)
    for (const r of [meta, ...buckets]) {
      const sealed = await sealRecord(key, r)
      expect(sealed.length).toBeLessThanOrEqual(61_440)
      expect(await openRecord(key, sealed)).toEqual(JSON.parse(JSON.stringify(r)))
    }
  })

  test('a record sealed with another key, or changed on the way, does not open', async () => {
    const key = await albumKey(generateCode())
    const sealed = await sealRecord(key, { v: 1, hello: 'there' })
    expect(await openRecord(await albumKey(generateCode()), sealed)).toBeNull()
    expect(await openRecord(key, sealed.slice(0, -4) + 'AAAA')).toBeNull()
    expect(await openRecord(key, 'not base64 at all')).toBeNull()
  })

  test('mergeList: a later code wins, a removal stays', () => {
    const one: ListEntry = { id: '0123456789abcdef', code: generateCode(), name: 'A', shared: false, updatedAt: 1, by: DEV }
    const moved = { ...one, code: generateCode(), updatedAt: 2 }
    expect(mergeList([one], [moved])[0].code).toBe(moved.code)
    expect(mergeList([moved], [one])[0].code).toBe(moved.code)
    const gone = { ...one, removedAt: 3, updatedAt: 3 }
    expect(mergeList([gone], [moved])[0].removedAt).toBe(3)
    expect(mergeList([moved], [gone])[0].removedAt).toBe(3)
  })
})
