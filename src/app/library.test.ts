import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => ({
  toasts: [] as { m: string; kind: string; action?: { label: string; run(): void } }[],
  vk: { add: 0 },
  updates: [] as [string, unknown][],
  opened: [] as (string | undefined)[],
}))

vi.mock('../sc/open', () => ({ openInSoundCloud: async (url?: string) => void h.opened.push(url) }))
vi.mock('../vk/api', () => ({ getMeId: () => 1, addTrack: async () => void h.vk.add++, deleteTrack: async () => {}, restoreTrack: async () => {}, getTracks: async () => ({ items: [], count: 0 }) }))
vi.mock('./toast', () => ({ toast: (m: string, kind: string, action?: { label: string; run(): void }) => void h.toasts.push({ m, kind, action }) }))
vi.mock('../player/store', () => ({ usePlayer: { getState: () => ({ updateTrack: (k: string, p: unknown) => void h.updates.push([k, p]) }) } }))

const { isInLibrary, likeLabel, toggleLibrary } = await import('./library')

const sc = (liked: boolean) => ({ service: 'sc', id: 402, ownerId: 1, key: 'sc_402', artist: 'A', title: 'T', duration: 1, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked, permalink: 'https://soundcloud.com/a/t' }) as Track
const vkTrack = { id: 5, ownerId: 2, key: '2_5', liked: false } as Track

beforeEach(() => {
  h.toasts.length = 0
  h.updates.length = 0
  h.opened.length = 0
  h.vk.add = 0
})

describe('likes per service', () => {
  // SoundCloud guards likes with bot protection (DataDome): only its own site can put one
  test("a SoundCloud like is put on SoundCloud's site, not here and not in VK", async () => {
    await toggleLibrary(sc(false))
    expect(h.vk.add).toBe(0)
    expect(h.updates).toEqual([])
    expect(h.toasts[0]).toMatchObject({ m: 'Лайк в SoundCloud ставится только на его сайте', action: { label: 'Открыть' } })
    h.toasts[0].action!.run()
    expect(h.opened).toEqual(['https://soundcloud.com/a/t'])
  })

  test('isInLibrary for SoundCloud follows liked only', () => {
    expect(isInLibrary(sc(false))).toBe(false)
    expect(isInLibrary(sc(true))).toBe(true)
  })

  test("likeLabel speaks each service's language", () => {
    expect([likeLabel(vkTrack, false), likeLabel(vkTrack, true)]).toEqual(['Добавить в Мою музыку', 'Удалить из Моей музыки'])
    expect([likeLabel(sc(false), false), likeLabel(sc(true), true)]).toEqual(['Лайкнуть на сайте SoundCloud', 'В ваших лайках SoundCloud'])
  })
})
