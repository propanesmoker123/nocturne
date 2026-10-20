import { describe, expect, test } from 'vitest'
import { pngHeader, png, toBase64 } from '../test/images'
import { generateCode } from '../together/code'
import type { Track } from '../vk/models'
import { addTracks, bucketOf, liveEntries, MAX_IMAGE, newAlbum, removeEntry, sameDoc, setAlbumCover, type AlbumDoc } from './model'
import { albumBase, albumCodeFromLink, albumKey, albumLink, albumTags, applyRecord, mergeList, openRecord, parseList, parseRecord, sealRecord, splitDoc, type BucketRecord, type ListEntry } from './records'

const DEV = 'aaaaaaaaaaaaaaaa'
const IMG = png(4, 4, 300)

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
    expect(albumTags(base)).toHaveLength(18)
    expect(albumTags(base)[0]).toBe(`${base}:m`)
    expect(albumTags(base)[16]).toBe(`${base}:b15`)
    expect(albumTags(base)[17]).toBe(`${base}:c`)
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

  test('a cover travels in its own record and comes back the same; no cover, no record', () => {
    const d = setAlbumCover(sample(), IMG, 4, DEV)
    const { meta, buckets, cover } = splitDoc(d)
    expect(cover).toEqual({ v: 1, id: d.id, cover: d.cover })
    let back: AlbumDoc | null = null
    for (const r of [cover!, ...buckets, meta]) back = applyRecord(back, r)
    expect(sameDoc(back!, d)).toBe(true)
    expect(splitDoc(sample()).cover).toBeNull()
  })

  test('a cover record that is off is refused; one taken off is kept', () => {
    const d = setAlbumCover(sample(), IMG, 4, DEV)
    const cover = splitDoc(d).cover!
    expect(parseRecord(JSON.parse(JSON.stringify(cover)))).toEqual(cover)
    expect(parseRecord({ ...cover, cover: { ...cover.cover, image: 'data:image/svg+xml;base64,PHN2Zz4=' } })).toBeNull()
    expect(parseRecord({ ...cover, cover: { ...cover.cover, updatedAt: -1 } })).toBeNull()
    expect(parseRecord({ ...cover, cover: { ...cover.cover, by: 'x' } })).toBeNull()
    expect(parseRecord({ ...cover, cover: { updatedAt: 9, by: DEV } })).toEqual({ v: 1, id: d.id, cover: { updatedAt: 9, by: DEV } })
  })

  test('the biggest cover allowed still fits a record', async () => {
    // a real header, then noise that does not squeeze
    const bytes = [...pngHeader(320, 320), ...crypto.getRandomValues(new Uint8Array(MAX_IMAGE))]
    const prefix = 'data:image/png;base64,'
    const body = toBase64(bytes)
    const image = prefix + body.slice(0, MAX_IMAGE - prefix.length - ((MAX_IMAGE - prefix.length) % 4))
    expect(image.length).toBeGreaterThan(MAX_IMAGE - 4)
    const d = setAlbumCover(sample(), image, 4, DEV)
    const cover = splitDoc(d).cover!
    const key = await albumKey(generateCode())
    const sealed = await sealRecord(key, cover)
    expect(sealed.length).toBeLessThanOrEqual(61_440)
    expect(parseRecord(await openRecord(key, sealed))).toEqual(cover)
  })

  test('a cover or a name from more than a day ahead is refused', () => {
    const now = 1_000_000_000_000
    const d = setAlbumCover(sample(), IMG, now + 3_600_000, DEV)
    const { meta, cover } = splitDoc(d)
    expect(parseRecord(cover, now)).toEqual(cover)
    expect(parseRecord({ ...cover!, cover: { ...cover!.cover, updatedAt: now + 2 * 86_400_000 } }, now)).toBeNull()
    expect(parseRecord({ ...meta, meta: { ...meta.meta, updatedAt: now + 2 * 86_400_000 } }, now)).toBeNull()
    expect(parseRecord({ ...meta, meta: { ...meta.meta, updatedAt: now } }, now)).not.toBeNull()
  })

  test('parseRecord keeps a good record and refuses a bad one', () => {
    const d = sample()
    const { meta, buckets } = splitDoc(d)
    const full = buckets.find((b) => b.entries.length > 0)!
    expect(parseRecord(JSON.parse(JSON.stringify(meta)))).toEqual(meta)
    expect(parseRecord({ ...full, extra: 1 })).toEqual(full)
    const entry = full.entries[0]
    // a bad entry is left out, its record kept
    expect(parseRecord({ ...full, entries: [{ ...entry, eid: undefined }] })).toEqual({ ...full, entries: [] })
    expect(parseRecord({ ...full, entries: [{ ...entry, pos: 5 }] })).toEqual({ ...full, entries: [] })
    expect(parseRecord({ ...full, entries: [{ ...entry, track: { ...entry.track, title: 'x'.repeat(301) } }] })).toEqual({ ...full, entries: [] })
    expect(parseRecord({ ...full, bucket: (full.bucket + 1) % 16 })).toEqual({ ...full, bucket: (full.bucket + 1) % 16, entries: [] })
    expect(parseRecord({ ...full, bucket: 16 })).toBeNull()
    expect(parseRecord({ ...full, entries: Array.from({ length: 2001 }, () => entry) })).toBeNull()
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
      expect(parseRecord(await openRecord(key, sealed))).toEqual(JSON.parse(JSON.stringify(r)))
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
    const one: ListEntry = { id: '0123456789abcdef', code: generateCode(), codeAt: 1, name: 'A', shared: false, updatedAt: 1, by: DEV }
    const moved = { ...one, code: generateCode(), codeAt: 2 }
    expect(mergeList([one], [moved])[0].code).toBe(moved.code)
    expect(mergeList([moved], [one])[0].code).toBe(moved.code)
    const gone = { ...one, removedAt: 3, updatedAt: 3 }
    expect(mergeList([gone], [moved])[0].removedAt).toBe(3)
    expect(mergeList([moved], [gone])[0].removedAt).toBe(3)
  })
})

