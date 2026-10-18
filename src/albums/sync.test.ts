import { schnorr } from '@noble/secp256k1'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeSocket } from '../test/fakeRelay'
import type { Track } from '../vk/models'

vi.mock('../lib/persist', () => ({ loadJSON: async () => null, saveJSON: async () => {}, debouncedSaver: () => ({ save() {}, flush() {} }) }))
const h = vi.hoisted(() => ({ journal: [] as string[] }))
vi.mock('../lib/journal', () => ({ journal: (...a: unknown[]) => void h.journal.push(a.join(' ')) }))

const WS = FakeSocket as unknown as typeof WebSocket
const G = 'K7QM-2XFD-9WRA-HT4C'
const OTHER_GROUP = 'ABCD-EFGH-JKMN-PQRS'

const track = (id: number): Track => ({ id, ownerId: 1, key: `1_${id}`, artist: 'A', title: `T${id}`, duration: 100, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false })

interface Device {
  albums: typeof import('./store')
  sync: typeof import('./sync')
  model: typeof import('./model')
  devices: typeof import('../connect/devices')
  start(): Promise<void>
  stop(): void
}
const running: Device[] = []

/** One device: its own copy of the modules (store, sync, device link), the relays shared. */
async function device(deviceId: string, groupCode: string | null): Promise<Device> {
  vi.resetModules()
  const albums = await import('./store')
  const sync = await import('./sync')
  const model = await import('./model')
  const devices = await import('../connect/devices')
  devices.useDevices.setState({ ready: true, deviceId, code: groupCode })
  albums.useAlbums.setState({ ready: true, docs: {}, list: [] })
  const d: Device = { albums, sync, model, devices, start: () => sync.startAlbumSync({ WebSocketImpl: WS, publishDelay: 20 }), stop: () => sync.stopAlbumSync() }
  await d.start()
  running.push(d)
  return d
}

async function until(cond: () => boolean, ms = 4000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 15))
  return cond()
}

const titles = (d: Device, id: string) => {
  const doc = d.albums.useAlbums.getState().docs[id]
  return doc ? d.model.liveEntries(doc).map((e) => e.track!.title).sort() : []
}
const codeOf = (d: Device, id: string) => d.albums.useAlbums.getState().list.find((e) => e.id === id)!.code

beforeEach(() => {
  FakeSocket.hub.clear()
  FakeSocket.stored.clear()
  h.journal.length = 0
})

afterEach(() => {
  for (const d of running.splice(0)) d.stop()
})

describe('albums between devices', () => {
  test('an album made on one device appears on the other linked one', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', G)
    const b = await device('bbbbbbbbbbbbbbbb', G)
    const id = a.albums.useAlbums.getState().create('Ночной')
    a.albums.useAlbums.getState().add(id, [track(1)])
    expect(await until(() => titles(b, id).length === 1)).toBe(true)
    expect(b.albums.useAlbums.getState().docs[id].meta.name).toBe('Ночной')
  })

  test('both devices add a track offline, then meet: both have both tracks', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', G)
    const b = await device('bbbbbbbbbbbbbbbb', G)
    const id = a.albums.useAlbums.getState().create('Микс')
    await until(() => !!b.albums.useAlbums.getState().docs[id])
    b.stop()
    a.albums.useAlbums.getState().add(id, [track(1)])
    b.albums.useAlbums.getState().add(id, [track(2)])
    await new Promise((r) => setTimeout(r, 100))
    await b.start()
    expect(await until(() => titles(a, id).length === 2 && titles(b, id).length === 2)).toBe(true)
    expect(titles(a, id)).toEqual(['T1', 'T2'])
  })

  test('a removed album stays removed after an old copy arrives', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', G)
    const b = await device('bbbbbbbbbbbbbbbb', G)
    const id = a.albums.useAlbums.getState().create('Старый')
    await until(() => !!b.albums.useAlbums.getState().docs[id])
    b.stop()
    a.albums.useAlbums.getState().deleteForAll(id)
    await new Promise((r) => setTimeout(r, 100))
    await b.start()
    expect(await until(() => !!b.albums.useAlbums.getState().docs[id]?.meta.deletedAt)).toBe(true)
    await new Promise((r) => setTimeout(r, 150))
    expect(a.albums.useAlbums.getState().docs[id].meta.deletedAt).toBeDefined()
  })

  test('a shared album: a friend with the code edits, the owner sees it', async () => {
    const owner = await device('aaaaaaaaaaaaaaaa', G)
    const friend = await device('cccccccccccccccc', OTHER_GROUP)
    const id = owner.albums.useAlbums.getState().create('Вместе')
    owner.albums.useAlbums.getState().add(id, [track(1)])
    await new Promise((r) => setTimeout(r, 100))
    const read = await friend.sync.readAlbum(codeOf(owner, id), 2000)
    expect(read?.meta.name).toBe('Вместе')
    friend.albums.useAlbums.getState().join(codeOf(owner, id), read!)
    friend.albums.useAlbums.getState().add(id, [track(2)])
    expect(await until(() => titles(owner, id).length === 2)).toBe(true)
  })

  test('a new code: own devices follow, the old code is no longer read', async () => {
    const o1 = await device('aaaaaaaaaaaaaaaa', G)
    const o2 = await device('bbbbbbbbbbbbbbbb', G)
    const friend = await device('cccccccccccccccc', OTHER_GROUP)
    const id = o1.albums.useAlbums.getState().create('Закрытый')
    await new Promise((r) => setTimeout(r, 100))
    const oldCode = codeOf(o1, id)
    friend.albums.useAlbums.getState().join(oldCode, (await friend.sync.readAlbum(oldCode, 2000))!)
    const newCode = o1.albums.useAlbums.getState().rotate(id)
    expect(await until(() => codeOf(o2, id) === newCode)).toBe(true)
    friend.albums.useAlbums.getState().add(id, [track(9)])
    await new Promise((r) => setTimeout(r, 300))
    expect(titles(o1, id)).toEqual([])
    expect(titles(o2, id)).toEqual([])
  })

  test('without linked devices albums still publish and read by their own codes', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', null)
    const id = a.albums.useAlbums.getState().create('Один')
    a.albums.useAlbums.getState().add(id, [track(5)])
    await new Promise((r) => setTimeout(r, 100))
    const friend = await device('cccccccccccccccc', null)
    const read = await friend.sync.readAlbum(codeOf(a, id), 2000)
    expect(read && friend.model.liveEntries(read).map((e) => e.track!.title)).toEqual(['T5'])
  })

  test('a bad or foreign record is ignored', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', null)
    const id = a.albums.useAlbums.getState().create('Свой')
    await new Promise((r) => setTimeout(r, 100))
    const before = JSON.stringify(a.albums.useAlbums.getState().docs[id])
    const { openRelayStore } = await import('../lib/relayStore')
    const { albumBase, albumKey, albumTags, sealRecord } = await import('./records')
    const tags = albumTags(await albumBase(codeOf(a, id)))
    const intruder = openRelayStore({ relays: a.sync.ALBUM_RELAYS, WebSocketImpl: WS, keys: schnorr.keygen(), onRecord() {} })
    await until(() => intruder.up())
    await intruder.publish(tags[0], await sealRecord(await albumKey('ZZZZ-ZZZZ-ZZZZ-ZZZZ'), { v: 1, id, meta: { name: 'чужой', updatedAt: Date.now() + 9e6, by: 'dddddddddddddddd' } }))
    await intruder.publish(tags[0], await sealRecord(await albumKey(codeOf(a, id)), { v: 1, id, meta: { name: 5 } }))
    await intruder.publish(tags[1], 'junk')
    await new Promise((r) => setTimeout(r, 200))
    intruder.close()
    expect(JSON.stringify(a.albums.useAlbums.getState().docs[id])).toBe(before)
  })
})

