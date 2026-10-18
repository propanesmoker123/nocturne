import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({ saved: [] as unknown[] }))
vi.mock('../lib/persist', () => ({ loadJSON: async () => null, saveJSON: async () => {}, debouncedSaver: () => ({ save: (d: unknown) => void h.saved.push(d), flush() {} }) }))
vi.mock('../connect/devices', () => ({ useDevices: { getState: () => ({ deviceId: 'aaaaaaaaaaaaaaaa' }) } }))

const { useAlbums, onAlbumsChanged } = await import('./store')
const { addTracks, liveEntries, newAlbum, renameAlbum } = await import('./model')

const track = (id: number): Track => ({ id, ownerId: 1, key: `1_${id}`, artist: 'A', title: `T${id}`, duration: 100, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false })
const s = () => useAlbums.getState()
const entry = (id: string) => s().list.find((e) => e.id === id)!

beforeEach(() => {
  useAlbums.setState({ ready: true, docs: {}, list: [] })
  h.saved.length = 0
})

describe('albums on the device', () => {
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
