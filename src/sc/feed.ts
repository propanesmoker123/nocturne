import { pluralRu } from '../lib/format'
import type { Playlist, Track } from '../vk/models'
import { artwork, normalizeScPlaylist, normalizeScTrack } from './normalize'
import type { RawScActivity, RawScTrack, RawScUser } from './types'

/**
 * «Лента»: what the people one follows did, newest first — SoundCloud's own stream (their new
 * tracks and reposts) and, from each followed profile, its new tracks, reposts and likes
 * (SoundCloud's stream has no likes).
 */

export type FeedKind = 'post' | 'repost' | 'like'

export interface FeedPerson {
  id: number
  name: string
  avatar?: string
}

export interface FeedItem {
  /** the same thing by the same person shows once */
  id: string
  kind: FeedKind
  /** ms */
  at: number
  who: FeedPerson
  track?: Track
  playlist?: Playlist
}

const person = (u: RawScUser): FeedPerson => {
  const avatar = artwork(u.avatar_url)?.s
  return { id: u.id, name: u.username || u.full_name || '', ...(avatar ? { avatar } : {}) }
}

function item(kind: FeedKind, who: FeedPerson | undefined, when: string | undefined, raw: { track?: RawScTrack; playlist?: RawScActivity['playlist'] }): FeedItem | null {
  const at = when ? Date.parse(when) : NaN
  if (!who || !who.id || !Number.isFinite(at)) return null
  if (raw.track?.title) {
    return { id: `${kind}:${who.id}:t${raw.track.id}`, kind, at, who, track: normalizeScTrack(raw.track) }
  }
  if (raw.playlist && (raw.playlist.id || raw.playlist.urn)) {
    const p = normalizeScPlaylist(raw.playlist)
    return { id: `${kind}:${who.id}:p${p.id || p.urn}`, kind, at, who, playlist: p }
  }
  return null
}

const kindOf = (type: string | undefined): FeedKind => (type?.endsWith('repost') ? 'repost' : 'post')

/** SoundCloud's own stream: new tracks and reposts of the people followed. */
export function streamFeed(items: RawScActivity[]): FeedItem[] {
  return items
    .map((it) => {
      const who = it.user ?? it.track?.user ?? it.playlist?.user
      return item(kindOf(it.type), who ? person(who) : undefined, it.created_at, it)
    })
    .filter((x): x is FeedItem => !!x)
}

/** One followed profile: its own new tracks, what it reposted and what it liked. */
export function userActivity(who: FeedPerson, parts: { tracks: RawScTrack[]; reposts: RawScActivity[]; likes: RawScActivity[] }): FeedItem[] {
  return [
    ...parts.tracks.map((t) => item('post', who, t.created_at, { track: t })),
    ...parts.reposts.map((r) => item('repost', who, r.created_at, r)),
    ...parts.likes.map((l) => item('like', who, l.created_at, l)),
  ].filter((x): x is FeedItem => !!x)
}

/** All of it newest first, each thing by each person once. */
export function mergeFeed(lists: FeedItem[][]): FeedItem[] {
  const byId = new Map<string, FeedItem>()
  for (const list of lists) for (const it of list) if (!byId.has(it.id)) byId.set(it.id, it)
  return [...byId.values()].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
}

/** The next few followed people to read (each costs three requests). */
export function feedPage<T>(people: T[], offset: number, size: number): { people: T[]; next?: number } {
  const next = offset + size
  return { people: people.slice(offset, next), next: next < people.length ? next : undefined }
}

/** «5 мин», «3 ч», «вчера», «3 дня», «12 сент.»: how long ago, short. */
export function agoRu(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'только что'
  if (s < 3600) return `${Math.floor(s / 60)} мин`
  if (s < 86_400) return `${Math.floor(s / 3600)} ч`
  if (s < 2 * 86_400) return 'вчера'
  const days = Math.floor(s / 86_400)
  if (days < 7) return `${days} ${pluralRu(days, 'день', 'дня', 'дней')}`
  const d = new Date(at)
  const day = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  return d.getFullYear() === new Date(now).getFullYear() ? day : `${day} ${d.getFullYear()}`
}

/** What a feed line says about its item. */
export function kindLabel(it: FeedItem): string {
  if (it.kind === 'like') return 'лайк'
  if (it.kind === 'repost') return 'репост'
  return it.playlist ? 'новый плейлист' : 'новый трек'
}

/** `fn` over `xs` with at most `n` running at once; results in the order of `xs`. */
export async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(xs.length)
  let next = 0
  const worker = async () => {
    while (next < xs.length) {
      const i = next++
      out[i] = await fn(xs[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker))
  return out
}
