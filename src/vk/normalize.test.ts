import { describe, expect, test } from 'vitest'
import { normalizeFriend, normalizePlaylist, normalizeTrack, normalizeUser, trackKeyWithAccess } from './normalize'
import type { RawAudio, RawPlaylist } from './types'

const thumb = {
  width: 1200,
  height: 1200,
  photo_34: 'https://img/34.jpg',
  photo_68: 'https://img/68.jpg',
  photo_135: 'https://img/135.jpg',
  photo_270: 'https://img/270.jpg',
  photo_300: 'https://img/300.jpg',
  photo_600: 'https://img/600.jpg',
  photo_1200: 'https://img/1200.jpg',
}

const rawAudio = (over: Partial<RawAudio> = {}): RawAudio => ({
  id: 456,
  owner_id: 123,
  artist: 'Artist A feat. Artist B',
  title: 'Song One',
  duration: 201,
  access_key: 'k1',
  url: 'https://cs1-1v4.vkuseraudio.ru/s/v1/ac/abc/index.m3u8?siren=1',
  is_explicit: false,
  main_artists: [{ id: '111', name: 'Artist A', domain: 'artista' }],
  featured_artists: [{ id: '222', name: 'Artist B', domain: 'artistb' }],
  album: { id: 9, owner_id: -5, title: 'Album X', access_key: 'ak', thumb },
  ...over,
})

describe('normalizeTrack', () => {
  test('maps core fields and builds the owner_id key', () => {
    const t = normalizeTrack(rawAudio(), 1000)
    expect(t).toMatchObject({
      id: 456,
      ownerId: 123,
      key: '123_456',
      accessKey: 'k1',
      artist: 'Artist A feat. Artist B',
      title: 'Song One',
      duration: 201,
      urlFetchedAt: 1000,
      explicit: false,
      playable: true,
      album: { id: 9, ownerId: -5, accessKey: 'ak', title: 'Album X' },
    })
  })

  test('picks small, medium and large covers from the album thumb', () => {
    expect(normalizeTrack(rawAudio()).cover).toEqual({
      s: 'https://img/68.jpg',
      m: 'https://img/300.jpg',
      l: 'https://img/1200.jpg',
    })
  })

  test('falls back to the track thumb when the album has none', () => {
    const t = normalizeTrack(rawAudio({ album: { id: 1, owner_id: 1, title: 'a' }, thumb: { photo_135: 'https://img/t135.jpg' } }))
    expect(t.cover).toEqual({ s: 'https://img/t135.jpg', m: 'https://img/t135.jpg', l: 'https://img/t135.jpg' })
  })

  test('has no cover when no thumbs exist', () => {
    expect(normalizeTrack(rawAudio({ album: undefined, thumb: undefined })).cover).toBeUndefined()
  })

  test('combines main and featured artists', () => {
    expect(normalizeTrack(rawAudio()).artists).toEqual([
      { id: '111', name: 'Artist A' },
      { id: '222', name: 'Artist B' },
    ])
  })

  test('derives a single artist from the artist string when main_artists is missing', () => {
    const t = normalizeTrack(rawAudio({ main_artists: undefined, featured_artists: undefined, artist: 'Solo' }))
    expect(t.artists).toEqual([{ name: 'Solo' }])
  })

  test('is not playable when the url is empty or the content is restricted', () => {
    expect(normalizeTrack(rawAudio({ url: '' })).playable).toBe(false)
    expect(normalizeTrack(rawAudio({ url: '' })).urlFetchedAt).toBe(0)
    expect(normalizeTrack(rawAudio({ content_restricted: 1 })).playable).toBe(false)
  })

  test('marks explicit tracks and keeps the subtitle', () => {
    const t = normalizeTrack(rawAudio({ is_explicit: true, subtitle: 'Remix' }))
    expect(t.explicit).toBe(true)
    expect(t.subtitle).toBe('Remix')
  })

  test('maps the library flag and the release id', () => {
    const t = normalizeTrack(rawAudio({ like: true, release_audio_id: '-2001_77' }))
    expect(t.liked).toBe(true)
    expect(t.releaseId).toBe('-2001_77')
    expect(normalizeTrack(rawAudio()).liked).toBe(false)
  })

  test('decodes html entities VK leaves in titles', () => {
    expect(normalizeTrack(rawAudio({ title: 'Rock &amp; Roll', artist: 'A &quot;B&quot;' })).title).toBe('Rock & Roll')
    expect(normalizeTrack(rawAudio({ title: 'x', artist: 'A &quot;B&quot;' })).artist).toBe('A "B"')
  })
})

