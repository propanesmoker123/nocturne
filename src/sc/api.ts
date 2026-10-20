import { invoke, isTauri } from '../lib/tauri'
import type { Playlist, Track } from '../vk/models'
import { ScApiError } from './errors'
import { normalizeScComment, normalizeScPlaylist, normalizeScTrack, normalizeScUser, streamItems, type ScComment, type ScUser } from './normalize'
import { streamFeed, userActivity, type FeedItem, type FeedPerson } from './feed'
import type { RawScActivity, RawScCollection, RawScComment, RawScLibraryItem, RawScLike, RawScPlaylist, RawScSelection, RawScStreamItem, RawScTrack, RawScUser } from './types'

export type { ScComment, ScUser } from './normalize'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
type Transport = (method: Method, path: string) => Promise<unknown>

let transport: Transport | null = null
let meId = 0
let accountVersion = 0
let likesVersion = 0
/** Tracks the person liked, as far as their likes have been read or changed. */
const likedIds = new Set<number>()

const defaultTransport: Transport = async (method, path) => {
  if (isTauri()) return invoke('sc_api', { method, path })
  const { mockScCall } = await import('./mock')
  return mockScCall(method, path)
}

/** Test hook: replace how requests are sent (null restores the default). */
export function setTransport(t: Transport | null) {
  transport = t
}

export function setScMeId(id: number) {
  if (id !== meId) {
    likedIds.clear()
    accountVersion++
    likesVersion++
  }
  meId = id
}

export const getScMeId = () => meId

async function call<T>(method: Method, path: string): Promise<T> {
  try {
    return (await (transport ?? defaultTransport)(method, path)) as T
  } catch (raw) {
    throw ScApiError.from(raw)
  }
}

const get = <T>(path: string) => call<T>('GET', path)

export interface ScPage<T> {
  items: T[]
  /** path and query of the next page, for the next call */
  next?: string
}

/** An api-v2 `next_href` as a path for `sc_api`; nothing for anything that is not api-v2. */
export function nextPath(href?: string | null): string | undefined {
  if (!href) return undefined
  try {
    const u = new URL(href)
    return u.protocol === 'https:' && u.host === 'api-v2.soundcloud.com' ? u.pathname + u.search : undefined
  } catch {
    return undefined
  }
}

const track = (r: RawScTrack) => normalizeScTrack(r, likedIds.has(r.id))
/** Not a stub: the track itself, not just its id. */
const full = (r: RawScTrack | undefined): boolean => !!r?.title
const fullOnes = (list: (RawScTrack | undefined)[]): RawScTrack[] => list.filter((r): r is RawScTrack => full(r))

export interface ScSelection {
  id: string
  title: string
  description?: string
  playlists: Playlist[]
}

export async function getMe(): Promise<ScUser> {
  return normalizeScUser(await get<RawScUser>('/me'))
}

/** «Для вас»: SoundCloud's own selections (made for you, stations, trending…). */
export async function getSelections(): Promise<ScSelection[]> {
  const raw = await get<RawScCollection<RawScSelection>>('/mixed-selections?limit=10')
  return (raw.collection ?? [])
    .map((s, i) => ({ id: s.urn ?? s.id ?? `sel-${i}`, title: s.title ?? '', description: s.description ?? undefined, playlists: (s.items?.collection ?? []).map(normalizeScPlaylist) }))
    .filter((s) => s.title && s.playlists.length)
}

/** Full tracks for these ids, 50 per request, in the order asked; unknown ones are left out. */
export async function getTracks(ids: number[]): Promise<Track[]> {
  const byId = new Map<number, Track>()
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    const raw = await get<RawScTrack[]>(`/tracks?ids=${chunk.join(',')}`)
    for (const r of fullOnes(raw ?? [])) byId.set(r.id, track(r))
  }
  return ids.map((id) => byId.get(id)).filter((t): t is Track => !!t)
}

/** A playlist or a system playlist with all its tracks (stubs filled in). */
export async function getPlaylistWithTracks(p: Pick<Playlist, 'id' | 'urn'>): Promise<{ playlist: Playlist; tracks: Track[] }> {
  const raw = await get<RawScPlaylist>(p.urn ? `/system-playlists/${p.urn}` : `/playlists/${p.id}`)
  const list = raw.tracks ?? []
  const missing = list.filter((t) => !full(t)).map((t) => t.id)
  const filled = new Map((await getTracks(missing)).map((t) => [t.id, t]))
  const tracks = list.map((r) => (full(r) ? track(r) : filled.get(r.id))).filter((t): t is Track => !!t)
  return { playlist: normalizeScPlaylist(raw), tracks }
}

/** «Лента»: uploads and reposts of the people followed. */
export async function getStream(cursor?: string): Promise<{ tracks: Track[]; playlists: Playlist[]; next?: string }> {
  const raw = await get<RawScCollection<RawScStreamItem>>(cursor ?? '/stream?limit=40')
  const { tracks, playlists } = streamItems(raw.collection ?? [])
  return { tracks: tracks.map((t) => ({ ...t, liked: likedIds.has(t.id) })), playlists, next: nextPath(raw.next_href) }
}

