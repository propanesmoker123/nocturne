import { invoke, isTauri } from '../lib/tauri'
import { beatsFromSegments } from '../lyrics/beats'
import { spotifyLines, type SpotifyRawLine } from '../lyrics/parse'
import { BINS } from '../player/peaks'
import type { Cover, Lyrics, Playlist, Track } from '../vk/models'
import { writeSpotifyQuerySnapshot } from './cache'
import { parseSpotifyLink } from './links'
import { spKeys } from './queries'

export interface SpotifyUser {
  id: string
  name: string
  avatar?: string
  country?: string
  followers?: number
  monthlyListeners?: number
  saved?: boolean
  genres?: string[]
}

const VALID_ID = /^[A-Za-z0-9]{22}$/
const COVER_URL = /^https:\/\/(?:[a-z0-9-]+\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com)\/[^\s"'<>]{1,500}$/i
const PREVIEW_URL = /^https:\/\/(?:[a-z0-9-]+\.scdn\.co|[a-z0-9-]+\.spotifycdn\.com)\/[^\s"'<>]{1,500}$/i

function numId(spotifyId: string): number {
  let h = 5381
  for (let i = 0; i < spotifyId.length; i++) h = ((h << 5) + h + spotifyId.charCodeAt(i)) | 0
  return Math.abs(h) || 1
}

function stripHtml(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;|&#47;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function pickCover(images: unknown): Cover | undefined {
  if (!Array.isArray(images) || !images.length) return undefined
  const valid = images
    .map((img) => {
      const r = img as Record<string, unknown> | null
      const url = typeof r?.url === 'string' && COVER_URL.test(r.url) ? r.url : null
      return url ? { url, width: Number(r?.width) || Number(r?.maxWidth) || 300 } : null
    })
    .filter((x): x is { url: string; width: number } => x !== null)
    .sort((a, b) => a.width - b.width)
  if (!valid.length) return undefined
  const s = valid[0].url
  const m = (valid.find((x) => x.width >= 250) ?? valid[valid.length - 1]).url
  const l = valid[valid.length - 1].url
  return { s, m, l }
}

function pickCoverCandidate(val: unknown): Cover | undefined {
  if (!val) return undefined
  if (Array.isArray(val)) return pickCover(val)
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    if (Array.isArray(obj.sources)) return pickCover(obj.sources)
    if (Array.isArray(obj.items)) {
      const flat = (obj.items as Array<{ sources?: unknown[] }>).flatMap((x) => (Array.isArray(x?.sources) ? x.sources : []))
      return pickCover(flat)
    }
  }
  return undefined
}

function firstCover(...candidates: unknown[]): Cover | undefined {
  for (const c of candidates) {
    const hit = pickCoverCandidate(c)
    if (hit) return hit
  }
  return undefined
}

function extractId(uriOrId: unknown): string | undefined {
  if (typeof uriOrId !== 'string') return undefined
  if (VALID_ID.test(uriOrId)) return uriOrId
  const parts = uriOrId.split(':')
  const last = parts[parts.length - 1]
  return last && VALID_ID.test(last) ? last : undefined
}

function unwrapEntity(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  let cur = raw as Record<string, unknown>
  let outerUri = typeof cur._uri === 'string' ? cur._uri : typeof cur.uri === 'string' ? cur.uri : undefined
  for (let depth = 0; depth < 4; depth++) {
    if (
      typeof cur.name === 'string' ||
      typeof cur.title === 'string' ||
      typeof cur.display_name === 'string' ||
      typeof cur.username === 'string' ||
      (cur.identityTrait && typeof cur.identityTrait === 'object')
    ) {
      break
    }
    const contentCandidate =
      cur.content &&
      typeof cur.content === 'object' &&
      !Array.isArray((cur.content as Record<string, unknown>).items) &&
      ((cur.content as Record<string, unknown>).data ||
        typeof (cur.content as Record<string, unknown>).uri === 'string' ||
        typeof (cur.content as Record<string, unknown>)._uri === 'string' ||
        typeof (cur.content as Record<string, unknown>).name === 'string')
        ? (cur.content as Record<string, unknown>)
        : null
    const next =
      (cur.itemV2 && typeof cur.itemV2 === 'object' ? (cur.itemV2 as Record<string, unknown>) : null) ??
      (cur.item && typeof cur.item === 'object' ? (cur.item as Record<string, unknown>) : null) ??
      (cur.track && typeof cur.track === 'object' ? (cur.track as Record<string, unknown>) : null) ??
      contentCandidate ??
      (cur.data && typeof cur.data === 'object' ? (cur.data as Record<string, unknown>) : null)
    if (!next) break
    if (!outerUri) outerUri = typeof next._uri === 'string' ? next._uri : typeof next.uri === 'string' ? next.uri : undefined
    cur = next
  }
  return outerUri && !cur.uri ? { ...cur, uri: outerUri } : cur
}

export function normalizeSpotifyTrack(raw: unknown, liked = false, fallbackCover?: Cover, fallbackAlbum?: Track['album']): Track | null {
  const outerUid = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).uid === 'string'
    ? String((raw as Record<string, unknown>).uid).trim()
    : undefined
  const r = unwrapEntity(raw)
  if (!r) return null
  const spotifyUid = outerUid || (typeof r.uid === 'string' ? r.uid.trim() : undefined)
  const id = extractId(r.id) ?? extractId(r.uri) ?? extractId(r._uri)
  const identity = r.identityTrait && typeof r.identityTrait === 'object' ? (r.identityTrait as Record<string, unknown>) : null
  const title =
    typeof r.name === 'string'
      ? r.name.trim()
      : typeof r.title === 'string'
        ? r.title.trim()
        : typeof identity?.name === 'string'
          ? identity.name.trim()
          : ''
  if (!id || !title) return null

  const artistsField = r.artists && typeof r.artists === 'object' && !Array.isArray(r.artists) ? (r.artists as Record<string, unknown>).items : r.artists
  const rawArtists = Array.isArray(artistsField) ? artistsField : []
  const artists = rawArtists
    .map((a) => {
      const ar = a as Record<string, unknown> | null
      const profile = ar?.profile && typeof ar.profile === 'object' ? (ar.profile as Record<string, unknown>) : null
      const name = typeof ar?.name === 'string' ? ar.name.trim() : typeof profile?.name === 'string' ? profile.name.trim() : ''
      const aid = extractId(ar?.id) ?? extractId(ar?.uri)
      return name ? { ...(aid ? { id: aid } : {}), name } : null
    })
    .filter((x): x is { id?: string; name: string } => x !== null)

  const subtitleArtist = typeof r.subtitle === 'string' ? r.subtitle.replace(/\u00a0/g, ' ').trim() : ''
  const artist = artists.length ? artists.map((a) => a.name).join(', ') : subtitleArtist || 'Spotify'
  if (!artists.length && subtitleArtist) artists.push({ name: subtitleArtist })

  const albumCandidate = r.album ?? r.albumOfTrack
  const albumObj = albumCandidate && typeof albumCandidate === 'object' ? (albumCandidate as Record<string, unknown>) : null
  const albumId = extractId(albumObj?.id) ?? extractId(albumObj?.uri)
  const albumTitle = typeof albumObj?.name === 'string' ? albumObj.name.trim() : ''
  const album: Track['album'] = albumId && albumTitle ? { id: numId(albumId), ownerId: 0, title: albumTitle, spotifyId: albumId } : fallbackAlbum

  const albumCoverArt = albumObj?.coverArt && typeof albumObj.coverArt === 'object' ? (albumObj.coverArt as Record<string, unknown>).sources : undefined
  const trackCoverArt = r.coverArt && typeof r.coverArt === 'object' ? (r.coverArt as Record<string, unknown>).sources : undefined
  const cover =
    pickCover(albumObj?.images) ??
    pickCover(albumCoverArt) ??
    pickCover(trackCoverArt) ??
    pickCover(r.images) ??
    pickCover((r.visualIdentity as Record<string, unknown> | undefined)?.image) ??
    fallbackCover

  const durObj = (r.duration && typeof r.duration === 'object' ? (r.duration as Record<string, unknown>) : null) ??
    (r.trackDuration && typeof r.trackDuration === 'object' ? (r.trackDuration as Record<string, unknown>) : null)
  const durationMs = Number(r.duration_ms ?? durObj?.totalMilliseconds ?? durObj?.milliseconds ?? r.duration) || 0
  const duration = Math.max(1, Math.round(durationMs / 1000))
  const rating = r.contentRating && typeof r.contentRating === 'object' ? (r.contentRating as Record<string, unknown>).label : undefined
  const explicit = r.explicit === true || r.isExplicit === true || rating === 'EXPLICIT'
  const playability = r.playability && typeof r.playability === 'object' ? (r.playability as Record<string, unknown>).playable : undefined
  const numeric = numId(id)

  return {
    service: 'spotify',
    spotifyId: id,
    ...(spotifyUid ? { spotifyUid } : {}),
    permalink: `https://open.spotify.com/track/${id}`,
    id: numeric,
    ownerId: 0,
    key: `sp_${id}`,
    artist,
    title,
    duration,
    url: `spotify:track:${id}`,
    urlFetchedAt: Date.now(),
    cover,
    album,
    explicit,
    artists,
    playable: r.is_playable !== false && r.isPlayable !== false && playability !== false,
    hasLyrics: false,
    liked,
  }
}

