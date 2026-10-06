import { invoke, isTauri } from '../lib/tauri'
import { parseCatalog, parseSection } from './catalog'
import { VkError } from './errors'
import type { CatalogSection, Friend, Lyrics, Playlist, Track, User } from './models'
import { normalizeFriend, normalizeLyrics, normalizePlaylist, normalizeTrack, normalizeUser, ownerNamesFrom, trackKeyWithAccess } from './normalize'
import type { RawAudio, RawCatalogResponse, RawList, RawLyrics, RawPlaylist, RawUser } from './types'

type Params = Record<string, unknown>
type Transport = (method: string, params: Params) => Promise<unknown>
type CaptchaHandler = (e: VkError) => Promise<string | null>

let transport: Transport | null = null
let captchaHandler: CaptchaHandler | null = null
let meId = 0

const defaultTransport: Transport = async (method, params) => {
  if (isTauri()) return invoke('vk_api', { method, params })
  const { mockCall } = await import('./mock')
  return mockCall(method, params)
}

/** Test hook: replace how requests are sent (null restores the default). */
export function setTransport(t: Transport | null) {
  transport = t
}

/** The UI registers a sheet that asks the user to type the captcha. */
export function setCaptchaHandler(h: CaptchaHandler | null) {
  captchaHandler = h
}

export function setMeId(id: number) {
  meId = id
}

export function getMeId(): number {
  return meId
}

export async function call<T>(method: string, params: Params = {}): Promise<T> {
  const send = transport ?? defaultTransport
  try {
    return (await send(method, params)) as T
  } catch (raw) {
    const err = VkError.from(raw)
    if (!err.isCaptcha || !captchaHandler || !err.captchaSid) throw err
    const key = await captchaHandler(err)
    if (!key) throw err
    try {
      return (await send(method, { ...params, captcha_sid: err.captchaSid, captcha_key: key })) as T
    } catch (raw2) {
      throw VkError.from(raw2)
    }
  }
}

export interface Page<T> {
  count: number
  items: T[]
  nextFrom?: string
}

const tracksPage = (r: RawList<RawAudio>): Page<Track> => {
  const now = Date.now()
  return { count: r.count, items: r.items.map((a) => normalizeTrack(a, now)), nextFrom: r.next_from }
}

// ── Account ──────────────────────────────────────────────────────────────

export async function getMe(): Promise<User> {
  const r = await call<RawUser[]>('users.get', { fields: 'photo_100,photo_200' })
  return normalizeUser(r[0])
}

export async function getFriends(): Promise<Friend[]> {
  const r = await call<RawList<RawUser>>('friends.get', { fields: 'photo_100,can_see_audio', order: 'hints', count: 5000 })
  return r.items.map(normalizeFriend)
}

// ── Tracks ───────────────────────────────────────────────────────────────

export async function getTracks(ownerId: number, offset = 0, count = 200): Promise<Page<Track>> {
  return tracksPage(await call<RawList<RawAudio>>('audio.get', { owner_id: ownerId, offset, count }))
}

export async function getByIds(tracks: Pick<Track, 'ownerId' | 'id' | 'accessKey'>[]): Promise<Track[]> {
  if (tracks.length === 0) return []
  const r = await call<RawAudio[]>('audio.getById', { audios: tracks.map(trackKeyWithAccess).join(',') })
  const now = Date.now()
  return r.map((a) => normalizeTrack(a, now))
}

/** Adds a track to "Моя музыка"; returns the id of the new copy. */
export async function addTrack(t: Track): Promise<number> {
  return call<number>('audio.add', { owner_id: t.ownerId, audio_id: t.id, access_key: t.accessKey })
}

export async function deleteTrack(t: Pick<Track, 'ownerId' | 'id'>): Promise<void> {
  await call('audio.delete', { owner_id: t.ownerId, audio_id: t.id })
}

export async function restoreTrack(t: Pick<Track, 'ownerId' | 'id'>): Promise<void> {
  await call('audio.restore', { owner_id: t.ownerId, audio_id: t.id })
}

export async function searchTracks(q: string, offset = 0, count = 60): Promise<Page<Track>> {
  return tracksPage(await call<RawList<RawAudio>>('audio.search', { q, offset, count, auto_complete: 1 }))
}

export async function getStreamMix(count = 20): Promise<Track[]> {
  const r = await call<RawAudio[]>('audio.getStreamMixAudios', { mix_id: 'common', count })
  const now = Date.now()
  return r.map((a) => normalizeTrack(a, now))
}

