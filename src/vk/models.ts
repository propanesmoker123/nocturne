export interface Cover {
  s: string
  m: string
  l: string
}

export interface Track {
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
  album?: { id: number; ownerId: number; accessKey?: string; title: string }
  explicit: boolean
  artists: { id?: string; name: string }[]
  playable: boolean
  hasLyrics: boolean
  /** In the viewer's "Моя музыка" (VK `like` flag). */
  liked: boolean
  releaseId?: string
}

export interface Playlist {
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
  ownerName?: string
  year?: number
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

interface BlockBase {
  id: string
  title: string
  nextFrom?: string
  layout?: string
}

export type Block =
  | (BlockBase & { kind: 'tracks'; tracks: Track[] })
  | (BlockBase & { kind: 'playlists'; playlists: Playlist[] })
  | (BlockBase & { kind: 'mix'; mixId: string; description?: string })

export interface CatalogSection {
  id: string
  title: string
  url?: string
  blocks: Block[]
  nextFrom?: string
}

export interface LyricsLine {
  text: string
  /** ms from track start, only for synced lyrics */
  begin?: number
}

export interface Lyrics {
  synced: boolean
  lines: LyricsLine[]
  credits?: string
}
