import { describe, expect, test } from 'vitest'
import type { Playlist, Track } from '../vk/models'
import { isAlgorithmicVkPlaylist, isRealTrackCover, needsDerivedPlaylistCovers, pickRealTrackCovers } from './covers'

const track = (id: number, patch: Partial<Track> = {}): Track => ({
  id,
  ownerId: 1,
  key: `1_${id}`,
  title: `Track ${id}`,
  artist: 'Artist',
  artists: [{ name: 'Artist' }],
  duration: 180,
  urlFetchedAt: 0,
  explicit: false,
  playable: true,
  hasLyrics: false,
  liked: false,
  ...patch,
})

const playlist = (id: number, patch: Partial<Playlist> = {}): Playlist => ({
  id,
  ownerId: -2000,
  title: 'Плейлист',
  count: 10,
  covers: [],
  isOwn: false,
  isFollowed: false,
  canEdit: false,
  type: 'playlist',
  ...patch,
})

describe('track & playlist real covers', () => {
  test('isRealTrackCover distinguishes VK tracks with real release albums from coverless/placeholder tracks', () => {
    const withAlbum = track(1, {
      cover: { s: 'https://img/s1.jpg', m: 'https://img/m1.jpg', l: 'https://img/l1.jpg' },
      album: { id: 100, ownerId: -2000, title: 'Album' },
    })
    const withoutAlbum = track(2, {
      cover: { s: 'https://img/s2.jpg', m: 'https://img/m2.jpg', l: 'https://img/l2.jpg' },
    })
    const noCover = track(3, { album: { id: 101, ownerId: -2000, title: 'Album' } })
    const scTrack = track(4, {
      service: 'sc',
      cover: { s: 'https://i1.sndcdn.com/s4.jpg', m: 'https://i1.sndcdn.com/m4.jpg', l: 'https://i1.sndcdn.com/l4.jpg' },
    })
    const scDefaultAvatar = track(5, {
      service: 'sc',
      cover: { s: 'https://a1.sndcdn.com/images/default_avatar_large.png', m: 'https://a1.sndcdn.com/images/default_avatar_large.png', l: 'https://a1.sndcdn.com/images/default_avatar_large.png' },
    })

    expect(isRealTrackCover(withAlbum)).toBe(true)
    expect(isRealTrackCover(withAlbum, 'https://img/m1.jpg')).toBe(false)
    expect(isRealTrackCover(withoutAlbum)).toBe(false)
    expect(isRealTrackCover(noCover)).toBe(false)
    expect(isRealTrackCover(scTrack)).toBe(true)
    expect(isRealTrackCover(scDefaultAvatar)).toBe(false)
  })

  test('pickRealTrackCovers skips coverless tracks, deduplicates covers, and falls back only when no album-backed covers exist', () => {
    const tNoCover = track(1)
    const tNoAlbum = track(2, { cover: { s: 'https://img/na.jpg', m: 'https://img/na.jpg', l: 'https://img/na.jpg' } })
    const tReal1 = track(3, {
      cover: { s: 'https://img/r1.jpg', m: 'https://img/r1.jpg', l: 'https://img/r1.jpg' },
      album: { id: 10, ownerId: -1, title: 'A1' },
    })
    const tReal1Dup = track(4, {
      cover: { s: 'https://img/r1.jpg', m: 'https://img/r1.jpg', l: 'https://img/r1.jpg' },
      album: { id: 10, ownerId: -1, title: 'A1' },
    })
    const tReal2 = track(5, {
      cover: { s: 'https://img/r2.jpg', m: 'https://img/r2.jpg', l: 'https://img/r2.jpg' },
      album: { id: 11, ownerId: -1, title: 'A2' },
    })

    expect(pickRealTrackCovers([tNoCover, tNoAlbum, tReal1, tReal1Dup, tReal2], 3)).toEqual([
      'https://img/r1.jpg',
      'https://img/r2.jpg',
    ])
    expect(pickRealTrackCovers([tNoCover, tNoAlbum], 3)).toEqual(['https://img/na.jpg'])
  })

  test('identifies VK algorithmic playlists and coverless playlists/albums', () => {
    expect(isAlgorithmicVkPlaylist(playlist(1, { title: 'Для вас', cover: 'https://vk/wave.png' }))).toBe(true)
    expect(isAlgorithmicVkPlaylist(playlist(2, { title: 'Открытия', cover: 'https://vk/wave.png' }))).toBe(true)
    expect(isAlgorithmicVkPlaylist(playlist(3, { title: 'Новинки', cover: 'https://vk/wave.png' }))).toBe(true)
    expect(isAlgorithmicVkPlaylist(playlist(4, { title: 'Плейлист дня 3', cover: 'https://vk/wave.png' }))).toBe(true)
    expect(isAlgorithmicVkPlaylist(playlist(-10, { title: 'Мой микс' }))).toBe(true)
    expect(isAlgorithmicVkPlaylist(playlist(5, { title: 'Для вас', service: 'spotify' }))).toBe(false)

    expect(needsDerivedPlaylistCovers(playlist(10, { title: 'Обычный', cover: 'https://vk/c.jpg' }))).toBe(false)
    expect(needsDerivedPlaylistCovers(playlist(11, { title: 'Без обложки', cover: undefined, covers: [] }))).toBe(true)
    expect(needsDerivedPlaylistCovers(playlist(12, { title: 'Открытия', cover: 'https://vk/wave.png' }))).toBe(true)
  })
})
