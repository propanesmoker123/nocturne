import { serviceOf, type Playlist, type Track } from '../vk/models'

const ALGORITHMIC_VK_TITLE_RE =
  /^(Для вас|Открытия|Новинки|Плейлист дня(\s*\d+)?|Недавно добавленные|Собрано алгоритмами|Совпадение по вкусам)$/i

function isRealCoverUrl(url: string | undefined, excludeCover?: string): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  if (excludeCover && url === excludeCover) return false
  if (/default_avatar/i.test(url)) return false
  return true
}

/** True when a track carries a real cover artwork rather than a generic service placeholder. */
export function isRealTrackCover(t: Track | null | undefined, excludeCover?: string): boolean {
  if (!t || !isRealCoverUrl(t.cover?.m, excludeCover)) return false
  const svc = serviceOf(t)
  if (svc === 'vk') return Boolean(t.album && t.album.id > 0)
  return true
}

/** Picks up to `max` unique cover URLs from tracks, preferring tracks with verified album/release artwork. */
export function pickRealTrackCovers(tracks: (Track | null | undefined)[], max: number, excludeCover?: string): string[] {
  if (max <= 0) return []
  const out: string[] = []
  for (const t of tracks) {
    if (!isRealTrackCover(t, excludeCover)) continue
    const c = t!.cover!.m
    if (!out.includes(c)) out.push(c)
    if (out.length >= max) return out
  }
  if (out.length === 0) {
    for (const t of tracks) {
      const c = t?.cover?.m
      if (!isRealCoverUrl(c, excludeCover)) continue
      if (!out.includes(c)) out.push(c)
      if (out.length >= max) return out
    }
  }
  return out
}

/** True for VK algorithmic/generated playlists whose `photo` is a synthetic neon wave instead of real track art. */
export function isAlgorithmicVkPlaylist(p: Playlist): boolean {
  const svc = p.service ?? 'vk'
  if (svc !== 'vk') return false
  return p.id < 0 || ALGORITHMIC_VK_TITLE_RE.test(p.title.trim())
}

/** True when a playlist/album card should resolve covers from its tracks rather than relying on `p.cover`. */
export function needsDerivedPlaylistCovers(p: Playlist): boolean {
  return isAlgorithmicVkPlaylist(p) || (!p.cover && (!p.covers || p.covers.length === 0))
}