function isNonMusicEntity(uri: unknown, rawType: string): boolean {
  if (/podcast|show|episode|audiobook|chapter|recents|browse/i.test(rawType)) return true
  if (typeof uri === 'string' && /^spotify:(?:show|episode|audiobook|chapter|list|user|genre|collection):/i.test(uri.trim())) {
    return true
  }
  return false
}

export function normalizeSpotifyPlaylist(raw: unknown, forceType?: 'playlist' | 'album'): Playlist | null {
  const r = unwrapEntity(raw)
  if (!r) return null
  const rawType = typeof r.__typename === 'string' ? r.__typename.toLowerCase() : typeof r.type === 'string' ? r.type.toLowerCase() : ''
  if (isNonMusicEntity(r.uri ?? r._uri ?? r.id, rawType)) return null
  const id = extractId(r.id) ?? extractId(r.uri) ?? extractId(r._uri)
  const title = typeof r.name === 'string' ? r.name.trim() : typeof r.title === 'string' ? r.title.trim() : ''
  if (!id || !title) return null

  const isAlbumUri = /^spotify:album:/i.test(String(r.uri ?? r._uri ?? ''))
  const type: 'playlist' | 'album' = forceType ?? (rawType === 'album' || Boolean(r.album_type) || Boolean(r._releaseGroup) || isAlbumUri ? 'album' : 'playlist')
  const cover = firstCover(
    r.images,
    r.coverArt,
    (r.visualIdentity as Record<string, unknown> | undefined)?.image,
  )?.l

  const owner = r.owner && typeof r.owner === 'object' ? (r.owner as Record<string, unknown>) : null
  const ownerV2Data =
    r.ownerV2 && typeof r.ownerV2 === 'object' && (r.ownerV2 as Record<string, unknown>).data && typeof (r.ownerV2 as Record<string, unknown>).data === 'object'
      ? ((r.ownerV2 as { data: Record<string, unknown> }).data)
      : null
  const artistsField = r.artists && typeof r.artists === 'object' && !Array.isArray(r.artists) ? (r.artists as Record<string, unknown>).items : r.artists
  const rawArtists = Array.isArray(artistsField) ? (artistsField as Record<string, unknown>[]) : []
  const ownerName =
    (typeof owner?.display_name === 'string' && owner.display_name.trim()) ||
    (typeof ownerV2Data?.name === 'string' && ownerV2Data.name.trim()) ||
    rawArtists
      .map((a) => {
        const p = a?.profile && typeof a.profile === 'object' ? (a.profile as Record<string, unknown>) : null
        return typeof a?.name === 'string' ? a.name.trim() : typeof p?.name === 'string' ? p.name.trim() : ''
      })
      .filter(Boolean)
      .join(', ') ||
    (typeof r.subtitle === 'string' ? r.subtitle.trim() : undefined)

  const tracksObj = r.tracks && typeof r.tracks === 'object' ? (r.tracks as Record<string, unknown>) : null
  const contentObj = r.content && typeof r.content === 'object' ? (r.content as Record<string, unknown>) : null
  const tracksV2Obj = r.tracksV2 && typeof r.tracksV2 === 'object' ? (r.tracksV2 as Record<string, unknown>) : null
  const trackList = Array.isArray(r.trackList) ? r.trackList : null
  const count = Number(tracksObj?.total ?? contentObj?.totalCount ?? tracksV2Obj?.totalCount ?? r.total_tracks ?? trackList?.length) || 0
  const rawGroup = typeof r._releaseGroup === 'string' ? r._releaseGroup : typeof r.album_type === 'string' ? r.album_type : typeof r.type === 'string' ? r.type : ''
  const albumType: Playlist['albumType'] =
    type === 'album'
      ? /single|ep/i.test(rawGroup)
        ? 'single'
        : /compilation/i.test(rawGroup)
          ? 'compilation'
          : 'album'
      : undefined
  const dateObj = r.date && typeof r.date === 'object' ? (r.date as Record<string, unknown>) : null
  const releaseDate = typeof r.release_date === 'string' ? r.release_date : typeof dateObj?.isoString === 'string' ? dateObj.isoString : ''
  const year = Number(dateObj?.year) || (releaseDate ? parseInt(releaseDate.slice(0, 4), 10) || undefined : undefined)

  return {
    service: 'spotify',
    spotifyId: id,
    permalink: `https://open.spotify.com/${type}/${id}`,
    id: numId(id),
    ownerId: 0,
    title,
    description: stripHtml(r.description),
    count,
    cover,
    covers: [],
    isOwn: false,
    isFollowed: false,
    canEdit: false,
    type,
    ...(albumType ? { albumType } : {}),
    ownerName,
    year,
  }
}

