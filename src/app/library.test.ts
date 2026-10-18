import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'
import { queryClient } from './queryClient'

const h = vi.hoisted(() => ({
  toasts: [] as { m: string; kind: string; action?: { label: string; run(): void } }[],
  vk: { add: 0 },
  sc: { like: vi.fn(), unlike: vi.fn() },
  updates: [] as [string, unknown][],
  opened: [] as (string | undefined)[],
}))

vi.mock('../sc/open', () => ({ openInSoundCloud: async (url?: string) => void h.opened.push(url) }))
vi.mock('../sc/api', () => ({ like: h.sc.like, unlike: h.sc.unlike, getScMeId: () => 7 }))
vi.mock('../vk/api', () => ({ getMeId: () => 1, addTrack: async () => void h.vk.add++, deleteTrack: async () => {}, restoreTrack: async () => {}, getTracks: async () => ({ items: [], count: 0 }) }))
vi.mock('./toast', () => ({ toast: (m: string, kind: string, action?: { label: string; run(): void }) => void h.toasts.push({ m, kind, action }) }))
vi.mock('../player/store', () => ({ usePlayer: { getState: () => ({ updateTrack: (k: string, p: unknown) => void h.updates.push([k, p]) }) } }))

const { isInLibrary, likeLabel, toggleLibrary } = await import('./library')

const sc = (liked: boolean) => ({ service: 'sc', id: 402, ownerId: 1, key: 'sc_402', artist: 'A', title: 'T', duration: 1, urlFetchedAt: 0, explicit: false, artists: [], playable: true, hasLyrics: false, liked, permalink: 'https://soundcloud.com/a/t' }) as Track
const vkTrack = { id: 5, ownerId: 2, key: '2_5', liked: false } as Track

beforeEach(() => {
  queryClient.clear()
  h.toasts.length = 0
  h.updates.length = 0
  h.opened.length = 0
  h.vk.add = 0
  h.sc.like.mockReset().mockResolvedValue(undefined)
  h.sc.unlike.mockReset().mockResolvedValue(undefined)
})

describe('likes per service', () => {
  test('a SoundCloud like uses SoundCloud and updates the player', async () => {
    await toggleLibrary(sc(false))
    expect(h.sc.like).toHaveBeenCalledWith(sc(false))
    expect(h.vk.add).toBe(0)
    expect(h.updates).toEqual([['sc_402', { liked: true }]])
    expect(h.toasts[0].m).toBe('Добавлено в лайки SoundCloud')
  })

  test('a SoundCloud unlike updates the player and can be undone', async () => {
    await toggleLibrary(sc(true))
    expect(h.sc.unlike).toHaveBeenCalledWith(sc(true))
    expect(h.updates).toContainEqual(['sc_402', { liked: false }])
    expect(h.toasts[0]).toMatchObject({ m: 'Убрано из лайков SoundCloud', action: { label: 'Вернуть' } })
    h.toasts[0].action!.run()
    await vi.waitFor(() => expect(h.updates).toContainEqual(['sc_402', { liked: true }]))
    expect(h.sc.like).toHaveBeenCalledOnce()
  })

  test('the heart turns at once, before SoundCloud answers (its first like opens the site, which takes a while)', async () => {
    let answer: () => void = () => {}
    h.sc.like.mockReturnValue(new Promise<void>((r) => (answer = r)))
    const done = toggleLibrary(sc(false))
    await Promise.resolve()
    expect(h.updates).toEqual([['sc_402', { liked: true }]])
    answer()
    await done
    expect(h.toasts[0].m).toBe('Добавлено в лайки SoundCloud')
  })

  test('a failed like turns the heart back and says why', async () => {
    h.sc.like.mockRejectedValue({ kind: 'http', status: 403 })
    await toggleLibrary(sc(false))
    expect(h.updates).toEqual([
      ['sc_402', { liked: true }],
      ['sc_402', { liked: false }],
    ])
    expect(h.toasts[0]).toMatchObject({ kind: 'error' })
    expect(h.opened).toEqual([])
  })

  test('double clicking a heart sends one request', async () => {
    let finish!: () => void
    h.sc.like.mockReturnValue(new Promise<void>((resolve) => { finish = resolve }))
    const first = toggleLibrary(sc(false))
    const second = toggleLibrary(sc(false))
    finish()
    await Promise.all([first, second])
    expect(h.sc.like).toHaveBeenCalledOnce()
  })

  test('changing a like updates membership in cached pages used by quick search', async () => {
    const key = ['sc-likes', 7]
    queryClient.setQueryData(key, { pages: [{ items: [sc(true)], next: '/next' }], pageParams: [undefined] })
    await toggleLibrary(sc(true))
    expect(queryClient.getQueryData(key)).toMatchObject({ pages: [{ items: [], next: '/next' }] })
    await toggleLibrary(sc(false))
    expect(queryClient.getQueryData(key)).toMatchObject({ pages: [{ items: [sc(true)], next: '/next' }] })
  })

  test('an earlier quick-search read cannot keep a removed like fresh', async () => {
    const key = ['sc-quick-likes', 7]
    let finish!: (tracks: Track[]) => void
    const pending = queryClient.fetchQuery({ queryKey: key, queryFn: () => new Promise<Track[]>((resolve) => { finish = resolve }) }).catch(() => undefined)
    await toggleLibrary(sc(true))
    finish([sc(true)])
    await pending
    const next = await queryClient.fetchQuery({ queryKey: key, queryFn: async () => [], staleTime: 60_000 })
    expect(next).toEqual([])
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
