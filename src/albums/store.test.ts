import { beforeEach, describe, expect, test, vi } from 'vitest'
import { png } from '../test/images'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({ saved: [] as unknown[], loaded: null as unknown, unlink: null as null | ((kind: 'here' | 'all') => void) }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => h.loaded, saveJSON: async () => {}, debouncedSaver: () => ({ save: (d: unknown) => void h.saved.push(d), flush() {} }) }))
vi.mock('../connect/devices', () => ({ useDevices: { getState: () => ({ deviceId: 'aaaaaaaaaaaaaaaa' }) }, onUnlink: (fn: (kind: 'here' | 'all') => void) => void (h.unlink = fn) }))

const { useAlbums, onAlbumsChanged, loadAlbums, joinKind } = await import('./store')
const { addTracks, liveEntries, mergeAlbum, newAlbum, renameAlbum, MAX_TRACKS } = await import('./model')

const track = (id: number): Track => ({ id, ownerId: 1, key: `1_${id}`, artist: 'A', title: `T${id}`, duration: 100, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false })
const s = () => useAlbums.getState()
const entry = (id: string) => s().list.find((e) => e.id === id)!

beforeEach(() => {
  useAlbums.setState({ ready: true, docs: {}, list: [] })
  h.saved.length = 0
  h.loaded = null
})