describe('albums over the relays, carefully', () => {
  test('a device that leaves keeps nothing: an edit elsewhere afterwards does not come back', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', G)
    const b = await device('bbbbbbbbbbbbbbbb', G)
    const id = a.albums.useAlbums.getState().create('Уходящий')
    a.albums.useAlbums.getState().add(id, [track(1)])
    expect(await until(() => titles(b, id).length === 1)).toBe(true)
    b.devices.unlinkHere()
    a.albums.useAlbums.getState().add(id, [track(2)])
    await new Promise((r) => setTimeout(r, 300))
    expect(b.albums.useAlbums.getState().docs).toEqual({})
    expect(b.albums.useAlbums.getState().list).toEqual([])
  })

  test('an edit does not ask the relays for everything again', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', G)
    const id = a.albums.useAlbums.getState().create('Тихий')
    await new Promise((r) => setTimeout(r, 150))
    const asks = () => FakeSocket.frames.filter((f) => f.frame[0] === 'REQ').length
    const before = asks()
    for (let i = 1; i <= 5; i++) a.albums.useAlbums.getState().add(id, [track(i)])
    await new Promise((r) => setTimeout(r, 200))
    expect(asks()).toBe(before)
  })

  test('a record too big is not sent; the journal says so with nothing from the album', async () => {
    const a = await device('aaaaaaaaaaaaaaaa', null)
    const id = a.albums.useAlbums.getState().create('Огромный')
    const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(150)), (b) => b.toString(16).padStart(2, '0')).join('')
    const many = Array.from({ length: 4000 }, (_, i): Track => ({ ...track(i + 1), title: hex(), artist: hex() }))
    const doc = a.albums.useAlbums.getState().docs[id]
    // what no device would make itself: thousands of long, random tracks
    a.albums.useAlbums.setState({ docs: { [id]: { ...doc, entries: a.model.addTracks({ ...doc, entries: {} }, many.slice(0, 1000), 2, 'aaaaaaaaaaaaaaaa').doc.entries } } })
    for (let k = 1; k < 4; k++) {
      const cur = a.albums.useAlbums.getState().docs[id]
      const more = a.model.addTracks({ ...cur, entries: {} }, many.slice(k * 1000, (k + 1) * 1000), 2, 'aaaaaaaaaaaaaaaa').doc.entries
      a.albums.useAlbums.setState({ docs: { [id]: { ...cur, entries: { ...cur.entries, ...more } } } })
    }
    a.albums.useAlbums.getState().rename(id, 'Огромный!')
    expect(await until(() => h.journal.some((l) => l.includes('record too big')))).toBe(true)
    const code = codeOf(a, id)
    expect(h.journal.filter((l) => l.includes(code) || l.includes(code.replace(/-/g, '')) || l.includes('Огромный') || l.includes(id))).toEqual([])
  })
})
