import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Track } from '../vk/models'

type RouterMod = typeof import('./router')
type ServiceMod = typeof import('./service')
let router: RouterMod
let service: ServiceMod

beforeEach(async () => {
  vi.resetModules()
  router = await import('./router')
  service = await import('./service')
  await service.initService()
})

const route = () => router.useRouter.getState().route

describe('routes and services', () => {
  test('routeService', () => {
    expect(router.routeService({ name: 'sc-likes' })).toBe('sc')
    expect(router.routeService({ name: 'home' })).toBe('vk')
    expect(router.routeService({ name: 'playlist', ownerId: 1, id: 2 })).toBe('vk')
    expect(router.routeService({ name: 'recent' })).toBeNull()
    expect(router.routeService({ name: 'settings' })).toBeNull()
  })

  test('artistRoute opens a SoundCloud profile for a SoundCloud track', () => {
    const sc = { service: 'sc', artist: 'x', artists: [{ id: '55', name: 'x' }] } as Track
    expect(router.artistRoute(sc, sc.artists[0])).toEqual({ name: 'sc-user', id: 55, title: 'x' })
    const vk = { artist: 'y', artists: [{ id: 'a1', name: 'y' }] } as Track
    expect(router.artistRoute(vk, vk.artists[0])).toEqual({ name: 'artist', id: 'a1', artist: 'y' })
    expect(router.artistRoute(vk)).toEqual({ name: 'artist', id: 'a1', artist: 'y' })
  })

  test("select goes to the service's home first, then back to where you were", () => {
    service.useService.getState().select('sc')
    expect(route()).toEqual({ name: 'sc-home' })
    router.useRouter.getState().push({ name: 'sc-likes' })
    service.useService.getState().select('vk')
    expect(route()).toEqual({ name: 'home' })
    service.useService.getState().select('sc')
    expect(route()).toEqual({ name: 'sc-likes' })
  })

  test('going to a SoundCloud page switches the rail; a shared page does not', () => {
    router.useRouter.getState().push({ name: 'sc-stream' })
    expect(service.useService.getState().current).toBe('sc')
    router.useRouter.getState().push({ name: 'recent' })
    expect(service.useService.getState().current).toBe('sc')
    router.useRouter.getState().push({ name: 'home' })
    expect(service.useService.getState().current).toBe('vk')
  })
})
