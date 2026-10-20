import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { queryClient } from '../app/queryClient'

const h = vi.hoisted(() => ({ toasts: [] as { m: string; kind: string; action?: { label: string; run(): void } }[] }))
vi.mock('../app/toast', () => ({ toast: (m: string, kind: string, action?: { label: string; run(): void }) => void h.toasts.push({ m, kind, action }) }))

const sc = await import('./api')
const { ScApiError } = await import('./errors')
const { scKeys } = await import('./queries')
const { toggleFollow } = await import('./follow')

const person = { id: 12, permalink: 'https://soundcloud.com/twelve' }
const followings = () => queryClient.getQueryData<number[]>(scKeys.followings(7))
const deps = () => ({ follow: vi.fn().mockResolvedValue(undefined), unfollow: vi.fn().mockResolvedValue(undefined), open: vi.fn().mockResolvedValue(undefined) })

afterEach(() => sc.setTransport(null))

beforeEach(() => {
  queryClient.clear()
  h.toasts.length = 0
  sc.setScMeId(7)
  queryClient.setQueryData(scKeys.followings(7), [3])
})

describe('following on SoundCloud', () => {
  test('a follow shows at once and stays when SoundCloud agrees', async () => {
    const d = deps()
    let shownBefore: number[] | undefined
    d.follow.mockImplementation(async () => void (shownBefore = followings()))
    await toggleFollow(person, d)
    expect(shownBefore).toEqual([3, 12])
    expect(followings()).toEqual([3, 12])
    expect(d.follow).toHaveBeenCalledWith(person)
  })

  test('after a follow the feed is read again on the next visit', async () => {
    queryClient.setQueryData(scKeys.feed(7), { pages: [], pageParams: [] })
    await toggleFollow(person, deps())
    expect(queryClient.getQueryData(scKeys.feed(7))).toBeUndefined()
  })

  test('a follow that fails turns back and says why', async () => {
    const d = deps()
    d.follow.mockRejectedValue(new ScApiError('challenge', ''))
    await toggleFollow(person, d)
    expect(followings()).toEqual([3])
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'error' })
    expect(h.toasts.at(-1)!.m).toContain('«Подписаться»')
  })

  test('the real follow action sends a POST and keeps the subscribed button on success', async () => {
    const sent: string[] = []
    sc.setTransport(async (method, path) => { sent.push(`${method} ${path}`); return null })
    await toggleFollow(person)
    expect(sent).toEqual(['POST /me/followings/12'])
    expect(followings()).toEqual([3, 12])
    expect(h.toasts.at(-1)).toMatchObject({ m: 'Вы подписались', kind: 'added' })
  })

  test('a failed real follow restores the button and reports the API error', async () => {
    sc.setTransport(async () => { throw { kind: 'http', status: 500 } })
    await toggleFollow(person)
    expect(followings()).toEqual([3])
    const t = h.toasts.at(-1)!
    expect(t).toMatchObject({ m: 'SoundCloud ответил ошибкой 500', kind: 'error' })
    expect(t.action).toBeUndefined()
  })

  test('unfollow goes through unfollow and turns back on failure', async () => {
    const d = deps()
    await toggleFollow({ id: 3, permalink: null }, d)
    expect(d.unfollow).toHaveBeenCalledWith(3)
    expect(followings()).toEqual([])
    d.follow.mockRejectedValue(new ScApiError('network', ''))
    d.unfollow.mockRejectedValue(new ScApiError('network', ''))
    queryClient.setQueryData(scKeys.followings(7), [3])
    await toggleFollow({ id: 3, permalink: null }, d)
    expect(followings()).toEqual([3])
  })
})

describe('leaving someone', () => {
  test('an unfollow stopped by a check names the button that is on screen', async () => {
    const d = deps()
    d.unfollow.mockRejectedValue(new ScApiError('challenge', ''))
    await toggleFollow({ id: 3, permalink: 'https://soundcloud.com/three' }, d)
    expect(followings()).toEqual([3])
    expect(h.toasts.at(-1)!.m).toContain('«Вы подписаны»')
    expect(h.toasts.at(-1)!.m).not.toContain('«Подписаться»')
  })

  test('an unfollow still offers the profile on the site', async () => {
    const d = deps()
    await toggleFollow({ id: 3, permalink: 'https://soundcloud.com/three' }, d)
    const t = h.toasts.at(-1)!
    expect(t.m).toBe('Вы отписались')
    expect(t.action?.label).toBe('Открыть в SoundCloud')
    t.action!.run()
    expect(d.open).toHaveBeenCalledWith('https://soundcloud.com/three')
  })

  test('without a profile address no dead «Открыть в SoundCloud» is offered', async () => {
    const d = deps()
    d.follow.mockRejectedValue(new ScApiError('http', '', 403))
    await toggleFollow({ id: 12, permalink: null }, d)
    expect(h.toasts.at(-1)!.action).toBeUndefined()
  })
})

describe('saying it at once', () => {
  test('«Вы подписались» shows with the button, before SoundCloud answers', async () => {
    const d = deps()
    let answer!: () => void
    d.follow.mockReturnValue(new Promise<void>((r) => (answer = r)))
    const done = toggleFollow(person, d)
    await Promise.resolve()
    expect(h.toasts.map((t) => t.m)).toEqual(['Вы подписались'])
    answer()
    await done
    expect(h.toasts.map((t) => t.m)).toEqual(['Вы подписались'])
  })

  test('«Вы отписались» shows with the button too', async () => {
    const d = deps()
    d.unfollow.mockReturnValue(new Promise<void>(() => {}))
    void toggleFollow({ id: 3, permalink: 'https://soundcloud.com/three' }, d)
    await Promise.resolve()
    expect(h.toasts.map((t) => t.m)).toEqual(['Вы отписались'])
  })
})
