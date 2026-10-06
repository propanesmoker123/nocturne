// Raw VK API response shapes (only the fields Nocturne reads). Verified against
// api.vk.ru v5.289 with a web-session token on 2026-10-06 (see spec §15).

export interface RawPhotoSizes {
  width?: number
  height?: number
  id?: string
  photo_34?: string
  photo_68?: string
  photo_135?: string
  photo_270?: string
  photo_300?: string
  photo_600?: string
  photo_1200?: string
}

export interface RawArtist {
  id?: string
  name: string
  domain?: string
  is_followed?: boolean
  can_follow?: boolean
}

export interface RawAudio {
  id: number
  owner_id: number
  artist: string
  title: string
  subtitle?: string
  duration: number
  access_key?: string
  url?: string
  date?: number
  is_explicit?: boolean
  is_licensed?: boolean
  content_restricted?: number
  has_lyrics?: boolean
  track_code?: string
  /** true when the track is in the viewer's library */
  like?: boolean
  release_audio_id?: string
  main_artists?: RawArtist[]
  featured_artists?: RawArtist[]
  album?: { id: number; owner_id: number; title: string; access_key?: string; thumb?: RawPhotoSizes }
  thumb?: RawPhotoSizes
  main_color?: string
}

export interface RawPlaylist {
  id: number
  owner_id: number
  type?: number | string
  title: string
  description?: string
  count: number
  followers?: number
  plays?: number
  create_time?: number
  update_time?: number
  year?: number
  is_following?: boolean
  photo?: RawPhotoSizes
  thumbs?: RawPhotoSizes[]
  permissions?: { play?: boolean; share?: boolean; edit?: boolean; follow?: boolean; delete?: boolean }
  access_key?: string
  main_color?: string
  subtitle?: string
  album_type?: string
  main_artists?: RawArtist[]
  original?: { playlist_id: number; owner_id: number; access_key?: string }
  followed?: { playlist_id: number; owner_id: number }
}

export interface RawUser {
  id: number
  first_name: string
  last_name: string
  photo_100?: string
  photo_200?: string
  can_see_audio?: number
  is_closed?: boolean
  can_access_closed?: boolean
  deactivated?: string
}

export interface RawGroup {
  id: number
  name: string
  photo_100?: string
}

export interface RawCatalogBlock {
  id: string
  data_type: string
  layout?: { name: string; title?: string; owner_id?: number; style?: string }
  title?: string
  audios_ids?: string[]
  playlists_ids?: string[]
  audio_stream_mixes_ids?: string[]
  next_from?: string
}

export interface RawCatalogSection {
  id: string
  title: string
  url?: string
  blocks?: RawCatalogBlock[]
  next_from?: string
}

export interface RawStreamMix {
  id: string
  description?: string
  background_animation_url?: string
  titles?: { common_state?: string; play_state?: string }
  stream_mix?: { id: string; title: string }
}

export interface RawCatalogResponse {
  catalog?: { default_section: string; sections: RawCatalogSection[] }
  section?: RawCatalogSection
  audios?: RawAudio[]
  playlists?: RawPlaylist[]
  profiles?: RawUser[]
  groups?: RawGroup[]
  audio_stream_mixes?: RawStreamMix[]
}

export interface RawList<T> {
  count: number
  items: T[]
  next_from?: string
  profiles?: RawUser[]
  groups?: RawGroup[]
}

export interface RawLyrics {
  lyrics?: {
    language?: string
    text?: string[]
    timestamps?: { line?: string; begin?: number; end?: number; interlude?: boolean }[]
  }
  credits?: string
}