describe('albums on the device', () => {
  test('a cover goes into the doc, is saved and announced; null takes it off', () => {
    const id = s().create('Обложка')
    const heard: string[][] = []
    const off = onAlbumsChanged((ids) => void heard.push(ids))
    const img = png(4, 4, 100)
    s().setCover(id, img)
    expect(s().docs[id].cover?.image).toBe(img)
    expect(heard).toEqual([[id]])
    expect(h.saved.length).toBeGreaterThan(0)
    s().setCover(id, null)
    expect(s().docs[id].cover?.image).toBeUndefined()
    expect(s().docs[id].cover?.updatedAt).toBeGreaterThan(0)
    off()
  })

  test('create, add, rename, move, remove go into the doc and are saved', () => {
    const id = s().create('Микс')
    expect(entry(id)).toMatchObject({ name: 'Микс', shared: false })
    expect(entry(id).code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
    expect(s().add(id, [track(1), track(2), track(3)])).toMatchObject({ added: 3, skipped: null })
    s().rename(id, 'Ночной')
    const [, , third] = liveEntries(s().docs[id])
    s().move(id, third.eid, 0)
    s().removeEntry(id, liveEntries(s().docs[id])[1].eid)
    const doc = s().docs[id]
    expect(doc.meta.name).toBe('Ночной')
    expect(entry(id).name).toBe('Ночной')
    expect(liveEntries(doc).map((e) => e.track!.title)).toEqual(['T3', 'T2'])
    expect(h.saved.length).toBeGreaterThan(0)
  })

  test('leave forgets the album here only', () => {
    const id = s().create('Микс')
    s().leave(id)
    expect(entry(id).removedAt).toBeDefined()
    expect(s().docs[id]).toBeUndefined()
  })

  test('deleteForAll marks the doc deleted and removes it from the list', () => {
    const id = s().create('Микс')
    s().deleteForAll(id)
    expect(s().docs[id].meta.deletedAt).toBeDefined()
    expect(entry(id).removedAt).toBeDefined()
  })

  test('rotate gives a new code in the list, the same id', () => {
    const id = s().create('Микс')
    const old = entry(id).code
    const next = s().rotate(id)
    expect(next).not.toBe(old)
    expect(entry(id).code).toBe(next)
    expect(s().docs[id]).toBeDefined()
  })

  test('rotateAll changes every code; wipe forgets everything here', () => {
    const a = s().create('A')
    const b = s().create('B')
    const before = [entry(a).code, entry(b).code]
    s().rotateAll()
    expect([entry(a).code, entry(b).code]).not.toContain(before[0])
    expect([entry(a).code, entry(b).code]).not.toContain(before[1])
    s().wipe()
    expect(s().docs).toEqual({})
    expect(s().list).toEqual([])
  })

  test('join adds the album shared, with the name from the confirmation', () => {
    const doc = addTracks(newAlbum('У друга', 1, 'bbbbbbbbbbbbbbbb'), [track(1)], 2, 'bbbbbbbbbbbbbbbb').doc
    const id = s().join('K7QM-2XFD-9WRA-HT4C', doc)
    expect(id).toBe(doc.id)
    expect(entry(id)).toMatchObject({ code: 'K7QM-2XFD-9WRA-HT4C', name: 'У друга', shared: true })
    expect(liveEntries(s().docs[id])).toHaveLength(1)
  })

  test('applyRemote merges and tells who changed; an unchanged doc tells nobody', () => {
    const id = s().create('Микс')
    const heard: string[][] = []
    const off = onAlbumsChanged((ids) => heard.push(ids))
    const remote = renameAlbum(s().docs[id], 'Из другого места', Date.now() + 1000, 'bbbbbbbbbbbbbbbb')
    expect(s().applyRemote(id, remote)).toBe(true)
    expect(s().docs[id].meta.name).toBe('Из другого места')
    expect(heard).toEqual([[id]])
    expect(s().applyRemote(id, remote)).toBe(false)
    expect(heard).toEqual([[id]])
    off()
  })
})

describe('albums and unlinking devices', () => {
  test('unlinking all devices changes every album code; unlinking this one forgets the albums here', () => {
    const id = s().create('Микс')
    const before = entry(id).code
    h.unlink!('all')
    expect(entry(id).code).not.toBe(before)
    h.unlink!('here')
    expect(s().list).toEqual([])
    expect(s().docs).toEqual({})
  })
})

describe('albums kept safe', () => {
  test('albums made before the saved ones load are kept with them', async () => {
    const old = newAlbum('Старый', 1, 'bbbbbbbbbbbbbbbb')
    h.loaded = { docs: { [old.id]: old }, list: [{ id: old.id, code: 'AAAA-BBBB-CCCC-DDDD', codeAt: 1, name: 'Старый', shared: false, updatedAt: 1, by: 'bbbbbbbbbbbbbbbb' }] }
    useAlbums.setState({ ready: false })
    const id = s().create('Новый')
    await loadAlbums()
    expect(s().list.map((e) => e.name).sort()).toEqual(['Новый', 'Старый'])
    expect(Object.keys(s().docs).sort()).toEqual([id, old.id].sort())
  })

  test('a saved list from before codes had their own time still loads', async () => {
    const old = newAlbum('Старый', 1, 'bbbbbbbbbbbbbbbb')
    h.loaded = { docs: { [old.id]: old }, list: [{ id: old.id, code: 'AAAA-BBBB-CCCC-DDDD', name: 'Старый', shared: false, updatedAt: 4, by: 'bbbbbbbbbbbbbbbb' }] }
    useAlbums.setState({ ready: false, docs: {}, list: [] })
    await loadAlbums()
    expect(entry(old.id).codeAt).toBe(4)
  })

  test('a copy of an album that is not in the list is ignored', () => {
    const other = newAlbum('Чужой', 1, 'bbbbbbbbbbbbbbbb')
    expect(s().applyRemote(other.id, other)).toBe(false)
    expect(s().docs[other.id]).toBeUndefined()
  })

  test('a copy that would grow an album far past its limit is ignored', () => {
    const id = s().create('Мой')
    const base = { ...newAlbum('Мой', 1, 'bbbbbbbbbbbbbbbb'), id }
    const one = addTracks(base, Array.from({ length: MAX_TRACKS }, (_, i) => track(i + 1)), 2, 'bbbbbbbbbbbbbbbb').doc
    const two = addTracks(base, Array.from({ length: MAX_TRACKS }, (_, i) => track(i + 5001)), 2, 'cccccccccccccccc').doc
    expect(s().applyRemote(id, mergeAlbum(one, two))).toBe(false)
    expect(liveEntries(s().docs[id])).toHaveLength(0)
  })

  test('a new code is kept when an older rename comes from another device', () => {
    const id = s().create('Альбом')
    const before = entry(id)
    s().rotateAll()
    const fresh = entry(id).code
    expect(fresh).not.toBe(before.code)
    s().applyList([{ ...before, name: 'Переименован', updatedAt: Date.now() + 60_000 }])
    expect(entry(id)).toMatchObject({ code: fresh, name: 'Переименован' })
  })

  test('a code for an album you already have under another code offers to move to it', () => {
    const id = s().create('Есть')
    expect(joinKind(id, entry(id).code)).toBe('have')
    expect(joinKind(id, 'ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toBe('recode')
    expect(joinKind('0123456789abcdef', 'ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toBe('new')
    s().leave(id)
    expect(joinKind(id, entry(id).code)).toBe('new')
  })

  test('joining by a new code moves the album you have to it and keeps your tracks', () => {
    const id = s().create('Есть')
    s().add(id, [track(1)])
    const theirs = addTracks({ ...newAlbum('Есть', 1, 'bbbbbbbbbbbbbbbb'), id }, [track(2)], 2, 'bbbbbbbbbbbbbbbb').doc
    s().join('ZZZZ-ZZZZ-ZZZZ-ZZZZ', theirs)
    expect(entry(id).code).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ')
    expect(liveEntries(s().docs[id]).map((e) => e.track!.title).sort()).toEqual(['T1', 'T2'])
  })
})
