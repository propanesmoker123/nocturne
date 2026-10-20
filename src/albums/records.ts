import { normalizeCode } from '../together/code'
import { bucketOf, BUCKETS, MAX_DURATION, MAX_TEXT, mergeAlbum, okAccessKey, okCover, okImage, okPermalink, type AlbumCover, type AlbumDoc, type AlbumEntry, type AlbumMeta, type AlbumTrack } from './model'

/**
 * What goes to the relays: per album and per author one `meta` record, 16 bucket records and,
 * once someone picked one, a cover record,
 * under tags derived from the album's code (never the code itself), sealed with a key derived
 * from it. Everything that comes back is checked field by field before it is merged.
 */

const enc = new TextEncoder()
const canonical = (code: string) => (normalizeCode(code) ?? code).replace(/-/g, '')
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
const sha = (text: string) => crypto.subtle.digest('SHA-256', enc.encode(text))
const aesKey = async (text: string) => crypto.subtle.importKey('raw', await sha(text), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function albumBase(code: string): Promise<string> {
  return `nocturne-a-${hex(await sha(`nocturne-album:${canonical(code)}`)).slice(0, 16)}`
}

export const albumKey = (code: string) => aesKey(`nocturne-album-key:${canonical(code)}`)

/** The tag of the list of a person's albums, in their linked devices' channel. */
export async function listTag(groupCode: string): Promise<string> {
  return `nocturne-l-${hex(await sha(`nocturne-albums:${canonical(groupCode)}`)).slice(0, 16)}`
}

export const listKey = (groupCode: string) => aesKey(`nocturne-albums-key:${canonical(groupCode)}`)

/** The 18 tags of one album: `meta`, the buckets, then the cover (a tag of its own: a picture is big, and changes seldom). */
export const albumTags = (base: string) => [`${base}:m`, ...Array.from({ length: BUCKETS }, (_, i) => `${base}:b${i}`), `${base}:c`]

export const albumLink = (code: string) => `nocturne://album?code=${code}`

/** The code from an album link or a typed code; null for anything else. */
export function albumCodeFromLink(input: string): string | null {
  const text = input.trim()
  const m = /^nocturne:\/\/album\/?\?code=([0-9A-Za-z-]{16,19})$/.exec(text)
  if (m) return normalizeCode(m[1])
  if (/^[a-z]+:/i.test(text)) return null
  return normalizeCode(text)
}

export interface MetaRecord {
  v: 1
  id: string
  meta: AlbumMeta
}

export interface BucketRecord {
  v: 1
  id: string
  bucket: number
  entries: AlbumEntry[]
}

export interface CoverRecord {
  v: 1
  id: string
  cover: AlbumCover
}

export type AlbumRecord = MetaRecord | BucketRecord | CoverRecord

export function splitDoc(d: AlbumDoc): { meta: MetaRecord; buckets: BucketRecord[]; cover: CoverRecord | null } {
  const buckets: BucketRecord[] = Array.from({ length: BUCKETS }, (_, bucket) => ({ v: 1, id: d.id, bucket, entries: [] }))
  for (const e of Object.values(d.entries)) buckets[bucketOf(e.eid)].entries.push(e)
  return { meta: { v: 1, id: d.id, meta: d.meta }, buckets, cover: d.cover ? { v: 1, id: d.id, cover: d.cover } : null }
}

/** Merges one record into the album (a bucket or the cover may come before its `meta`). */
export function applyRecord(d: AlbumDoc | null, r: AlbumRecord): AlbumDoc {
  const base: AlbumDoc = d ?? { id: r.id, meta: { name: '', updatedAt: 0, by: '' }, entries: {} }
  if ('meta' in r) return mergeAlbum(base, { id: r.id, meta: r.meta, entries: {} })
  if ('cover' in r) return mergeAlbum(base, { id: r.id, meta: base.meta, entries: {}, cover: r.cover })
  return mergeAlbum(base, { id: r.id, meta: base.meta, entries: Object.fromEntries(r.entries.map((e) => [e.eid, e])) })
}

// ── sealing: compressed, then encrypted ────────────────────────────────────────────────────────

/** A record never opens to more than this (a hostile one could inflate without end). */
const MAX_OPEN = 2 * 1024 * 1024

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      void reader.cancel()
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const toBase64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** base64(nonce ‖ AES-GCM(deflate(JSON))): album records are long and repetitive, so they are squeezed first. */
export async function sealRecord(key: CryptoKey, data: unknown): Promise<string> {
  const packed = (await pipe(enc.encode(JSON.stringify(data)), new CompressionStream('deflate-raw')))!
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, packed))
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return toBase64(out)
}

