import { describe, expect, test } from 'vitest'
import { playlistRaw, trackRaw } from './fixtures'
import { agoRu, feedPage, mergeFeed, settlePage, streamFeed, uniqueTracks, userActivity, type FeedItem } from './feed'

const owl = { id: 501, username: 'night owl', avatar_url: 'https://i1.sndcdn.com/avatars-000501-aaaaaa-large.jpg' }
const peep = { id: 7, name: 'LIL PEEP' }

describe('the SoundCloud feed', () => {
  test('the stream gives posts and reposts, with who and when', () => {
    const items = streamFeed([
      { type: 'track', created_at: '2026-10-19T10:00:00Z', user: owl, track: trackRaw(402, 'midnight demo') },
      { type: 'track-repost', created_at: '2026-10-19T12:00:00Z', user: { id: 9, username: 'kid' }, track: trackRaw(403, 'tape loop 03') },
      { type: 'playlist-repost', created_at: '2026-10-18T09:00:00Z', user: { id: 9, username: 'kid' }, playlist: playlistRaw },
      { type: 'track', created_at: '2026-10-19T08:00:00Z', track: { id: 404, kind: 'track' } },
      { type: 'track', user: owl, track: trackRaw(405, 'neon rain') },
    ])
    expect(items.map((i) => [i.kind, i.who.name, i.track?.title ?? i.playlist?.title])).toEqual([
      ['post', 'night owl', 'midnight demo'],
      ['repost', 'kid', 'tape loop 03'],
      ['repost', 'kid', 'night drive'],
    ])
    expect(items[0].at).toBe(Date.parse('2026-10-19T10:00:00Z'))
    expect(items[0].who.avatar).toContain('-t67x67.')
  })

  test("a followed artist's own tracks, reposts and likes become dated items", () => {
    const items = userActivity(peep, {
      tracks: [{ ...trackRaw(410, 'new one'), created_at: '2026-10-20T01:00:00Z' }],
      reposts: [{ type: 'track-repost', created_at: '2026-10-19T00:00:00Z', track: trackRaw(411, 'theirs') }],
      likes: [{ created_at: '2026-10-18T00:00:00Z', track: trackRaw(412, 'liked') }, { created_at: '2026-10-17T00:00:00Z', playlist: playlistRaw }],
    })
    expect(items.map((i) => [i.kind, i.who.name, i.track?.title ?? i.playlist?.title, new Date(i.at).toISOString().slice(0, 10)])).toEqual([
      ['post', 'LIL PEEP', 'new one', '2026-10-20'],
      ['repost', 'LIL PEEP', 'theirs', '2026-10-19'],
      ['like', 'LIL PEEP', 'liked', '2026-10-18'],
      ['like', 'LIL PEEP', 'night drive', '2026-10-17'],
    ])
  })

  test('the feed is newest first, and the same thing by the same person once', () => {
    const a = userActivity(peep, { tracks: [], reposts: [{ type: 'track-repost', created_at: '2026-10-19T00:00:00Z', track: trackRaw(411, 'x') }], likes: [] })
    const b = streamFeed([{ type: 'track-repost', created_at: '2026-10-19T00:00:00Z', user: { id: 7, username: 'LIL PEEP' }, track: trackRaw(411, 'x') }])
    const c = userActivity({ id: 8, name: 'other' }, { tracks: [], reposts: [], likes: [{ created_at: '2026-10-20T00:00:00Z', track: trackRaw(411, 'x') }] })
    const merged = mergeFeed([a, b, c])
    expect(merged.map((i: FeedItem) => [i.kind, i.who.id])).toEqual([
      ['like', 8],
      ['repost', 7],
    ])
  })

  test('the people are taken a few at a time', () => {
    const people = Array.from({ length: 32 }, (_, i) => ({ id: i + 1, name: `p${i}` }))
    expect(feedPage(people, 0, 15)).toEqual({ people: people.slice(0, 15), next: 15 })
    expect(feedPage(people, 30, 15)).toEqual({ people: people.slice(30), next: undefined })
  })

  test('when, in Russian', () => {
    const now = Date.parse('2026-10-20T12:00:00Z')
    expect(agoRu(now - 30_000, now)).toBe('только что')
    expect(agoRu(now - 5 * 60_000, now)).toBe('5 мин')
    expect(agoRu(now - 3 * 3_600_000, now)).toBe('3 ч')
    expect(agoRu(now - 30 * 3_600_000, now)).toBe('вчера')
    expect(agoRu(now - 3 * 86_400_000, now)).toBe('3 дня')
    expect(agoRu(now - 5 * 86_400_000, now)).toBe('5 дней')
    expect(agoRu(Date.parse('2026-09-12T12:00:00Z'), now)).toBe('12 сент.')
    expect(agoRu(Date.parse('2025-09-12T12:00:00Z'), now)).toBe('12 сент. 2025')
  })
})

test('profiles are read a few at a time, in order', async () => {
  const { mapLimit } = await import('./feed')
  let running = 0
  let most = 0
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
    running++
    most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, 5))
    running--
    return n * 10
  })
  expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])
  expect(most).toBe(4)
})

describe('a page of the feed when SoundCloud does not answer', () => {
  const a = userActivity({ id: 7, name: 'a' }, { tracks: [{ ...trackRaw(410, 'x'), created_at: '2026-10-20T01:00:00Z' }], reposts: [], likes: [] })
  const b = userActivity({ id: 8, name: 'b' }, { tracks: [{ ...trackRaw(411, 'y'), created_at: '2026-10-19T01:00:00Z' }], reposts: [], likes: [] })
  const down = new Error('offline')

  test('what came is kept, and the profiles that did not are counted', () => {
    const page = settlePage([{ ok: true, value: a }, { ok: false, error: down }, { ok: true, value: b }])
    expect(page.items.map((i) => i.track?.title)).toEqual(['x', 'y'])
    expect(page.failed).toBe(1)
  })

  test('nothing coming at all is an error, not an empty feed', () => {
    expect(() => settlePage([{ ok: false, error: down }, { ok: false, error: new Error('later') }])).toThrow('offline')
    expect(settlePage([])).toEqual({ items: [], failed: 0 })
  })
})

test('a track in the feed several times plays once, at its newest place', () => {
  const t = (id: number, title: string) => ({ ...userActivity({ id, name: title }, { tracks: [{ ...trackRaw(id, title), created_at: '2026-10-20T01:00:00Z' }], reposts: [], likes: [] })[0].track! })
  const x = t(1, 'x')
  const y = t(2, 'y')
  expect(uniqueTracks([x, y, x, x]).map((tr) => tr.title)).toEqual(['x', 'y'])
})
