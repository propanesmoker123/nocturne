import type { Cover, Friend, Lyrics, Playlist, Track, User } from './models'
import type { RawAudio, RawLyrics, RawPhotoSizes, RawPlaylist, RawUser } from './types'

const ENTITIES: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' }

/** VK still returns a few html entities in user-provided strings. */
export function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|#0?39|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
}

function pick(p: RawPhotoSizes | undefined, keys: (keyof RawPhotoSizes)[]): string | undefined {
  if (!p) return undefined
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

const SMALL: (keyof RawPhotoSizes)[] = ['photo_68', 'photo_135', 'photo_34', 'photo_270', 'photo_300']
const MEDIUM: (keyof RawPhotoSizes)[] = ['photo_300', 'photo_270', 'photo_600', 'photo_135', 'photo_1200', 'photo_68']
const LARGE: (keyof RawPhotoSizes)[] = ['photo_1200', 'photo_600', 'photo_300', 'photo_270', 'photo_135', 'photo_68']

export function coverFrom(p: RawPhotoSizes | undefined): Cover | undefined {
  const m = pick(p, MEDIUM)
  if (!m) return undefined
  return { s: pick(p, SMALL) ?? m, m, l: pick(p, LARGE) ?? m }
}

export function normalizeTrack(raw: RawAudio, now: number = Date.now()): Track {
  const url = raw.url || undefined
  const artists = [...(raw.main_artists ?? []), ...(raw.featured_artists ?? [])].map((a) => ({ id: a.id, name: decodeEntities(a.name) }))
  const artist = decodeEntities(raw.artist ?? '')
  return {
    id: raw.id,
    ownerId: raw.owner_id,
    key: `${raw.owner_id}_${raw.id}`,
    accessKey: raw.access_key || undefined,
    artist,
    title: decodeEntities(raw.title ?? ''),
    subtitle: raw.subtitle ? decodeEntities(raw.subtitle) : undefined,
    duration: raw.duration ?? 0,
    url,
    urlFetchedAt: url ? now : 0,
    cover: coverFrom(raw.album?.thumb) ?? coverFrom(raw.thumb),
    album: raw.album
      ? { id: raw.album.id, ownerId: raw.album.owner_id, accessKey: raw.album.access_key || undefined, title: decodeEntities(raw.album.title ?? '') }
      : undefined,
    explicit: !!raw.is_explicit,
    artists: artists.length ? artists : [{ name: artist }],
    playable: !!url && !raw.content_restricted,
    hasLyrics: !!raw.has_lyrics,
    liked: !!raw.like,
    releaseId: raw.release_audio_id || undefined,
  }
}

/** Id used by audio.getById / audio.add: "owner_id_id[_access_key]". */
export function trackKeyWithAccess(t: Pick<Track, 'ownerId' | 'id' | 'accessKey'>): string {
  return t.accessKey ? `${t.ownerId}_${t.id}_${t.accessKey}` : `${t.ownerId}_${t.id}`
}

export function normalizePlaylist(raw: RawPlaylist, meId: number, ownerNames?: Map<number, string>): Playlist {
  const isFollowed = !!raw.original || !!raw.is_following
  const covers = (raw.thumbs ?? []).map((t) => pick(t, MEDIUM)).filter((x): x is string => !!x).slice(0, 4)
  const isAlbum = raw.type === 1 || raw.type === 'album' || !!raw.album_type
  return {
    id: raw.id,
    ownerId: raw.owner_id,
    accessKey: raw.access_key || undefined,
    title: decodeEntities(raw.title ?? ''),
    description: raw.description?.trim() ? decodeEntities(raw.description.trim()) : undefined,
    count: raw.count ?? 0,
    cover: pick(raw.photo, ['photo_600', 'photo_300', 'photo_1200', 'photo_270', 'photo_135']),
    covers,
    isOwn: raw.owner_id === meId && !isFollowed,
    isFollowed,
    canEdit: !!raw.permissions?.edit && raw.owner_id === meId && !isFollowed,
    type: isAlbum ? 'album' : 'playlist',
    ownerName: ownerNames?.get(raw.owner_id),
    year: raw.year,
    original: raw.original ? { id: raw.original.playlist_id, ownerId: raw.original.owner_id, accessKey: raw.original.access_key } : undefined,
  }
}

export function normalizeFriend(raw: RawUser): Friend {
  return {
    id: raw.id,
    name: `${raw.first_name} ${raw.last_name}`.trim(),
    photo: raw.photo_100,
    canSeeAudio: raw.can_see_audio === 1 && !raw.deactivated,
  }
}

export function normalizeUser(raw: RawUser): User {
  return { id: raw.id, name: `${raw.first_name} ${raw.last_name}`.trim(), photo: raw.photo_200 ?? raw.photo_100 }
}

export function normalizeLyrics(raw: RawLyrics): Lyrics | null {
  const ts = raw.lyrics?.timestamps
  if (ts && ts.length) {
    return {
      synced: true,
      lines: ts.filter((l) => !l.interlude).map((l) => ({ text: l.line ?? '', begin: l.begin })),
      credits: raw.credits,
    }
  }
  const text = raw.lyrics?.text
  if (text && text.length) return { synced: false, lines: text.map((t) => ({ text: t })), credits: raw.credits }
  return null
}

/** Builds an owner-id → display-name map from extended responses. */
export function ownerNamesFrom(profiles?: RawUser[], groups?: { id: number; name: string }[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const p of profiles ?? []) m.set(p.id, `${p.first_name} ${p.last_name}`.trim())
  for (const g of groups ?? []) m.set(-g.id, g.name)
  return m
}
