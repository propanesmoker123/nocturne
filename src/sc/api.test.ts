import { afterEach, describe, expect, test } from 'vitest'
import type { Track } from '../vk/models'
import * as sc from './api'
import { describeScError, SC_UNREACHABLE, ScApiError } from './errors'
import { playlistRaw, systemPlaylistRaw, trackRaw, tracks } from './fixtures'

type Call = { method: string; path: string }

function record(answer: (path: string, method: string) => unknown) {
  const calls: Call[] = []
  sc.setTransport(async (method, path) => {
    calls.push({ method, path })
    return answer(path, method)
  })
  return calls
}

afterEach(() => sc.setTransport(null))

const idsOf = (path: string) => new URLSearchParams(path.split('?')[1]).get('ids')!.split(',').map(Number)

describe('SoundCloud API', () => {
  test('getTracks asks in chunks of 50 and keeps the order', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => i + 1)
    const calls = record((path) => idsOf(path).filter((id) => id !== 7 && id !== 80).reverse().map((id) => trackRaw(id, `t${id}`)))
    const got = await sc.getTracks(ids)
    expect(calls.map((c) => idsOf(c.path).length)).toEqual([50, 50, 20])
    expect(calls.every((c) => c.method === 'GET' && c.path.startsWith('/tracks?ids='))).toBe(true)
    expect(got.map((t) => t.id)).toEqual(ids.filter((id) => id !== 7 && id !== 80))
  })

  test('nextPath keeps only api-v2 paths', () => {
    expect(sc.nextPath('https://api-v2.soundcloud.com/stream?cursor=x&limit=40')).toBe('/stream?cursor=x&limit=40')
    expect(sc.nextPath('https://evil.com/x')).toBeUndefined()
    expect(sc.nextPath(null)).toBeUndefined()
  })

  test('a playlist with stub tracks gets them filled in', async () => {
    const calls = record((path) => (path.startsWith('/playlists/') ? playlistRaw : idsOf(path).map((id) => tracks.find((t) => t.id === id))))
    const { playlist, tracks: got } = await sc.getPlaylistWithTracks({ id: 9001 })
    expect(playlist.title).toBe('night drive')
    expect(calls.map((c) => c.path)).toEqual(['/playlists/9001', '/tracks?ids=406,407'])
    expect(got.map((t) => t.id)).toEqual([404, 405, 406, 407])
  })

  test('a system playlist is asked by urn', async () => {
    const calls = record((path) => (path.startsWith('/system-playlists/') ? systemPlaylistRaw : idsOf(path).map((id) => tracks.find((t) => t.id === id))))
    const { tracks: got } = await sc.getPlaylistWithTracks({ id: 0, urn: 'soundcloud:system-playlists:mixed-for-you:7' })
    expect(calls[0].path).toBe('/system-playlists/soundcloud:system-playlists:mixed-for-you:7')
    expect(got.map((t) => t.id)).toEqual([402, 403, 404, 405])
  })

  test('like and unlike use the signed-in user', async () => {
    sc.setScMeId(7)
    const calls = record(() => null)
    const t = { id: 402 } as Track
    await sc.like(t)
    await sc.unlike(t)
    expect(calls).toEqual([
      { method: 'PUT', path: '/users/7/track_likes/402' },
      { method: 'DELETE', path: '/users/7/track_likes/402' },
    ])
  })

  test('tracks the person liked come marked liked', async () => {
    sc.setScMeId(7)
    record((path) => (path.startsWith('/users/7/track_likes') ? { collection: [{ track: trackRaw(403, 'tape loop 03') }] } : [trackRaw(402, 'a'), trackRaw(403, 'b')]))
    await sc.getLikes(7)
    const got = await sc.getTracks([402, 403])
    expect(got.map((t) => t.liked)).toEqual([false, true])
  })

  test('search asks tracks, people and playlists', async () => {
    const calls = record(() => ({ collection: [] }))
    await sc.search('лоу фай')
    const q = encodeURIComponent('лоу фай')
    expect(calls.map((c) => c.path).sort()).toEqual([`/search/playlists?q=${q}&limit=12`, `/search/tracks?q=${q}&limit=50`, `/search/users?q=${q}&limit=12`])
  })

  test('errors come back as ScApiError', async () => {
    sc.setTransport(async () => Promise.reject({ kind: 'network', message: 'x' }))
    const e = await sc.getMe().catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ScApiError)
    expect((e as ScApiError).kind).toBe('network')
    expect(describeScError(e)).toBe(SC_UNREACHABLE)
    expect(describeScError(ScApiError.from({ kind: 'signedOut' }))).toBe('Войдите в SoundCloud')
    expect(describeScError(ScApiError.from({ kind: 'http', status: 404 }))).toBe('Не найдено в SoundCloud')
    expect(describeScError(ScApiError.from({ kind: 'http', status: 500 }))).toBe('SoundCloud ответил ошибкой 500')
  })
})
