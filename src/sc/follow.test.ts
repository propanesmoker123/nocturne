import { beforeEach, describe, expect, test, vi } from 'vitest'
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

  test('a follow that fails turns back and says why', async () => {
    const d = deps()
    d.follow.mockRejectedValue(new ScApiError('challenge', ''))
    await toggleFollow(person, d)
    expect(followings()).toEqual([3])
    expect(h.toasts.at(-1)).toMatchObject({ kind: 'error' })
    expect(h.toasts.at(-1)!.m).toContain('«Подписаться»')
  })

  test('a follow not done yet says so and offers the site', async () => {
    const d = deps()
    d.follow.mockRejectedValue(new ScApiError('invalid', sc.FOLLOW_NOT_DONE))
    await toggleFollow(person, d)
    expect(followings()).toEqual([3])
    const t = h.toasts.at(-1)!
    expect(t.m).toBe('Подписка из Nocturne пока не сделана')
    expect(t.action?.label).toBe('Открыть в SoundCloud')
    t.action!.run()
    expect(d.open).toHaveBeenCalledWith(person.permalink)
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

  test('an unfollow offers the site to follow again (Nocturne cannot follow yet)', async () => {
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
    d.follow.mockRejectedValue(new ScApiError('invalid', sc.FOLLOW_NOT_DONE))
    await toggleFollow({ id: 12, permalink: null }, d)
    expect(h.toasts.at(-1)!.action).toBeUndefined()
  })
})
