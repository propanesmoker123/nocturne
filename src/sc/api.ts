import { invoke, isTauri } from '../lib/tauri'
import type { Playlist, Track } from '../vk/models'
import { ScApiError } from './errors'
import { normalizeScPlaylist, normalizeScTrack, normalizeScUser, streamItems, type ScUser } from './normalize'
import type { RawScCollection, RawScLibraryItem, RawScLike, RawScPlaylist, RawScSelection, RawScStreamItem, RawScTrack, RawScUser } from './types'

export type { ScUser } from './normalize'

type Method = 'GET' | 'PUT' | 'DELETE'
type Transport = (method: Method, path: string) => Promise<unknown>

let transport: Transport | null = null
let meId = 0
/** Tracks the person liked, as far as their likes have been read: other lists mark them. Liking itself
 *  happens on SoundCloud's site (its bot protection refuses likes from elsewhere). */
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
  if (id !== meId) likedIds.clear()
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
  const raw = await get<RawScCollection<RawScLike>>(cursor ?? `/users/${userId}/track_likes?limit=200`)
  const items = fullOnes((raw.collection ?? []).map((l) => l.track)).map((r) => normalizeScTrack(r, true))
  if (userId === meId) for (const t of items) likedIds.add(t.id)
  return { items, next: nextPath(raw.next_href) }
}

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