export function normalizeSpotifyUser(raw: unknown): SpotifyUser | null {
  const r = unwrapEntity(raw)
  if (!r) return null
  const profile = r.profile && typeof r.profile === 'object' ? (r.profile as Record<string, unknown>) : null
  const username = typeof r.username === 'string' ? r.username.trim() : ''
  const rawId = typeof r.id === 'string' ? r.id.trim() : ''
  const id = extractId(r.id) || extractId(r.uri) || extractId(r._uri) || username || rawId
  const name =
    (typeof r.display_name === 'string' && r.display_name.trim()) ||
    (typeof r.name === 'string' && r.name.trim()) ||
    (typeof profile?.name === 'string' && profile.name.trim()) ||
    (typeof r.username === 'string' && r.username.trim()) ||
    ''
  if (!id || !name) return null
  const avatarObj = r.avatar && typeof r.avatar === 'object' ? (r.avatar as Record<string, unknown>) : null
  const visualsObj = r.visuals && typeof r.visuals === 'object' ? (r.visuals as Record<string, Record<string, unknown>>) : null
  const visualIdentityObj = r.visualIdentity && typeof r.visualIdentity === 'object' ? (r.visualIdentity as Record<string, unknown>) : null
  const cardRepObj = r.cardRepresentation && typeof r.cardRepresentation === 'object' ? (r.cardRepresentation as Record<string, unknown>) : null
  const avatar = firstCover(
    r.images,
    avatarObj ?? r.avatar,
    visualsObj?.avatarImage,
    visualsObj?.avatar,
    visualIdentityObj?.image,
    cardRepObj?.artwork,
    r.coverArt,
    visualsObj?.headerImage,
    r.headerImage,
  )?.m
  const country = typeof r.country === 'string' && r.country.trim() ? r.country.trim().toUpperCase() : undefined
  const statsObj = r.stats && typeof r.stats === 'object' ? (r.stats as Record<string, unknown>) : null
  const followers = Number((r.followers as Record<string, unknown> | undefined)?.total ?? statsObj?.followers) || undefined
  const monthlyListeners = Number(statsObj?.monthlyListeners) || undefined
  const saved = typeof r.saved === 'boolean' ? r.saved : undefined
  const genres = Array.isArray(r.genres) ? r.genres.filter((g): g is string => typeof g === 'string').slice(0, 5) : undefined
  return { id, name, avatar, country, followers, monthlyListeners, saved, genres }
}

async function callSpotify<T>(request: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error('Spotify доступен в настольном приложении Nocturne')
  return invoke<T>('spotify_status', { request })
}

export async function getMe(): Promise<SpotifyUser | null> {
  const data = await callSpotify< unknown>({ kind: 'api', method: 'GET', path: '/me' })
  return normalizeSpotifyUser(data)
}

export async function getLikes(offset = 0, limit = 50): Promise<{ items: Track[]; total: number; nextOffset?: number }> {
  const data = await callSpotify<{ items?: { track?: unknown }[]; total?: number; next?: string | null }>({
    kind: 'api',
    method: 'GET',
    path: `/me/tracks?limit=${limit}&offset=${offset}&market=from_token`,
  })
  const items = (data?.items ?? []).map((entry) => normalizeSpotifyTrack(entry?.track, true)).filter((t): t is Track => t !== null)
  const total = Number(data?.total) || items.length
  const nextOffset = offset + items.length < total && items.length > 0 ? offset + items.length : undefined
  const out = { items, total, nextOffset }
  if (offset === 0 && items.length > 0) {
    writeSpotifyQuerySnapshot(spKeys.likes(), out, { infinite: true })
  }
  return out
}

export async function setTrackLiked(spotifyId: string, liked: boolean): Promise<void> {
  await callSpotify({
    kind: 'api',
    method: liked ? 'PUT' : 'DELETE',
    path: `/me/tracks?ids=${encodeURIComponent(spotifyId)}`,
  })
}

export async function getMyPlaylists(): Promise<Playlist[]> {
  const data = await callSpotify<{ items?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path: '/me/playlists?limit=50&offset=0',
  })
  const playlists = (data?.items ?? [])
    .map((p) => normalizeSpotifyPlaylist(p))
    .filter((p): p is Playlist => p !== null && p.type === 'playlist')
  if (playlists.length > 0) {
    writeSpotifyQuerySnapshot(spKeys.myPlaylists(), playlists)
  }
  return playlists
}

export interface SpotifyHomeSection {
  id: string
  typename?: string
  title: string
  subtitle?: string
  playlists: Playlist[]
  tracks: Track[]
  artists: SpotifyUser[]
  kindLabels?: Record<string, string>
  personalized?: boolean
}

export interface SpotifySpotlightItem {
  id: string
  eyebrow: string
  kindLabel: string
  playlist: Playlist
}

export interface SpotifyBrowseCard {
  uri: string
  id?: string
  kind?: 'playlist' | 'album' | 'artist'
  title: string
  color?: string
  image?: string
}

export interface SpotifyHomeData {
  greeting?: string
  sections?: SpotifyHomeSection[]
  spotlights?: SpotifySpotlightItem[]
  topTracks: Track[]
  recentTracks: Track[]
  topArtists: SpotifyUser[]
  playlists: Playlist[]
}

function mergeUniqueBy<T>(dest: T[], items: T[], keyOf: (x: T) => string) {
  const seen = new Set(dest.map(keyOf))
  for (const item of items) {
    const key = keyOf(item)
    if (!seen.has(key)) {
      seen.add(key)
      dest.push(item)
    }
  }
}

export function normalizeHomeSectionHeading(rawTitle: string, rawSubtitle?: string): { title: string; subtitle?: string } {
  const trimmedTitle = rawTitle.trim()
  const trimmedSub = rawSubtitle?.trim() || undefined
  if (!trimmedSub) {
    const forYouMatch = trimmedTitle.match(/^(Только для тебя),\s*(.+)$/i)
    if (forYouMatch) {
      return { subtitle: forYouMatch[1], title: forYouMatch[2].trim() }
    }
  }
  return { title: trimmedTitle, subtitle: trimmedSub }
}

function isPersonalizedShelf(title: string, subtitle?: string): boolean {
  const combined = subtitle ? `${subtitle} ${title}` : title
  return /[а-яё]/i.test(combined) || /made for|recommended|top mixes|best of|favorite/i.test(combined)
}

function mergeIntoSectionMap(byTitle: Map<string, SpotifyHomeSection>, sec: SpotifyHomeSection, title: string, subtitle?: string) {
  const key = title.toLowerCase()
  let target = byTitle.get(key)
  if (!target) {
    target = {
      id: sec.id,
      typename: sec.typename,
      title,
      subtitle,
      playlists: [],
      tracks: [],
      artists: [],
      kindLabels: sec.kindLabels ? { ...sec.kindLabels } : undefined,
    }
    byTitle.set(key, target)
  } else {
    if (!target.subtitle && subtitle) target.subtitle = subtitle
    if (sec.kindLabels) target.kindLabels = { ...(target.kindLabels ?? {}), ...sec.kindLabels }
  }
  mergeUniqueBy(target.playlists, sec.playlists, (p) => p.spotifyId ?? String(p.id))
  mergeUniqueBy(target.tracks, sec.tracks, (t) => t.key)
  mergeUniqueBy(target.artists, sec.artists, (a) => a.id)
}

