import type { Cover, Playlist, Track } from '../vk/models'
import type { RawScPlaylist, RawScStreamItem, RawScTrack, RawScUser } from './types'

export interface ScUser {
  id: number
  name: string
  avatar?: string | null
  permalink?: string | null
}

/** SoundCloud's `-large` artwork (100 px) in the three sizes Nocturne shows. */
export function artwork(url: string | null | undefined): Cover | undefined {
  if (!url) return undefined
  const size = (s: string) => url.replace('-large.', `-${s}.`)
  return { s: size('t67x67'), m: size('t300x300'), l: size('t500x500') }
}

/** A plain HLS stream exists (AAC or MP3, not a 30-second preview) and the track is not blocked or Go+ only. */
export function playableTrack(r: RawScTrack): boolean {
  if (r.streamable === false || r.policy === 'BLOCK' || r.policy === 'SNIP') return false
  return (r.media?.transcodings ?? []).some((c) => {
    const mime = c.format?.mime_type ?? ''
    return c.format?.protocol === 'hls' && !c.snipped && (mime.startsWith('audio/mp4') || (mime.startsWith('audio/mpeg') && !mime.startsWith('audio/mpegurl')))
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

export function normalizeScUser(r: RawScUser): ScUser {
  return { id: r.id, name: r.username || r.full_name || '', avatar: artwork(r.avatar_url)?.m, permalink: r.permalink_url }
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
