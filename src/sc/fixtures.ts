import type { RawScComment, RawScPlaylist, RawScSelection, RawScStreamItem, RawScTrack, RawScTranscoding, RawScUser } from './types'

/** Made-up SoundCloud data in api-v2's shape: for tests and for the browser mock. */

export const userRaw: RawScUser = {
  id: 501,
  username: 'night owl',
  avatar_url: 'https://i1.sndcdn.com/avatars-000501-aaaaaa-large.jpg',
  permalink_url: 'https://soundcloud.com/night-owl',
  city: 'Berlin',
  followers_count: 12_480,
  followings_count: 87,
  track_count: 6,
}

/** Someone who only listens: no tracks of their own, reposts and likes. */
export const listenerRaw: RawScUser = {
  id: 502,
  username: 'quiet listener',
  avatar_url: null,
  permalink_url: 'https://soundcloud.com/quiet-listener',
  city: '',
  followers_count: 6276,
  followings_count: 11,
  track_count: 0,
}

export const meRaw: RawScUser = { id: 7, username: 'listener', avatar_url: null, permalink_url: 'https://soundcloud.com/listener' }

const tc = (preset: string, mime: string, protocol = 'hls', snipped = false): RawScTranscoding => ({
  url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:1/${preset}/stream/hls`,
  preset,
  snipped,
  format: { protocol, mime_type: mime },
})

const AAC = 'audio/mp4; codecs="mp4a.40.2"'

export function trackRaw(id: number, title: string, extra: Partial<RawScTrack> = {}): RawScTrack {
  return {
    id,
    kind: 'track',
    title,
    duration: 201_000,
    full_duration: 201_400,
    artwork_url: `https://i1.sndcdn.com/artworks-000${id}-bbbbbb-large.jpg`,
    permalink_url: `https://soundcloud.com/night-owl/${title.replace(/\s+/g, '-')}`,
    policy: 'ALLOW',
    streamable: true,
    user: userRaw,
    publisher_metadata: { artist: 'Night Owl', explicit: false },
    media: { transcodings: [tc('aac_160k', AAC), tc('aac_96k', AAC), tc('abr_sq', 'audio/mpegurl')] },
    ...extra,
  }
}

export const encryptedOnly = trackRaw(410, 'locked', { media: { transcodings: [tc('aac_256k', AAC, 'ctr-encrypted-hls'), tc('aac_256k', AAC, 'cbc-encrypted-hls')] } })
export const snippedOnly = trackRaw(411, 'preview', { duration: 30_000, media: { transcodings: [tc('aac_160k', AAC, 'hls', true)] } })
export const snipPolicy = trackRaw(412, 'go plus', { policy: 'SNIP' })
export const blocked = trackRaw(413, 'blocked here', { policy: 'BLOCK' })

export const tracks = [trackRaw(402, 'midnight demo'), trackRaw(403, 'tape loop 03'), trackRaw(404, 'late tram'), trackRaw(405, 'neon rain'), trackRaw(406, 'quiet hours'), trackRaw(407, 'last bus')]

export const stub = (id: number): RawScTrack => ({ id, kind: 'track', policy: 'ALLOW' })

export const systemPlaylistRaw: RawScPlaylist = {
  id: 'soundcloud:system-playlists:mixed-for-you:7',
  urn: 'soundcloud:system-playlists:mixed-for-you:7',
  kind: 'system-playlist',
  title: 'Mixed for listener',
  short_description: 'Tracks picked for you',
  artwork_url: null,
  calculated_artwork_url: 'https://i1.sndcdn.com/artworks-000402-bbbbbb-large.jpg',
  tracks: [tracks[0], tracks[1], stub(404), stub(405)],
}

export const playlistRaw: RawScPlaylist = {
  id: 9001,
  kind: 'playlist',
  title: 'night drive',
  artwork_url: 'https://i1.sndcdn.com/artworks-009001-cccccc-large.jpg',
  permalink_url: 'https://soundcloud.com/night-owl/sets/night-drive',
  track_count: 4,
  is_album: false,
  user: userRaw,
  tracks: [tracks[2], tracks[3], stub(406), stub(407)],
}

export const albumRaw: RawScPlaylist = { ...playlistRaw, id: 9002, title: 'owl hours', is_album: true }

export const selectionsRaw: RawScSelection[] = [
  { urn: 'soundcloud:selections:made-for-you', title: 'Made for listener', items: { collection: [systemPlaylistRaw] } },
  { urn: 'soundcloud:selections:charts', title: 'Trending by genre', items: { collection: [playlistRaw, albumRaw] } },
]

export const streamRaw: RawScStreamItem[] = [
  { type: 'track', track: tracks[0] },
  { type: 'track-repost', track: tracks[0] },
  { type: 'track', track: tracks[4] },
  { type: 'playlist-repost', playlist: playlistRaw },
]

const people = ['Аня', 'mira', 'Костя', 'lowend', 'Саша', 'nightbus']
/** A dozen comments over a track, some without an avatar. */
export const commentsRaw = (trackId: number): RawScComment[] =>
  Array.from({ length: 12 }, (_, i) => ({
    id: trackId * 100 + i,
    body: ['огонь', 'вот этот момент', 'на репите', 'bass!!', 'мурашки', 'кто здесь в 2026?'][i % 6],
    timestamp: 8_000 + i * 15_000,
    user: { id: 600 + (i % 6), username: people[i % 6], avatar_url: i % 3 === 0 ? null : `https://i1.sndcdn.com/avatars-00060${i % 6}-bbbbbb-large.jpg` },
  }))
