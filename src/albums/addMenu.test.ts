import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

vi.mock('../lib/persist', () => ({ loadJSON: async () => null, saveJSON: async () => {}, debouncedSaver: () => ({ save() {}, flush() {} }) }))
vi.mock('../connect/devices', () => ({ useDevices: { getState: () => ({ deviceId: 'aaaaaaaaaaaaaaaa' }) }, onUnlink: () => {} }))

const { useAlbums } = await import('./store')
const { liveEntries, MAX_TRACKS } = await import('./model')
const { albumMenuItems } = await import('./addMenu')
const { useSheet } = await import('../app/sheetStore')
const { useToasts } = await import('../app/toast')

const track = (id: number): Track => ({ id, ownerId: 1, key: `1_${id}`, artist: 'A', title: `T${id}`, duration: 100, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked: false })
const s = () => useAlbums.getState()
const lastToast = () => useToasts.getState().toasts.at(-1)?.text

beforeEach(() => {
  useAlbums.setState({ ready: true, docs: {}, list: [] })
  useToasts.setState({ toasts: [] })
  useSheet.getState().close()
})

describe('the plus: add to a Nocturne album', () => {
  test('the add menu lists albums by name and offers a new one first', () => {
    s().create('Ясно')
    const alpha = s().create('Альфа')
    s().create('Бета')
    s().leave(s().create('Ушедший'))

    const items = albumMenuItems([track(1)])
    expect(items[0].label).toBe('Новый альбом…')
    expect(items[1].separator).toBe(true)
    expect(items.slice(2).map((i) => i.label)).toEqual(['Альфа', 'Бета', 'Ясно'])

    items[0].onSelect!()
    expect(useSheet.getState().sheet).toMatchObject({ kind: 'album-create', addTracks: [track(1)] })

    items[2].onSelect!()
    expect(liveEntries(s().docs[alpha]).map((e) => e.track!.title)).toEqual(['T1'])
    expect(lastToast()).toBe('Добавлено в «Альфа»')
    albumMenuItems([track(1)])[2].onSelect!()
    expect(liveEntries(s().docs[alpha])).toHaveLength(1)
    expect(lastToast()).toBe('Уже в «Альфа»')
  })

  test('with no albums the menu only offers a new one', () => {
    expect(albumMenuItems([track(1)]).map((i) => i.label)).toEqual(['Новый альбом…'])
  })

  test('adding to a full album says so', () => {
    const id = s().create('Полный')
    s().add(id, Array.from({ length: MAX_TRACKS }, (_, i) => track(i + 10)))
    const items = albumMenuItems([track(1)])
    expect(items[2].label).toBe('Полный — полный')
    items[2].onSelect!()
    expect(liveEntries(s().docs[id])).toHaveLength(MAX_TRACKS)
    expect(lastToast()).toBe(`В «Полный» уже ${MAX_TRACKS} треков — больше не поместится`)
  })
})
