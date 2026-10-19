/** api-v2 answers as they come (only the fields Nocturne reads). Stub tracks inside playlists
 *  carry just `id`, `kind` and `policy` and are filled in through `/tracks?ids=`. */

export interface RawScUser {
  id: number
  username?: string
  full_name?: string
  avatar_url?: string | null
  permalink_url?: string
  city?: string | null
  followers_count?: number
  followings_count?: number
  track_count?: number
}

/** A comment at a moment of a track (`timestamp`, ms from the start). */
export interface RawScComment {
  id: number
  body?: string
  timestamp?: number | null
  user?: RawScUser
}

export interface RawScTranscoding {
  url: string
  preset?: string
  snipped?: boolean
  format: { protocol: string; mime_type: string }
}

export interface RawScTrack {
  id: number
  kind?: string
  title?: string
  /** ms; a 30-second preview has 30000 here and the real length in `full_duration` */
  duration?: number
  full_duration?: number
  artwork_url?: string | null
  permalink_url?: string
  policy?: string
  streamable?: boolean
  user?: RawScUser
  publisher_metadata?: { artist?: string; explicit?: boolean } | null
  media?: { transcodings: RawScTranscoding[] }
}

export interface RawScPlaylist {
  /** a number for playlists and albums; system playlists are known by `urn` */
  id?: number | string
  urn?: string
  kind?: string
  title?: string
  short_title?: string
  description?: string | null
  short_description?: string | null
  artwork_url?: string | null
  calculated_artwork_url?: string | null
  permalink_url?: string
  track_count?: number
  is_album?: boolean
  user?: RawScUser
  tracks?: RawScTrack[]
}

export interface RawScSelection {
  id?: string
  urn?: string
  title?: string
  description?: string | null
  items?: { collection?: RawScPlaylist[] }
}

export interface RawScStreamItem {
  type?: string
  track?: RawScTrack
  playlist?: RawScPlaylist
}

export interface RawScLike {
  track?: RawScTrack
}

export interface RawScLibraryItem {
  type?: string
  playlist?: RawScPlaylist
  system_playlist?: RawScPlaylist
}

export interface RawScCollection<T> {
  collection?: T[]
  next_href?: string | null
}