export function organizeHomeFeed(raw: SpotifyHomeSection[]): {
  sections: SpotifyHomeSection[]
  spotlights: SpotifySpotlightItem[]
} {
  const spotlights: SpotifySpotlightItem[] = []
  const seenSpotlights = new Set<string>()
  const pushSpotlight = (eyebrow: string, playlist: Playlist, kindLabel?: string) => {
    const pid = playlist.spotifyId ?? String(playlist.id)
    if (seenSpotlights.has(pid)) return
    seenSpotlights.add(pid)
    spotlights.push({
      id: `spot-${pid}`,
      eyebrow: eyebrow.trim() || 'Для тебя',
      kindLabel: kindLabel || (playlist.type === 'album' ? 'Альбом' : 'Плейлист'),
      playlist,
    })
  }

  const byTitle = new Map<string, SpotifyHomeSection>()
  for (const sec of raw) {
    if (sec.typename === 'HomeFeedBaselineSectionData') {
      for (const pl of sec.playlists) {
        const key = pl.spotifyId ?? String(pl.id)
        pushSpotlight(sec.title || 'Для тебя', pl, sec.kindLabels?.[key])
      }
      continue
    }
    if (sec.typename === 'HomeShortsSectionData' && !sec.title.trim()) {
      continue
    }

    const heading = normalizeHomeSectionHeading(sec.title, sec.subtitle)
    mergeIntoSectionMap(byTitle, sec, heading.title || 'Рекомендации', heading.subtitle)
  }

  const rich: SpotifyHomeSection[] = []
  const leftoverTracks: Track[] = []
  const leftoverArtists: SpotifyUser[] = []

  for (const sec of byTitle.values()) {
    const total = sec.playlists.length + sec.tracks.length + sec.artists.length
    if (total === 0) continue
    if (total >= 2) {
      rich.push(sec)
      continue
    }
    for (const pl of sec.playlists) {
      const pid = pl.spotifyId ?? String(pl.id)
      pushSpotlight(sec.title, pl, sec.kindLabels?.[pid])
    }
    mergeUniqueBy(leftoverTracks, sec.tracks, (t) => t.key)
    mergeUniqueBy(leftoverArtists, sec.artists, (a) => a.id)
  }

  if (leftoverTracks.length >= 2) {
    rich.push({
      id: 'spotify-spotlight-tracks',
      title: 'Треки для вас',
      playlists: [],
      tracks: leftoverTracks,
      artists: [],
    })
  }
  if (leftoverArtists.length >= 2) {
    rich.push({
      id: 'spotify-spotlight-artists',
      title: 'Исполнители для вас',
      playlists: [],
      tracks: [],
      artists: leftoverArtists,
    })
  }

  for (const sec of rich) {
    sec.personalized = isPersonalizedShelf(sec.title, sec.subtitle)
  }
  rich.sort(
    (a, b) => Number(!a.personalized) - Number(!b.personalized),
  )

  return { sections: rich, spotlights }
}

export function organizeHomeSections(raw: SpotifyHomeSection[]): SpotifyHomeSection[] {
  const byTitle = new Map<string, SpotifyHomeSection>()
  for (const sec of raw) {
    mergeIntoSectionMap(byTitle, sec, sec.title.trim() || 'Рекомендации', sec.subtitle)
  }

  const rich: SpotifyHomeSection[] = []
  const spotlightPlaylists: Playlist[] = []
  const spotlightTracks: Track[] = []
  const spotlightArtists: SpotifyUser[] = []

  for (const sec of byTitle.values()) {
    const total = sec.playlists.length + sec.tracks.length + sec.artists.length
    if (total === 0) continue
    if (total >= 2) {
      rich.push(sec)
      continue
    }
    mergeUniqueBy(spotlightPlaylists, sec.playlists, (p) => p.spotifyId ?? String(p.id))
    mergeUniqueBy(spotlightTracks, sec.tracks, (t) => t.key)
    mergeUniqueBy(spotlightArtists, sec.artists, (a) => a.id)
  }

  if (rich.length === 0) return [...byTitle.values()]

  if (spotlightPlaylists.length >= 2) {
    rich.push({
      id: 'spotify-spotlight-mix',
      title: 'Подборка дня',
      playlists: spotlightPlaylists,
      tracks: [],
      artists: [],
    })
  } else if (spotlightPlaylists.length === 1 && !byTitle.has('подборка дня')) {
    rich.push({
      id: 'spotify-spotlight-single',
      title: 'Обратите внимание',
      playlists: spotlightPlaylists,
      tracks: [],
      artists: [],
    })
  }
  if (spotlightTracks.length >= 2) {
    rich.push({
      id: 'spotify-spotlight-tracks',
      title: 'Треки для вас',
      playlists: [],
      tracks: spotlightTracks,
      artists: [],
    })
  }
  if (spotlightArtists.length >= 2) {
    rich.push({
      id: 'spotify-spotlight-artists',
      title: 'Исполнители для вас',
      playlists: [],
      tracks: [],
      artists: spotlightArtists,
    })
  }
  return rich
}

