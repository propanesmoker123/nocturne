import type { Cover, Playlist, Track } from '../vk/models'
import type { RawScComment, RawScPlaylist, RawScStreamItem, RawScTrack, RawScUser } from './types'

export interface ScUser {
  id: number
  name: string
  avatar?: string | null
  permalink?: string | null
  city?: string
  followers?: number
  followings?: number
  trackCount?: number
}

/** A comment on a track, at its moment (ms from the start). */
export interface ScComment {
  id: number
  atMs: number
  body: string
  user: { name: string; avatar?: string }
}

/** SoundCloud's `-large` artwork (100 px) in the three sizes Nocturne shows. */
export function artwork(url: string | null | undefined): Cover | undefined {
  if (!url) return undefined
  const size = (s: string) => url.replace('-large.', `-${s}.`)
  return { s: size('t67x67'), m: size('t300x300'), l: size('t500x500') }
}

/** This computer plays protected (CTR) streams: set at start by `probeDrm` (playback.ts). */
let drmAvailable = true
export function setDrmAvailable(on: boolean) {
  drmAvailable = on
}

/** Clear HLS (AAC or MP3), or CTR HLS in MP4 where this computer has Widevine/PlayReady; full tracks only. CBC requires FairPlay. */
export function playableTrack(r: RawScTrack): boolean {
  if (r.streamable === false || r.policy === 'BLOCK' || r.policy === 'SNIP') return false
  return (r.media?.transcodings ?? []).some((c) => {
    const mime = c.format?.mime_type ?? ''
    if (c.snipped) return false
    if (c.format?.protocol === 'hls') return mime.startsWith('audio/mp4') || (mime.startsWith('audio/mpeg') && !mime.startsWith('audio/mpegurl'))
    return drmAvailable && c.format?.protocol === 'ctr-encrypted-hls' && mime.startsWith('audio/mp4')
  })
}

export function normalizeScTrack(r: RawScTrack, liked = false): Track {
  const user = r.user
  const artist = r.publisher_metadata?.artist?.trim() || user?.username || ''
  const ms = r.full_duration ?? r.duration ?? 0
  return {
    service: 'sc',
    key: `sc_${r.id}`,
    id: r.id,
    ownerId: user?.id ?? 0,
    artist,
    title: r.title ?? '',
    duration: Math.round(ms / 1000),
    urlFetchedAt: 0,
    cover: artwork(r.artwork_url || user?.avatar_url),
    explicit: r.publisher_metadata?.explicit ?? false,
    artists: user ? [{ id: String(user.id), name: artist }] : [{ name: artist }],
    playable: playableTrack(r),
    hasLyrics: false,
    liked,
    permalink: r.permalink_url,
  }
}

export function normalizeScPlaylist(r: RawScPlaylist): Playlist {
  const system = r.kind === 'system-playlist' || (r.urn ?? '').startsWith('soundcloud:system-playlists:')
  return {
    service: 'sc',
    id: typeof r.id === 'number' ? r.id : 0,
    ...(system && r.urn ? { urn: r.urn } : {}),
    ownerId: r.user?.id ?? 0,
    title: r.title || r.short_title || '',
    description: r.short_description || r.description || undefined,
    count: r.track_count ?? r.tracks?.length ?? 0,
    cover: artwork(r.artwork_url || r.calculated_artwork_url)?.l,
    covers: [],
    isOwn: false,
    isFollowed: false,
    canEdit: false,
    type: r.is_album ? 'album' : 'playlist',
    ownerName: r.user?.username,
    permalink: r.permalink_url,
  }
}

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined)

export function normalizeScUser(r: RawScUser): ScUser {
  return {
    id: r.id,
    name: r.username || r.full_name || '',
    avatar: artwork(r.avatar_url)?.m,
    permalink: r.permalink_url,
    city: r.city?.trim() || undefined,
    followers: count(r.followers_count),
    followings: count(r.followings_count),
    trackCount: count(r.track_count),
  }
}

/** A comment as shown on the waveform; none without a moment, a text or an author. */
export function normalizeScComment(r: RawScComment): ScComment | null {
  const body = r.body?.trim().slice(0, 300)
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp) || r.timestamp < 0 || !body || !r.user) return null
  const avatar = artwork(r.user.avatar_url)?.s
  return { id: r.id, atMs: r.timestamp, body, user: { name: r.user.username || r.user.full_name || '', ...(avatar ? { avatar } : {}) } }
}

/** The feed: uploads and reposts of tracks, then of playlists, each once. */
export function streamItems(items: RawScStreamItem[]): { tracks: Track[]; playlists: Playlist[] } {
  const tracks: Track[] = []
  const playlists: Playlist[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (it.track?.title) {
      const t = normalizeScTrack(it.track)
      if (!seen.has(t.key)) tracks.push(t)
      seen.add(t.key)
    } else if (it.playlist) {
      const p = normalizeScPlaylist(it.playlist)
      const k = `pl_${p.id}_${p.urn ?? ''}`
      if (!seen.has(k)) playlists.push(p)
      seen.add(k)
    }
  }
  return { tracks, playlists }
}