export async function getArtistTracks(artistId: string, offset = 0, count = 100): Promise<Page<Track>> {
  const r = await call<RawList<RawAudio> | RawAudio[]>('audio.getAudiosByArtist', { artist_id: artistId, offset, count })
  return Array.isArray(r) ? tracksPage({ count: r.length, items: r }) : tracksPage(r)
}

export async function getLyrics(t: Track): Promise<Lyrics | null> {
  return normalizeLyrics(await call<RawLyrics>('audio.getLyrics', { audio_id: `${t.ownerId}_${t.id}` }))
}

export async function setBroadcast(t: Track | null): Promise<void> {
  await call('audio.setBroadcast', t ? { audio: `${t.ownerId}_${t.id}` } : {})
}

// ── Playlists ────────────────────────────────────────────────────────────

const playlistsPage = (r: RawList<RawPlaylist>): Page<Playlist> => {
  const names = ownerNamesFrom(r.profiles, r.groups)
  return { count: r.count, items: r.items.map((p) => normalizePlaylist(p, meId, names)), nextFrom: r.next_from }
}

export async function getPlaylists(ownerId: number, offset = 0, count = 100): Promise<Page<Playlist>> {
  return playlistsPage(await call<RawList<RawPlaylist>>('audio.getPlaylists', { owner_id: ownerId, offset, count, extended: 1 }))
}

export async function getPlaylist(ownerId: number, id: number, accessKey?: string): Promise<Playlist> {
  const r = await call<RawPlaylist>('audio.getPlaylistById', { owner_id: ownerId, playlist_id: id, access_key: accessKey })
  return normalizePlaylist(r, meId)
}

export async function getPlaylistTracks(p: Pick<Playlist, 'ownerId' | 'id' | 'accessKey'>, offset = 0, count = 200): Promise<Page<Track>> {
  return tracksPage(
    await call<RawList<RawAudio>>('audio.get', { owner_id: p.ownerId, playlist_id: p.id, access_key: p.accessKey, offset, count }),
  )
}

export async function createPlaylist(title: string, description: string): Promise<Playlist> {
  const r = await call<RawPlaylist>('audio.createPlaylist', { owner_id: meId, title, description })
  return normalizePlaylist(r, meId)
}

export async function editPlaylist(p: Pick<Playlist, 'ownerId' | 'id'>, title: string, description: string): Promise<void> {
  await call('audio.editPlaylist', { owner_id: p.ownerId, playlist_id: p.id, title, description })
}

/** Deletes an own playlist, or unfollows a followed copy. */
export async function deletePlaylist(p: Pick<Playlist, 'ownerId' | 'id'>): Promise<void> {
  await call('audio.deletePlaylist', { owner_id: p.ownerId, playlist_id: p.id })
}

export async function followPlaylist(p: Pick<Playlist, 'ownerId' | 'id' | 'accessKey'>): Promise<{ id: number; ownerId: number }> {
  const r = await call<{ playlist_id: number; owner_id: number }>('audio.followPlaylist', { owner_id: p.ownerId, playlist_id: p.id, access_key: p.accessKey })
  return { id: r.playlist_id, ownerId: r.owner_id }
}

export async function addToPlaylist(p: Pick<Playlist, 'ownerId' | 'id'>, tracks: Track[]): Promise<void> {
  await call('audio.addToPlaylist', { owner_id: p.ownerId, playlist_id: p.id, audio_ids: tracks.map(trackKeyWithAccess).join(',') })
}

export async function removeFromPlaylist(p: Pick<Playlist, 'ownerId' | 'id'>, tracks: Track[]): Promise<void> {
  await call('audio.removeFromPlaylist', { owner_id: p.ownerId, playlist_id: p.id, audio_ids: tracks.map((t) => `${t.ownerId}_${t.id}`).join(',') })
}

export async function searchPlaylists(q: string, offset = 0, count = 30): Promise<Page<Playlist>> {
  return playlistsPage(await call<RawList<RawPlaylist>>('audio.searchPlaylists', { q, offset, count }))
}

export async function searchAlbums(q: string, offset = 0, count = 30): Promise<Page<Playlist>> {
  return playlistsPage(await call<RawList<RawPlaylist>>('audio.searchAlbums', { q, offset, count }))
}

// ── Catalog ──────────────────────────────────────────────────────────────

export async function getCatalog(): Promise<CatalogSection[]> {
  return parseCatalog(await call<RawCatalogResponse>('catalog.getAudio', { need_blocks: 1 }), meId)
}

export async function getSection(sectionId: string, startFrom?: string): Promise<CatalogSection> {
  return parseSection(await call<RawCatalogResponse>('catalog.getSection', { section_id: sectionId, start_from: startFrom }), meId)
}