export async function getHome(): Promise<SpotifyHomeData> {
  const [homeRes, topT, rec, topA, pls] = await Promise.allSettled([
    callSpotify<{
      greeting?: string
      sections?: Array<{
        uri?: string
        typename?: string
        title?: string
        subtitle?: string
        items?: Array<{ typename?: string; data?: unknown }>
      }>
    }>({ kind: 'api', method: 'GET', path: '/home' }),
    callSpotify<{ items?: unknown[] }>({ kind: 'api', method: 'GET', path: '/me/top/tracks?limit=20&time_range=medium_term' }),
    callSpotify<{ items?: { track?: unknown }[] }>({ kind: 'api', method: 'GET', path: '/me/player/recently-played?limit=24' }),
    callSpotify<{ items?: unknown[] }>({ kind: 'api', method: 'GET', path: '/me/top/artists?limit=15&time_range=medium_term' }),
    getMyPlaylists(),
  ])

  const results = [homeRes, topT, rec, topA, pls]
  const firstRejection = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (results.every((r) => r.status === 'rejected') && firstRejection) {
    throw firstRejection.reason
  }

  let topTracks =
    topT.status === 'fulfilled'
      ? (topT.value?.items ?? []).map((t) => normalizeSpotifyTrack(t)).filter((t): t is Track => t !== null)
      : []

  const seenRecent = new Set<string>()
  const recentTracks = (rec.status === 'fulfilled' ? rec.value?.items ?? [] : [])
    .map((entry) => normalizeSpotifyTrack(entry?.track ?? entry))
    .filter((t): t is Track => {
      if (!t || seenRecent.has(t.key)) return false
      seenRecent.add(t.key)
      return true
    })

  const topArtists =
    topA.status === 'fulfilled'
      ? (topA.value?.items ?? []).map(normalizeSpotifyUser).filter((u): u is SpotifyUser => u !== null)
      : []

  const finalPlaylists = pls.status === 'fulfilled' ? pls.value : []

  const rawSections: SpotifyHomeSection[] = []
  if (homeRes.status === 'fulfilled') {
    for (const sec of homeRes.value?.sections ?? []) {
      const playlistsInSec: Playlist[] = []
      const tracksInSec: Track[] = []
      const artistsInSec: SpotifyUser[] = []
      const kindLabels: Record<string, string> = {}
      for (const entry of sec.items ?? []) {
        const d = entry?.data
        if (!d) continue
        if (entry.typename === 'TrackResponseWrapper') {
          const t = normalizeSpotifyTrack(d)
          if (t) tracksInSec.push(t)
        } else if (entry.typename === 'ArtistResponseWrapper') {
          const a = normalizeSpotifyUser(d)
          if (a) artistsInSec.push(a)
        } else {
          const p = normalizeSpotifyPlaylist(d)
          if (p) {
            playlistsInSec.push(p)
            const rawAlbumType = typeof (d as Record<string, unknown>).albumType === 'string'
              ? String((d as Record<string, unknown>).albumType).toUpperCase()
              : ''
            kindLabels[p.spotifyId ?? String(p.id)] =
              p.type === 'album' ? (rawAlbumType === 'SINGLE' ? 'Сингл' : 'Альбом') : 'Плейлист'
          }
        }
      }
      if (playlistsInSec.length || tracksInSec.length || artistsInSec.length) {
        rawSections.push({
          id: sec.uri || sec.title || `sec-${rawSections.length}`,
          typename: sec.typename || undefined,
          title: sec.title || (rawSections.length === 0 && !sec.typename?.includes('Shorts') ? 'Быстрый доступ' : ''),
          subtitle: sec.subtitle || undefined,
          playlists: playlistsInSec,
          tracks: tracksInSec,
          artists: artistsInSec,
          kindLabels,
        })
      }
    }
  }

  if (!topTracks.length) {
    const likes = await getLikes(0, 20).catch(() => ({ items: [] as Track[] }))
    if (likes.items.length) topTracks = likes.items
  }

  const organized = organizeHomeFeed(rawSections)

  const homeData: SpotifyHomeData = {
    greeting: homeRes.status === 'fulfilled' ? homeRes.value?.greeting : undefined,
    sections: organized.sections,
    spotlights: organized.spotlights,
    topTracks,
    recentTracks,
    topArtists,
    playlists: finalPlaylists,
  }
  if (
    homeData.sections?.length ||
    homeData.spotlights?.length ||
    homeData.topTracks.length ||
    homeData.recentTracks.length ||
    homeData.playlists.length
  ) {
    writeSpotifyQuerySnapshot(spKeys.home(), homeData)
  }
  return homeData
}

export async function getPlaylistOrAlbum(spotifyId: string, kind: 'playlist' | 'album' = 'playlist'): Promise<{ playlist: Playlist; tracks: Track[] }> {
  const path = kind === 'album' ? `/albums/${spotifyId}?market=from_token` : `/playlists/${spotifyId}?market=from_token`
  const data = await callSpotify<Record<string, unknown>>({
    kind: 'api',
    method: 'GET',
    path,
    fallbackEmbed: { entity: kind, id: spotifyId },
  }).catch(() => callSpotify<Record<string, unknown>>({ kind: 'embed', entity: kind, id: spotifyId }))

  const raw = data?.source === 'embed' && data.entity && typeof data.entity === 'object' ? (data.entity as Record<string, unknown>) : data
  const playlist = normalizeSpotifyPlaylist(raw, kind) ?? {
    service: 'spotify',
    spotifyId,
    id: numId(spotifyId),
    ownerId: 0,
    title: 'Spotify',
    count: 0,
    covers: [],
    isOwn: false,
    isFollowed: false,
    canEdit: false,
    type: kind,
  }
  const cover = playlist.cover ? { s: playlist.cover, m: playlist.cover, l: playlist.cover } : undefined
  const fallbackAlbum: Track['album'] = kind === 'album' ? { id: playlist.id, ownerId: 0, title: playlist.title, spotifyId } : undefined

  const tracksContainer =
    (raw?.tracks && typeof raw.tracks === 'object' ? (raw.tracks as Record<string, unknown>) : null) ??
    (raw?.content && typeof raw.content === 'object' ? (raw.content as Record<string, unknown>) : null) ??
    (raw?.tracksV2 && typeof raw.tracksV2 === 'object' ? (raw.tracksV2 as Record<string, unknown>) : null)
  const rawItems = Array.isArray(tracksContainer?.items)
    ? tracksContainer.items
    : Array.isArray(raw?.trackList)
      ? raw.trackList
      : []

  const tracks = rawItems
    .map((item) => normalizeSpotifyTrack(item, false, cover, fallbackAlbum))
    .filter((t): t is Track => t !== null)

  const out = { playlist: { ...playlist, count: Number(tracksContainer?.totalCount ?? tracksContainer?.total) || tracks.length || playlist.count }, tracks }
  if (tracks.length > 0 || playlist.title !== 'Spotify') {
    writeSpotifyQuerySnapshot(spKeys.playlist(spotifyId, kind), out)
  }
  return out
}

export async function getPlaylistTracksPage(
  spotifyId: string,
  kind: 'playlist' | 'album' = 'playlist',
  offset = 0,
  limit = 100,
): Promise<{ tracks: Track[]; total: number }> {
  const path = kind === 'album' ? `/albums/${spotifyId}/tracks?offset=${offset}&limit=${limit}` : `/playlists/${spotifyId}/tracks?offset=${offset}&limit=${limit}`
  const data = await callSpotify<{ totalCount?: number; total?: number; items?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path,
  })
  const tracks = (data?.items ?? []).map((item) => normalizeSpotifyTrack(item)).filter((t): t is Track => t !== null)
  const total = Number(data?.totalCount ?? data?.total) || tracks.length
  return { tracks, total }
}

const NON_MUSIC_BROWSE =
  /^(?:подкасты|аудиокниги|чарты подкастов|video podcasts|вся литература|мероприятия|podcasts?|audiobooks?|live events|podcast charts|детективы и триллеры|саморазвитие|забота о себе|автор микса:?|lifestyle\s*&\s*health|кино и сериалы|netflix|для всей семьи|шумы и звуки природы)$/i

