import { describe, expect, test } from 'vitest'
import { canFollow, countsLine, openTab, visibleTabs, type ProfileTab, type TabState } from './profile'

const st = (o: Partial<Record<ProfileTab, TabState>>) => ({ popular: 'empty', tracks: 'empty', reposts: 'empty', likes: 'empty', playlists: 'empty', ...o }) as Record<ProfileTab, TabState>

describe('a SoundCloud profile page', () => {
  test("a listener's profile opens on the first tab with something", () => {
    const s = st({ reposts: 'some', likes: 'some' })
    expect(visibleTabs(s)).toEqual(['reposts', 'likes'])
    expect(openTab(s)).toBe('reposts')
  })

  test('it waits for earlier tabs before choosing', () => {
    expect(openTab(st({ popular: 'loading', tracks: 'some' }))).toBeNull()
    expect(openTab(st({ popular: 'some', likes: 'loading' }))).toBe('popular')
  })

  test('nothing anywhere: no tab, a failed one is still offered', () => {
    expect(openTab(st({}))).toBeNull()
    expect(visibleTabs(st({ likes: 'error' }))).toEqual(['likes'])
    expect(openTab(st({ likes: 'error' }))).toBe('likes')
  })

  test('the counts line', () => {
    expect(countsLine({ id: 1, name: 'x', followers: 6276, followings: 11, trackCount: 0 })).toBe('6,3 тыс. подписчиков · 11 подписок · 0 треков')
    expect(countsLine({ id: 1, name: 'x', city: 'Москва', followers: 1, followings: 2, trackCount: 1 })).toBe('Москва · 1 подписчик · 2 подписки · 1 трек')
    expect(countsLine({ id: 1, name: 'x' })).toBe('')
  })

  test('no follow button on your own profile, or signed out', () => {
    expect([canFollow(5, 5), canFollow(5, 0), canFollow(5, 7)]).toEqual([false, false, true])
  })
})