export async function getLikes(userId: number, cursor?: string): Promise<ScPage<Track>> {
  const version = likesVersion
  const raw = await get<RawScCollection<RawScLike>>(cursor ?? `/users/${userId}/track_likes?limit=200`)
  const items = fullOnes((raw.collection ?? []).map((l) => l.track)).map((r) => normalizeScTrack(r, true))
  if (userId === meId && version === likesVersion) for (const t of items) likedIds.add(t.id)
  return { items, next: nextPath(raw.next_href) }
}

async function setLiked(t: Pick<Track, 'id'>, liked: boolean): Promise<void> {
  const account = meId
  const version = accountVersion
  if (!account) throw new ScApiError('signedOut', '')
  await call(liked ? 'PUT' : 'DELETE', `/users/${account}/track_likes/${t.id}`)
  if (meId !== account || version !== accountVersion) throw new ScApiError('signedOut', '')
  likesVersion++
  if (liked) likedIds.add(t.id)
  else likedIds.delete(t.id)
}

export const like = (t: Pick<Track, 'id'>) => setLiked(t, true)
export const unlike = (t: Pick<Track, 'id'>) => setLiked(t, false)

const playlistKey = (p: Playlist) => `${p.id}_${p.urn ?? ''}`

/** The person's own playlists and albums, then the ones they liked, each once. */
export async function getMyPlaylists(): Promise<Playlist[]> {
  const [own, albums, library] = await Promise.allSettled([
    get<RawScCollection<RawScPlaylist>>(`/users/${meId}/playlists_without_albums?limit=200`),
    get<RawScCollection<RawScPlaylist>>(`/users/${meId}/albums?limit=200`),
    get<RawScCollection<RawScLibraryItem>>('/me/library/all?limit=200'),
  ])
  if (own.status === 'rejected' && library.status === 'rejected') throw own.reason
  const out: Playlist[] = []
  const seen = new Set<string>()
  const add = (p: Playlist) => {
    if (seen.has(playlistKey(p))) return
    seen.add(playlistKey(p))
    out.push(p)
  }
  for (const r of [own, albums]) if (r.status === 'fulfilled') for (const raw of r.value.collection ?? []) add({ ...normalizeScPlaylist(raw), isOwn: true })
  if (library.status === 'fulfilled') {
    for (const it of library.value.collection ?? []) {
      const raw = it.playlist ?? it.system_playlist
      if (raw) add(normalizeScPlaylist(raw))
    }
  }
  return out
}

export async function getUser(id: number): Promise<ScUser> {
  return normalizeScUser(await get<RawScUser>(`/users/${id}`))
}

export async function getUserTopTracks(id: number): Promise<Track[]> {
  const raw = await get<RawScCollection<RawScTrack>>(`/users/${id}/toptracks?limit=50`)
  return fullOnes(raw.collection ?? []).map(track)
}

export async function getUserTracks(id: number, cursor?: string): Promise<ScPage<Track>> {
  const raw = await get<RawScCollection<RawScTrack>>(cursor ?? `/users/${id}/tracks?limit=50`)
  return { items: fullOnes(raw.collection ?? []).map(track), next: nextPath(raw.next_href) }
}

export async function getUserPlaylists(id: number): Promise<Playlist[]> {
  const [lists, albums] = await Promise.all([get<RawScCollection<RawScPlaylist>>(`/users/${id}/playlists_without_albums?limit=50`), get<RawScCollection<RawScPlaylist>>(`/users/${id}/albums?limit=50`)])
  return [...(albums.collection ?? []), ...(lists.collection ?? [])].map(normalizeScPlaylist)
}

/** Tracks and playlists of one page of a profile's reposts or likes. */
export interface ScMixedPage {
  tracks: Track[]
  playlists: Playlist[]
  next?: string
}

async function mixedPage(path: string): Promise<ScMixedPage> {
  const raw = await get<RawScCollection<RawScStreamItem>>(path)
  const { tracks, playlists } = streamItems(raw.collection ?? [])
  return { tracks: tracks.map((t) => ({ ...t, liked: likedIds.has(t.id) })), playlists, next: nextPath(raw.next_href) }
}

/** «Репосты» of a profile, a page at a time. */
export const getUserReposts = (id: number, cursor?: string) => mixedPage(cursor ?? `/stream/users/${id}/reposts?limit=50`)

/** «Лайки» of a profile (tracks and playlists), a page at a time. */
export const getUserLikes = (id: number, cursor?: string) => mixedPage(cursor ?? `/users/${id}/likes?limit=50`)

/** Whom the signed-in person follows (ids); nothing is asked while signed out. */
export async function getMyFollowings(): Promise<number[]> {
  if (!meId) return []
  const out: number[] = []
  let path: string | undefined = `/users/${meId}/followings/ids?limit=5000`
  for (let page = 0; path && page < 4; page++) {
    const raw: RawScCollection<number> = await get<RawScCollection<number>>(path)
    for (const id of raw.collection ?? []) if (Number.isSafeInteger(id)) out.push(id)
    path = nextPath(raw.next_href)
  }
  return out
}

