export interface Cover {
  s: string
  m: string
  l: string
}

/** Where a track or a playlist comes from. */
export type ServiceId = 'vk' | 'sc' | 'spotify'
export type AudioServiceId = ServiceId

/** Older saved queues and history have no `service`: they are VK's. */
export const serviceOf = (x: { service?: ServiceId }): ServiceId => x.service ?? 'vk'

export interface Track {
  /** Absent for VK (and for everything saved before SoundCloud came). */
  service?: ServiceId
  /** Spotify: the 22-character base62 id of the track. */
  spotifyId?: string
  /** Spotify: unique playlist item uid used when removing a track from a playlist. */
  spotifyUid?: string
  /** SoundCloud / Spotify: the track's page — what «Скопировать ссылку» copies. */
  permalink?: string
  id: number
  ownerId: number
  /** "owner_id" — stable identity of the track in VK. */
  key: string
  accessKey?: string
  artist: string
  title: string
  subtitle?: string
  duration: number
  url?: string
  /** ms timestamp when `url` was received; 0 when there is no url. */
  urlFetchedAt: number
  cover?: Cover
  album?: { id: number; ownerId: number; accessKey?: string; title: string; spotifyId?: string }
  explicit: boolean
  artists: { id?: string; name: string }[]
  playable: boolean
  hasLyrics: boolean
  /** In the viewer's "Моя музыка" (VK `like` flag). */
  liked: boolean
  releaseId?: string
}

export interface Playlist {
  service?: ServiceId
  /** Spotify: the 22-character base62 id of the playlist or album. */
  spotifyId?: string
  /** SoundCloud system playlists («Mixed for you»…) are known by urn, not by id. */
  urn?: string
  permalink?: string
  id: number
  ownerId: number
  accessKey?: string
  title: string
  description?: string
  count: number
  cover?: string
  covers: string[]
  isOwn: boolean
  isFollowed: boolean
  canEdit: boolean
  type: 'playlist' | 'album'
  albumType?: 'album' | 'single' | 'compilation'
  ownerName?: string
  year?: number
  /** How many times it was played in VK, when VK says. */
  plays?: number
  /** For a followed copy: the playlist it was followed from. */
  original?: { id: number; ownerId: number; accessKey?: string }
}

export interface Friend {
  id: number
  name: string
  photo?: string
  canSeeAudio: boolean
}

export interface User {
  id: number
  name: string
  photo?: string
}

export interface RecommendedPlaylist {
  playlist: Playlist
  /** Taste match, 0..1 */
  match: number
  matchTitle: string
  color?: string
  background?: string
  ownerPhoto?: string
  /** A few tracks VK picked as a preview */
  tracks: Track[]
}

interface BlockBase {
  id: string
  title: string
  nextFrom?: string
  layout?: string
  /** «Показать все»: the catalog section holding the whole list behind this block. */
  more?: string
}

export type Block =
  | (BlockBase & { kind: 'tracks'; tracks: Track[] })
  | (BlockBase & { kind: 'playlists'; playlists: Playlist[] })
  | (BlockBase & { kind: 'mix'; mixId: string; description?: string })
  | (BlockBase & { kind: 'recommended'; items: RecommendedPlaylist[] })

export interface CatalogSection {
  id: string
  title: string
  url?: string
  blocks: Block[]
  nextFrom?: string
}

export interface LyricsWord {
  text: string
  /** ms from track start */
  begin: number
  end?: number
}

export interface LyricsLine {
  text: string
  /** ms from track start, only for synced lyrics */
  begin?: number
  end?: number
  words?: LyricsWord[]
}

export type LyricsSource = 'vk' | 'spotify' | 'lrclib' | 'netease' | 'kugou' | 'qq' | 'genius' | 'ovh' | 'ai'

export interface Lyrics {
  synced: boolean
  lines: LyricsLine[]
  credits?: string
  source?: LyricsSource
  instrumental?: boolean
}