describe('what readers accept', () => {
  test('1000 tracks added one by one: readers accept every record this device publishes', async () => {
    let d = newAlbum('По одному', 1, DEV)
    for (let i = 0; i < 1000; i++) d = addTracks(d, [vk(i + 1)], 2 + i, DEV).doc
    const key = await albumKey(generateCode())
    const { meta, buckets } = splitDoc(d)
    for (const r of [meta, ...buckets]) {
      const sealed = await sealRecord(key, r)
      expect(sealed.length).toBeLessThanOrEqual(61_440)
      expect(parseRecord(await openRecord(key, sealed))).toEqual(JSON.parse(JSON.stringify(r)))
    }
  })

  test('a track with odd fields is stored so that readers keep it', () => {
    const odd: Track = { ...vk(7), title: 'т'.repeat(500), artist: 'а'.repeat(500), duration: 12 * 3600, accessKey: 'bad key!', cover: { s: 'x', m: 'https://tracker.example/pixel.gif', l: 'x' } }
    const d = addTracks(newAlbum('Странный', 1, DEV), [odd], 2, DEV).doc
    const bucket = splitDoc(d).buckets.find((b) => b.entries.length)!
    const back = parseRecord(JSON.parse(JSON.stringify(bucket))) as BucketRecord
    expect(back.entries).toHaveLength(1)
    const t = back.entries[0].track!
    expect([t.title.length, t.artist.length, t.duration, t.accessKey, t.cover]).toEqual([300, 300, 36_000, undefined, undefined])
  })

  test('one bad entry is left out, the rest of its bucket is kept', () => {
    const d = addTracks(newAlbum('Два', 1, DEV), [vk(1)], 2, DEV).doc
    const bucket = splitDoc(d).buckets.find((b) => b.entries.length)!
    const good = bucket.entries[0]
    let eid = 1
    while (bucketOf(eid.toString(16).padStart(16, '0')) !== bucket.bucket) eid++
    const bad = { ...good, eid: eid.toString(16).padStart(16, '0'), track: { ...good.track!, duration: -1 } }
    expect((parseRecord(JSON.parse(JSON.stringify({ ...bucket, entries: [bad, good] }))) as BucketRecord).entries).toEqual([good])
  })

  test('a cover from anywhere but VK or SoundCloud is dropped, the track kept', () => {
    const d = addTracks(newAlbum('Обложки', 1, DEV), [vk(1)], 2, DEV).doc
    const bucket = splitDoc(d).buckets.find((b) => b.entries.length)!
    const e = bucket.entries[0]
    const coverOf = (cover: string) => (parseRecord({ ...bucket, entries: [{ ...e, track: { ...e.track!, cover } }] }) as BucketRecord).entries[0]?.track?.cover
    expect(coverOf('https://tracker.example/pixel.gif?who=me')).toBeUndefined()
    expect(coverOf('https://sun9-54.vkuserphoto.ru/impg/a.jpg')).toBe('https://sun9-54.vkuserphoto.ru/impg/a.jpg')
    expect(coverOf('https://sun9-1.userapi.com/impg/a.jpg')).toBe('https://sun9-1.userapi.com/impg/a.jpg')
    expect(coverOf('https://i1.sndcdn.com/artworks-x-t500x500.jpg')).toBe('https://i1.sndcdn.com/artworks-x-t500x500.jpg')
    expect(coverOf('https://sndcdn.com.tracker.example/a.jpg')).toBeUndefined()
  })
})

describe('the list of albums, field by field', () => {
  const one: ListEntry = { id: '0123456789abcdef', code: 'AAAA-BBBB-CCCC-DDDD', codeAt: 1, name: 'A', shared: false, updatedAt: 1, by: DEV }

  test('a rename on another device does not bring an old code back', () => {
    const recoded = { ...one, code: 'EEEE-FFFF-GGGG-HHHH', codeAt: 5 }
    const renamedElsewhere = { ...one, name: 'B', updatedAt: 9, by: 'bbbbbbbbbbbbbbbb' }
    for (const m of [mergeList([recoded], [renamedElsewhere]), mergeList([renamedElsewhere], [recoded])]) expect(m[0]).toMatchObject({ code: 'EEEE-FFFF-GGGG-HHHH', name: 'B' })
  })

  test('a removal stays when a later rename comes; adding it again brings it back', () => {
    const gone = { ...one, removedAt: 5 }
    const renamed = { ...one, name: 'B', updatedAt: 9 }
    expect(mergeList([gone], [renamed])[0].removedAt).toBe(5)
    expect(mergeList([renamed], [gone])[0].removedAt).toBe(5)
    const again = { ...one, joinedAt: 12 }
    expect(mergeList([gone], [again])[0].removedAt).toBeUndefined()
    expect(mergeList([again], [gone])[0].removedAt).toBeUndefined()
  })

  test('a shared album stays shared', () => {
    expect(mergeList([{ ...one, shared: true }], [{ ...one, updatedAt: 9 }])[0].shared).toBe(true)
  })

  test('a list kept before codes had their own time still reads', () => {
    const { codeAt: _, ...old } = one
    expect(parseList({ v: 1, albums: [{ ...old, updatedAt: 7 }] })?.albums[0]).toMatchObject({ code: one.code, codeAt: 7 })
  })
})