// ── «Лента» ──────────────────────────────────────────────────────────────────────────────────

/** A feed item's track knows whether it is liked here. */
const withLikes = (items: FeedItem[]): FeedItem[] => items.map((i) => (i.track ? { ...i, track: { ...i.track, liked: likedIds.has(i.track.id) } } : i))

/** SoundCloud's own stream (new tracks and reposts of the people followed), a page at a time. */
export async function getStreamFeed(cursor?: string): Promise<{ items: FeedItem[]; next?: string }> {
  const raw = await get<RawScCollection<RawScActivity>>(cursor ?? '/stream?limit=40')
  return { items: withLikes(streamFeed(raw.collection ?? [])), next: nextPath(raw.next_href) }
}

/** One followed profile's latest tracks, reposts and likes; a part that fails is left out, all three failing is an error. */
export async function getUserActivity(who: FeedPerson): Promise<FeedItem[]> {
  const parts = await Promise.allSettled([
    get<RawScCollection<RawScTrack>>(`/users/${who.id}/tracks?limit=10`),
    get<RawScCollection<RawScActivity>>(`/stream/users/${who.id}/reposts?limit=10`),
    get<RawScCollection<RawScActivity>>(`/users/${who.id}/likes?limit=10`),
  ])
  const [tracks, reposts, likes] = parts
  if (parts.every((p) => p.status === 'rejected')) throw (parts[0] as PromiseRejectedResult).reason
  const list = <T>(r: PromiseSettledResult<RawScCollection<T>>) => (r.status === 'fulfilled' ? (r.value.collection ?? []) : [])
  return withLikes(userActivity(who, { tracks: list(tracks), reposts: list(reposts), likes: list(likes) }))
}

/** The people the signed-in person follows, for the feed (up to 200). */
export async function getFeedPeople(): Promise<FeedPerson[]> {
  if (!meId) return []
  const out: FeedPerson[] = []
  let cursor: string | undefined
  for (let page = 0; page < 4; page++) {
    const p = await getFollowingUsers(meId, cursor)
    for (const u of p.items) out.push({ id: u.id, name: u.name, ...(u.avatar ? { avatar: u.avatar } : {}) })
    if (!p.next) break
    cursor = p.next
  }
  return out
}

/** The people someone follows, a page at a time (with their counts). */
export async function getFollowingUsers(id: number, cursor?: string): Promise<ScPage<ScUser>> {
  const raw = await get<RawScCollection<RawScUser>>(cursor ?? `/users/${id}/followings?limit=50`)
  return { items: (raw.collection ?? []).map(normalizeScUser), next: nextPath(raw.next_href) }
}

/** Follows someone in the site's session. Native code adds the signature using the account,
 * current client id and the service browser's actual user agent immediately before sending. */
export async function follow(u: Pick<ScUser, 'id' | 'permalink'>): Promise<void> {
  if (!meId) throw new ScApiError('signedOut', '')
  if (!Number.isSafeInteger(u.id) || u.id <= 0 || u.id === meId) throw new ScApiError('invalid', 'bad follow target')
  await call('POST', `/me/followings/${u.id}`)
}

/** Stops following someone (the site's session, like a like). */
export async function unfollow(id: number): Promise<void> {
  await call('DELETE', `/me/followings/${id}`)
}

/** Up to 200 newest comments of a track, each at its moment, with the track they belong to. */
export async function getComments(trackId: number): Promise<{ trackId: number; comments: ScComment[] }> {
  const raw = await get<RawScCollection<RawScComment>>(`/tracks/${trackId}/comments?threaded=0&filter_replies=1&limit=200`)
  return { trackId, comments: (raw.collection ?? []).map(normalizeScComment).filter((c): c is ScComment => !!c) }
}

export async function search(q: string): Promise<{ tracks: Track[]; users: ScUser[]; playlists: Playlist[] }> {
  const term = encodeURIComponent(q)
  const [tracks, users, playlists] = await Promise.all([
    get<RawScCollection<RawScTrack>>(`/search/tracks?q=${term}&limit=50`),
    get<RawScCollection<RawScUser>>(`/search/users?q=${term}&limit=12`),
    get<RawScCollection<RawScPlaylist>>(`/search/playlists?q=${term}&limit=12`),
  ])
  return {
    tracks: fullOnes(tracks.collection ?? []).map(track),
    users: (users.collection ?? []).map(normalizeScUser),
    playlists: (playlists.collection ?? []).map(normalizeScPlaylist),
  }
}

/** A fresh stream link for the track (SoundCloud's links last minutes). */
export async function streamUrl(t: Pick<Track, 'id'>): Promise<string> {
  if (!isTauri()) return 'https://example.invalid/sc.m3u8'
  try {
    return await invoke<string>('sc_stream', { trackId: t.id })
  } catch (raw) {
    throw ScApiError.from(raw)
  }
}
