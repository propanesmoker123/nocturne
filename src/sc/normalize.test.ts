import { describe, expect, test } from 'vitest'
import { serviceOf } from '../vk/models'
import { albumRaw, blocked, encryptedOnly, playlistRaw, snippedOnly, snipPolicy, streamRaw, systemPlaylistRaw, trackRaw, userRaw } from './fixtures'
import { artwork, normalizeScComment, normalizeScPlaylist, normalizeScTrack, normalizeScUser, streamItems } from './normalize'

describe('SoundCloud tracks', () => {
  test('a full SoundCloud track becomes a playable Nocturne track', () => {
    const t = normalizeScTrack(trackRaw(402, 'midnight demo'))
    expect(t).toMatchObject({ key: 'sc_402', service: 'sc', id: 402, ownerId: 501, artist: 'Night Owl', title: 'midnight demo', duration: 201, playable: true, liked: false, hasLyrics: false, explicit: false })
    expect(t.cover?.l).toContain('-t500x500.')
    expect(t.cover?.m).toContain('-t300x300.')
    expect(t.cover?.s).toContain('-t67x67.')
    expect(t.artists).toEqual([{ id: '501', name: 'Night Owl' }])
    expect(t.permalink).toBe('https://soundcloud.com/night-owl/midnight-demo')
    expect(t.urlFetchedAt).toBe(0)
  })

  test('liked comes from the caller', () => {
    expect(normalizeScTrack(trackRaw(402, 'x'), true).liked).toBe(true)
  })

  test('the artist falls back to the uploader', () => {
    const t = normalizeScTrack(trackRaw(402, 'x', { publisher_metadata: null }))
    expect(t.artist).toBe('night owl')
    expect(t.artists).toEqual([{ id: '501', name: 'night owl' }])
  })

  test('an encrypted-only, snipped, SNIP or BLOCK track is not playable', () => {
    for (const raw of [encryptedOnly, snippedOnly, snipPolicy, blocked]) expect(normalizeScTrack(raw).playable, raw.title).toBe(false)
  })

  test('no artwork falls back to the avatar; none at all gives no cover', () => {
    expect(normalizeScTrack(trackRaw(402, 'x', { artwork_url: null })).cover?.l).toContain('avatars-000501')
    expect(normalizeScTrack(trackRaw(402, 'x', { artwork_url: null, user: { ...userRaw, avatar_url: null } })).cover).toBeUndefined()
    expect(artwork(undefined)).toBeUndefined()
  })
})

describe('SoundCloud playlists', () => {
  test('a system playlist keeps its urn, an album is an album', () => {
    const sys = normalizeScPlaylist(systemPlaylistRaw)
    expect(sys).toMatchObject({ service: 'sc', id: 0, urn: 'soundcloud:system-playlists:mixed-for-you:7', title: 'Mixed for listener', description: 'Tracks picked for you', count: 4, type: 'playlist', isOwn: false, canEdit: false, isFollowed: false })
    expect(sys.cover).toContain('-t500x500.')
    const pl = normalizeScPlaylist(playlistRaw)
    expect(pl).toMatchObject({ service: 'sc', id: 9001, title: 'night drive', type: 'playlist', ownerName: 'night owl', count: 4, permalink: 'https://soundcloud.com/night-owl/sets/night-drive' })
    expect(pl.urn).toBeUndefined()
    expect(normalizeScPlaylist(albumRaw).type).toBe('album')
  })
})

describe('the feed', () => {
  test('stream items split into tracks and playlists, reposts included, duplicates dropped', () => {
    const { tracks, playlists } = streamItems(streamRaw)
    expect(tracks.map((t) => t.key)).toEqual(['sc_402', 'sc_406'])
    expect(playlists.map((p) => p.id)).toEqual([9001])
  })
})

test('a SoundCloud profile', () => {
  expect(normalizeScUser(userRaw)).toEqual({ id: 501, name: 'night owl', avatar: 'https://i1.sndcdn.com/avatars-000501-aaaaaa-t300x300.jpg', permalink: 'https://soundcloud.com/night-owl', city: 'Berlin', followers: 12480, followings: 87, trackCount: 6 })
})

test('serviceOf treats a track without service as VK', () => {
  expect(serviceOf({})).toBe('vk')
  expect(serviceOf({ service: 'sc' })).toBe('sc')
})

describe('SoundCloud profiles and comments', () => {
  test('a profile carries its counts, and an empty city is none', () => {
    expect(normalizeScUser({ id: 1, username: 'u', city: '', followers_count: 6276, followings_count: 11, track_count: 0 })).toMatchObject({ followers: 6276, followings: 11, trackCount: 0, city: undefined })
    expect(normalizeScUser({ id: 2, username: 'v', city: 'Москва' }).city).toBe('Москва')
  })

  test('comments without a place on the track are left out', () => {
    const user = { id: 3, username: 'Аня', avatar_url: 'https://i1.sndcdn.com/avatars-x-large.jpg' }
    expect(normalizeScComment({ id: 1, body: ' огонь ', timestamp: 43638, user })).toEqual({ id: 1, atMs: 43638, body: 'огонь', user: { name: 'Аня', avatar: 'https://i1.sndcdn.com/avatars-x-t67x67.jpg' } })
    for (const bad of [{ timestamp: null }, { timestamp: -1 }, { timestamp: undefined }, { body: '  ' }, { user: undefined }]) {
      expect(normalizeScComment({ id: 2, body: 'x', timestamp: 5, user, ...bad })).toBeNull()
    }
    expect(normalizeScComment({ id: 3, body: 'я'.repeat(400), timestamp: 5, user })!.body).toHaveLength(300)
  })
})