export async function getBrowseCategories(): Promise<SpotifyBrowseCard[]> {
  const data = await callSpotify<{ items?: Array<{ uri?: string; title?: string; color?: string; image?: string }> }>({
    kind: 'api',
    method: 'GET',
    path: '/browse',
  })
  const seen = new Set<string>()
  const cats = (data?.items ?? [])
    .filter((c) => {
      const title = typeof c?.title === 'string' ? c.title.trim() : ''
      if (!title || NON_MUSIC_BROWSE.test(title)) return false
      if (/(?:podcast|audiobook|live-events|episode)/i.test(String(c?.uri || ''))) return false
      const key = title.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((c) => {
      const m = String(c.uri || '').match(/spotify:(playlist|album|artist):([A-Za-z0-9]{22})/)
      const pageMatch = String(c.uri || '').match(/spotify:page:([A-Za-z0-9_-]+)/)
      return {
        uri: c.uri || '',
        kind: m ? (m[1] as 'playlist' | 'album' | 'artist') : undefined,
        id: m ? m[2] : pageMatch ? pageMatch[1] : undefined,
        title: c.title!.trim(),
        color: typeof c.color === 'string' ? c.color : undefined,
        image: typeof c.image === 'string' && COVER_URL.test(c.image) ? c.image : undefined,
      }
    })
  if (cats.length > 0) writeSpotifyQuerySnapshot(spKeys.browse(), cats)
  return cats
}

export interface SpotifyBrowseCategoryData {
  title?: string
  sections: SpotifyHomeSection[]
  subcategories: SpotifyBrowseCard[]
  playlists: Playlist[]
  albums: Playlist[]
  artists: SpotifyUser[]
  tracks: Track[]
}

export async function getBrowseCategory(
  title: string,
  id = '',
  uri = '',
): Promise<SpotifyBrowseCategoryData> {
  const qs = new URLSearchParams()
  if (uri) qs.set('uri', uri.slice(0, 120))
  if (id) qs.set('id', id.slice(0, 40))
  if (title.trim()) qs.set('q', title.trim().slice(0, 120))
  const data = await callSpotify<{
    title?: string
    sections?: Array<{
      id?: string
      title?: string
      playlists?: unknown[]
      albums?: unknown[]
      artists?: unknown[]
      tracks?: unknown[]
    }>
    subcategories?: Array<{ uri?: string; title?: string; color?: string; image?: string }>
    playlists?: unknown[]
    albums?: unknown[]
    artists?: unknown[]
    tracks?: unknown[]
  }>({
    kind: 'api',
    method: 'GET',
    path: `/browse?${qs.toString()}`,
  })
  const playlists = (data?.playlists ?? [])
    .map((p) => normalizeSpotifyPlaylist(p, 'playlist'))
    .filter((p): p is Playlist => p !== null)
  const albums = (data?.albums ?? [])
    .map((a) => normalizeSpotifyPlaylist(a, 'album'))
    .filter((p): p is Playlist => p !== null)
  const artists = (data?.artists ?? [])
    .map(normalizeSpotifyUser)
    .filter((u): u is SpotifyUser => u !== null)
  const tracks = (data?.tracks ?? [])
    .map((t) => normalizeSpotifyTrack(t))
    .filter((t): t is Track => t !== null)
  const sections: SpotifyHomeSection[] = (data?.sections ?? [])
    .map((sec, i) => {
      const secPl = (sec.playlists ?? []).map((p) => normalizeSpotifyPlaylist(p, 'playlist')).filter((p): p is Playlist => p !== null)
      const secAl = (sec.albums ?? []).map((a) => normalizeSpotifyPlaylist(a, 'album')).filter((p): p is Playlist => p !== null)
      const secAr = (sec.artists ?? []).map(normalizeSpotifyUser).filter((u): u is SpotifyUser => u !== null)
      const secTr = (sec.tracks ?? []).map((t) => normalizeSpotifyTrack(t)).filter((t): t is Track => t !== null)
      return {
        id: sec.id || `cat_sec_${i}`,
        title: sec.title || 'Подборки',
        playlists: [...secPl, ...secAl],
        artists: secAr,
        tracks: secTr,
      }
    })
    .filter((sec) => sec.playlists.length > 0 || sec.artists.length > 0 || sec.tracks.length > 0)
  const subcategories: SpotifyBrowseCard[] = (data?.subcategories ?? [])
    .filter((c) => {
      const t = typeof c?.title === 'string' ? c.title.trim() : ''
      return t.length > 0 && !NON_MUSIC_BROWSE.test(t)
    })
    .map((c) => {
      const m = String(c.uri || '').match(/spotify:(playlist|album|artist):([A-Za-z0-9]{22})/)
      const pageMatch = String(c.uri || '').match(/spotify:page:([A-Za-z0-9_-]+)/)
      return {
        uri: c.uri || '',
        kind: m ? (m[1] as 'playlist' | 'album' | 'artist') : undefined,
        id: m ? m[2] : pageMatch ? pageMatch[1] : undefined,
        title: c.title!.trim(),
        color: typeof c.color === 'string' ? c.color : undefined,
        image: typeof c.image === 'string' && COVER_URL.test(c.image) ? c.image : undefined,
      }
    })
  return {
    title: typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : undefined,
    sections,
    subcategories,
    playlists,
    albums,
    artists,
    tracks,
  }
}

export async function getMyAlbums(offset = 0, limit = 50): Promise<{ items: Playlist[]; total: number }> {
  const data = await callSpotify<{ items?: unknown[]; total?: number }>({
    kind: 'api',
    method: 'GET',
    path: `/me/albums?limit=${limit}&offset=${offset}`,
  })
  const items = (data?.items ?? []).map((a) => normalizeSpotifyPlaylist(a, 'album')).filter((p): p is Playlist => p !== null)
  const out = { items, total: Number(data?.total) || items.length }
  if (offset === 0 && items.length > 0) writeSpotifyQuerySnapshot(spKeys.albums(), out)
  return out
}

export async function getFollowedArtists(offset = 0, limit = 50): Promise<SpotifyUser[]> {
  const data = await callSpotify<{ items?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path: `/me/following?limit=${limit}&offset=${offset}`,
  })
  const artists = (data?.items ?? []).map(normalizeSpotifyUser).filter((u): u is SpotifyUser => u !== null)
  if (offset === 0 && artists.length > 0) writeSpotifyQuerySnapshot(spKeys.artists(), artists)
  return artists
}

export async function getRecentTracks(limit = 30): Promise<Track[]> {
  const data = await callSpotify<{ items?: Array<{ track?: unknown }> }>({
    kind: 'api',
    method: 'GET',
    path: `/me/player/recently-played?limit=${limit}`,
  })
  const seen = new Set<string>()
  const tracks = (data?.items ?? [])
    .map((entry) => normalizeSpotifyTrack(entry?.track ?? entry))
    .filter((t): t is Track => {
      if (!t || seen.has(t.key)) return false
      seen.add(t.key)
      return true
    })
  if (tracks.length > 0) writeSpotifyQuerySnapshot(spKeys.recent(), tracks)
  return tracks
}

export async function getEditablePlaylists(): Promise<Playlist[]> {
  const data = await callSpotify<{ items?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path: '/me/editable-playlists',
  })
  return (data?.items ?? []).map((p) => normalizeSpotifyPlaylist(p, 'playlist')).filter((p): p is Playlist => p !== null)
}