/** The data, or null for anything not sealed with this key, changed on the way, or too big. */
export async function openRecord(key: CryptoKey, text: string): Promise<unknown | null> {
  try {
    const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
    if (bytes.length < 12 + 16) return null
    const packed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)))
    const plain = await pipe(packed, new DecompressionStream('deflate-raw'), MAX_OPEN)
    return plain ? JSON.parse(new TextDecoder().decode(plain)) : null
  } catch {
    return null
  }
}

// ── checking what came from the relays ─────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const hex16 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const optInt = (v: unknown) => v === undefined || int(v)

/** A track as read: what it must have checked, what it may have left out when it is off. */
function track(v: unknown): AlbumTrack | null {
  if (!isObj(v)) return null
  if (v.service !== undefined && v.service !== 'sc') return null
  if (!int(v.id) || !int(v.ownerId, -Number.MAX_SAFE_INTEGER) || !text(v.title, MAX_TEXT) || !text(v.artist, MAX_TEXT)) return null
  if (typeof v.duration !== 'number' || !Number.isFinite(v.duration) || v.duration < 0 || v.duration > MAX_DURATION) return null
  return {
    ...(v.service ? { service: 'sc' as const } : {}),
    id: v.id,
    ownerId: v.ownerId,
    ...(okAccessKey(v.accessKey) ? { accessKey: v.accessKey } : {}),
    title: v.title,
    artist: v.artist,
    duration: v.duration,
    ...(okCover(v.cover) ? { cover: v.cover } : {}),
    ...(okPermalink(v.permalink) ? { permalink: v.permalink } : {}),
  }
}

function entry(v: unknown): AlbumEntry | null {
  if (!isObj(v) || !hex16(v.eid) || !hex16(v.by) || !int(v.addedAt) || !int(v.updatedAt) || !optInt(v.removedAt)) return null
  // a track's place never ends in 0 (there would be no room before it); a removed one has none
  const place = v.removedAt === undefined ? /^[0-9a-z]{0,127}[1-9a-z]$/ : /^[0-9a-z]{0,128}$/
  if (!(typeof v.pos === 'string' && place.test(v.pos))) return null
  const t = v.track === undefined ? undefined : track(v.track)
  if (t === null) return null
  if (!t && v.removedAt === undefined) return null
  return { eid: v.eid, ...(t ? { track: t } : {}), pos: v.pos, addedAt: v.addedAt, updatedAt: v.updatedAt, by: v.by, ...(v.removedAt !== undefined ? { removedAt: v.removedAt as number } : {}) }
}

/** A name or a cover dated further ahead than this could never be changed again: refused. */
const AHEAD_MS = 86_400_000

function meta(v: unknown, now: number): AlbumMeta | null {
  if (!isObj(v) || !text(v.name, 100) || !int(v.updatedAt, 0, now + AHEAD_MS) || !hex16(v.by) || !optInt(v.deletedAt)) return null
  return { name: v.name, updatedAt: v.updatedAt, by: v.by, ...(v.deletedAt !== undefined ? { deletedAt: v.deletedAt as number } : {}) }
}

function cover(v: unknown, now: number): AlbumCover | null {
  if (!isObj(v) || !int(v.updatedAt, 0, now + AHEAD_MS) || !hex16(v.by) || (v.image !== undefined && !okImage(v.image))) return null
  return { ...(v.image !== undefined ? { image: v.image as string } : {}), updatedAt: v.updatedAt, by: v.by }
}

