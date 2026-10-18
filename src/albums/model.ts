import type { ServiceId, Track } from '../vk/models'

/**
 * A Nocturne album as a replicated document: entries with fractional positions and removal
 * markers, each field last-writer-wins. Any two copies merge to the same result in any order, so
 * edits made at the same time on different devices (or by different people) are all kept.
 */

/** What an album remembers of a track: enough to find it again, play it and show it. */
export interface AlbumTrack {
  service?: ServiceId
  id: number
  ownerId: number
  accessKey?: string
  title: string
  artist: string
  duration: number
  cover?: string
  permalink?: string
}

export interface AlbumEntry {
  eid: string
  /** gone once the entry was removed (the marker keeps only what merging needs) */
  track?: AlbumTrack
  pos: string
  addedAt: number
  updatedAt: number
  /** the device that made the last change: breaks ties */
  by: string
  removedAt?: number
}

export interface AlbumMeta {
  name: string
  updatedAt: number
  by: string
  deletedAt?: number
}

export interface AlbumDoc {
  id: string
  meta: AlbumMeta
  entries: Record<string, AlbumEntry>
}

export const BUCKETS = 16
export const MAX_TRACKS = 1000

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** A position key strictly between `a` and `b` (either may be open). Keys compare as strings. */
export function between(a?: string, b?: string): string {
  const low = a ?? ''
  let high = b
  let out = ''
  for (let i = 0; ; i++) {
    const lo = i < low.length ? DIGITS.indexOf(low[i]) : 0
    const hi = high !== undefined && i < high.length ? DIGITS.indexOf(high[i]) : DIGITS.length
    if (hi - lo > 1) return out + DIGITS[Math.floor((lo + hi) / 2)]
    out += DIGITS[lo]
    // one apart: everything after this digit is already below `b`
    if (hi - lo === 1) high = undefined
  }
}

/** FNV-1a, 32 bits: a fixed, fast spread of entry ids over the buckets. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

export const bucketOf = (eid: string) => fnv1a32(eid) % BUCKETS

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')

const sameKeyOf = (t: { service?: ServiceId; ownerId: number; id: number }) => `${t.service ?? 'vk'}:${t.ownerId}_${t.id}`

export function snapshot(t: Track): AlbumTrack {
  const sc = t.service === 'sc'
  return {
    ...(sc ? { service: 'sc' as const } : {}),
    id: t.id,
    ownerId: t.ownerId,
    ...(!sc && t.accessKey ? { accessKey: t.accessKey } : {}),
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    ...(t.cover?.m ? { cover: t.cover.m } : {}),
    ...(sc && t.permalink ? { permalink: t.permalink } : {}),
  }
}

/** A playable track from an album entry (its stream link is taken when it plays). */
export function toTrack(e: AlbumEntry): Track {
  const t = e.track!
  const sc = t.service === 'sc'
  return {
    ...(sc ? { service: 'sc' as const, permalink: t.permalink } : {}),
    id: t.id,
    ownerId: t.ownerId,
    key: sc ? `sc_${t.id}` : `${t.ownerId}_${t.id}`,
    ...(t.accessKey ? { accessKey: t.accessKey } : {}),
    artist: t.artist,
    title: t.title,
    duration: t.duration,
    urlFetchedAt: 0,
    ...(t.cover ? { cover: { s: t.cover, m: t.cover, l: t.cover } } : {}),
    explicit: false,
    artists: sc ? [{ id: String(t.ownerId), name: t.artist }] : [{ name: t.artist }],
    playable: true,
    hasLyrics: false,
    liked: false,
  }
}

export function newAlbum(name: string, now: number, by: string): AlbumDoc {
  return { id: randomId(), meta: { name, updatedAt: now, by }, entries: {} }
}

/** The tracks in order (removed ones left out). */
export function liveEntries(d: AlbumDoc): AlbumEntry[] {
  return Object.values(d.entries)
    .filter((e) => !e.removedAt && e.track)
    .sort((x, y) => (x.pos < y.pos ? -1 : x.pos > y.pos ? 1 : x.eid < y.eid ? -1 : x.eid > y.eid ? 1 : 0))
}

/** Adds tracks at the end (or before position `at`), skipping ones already there. */
export function addTracks(d: AlbumDoc, tracks: Track[], now: number, by: string, at?: number): { doc: AlbumDoc; added: number; skipped: 'full' | null } {
  const live = liveEntries(d)
  const present = new Set(live.map((e) => sameKeyOf(e.track!)))
  const next = at !== undefined ? live[at]?.pos : undefined
  let prev = at !== undefined ? live[at - 1]?.pos : live[live.length - 1]?.pos
  let count = live.length
  let added = 0
  let skipped: 'full' | null = null
  const entries = { ...d.entries }
  for (const t of tracks) {
    const k = sameKeyOf(t)
    if (present.has(k)) continue
    if (count >= MAX_TRACKS) {
      skipped = 'full'
      break
    }
    const pos = between(prev, next)
    const eid = randomId()
    entries[eid] = { eid, track: snapshot(t), pos, addedAt: now, updatedAt: now, by }
    present.add(k)
    prev = pos
    count++
    added++
  }
  return { doc: { ...d, entries }, added, skipped }
}

export function removeEntry(d: AlbumDoc, eid: string, now: number, by: string): AlbumDoc {
  if (!d.entries[eid]) return d
  return { ...d, entries: { ...d.entries, [eid]: { eid, pos: '', addedAt: 0, updatedAt: now, by, removedAt: now } } }
}

export function moveEntry(d: AlbumDoc, eid: string, toIndex: number, now: number, by: string): AlbumDoc {
  const e = d.entries[eid]
  if (!e || e.removedAt) return d
  const rest = liveEntries(d).filter((x) => x.eid !== eid)
  const i = Math.max(0, Math.min(toIndex, rest.length))
  const pos = between(rest[i - 1]?.pos, rest[i]?.pos)
  return { ...d, entries: { ...d.entries, [eid]: { ...e, pos, updatedAt: now, by } } }
}

export function renameAlbum(d: AlbumDoc, name: string, now: number, by: string): AlbumDoc {
  return { ...d, meta: { ...d.meta, name, updatedAt: now, by } }
}

export function deleteAlbum(d: AlbumDoc, now: number, by: string): AlbumDoc {
  return { ...d, meta: { ...d.meta, deletedAt: now, updatedAt: now, by } }
}

const newer = <T extends { updatedAt: number; by: string }>(a: T, b: T): T => (b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && b.by > a.by) ? b : a)

export const mergeEntry = (a: AlbumEntry, b: AlbumEntry): AlbumEntry => newer(a, b)

export function mergeAlbum(a: AlbumDoc, b: AlbumDoc): AlbumDoc {
  const entries: Record<string, AlbumEntry> = { ...a.entries }
  for (const [eid, e] of Object.entries(b.entries)) entries[eid] = entries[eid] ? mergeEntry(entries[eid], e) : e
  return { id: a.id, meta: newer(a.meta, b.meta), entries }
}

/** JSON with keys in a fixed order: two equal documents give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export const sameDoc = (a: AlbumDoc, b: AlbumDoc) => canonical(a) === canonical(b)