export async function addTrackToPlaylist(playlistId: string, trackId: string): Promise<void> {
  if (!VALID_ID.test(playlistId) || !VALID_ID.test(trackId)) throw new Error('Некорректный ID Spotify')
  await callSpotify({
    kind: 'api',
    method: 'POST',
    path: `/playlists/${playlistId}/tracks?ids=${encodeURIComponent(trackId)}`,
  })
}

export async function removeTrackFromPlaylist(playlistId: string, uid: string): Promise<void> {
  if (!VALID_ID.test(playlistId) || !uid.trim()) throw new Error('Некорректный ID трека или плейлиста')
  await callSpotify({
    kind: 'api',
    method: 'DELETE',
    path: `/playlists/${playlistId}/tracks?uids=${encodeURIComponent(uid.trim())}`,
  })
}

export async function setPlaylistSaved(playlistId: string, saved: boolean): Promise<void> {
  if (!VALID_ID.test(playlistId)) return
  await callSpotify({
    kind: 'api',
    method: saved ? 'PUT' : 'DELETE',
    path: `/playlists/${playlistId}/followers`,
  })
}

export async function warmSpotifyTrack(spotifyId: string): Promise<void> {
  if (!VALID_ID.test(spotifyId) || !isTauri()) return
  await callSpotify({
    kind: 'api',
    method: 'GET',
    path: `/tracks/${spotifyId}`,
  }).catch(() => {})
}

export async function setAlbumSaved(albumId: string, saved: boolean): Promise<void> {
  if (!VALID_ID.test(albumId)) return
  await callSpotify({
    kind: 'api',
    method: saved ? 'PUT' : 'DELETE',
    path: `/me/albums?ids=${encodeURIComponent(albumId)}`,
  })
}

export async function setArtistFollowed(artistId: string, followed: boolean): Promise<void> {
  if (!VALID_ID.test(artistId)) return
  await callSpotify({
    kind: 'api',
    method: followed ? 'PUT' : 'DELETE',
    path: `/me/following?ids=${encodeURIComponent(artistId)}`,
  })
}

export async function getArtistRelated(artistId: string): Promise<SpotifyUser[]> {
  const data = await callSpotify<{ items?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path: `/artists/${artistId}/related`,
  })
  return (data?.items ?? []).map(normalizeSpotifyUser).filter((u): u is SpotifyUser => u !== null)
}

export async function getTrackRelated(trackId: string): Promise<{ tracks: Track[]; albums: Playlist[] }> {
  const data = await callSpotify<{ tracks?: unknown[]; albums?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path: `/tracks/${trackId}/related`,
  })
  return {
    tracks: (data?.tracks ?? []).map((t) => normalizeSpotifyTrack(t)).filter((t): t is Track => t !== null),
    albums: (data?.albums ?? []).map((a) => normalizeSpotifyPlaylist(a, 'album')).filter((p): p is Playlist => p !== null),
  }
}

export async function getTrackRadio(seedUri: string): Promise<Track[]> {
  const data = await callSpotify<{ tracks?: unknown[]; items?: unknown[] }>({
    kind: 'api',
    method: 'GET',
    path: `/radio?uri=${encodeURIComponent(seedUri)}`,
  })
  const seen = new Set<string>()
  return (data?.tracks ?? data?.items ?? [])
    .map((t) => normalizeSpotifyTrack(t))
    .filter((t): t is Track => {
      if (!t || seen.has(t.key)) return false
      seen.add(t.key)
      return true
    })
}

export async function getSpotifyMix(): Promise<Track[]> {
  const likes = await getLikes(0, 12).catch(() => ({ items: [] as Track[] }))
  const pool = likes.items.filter((t) => !!t.spotifyId)
  const seed = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
  let radio: Track[] = []
  if (seed?.spotifyId) {
    radio = await getTrackRadio(`spotify:track:${seed.spotifyId}`).catch(() => [])
  } else {
    const res = await callSpotify<{ tracks?: unknown[] }>({ kind: 'api', method: 'GET', path: '/radio' }).catch(() => ({ tracks: [] }))
    radio = (res?.tracks ?? []).map((t) => normalizeSpotifyTrack(t)).filter((t): t is Track => t !== null)
  }
  const seen = new Set<string>()
  const merged: Track[] = []
  for (const t of [...radio, ...pool]) {
    if (!seen.has(t.key)) {
      seen.add(t.key)
      merged.push(t)
    }
  }
  return merged
}

export async function getSpotifyLyrics(trackId: string, coverUrl?: string): Promise<Lyrics | null> {
  if (!VALID_ID.test(trackId)) return null
  const imgQuery = coverUrl && coverUrl.length <= 240 && COVER_URL.test(coverUrl) ? `?img=${encodeURIComponent(coverUrl)}` : ''
  const res = await callSpotify<{
    lyrics?: {
      syncType?: string
      providerDisplayName?: string
      lines?: SpotifyRawLine[]
    } | null
  }>({
    kind: 'api',
    method: 'GET',
    path: `/tracks/${trackId}/lyrics${imgQuery}`,
  })
  const raw = res?.lyrics
  if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return null
  const { synced, lines } = spotifyLines(raw)
  if (!lines.length) return null
  return {
    synced,
    source: 'spotify',
    lines,
    credits: raw.providerDisplayName ? `Текст: Spotify (${raw.providerDisplayName})` : 'Текст: Spotify',
  }
}

export async function getArtist(spotifyId: string): Promise<{ artist: SpotifyUser; tracks: Track[]; albums: Playlist[] }> {
  try {
    const [artistRaw, topRaw, albumsRaw] = await Promise.all([
      callSpotify<unknown>({ kind: 'api', method: 'GET', path: `/artists/${spotifyId}` }),
      callSpotify<{ tracks?: unknown[] }>({ kind: 'api', method: 'GET', path: `/artists/${spotifyId}/top-tracks?market=from_token` }),
      callSpotify<{ items?: unknown[] }>({ kind: 'api', method: 'GET', path: `/artists/${spotifyId}/albums?include_groups=album,single&limit=30&market=from_token` }),
    ])
    const artist = normalizeSpotifyUser(artistRaw) ?? { id: spotifyId, name: 'Spotify Artist' }
    const tracks = (topRaw?.tracks ?? []).map((t) => normalizeSpotifyTrack(t)).filter((t): t is Track => t !== null)
    const albums = (albumsRaw?.items ?? []).map((a) => normalizeSpotifyPlaylist(a, 'album')).filter((p): p is Playlist => p !== null)
    const out = { artist, tracks, albums }
    if (tracks.length || albums.length) writeSpotifyQuerySnapshot(spKeys.artist(spotifyId), out)
    return out
  } catch {
    const embed = await callSpotify<{ entity?: Record<string, unknown> }>({ kind: 'embed', entity: 'artist', id: spotifyId })
    const entity = embed?.entity ?? {}
    const artist = normalizeSpotifyUser({ id: spotifyId, name: entity.title ?? entity.name, images: (entity.visualIdentity as Record<string, unknown> | undefined)?.image }) ?? { id: spotifyId, name: 'Spotify Artist' }
    const cover = artist.avatar ? { s: artist.avatar, m: artist.avatar, l: artist.avatar } : undefined
    const tracks = (Array.isArray(entity.trackList) ? entity.trackList : []).map((t) => normalizeSpotifyTrack(t, false, cover)).filter((t): t is Track => t !== null)
    const out = { artist, tracks, albums: [] as Playlist[] }
    if (tracks.length) writeSpotifyQuerySnapshot(spKeys.artist(spotifyId), out)
    return out
  }
}