/** A record as it came from a relay, cleaned; null when anything in it is off. `now`: the time by VK's clock. */
export function parseRecord(raw: unknown, now = Date.now()): AlbumRecord | null {
  if (!isObj(raw) || raw.v !== 1 || !hex16(raw.id)) return null
  if (raw.cover !== undefined) {
    const c = cover(raw.cover, now)
    return c ? { v: 1, id: raw.id, cover: c } : null
  }
  if (raw.meta !== undefined) {
    const m = meta(raw.meta, now)
    return m ? { v: 1, id: raw.id, meta: m } : null
  }
  if (!int(raw.bucket, 0, BUCKETS - 1) || !Array.isArray(raw.entries) || raw.entries.length > 2000) return null
  const entries: AlbumEntry[] = []
  for (const e of raw.entries) {
    const clean = entry(e)
    // an entry that is off (or not of this bucket: an entry lives in one only) is left out, the rest kept
    if (clean && bucketOf(clean.eid) === raw.bucket) entries.push(clean)
  }
  return { v: 1, id: raw.id, bucket: raw.bucket, entries }
}

// ── the list of a person's albums ──────────────────────────────────────────────────────────────

/**
 * One album in a person's list. Its fields merge each on its own: the code by when it was set
 * (a rename elsewhere must not bring an old code back), the name by `updatedAt`, «shared» once
 * set stays, and a removal holds until the album is added again (`joinedAt`).
 */
export interface ListEntry {
  id: string
  code: string
  codeAt: number
  name: string
  /** shared with someone (or joined by code) */
  shared: boolean
  updatedAt: number
  by: string
  removedAt?: number
  joinedAt?: number
}

export interface ListRecord {
  v: 1
  albums: ListEntry[]
}

function mergeListEntry(a: ListEntry, b: ListEntry): ListEntry {
  const named = b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && b.by > a.by) ? b : a
  const coded = b.codeAt > a.codeAt || (b.codeAt === a.codeAt && b.code > a.code) ? b : a
  const joinedAt = Math.max(a.joinedAt ?? 0, b.joinedAt ?? 0)
  const removedAt = Math.max(a.removedAt ?? 0, b.removedAt ?? 0)
  return {
    id: a.id,
    code: coded.code,
    codeAt: coded.codeAt,
    name: named.name,
    shared: a.shared || b.shared,
    updatedAt: named.updatedAt,
    by: named.by,
    ...(removedAt > joinedAt ? { removedAt } : {}),
    ...(joinedAt ? { joinedAt } : {}),
  }
}

export function mergeList(a: ListEntry[], b: ListEntry[]): ListEntry[] {
  const out = new Map(a.map((e) => [e.id, mergeListEntry(e, e)]))
  for (const e of b) out.set(e.id, mergeListEntry(out.get(e.id) ?? e, e))
  return [...out.values()]
}

export function parseList(raw: unknown): ListRecord | null {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.albums) || raw.albums.length > 500) return null
  const albums: ListEntry[] = []
  for (const v of raw.albums) {
    if (!isObj(v) || !hex16(v.id) || typeof v.code !== 'string' || normalizeCode(v.code) !== v.code || !text(v.name, 100)) return null
    if (typeof v.shared !== 'boolean' || !int(v.updatedAt) || !hex16(v.by) || !optInt(v.removedAt) || !optInt(v.codeAt) || !optInt(v.joinedAt)) return null
    albums.push({
      id: v.id,
      code: v.code,
      // a list from before codes had their own time
      codeAt: (v.codeAt as number | undefined) ?? v.updatedAt,
      name: v.name,
      shared: v.shared,
      updatedAt: v.updatedAt,
      by: v.by,
      ...(v.removedAt !== undefined ? { removedAt: v.removedAt as number } : {}),
      ...(v.joinedAt !== undefined ? { joinedAt: v.joinedAt as number } : {}),
    })
  }
  return { v: 1, albums }
}