describe('trackKeyWithAccess', () => {
  test('appends the access key when present', () => {
    expect(trackKeyWithAccess(normalizeTrack(rawAudio()))).toBe('123_456_k1')
    expect(trackKeyWithAccess(normalizeTrack(rawAudio({ access_key: undefined })))).toBe('123_456')
  })
})

const rawPlaylist = (over: Partial<RawPlaylist> = {}): RawPlaylist => ({
  id: 7,
  owner_id: 100,
  type: 0,
  title: 'My mix',
  description: '',
  count: 12,
  photo: thumb,
  access_key: 'pk',
  permissions: { play: true, share: true, edit: true, follow: false, delete: true },
  ...over,
})

describe('normalizePlaylist', () => {
  test('marks own playlists as editable', () => {
    const p = normalizePlaylist(rawPlaylist(), 100)
    expect(p).toMatchObject({ id: 7, ownerId: 100, accessKey: 'pk', title: 'My mix', count: 12, isOwn: true, isFollowed: false, canEdit: true, type: 'playlist' })
    expect(p.cover).toBe('https://img/600.jpg')
    expect(p.description).toBeUndefined()
  })

  test('treats playlists of other owners as not own', () => {
    const p = normalizePlaylist(rawPlaylist({ owner_id: -42, permissions: { play: true, edit: false } }), 100)
    expect(p.isOwn).toBe(false)
    expect(p.canEdit).toBe(false)
  })

  test('recognises followed copies via original or is_following', () => {
    const viaOriginal = normalizePlaylist(rawPlaylist({ original: { playlist_id: 1, owner_id: -9, access_key: 'o' } }), 100)
    expect(viaOriginal.isFollowed).toBe(true)
    expect(viaOriginal.isOwn).toBe(false)
    expect(viaOriginal.original).toEqual({ id: 1, ownerId: -9, accessKey: 'o' })
    expect(normalizePlaylist(rawPlaylist({ owner_id: -9, is_following: true }), 100).isFollowed).toBe(true)
  })

  test('detects albums from numeric or string type', () => {
    expect(normalizePlaylist(rawPlaylist({ type: 1 }), 100).type).toBe('album')
    expect(normalizePlaylist(rawPlaylist({ type: 'album' }), 100).type).toBe('album')
  })

  test('uses mosaic thumbs when there is no photo', () => {
    const p = normalizePlaylist(rawPlaylist({ photo: undefined, thumbs: [{ photo_300: 'https://a' }, { photo_300: 'https://b' }] }), 100)
    expect(p.cover).toBeUndefined()
    expect(p.covers).toEqual(['https://a', 'https://b'])
  })

  test('resolves the owner name from a lookup', () => {
    const p = normalizePlaylist(rawPlaylist({ owner_id: -9 }), 100, new Map([[-9, 'VK Музыка']]))
    expect(p.ownerName).toBe('VK Музыка')
  })
})

describe('normalizeFriend / normalizeUser', () => {
  test('friend with audio access', () => {
    expect(normalizeFriend({ id: 5, first_name: 'Иван', last_name: 'Петров', photo_100: 'https://p', can_see_audio: 1 })).toEqual({
      id: 5,
      name: 'Иван Петров',
      photo: 'https://p',
      canSeeAudio: true,
    })
  })

  test('deactivated friends cannot share audio', () => {
    expect(normalizeFriend({ id: 5, first_name: 'A', last_name: 'B', can_see_audio: 1, deactivated: 'deleted' }).canSeeAudio).toBe(false)
  })

  test('user prefers the larger photo', () => {
    expect(normalizeUser({ id: 1, first_name: 'A', last_name: 'B', photo_100: 'https://s', photo_200: 'https://l' })).toEqual({ id: 1, name: 'A B', photo: 'https://l' })
  })
})
