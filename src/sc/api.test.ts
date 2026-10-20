import { afterEach, describe, expect, test } from 'vitest'
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

afterEach(() => {
  sc.setTransport(null)
  sc.setScMeId(0)
})

const idsOf = (path: string) => new URLSearchParams(path.split('?')[1]).get('ids')!.split(',').map(Number)

describe('SoundCloud API', () => {
  test('likes and unlikes update subsequent track reads only after success', async () => {
    sc.setScMeId(7)
    const calls = record((_path, method) => method === 'GET' ? [trackRaw(402, 'a')] : null)
    await sc.like({ id: 402 })
    expect((await sc.getTracks([402]))[0].liked).toBe(true)
    await sc.unlike({ id: 402 })
    expect((await sc.getTracks([402]))[0].liked).toBe(false)
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([
      { method: 'PUT', path: '/users/7/track_likes/402' },
      { method: 'DELETE', path: '/users/7/track_likes/402' },
    ])
  })

  test('a rejected like does not mark a track liked', async () => {
    sc.setScMeId(7)
    record((_path, method) => {
      if (method !== 'GET') throw { kind: 'http', status: 403 }
      return [trackRaw(402, 'a')]
    })
    await expect(sc.like({ id: 402 })).rejects.toMatchObject({ kind: 'http', status: 403 })
    expect((await sc.getTracks([402]))[0].liked).toBe(false)
  })

  test('a signed-out like never sends a request', async () => {
    sc.setScMeId(0)
    const calls = record(() => null)
    await expect(sc.like({ id: 402 })).rejects.toMatchObject({ kind: 'signedOut' })
    expect(calls).toEqual([])
  })

  test('an earlier likes read cannot overwrite a completed unlike', async () => {
    sc.setScMeId(7)
    let finish!: (raw: unknown) => void
    sc.setTransport(async (method, path) => {
      if (path.startsWith('/users/7/track_likes?')) return new Promise((resolve) => { finish = resolve })
      return method === 'GET' ? [trackRaw(402, 'a')] : null
    })
    await sc.like({ id: 402 })
    const pendingRead = sc.getLikes(7)
    await sc.unlike({ id: 402 })
    finish({ collection: [{ track: trackRaw(402, 'a') }] })
    await pendingRead
    expect((await sc.getTracks([402]))[0].liked).toBe(false)
  })

  test('a write from an earlier login does not update the next login to the same account', async () => {
    sc.setScMeId(7)
    let finish!: () => void
    sc.setTransport(async (method) => {
      if (method !== 'GET') return new Promise<void>((resolve) => { finish = resolve })
      return [trackRaw(402, 'a')]
    })
    const write = sc.like({ id: 402 })
    sc.setScMeId(0)
    sc.setScMeId(7)
    finish()
    await expect(write).rejects.toMatchObject({ kind: 'signedOut' })
    expect((await sc.getTracks([402]))[0].liked).toBe(false)
  })

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
    expect(describeScError(ScApiError.from({ kind: 'challenge' }))).toBe('Пройдите проверку SoundCloud в открывшемся окне и нажмите сердечко ещё раз')
  })
})

describe('SoundCloud profiles', () => {
  test('follow sends a POST for the native browser session to sign', async () => {
    sc.setScMeId(7)
    const calls = record(() => null)
    await sc.follow({ id: 12, permalink: null })
    expect(calls).toEqual([{ method: 'POST', path: '/me/followings/12' }])
  })

  test('a rejected follow is reported and does not use a browser mock', async () => {
    sc.setScMeId(7)
    record(() => { throw { kind: 'http', status: 403 } })
    await expect(sc.follow({ id: 12 })).rejects.toMatchObject({ kind: 'http', status: 403 })
  })

  test('follow refuses signed-out, self and invalid targets without sending', async () => {
    const calls = record(() => null)
    await expect(sc.follow({ id: 12 })).rejects.toMatchObject({ kind: 'signedOut' })
    sc.setScMeId(7)
    for (const id of [7, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(sc.follow({ id })).rejects.toMatchObject({ kind: 'invalid' })
    }
    expect(calls).toEqual([])
  })

  test('reposts and likes come a page at a time with the next cursor', async () => {
    const calls = record((path) => ({
      collection: [{ type: 'track-repost', track: trackRaw(402, 'a') }, { type: 'playlist-repost', playlist: playlistRaw }],
      next_href: `https://api-v2.soundcloud.com${path.split('?')[0]}?offset=x`,
    }))
    const reposts = await sc.getUserReposts(5)
    expect([reposts.tracks.length, reposts.playlists.length, reposts.next]).toEqual([1, 1, '/stream/users/5/reposts?offset=x'])
    const likes = await sc.getUserLikes(5)
    expect([likes.tracks.length, likes.playlists.length, likes.next]).toEqual([1, 1, '/users/5/likes?offset=x'])
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /stream/users/5/reposts?limit=50', 'GET /users/5/likes?limit=50'])
  })

  test('followings: every page is read; signed out reads nothing', async () => {
    const calls = record((path) => (path.includes('cursor') ? { collection: [3] } : { collection: [1, 2], next_href: 'https://api-v2.soundcloud.com/users/7/followings/ids?cursor=2' }))
    expect(await sc.getMyFollowings()).toEqual([])
    expect(calls).toEqual([])
    sc.setScMeId(7)
    expect(await sc.getMyFollowings()).toEqual([1, 2, 3])
    expect(calls.map((c) => c.path)).toEqual(['/users/7/followings/ids?limit=5000', '/users/7/followings/ids?cursor=2'])
  })

  test('unfollow is a DELETE of my following', async () => {
    sc.setScMeId(7)
    const calls = record(() => null)
    await sc.unfollow(12)
    expect(calls).toEqual([{ method: 'DELETE', path: '/me/followings/12' }])
  })

  test('comments of a track come with the track they belong to', async () => {
    const calls = record(() => ({ collection: [{ id: 1, body: 'x', timestamp: 10, user: { id: 2, username: 'b' } }, { id: 2, body: 'y', timestamp: null, user: { id: 2, username: 'b' } }] }))
    expect(await sc.getComments(402)).toEqual({ trackId: 402, comments: [{ id: 1, atMs: 10, body: 'x', user: { name: 'b' } }] })
    expect(calls[0].path).toBe('/tracks/402/comments?threaded=0&filter_replies=1&limit=200')
  })
})

describe('whom someone follows', () => {
  test('the people come a page at a time, with their counts', async () => {
    const calls = record(() => ({
      collection: [{ id: 501, username: 'night owl', followers_count: 12480, permalink_url: 'https://soundcloud.com/night-owl' }],
      next_href: 'https://api-v2.soundcloud.com/users/7/followings?offset=1&limit=50',
    }))
    const page = await sc.getFollowingUsers(7)
    expect(page.items).toMatchObject([{ id: 501, name: 'night owl', followers: 12480 }])
    expect(page.next).toBe('/users/7/followings?offset=1&limit=50')
    await sc.getFollowingUsers(7, page.next)
    expect(calls.map((c) => c.path)).toEqual(['/users/7/followings?limit=50', '/users/7/followings?offset=1&limit=50'])
  })
})