export interface SpotifySearchResults {
  tracks: Track[]
  artists: SpotifyUser[]
  playlists: Playlist[]
  albums?: Playlist[]
}

export async function search(q: string): Promise<SpotifySearchResults> {
  const link = parseSpotifyLink(q)
  if (link) {
    if (link.kind === 'track') {
      const data = await callSpotify<Record<string, unknown>>({
        kind: 'api',
        method: 'GET',
        path: `/tracks/${link.id}?market=from_token`,
        fallbackEmbed: { entity: 'track', id: link.id },
      })
      const raw = data?.source === 'embed' ? data.entity : data
      const t = normalizeSpotifyTrack(raw)
      return { tracks: t ? [t] : [], artists: [], playlists: [], albums: [] }
    }
    if (link.kind === 'playlist' || link.kind === 'album') {
      const { playlist, tracks } = await getPlaylistOrAlbum(link.id, link.kind)
      return {
        tracks,
        artists: [],
        playlists: link.kind === 'playlist' ? [playlist] : [],
        albums: link.kind === 'album' ? [playlist] : [],
      }
    }
    if (link.kind === 'artist') {
      const { artist, tracks, albums } = await getArtist(link.id)
      return { tracks, artists: [artist], playlists: albums, albums }
    }
  }

  const data = await callSpotify<{
    tracks?: { items?: unknown[] }
    artists?: { items?: unknown[] }
    playlists?: { items?: unknown[] }
    albums?: { items?: unknown[] }
  }>({
    kind: 'api',
    method: 'GET',
    path: `/search?q=${encodeURIComponent(q.trim().slice(0, 200))}&type=track,artist,playlist,album&limit=20&market=from_token`,
  })

  const tracks = (data?.tracks?.items ?? []).map((t) => normalizeSpotifyTrack(t)).filter((t): t is Track => t !== null)
  const artists = (data?.artists?.items ?? []).map(normalizeSpotifyUser).filter((u): u is SpotifyUser => u !== null)
  const albums = (data?.albums?.items ?? []).map((a) => normalizeSpotifyPlaylist(a, 'album')).filter((p): p is Playlist => p !== null)
  const playlists = (data?.playlists?.items ?? []).map((p) => normalizeSpotifyPlaylist(p, 'playlist')).filter((p): p is Playlist => p !== null)
  return { tracks, artists, playlists: playlists.length ? playlists : albums, albums }
}

/**
 * Builds a realistic song-structure loudness curve (intro -> verse -> chorus 1 -> verse 2 ->
 * chorus 2 -> bridge -> final chorus -> outro) seeded deterministically by the track ID, used
 * immediately while audio-analysis loads or when Spotify's segment endpoint is unavailable.
 */
export function structuralPeaks(spotifyId: string): Float32Array {
  let seed = numId(spotifyId)
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 0xffffffff
  }
  const c1Start = 0.2 + rnd() * 0.05
  const c1End = c1Start + 0.14 + rnd() * 0.04
  const c2Start = 0.5 + rnd() * 0.05
  const c2End = c2Start + 0.16 + rnd() * 0.04
  const brStart = c2End + 0.02
  const brEnd = brStart + 0.08
  const c3Start = brEnd + 0.01
  const c3End = Math.min(0.92, c3Start + 0.16)

  const out = new Float32Array(BINS)
  let max = 0
  for (let i = 0; i < BINS; i++) {
    const pos = i / BINS
    let base = 0.44
    if (pos < 0.06) base = 0.18 + (pos / 0.06) * 0.24 // intro build
    else if (pos >= c1Start && pos <= c1End) base = 0.86 // Chorus 1 ("припев 1")
    else if (pos >= c1End - 0.03 && pos < c1Start) base = 0.65 // pre-chorus
    else if (pos >= c2Start && pos <= c2End) base = 0.9 // Chorus 2 ("припев 2")
    else if (pos >= brStart && pos <= brEnd) base = 0.34 // Bridge breakdown
    else if (pos >= c3Start && pos <= c3End) base = 0.95 // Final Chorus ("финальный припев")
    else if (pos > c3End) base = Math.max(0.14, 0.5 * (1 - (pos - c3End) / (1 - c3End))) // Outro fade
    const beat = (rnd() - 0.45) * 0.18
    const val = Math.max(0.08, Math.min(1, base + beat))
    out[i] = val
    if (val > max) max = val
  }
  for (let i = 0; i < BINS; i++) out[i] = max > 0 ? Math.pow(out[i] / max, 0.8) : out[i]
  return out
}

export function peaksFromSegments(segments: [number, number, number][], duration: number): Float32Array | null {
  if (!segments.length || duration <= 0) return null
  const sums = new Float64Array(BINS)
  const counts = new Uint32Array(BINS)
  for (const [start, dur, loudnessDb] of segments) {
    const amp = Math.pow(10, Math.min(0, Math.max(-45, loudnessDb)) / 20)
    const fromBin = Math.max(0, Math.floor((start / duration) * BINS))
    const toBin = Math.min(BINS - 1, Math.max(fromBin, Math.floor(((start + Math.max(0.05, dur)) / duration) * BINS)))
    for (let b = fromBin; b <= toBin; b++) {
      sums[b] += amp
      counts[b]++
    }
  }
  const out = new Float32Array(BINS)
  let max = 0
  let filled = 0
  for (let b = 0; b < BINS; b++) {
    if (counts[b]) {
      out[b] = sums[b] / counts[b]
      filled++
    } else {
      out[b] = b > 0 ? out[b - 1] : 0.25
    }
    if (out[b] > max) max = out[b]
  }
  if (filled < BINS / 4 || max <= 0) return null
  for (let b = 0; b < BINS; b++) out[b] = Math.pow(out[b] / max, 0.8)
  return out
}

export async function fetchSpotifyWaveform(
  spotifyId: string,
  duration: number,
): Promise<{ peaks?: Float32Array; beats?: Float32Array; previewUrl?: string }> {
  try {
    const res = await callSpotify<{ segments?: [number, number, number][]; previewUrl?: string | null }>({
      kind: 'waveform',
      id: spotifyId,
    })
    if (Array.isArray(res?.segments) && res.segments.length > 0) {
      const dur = duration || 180
      const peaks = peaksFromSegments(res.segments, dur)
      const beats = beatsFromSegments(res.segments, dur) ?? undefined
      if (peaks) return { peaks, beats }
    }
    if (typeof res?.previewUrl === 'string' && PREVIEW_URL.test(res.previewUrl)) {
      return { previewUrl: res.previewUrl }
    }
  } catch {}
  return { peaks: structuralPeaks(spotifyId) }
}
