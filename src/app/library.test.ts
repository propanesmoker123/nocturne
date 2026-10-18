import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({
  toasts: [] as { m: string; kind: string; action?: { label: string; run(): void } }[],
  sc: { like: 0, unlike: 0 },
  vk: { add: 0 },
  updates: [] as [string, unknown][],
}))

vi.mock('../sc/api', () => ({ like: async () => void h.sc.like++, unlike: async () => void h.sc.unlike++ }))
vi.mock('../vk/api', () => ({ getMeId: () => 1, addTrack: async () => void h.vk.add++, deleteTrack: async () => {}, restoreTrack: async () => {}, getTracks: async () => ({ items: [], count: 0 }) }))
vi.mock('./toast', () => ({ toast: (m: string, kind: string, action?: { label: string; run(): void }) => void h.toasts.push({ m, kind, action }) }))
vi.mock('../player/store', () => ({ usePlayer: { getState: () => ({ updateTrack: (k: string, p: unknown) => void h.updates.push([k, p]) }) } }))

const { isInLibrary, likeLabel, toggleLibrary } = await import('./library')

const sc = (liked: boolean) => ({ service: 'sc', id: 402, ownerId: 1, key: 'sc_402', artist: 'A', title: 'T', duration: 1, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked }) as Track
const vkTrack = { id: 5, ownerId: 2, key: '2_5', liked: false } as Track

beforeEach(() => {
  h.toasts.length = 0
  h.updates.length = 0
  h.sc.like = h.sc.unlike = h.vk.add = 0
})

describe('likes per service', () => {
  test('liking a SoundCloud track uses SoundCloud, not VK', async () => {
    await toggleLibrary(sc(false))
    expect(h.sc.like).toBe(1)
    expect(h.vk.add).toBe(0)
    expect(h.updates).toContainEqual(['sc_402', { liked: true }])
    expect(h.toasts[0].m).toBe('Добавлено в лайки SoundCloud')
  })

  test('unliking a SoundCloud track offers to bring it back', async () => {
    await toggleLibrary(sc(true))
    expect(h.sc.unlike).toBe(1)
    expect(h.toasts[0]).toMatchObject({ m: 'Убрано из лайков SoundCloud', action: { label: 'Вернуть' } })
    h.toasts[0].action!.run()
    await Promise.resolve()
    expect(h.sc.like).toBe(1)
  })

  test('isInLibrary for SoundCloud follows liked only', () => {
    expect(isInLibrary(sc(false))).toBe(false)
    expect(isInLibrary(sc(true))).toBe(true)
  })

  test("likeLabel speaks each service's language", () => {
    expect([likeLabel(vkTrack, false), likeLabel(vkTrack, true)]).toEqual(['Добавить в Мою музыку', 'Удалить из Моей музыки'])
    expect([likeLabel(sc(false), false), likeLabel(sc(true), true)]).toEqual(['Нравится', 'Убрать из лайков'])
  })
})
