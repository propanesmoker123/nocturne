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

/** A picture of the album's own, chosen by someone who has it; merges by itself (a rename does not touch it). */
export interface AlbumCover {
  /** a small picture as a `data:` address; gone once the cover was taken off */
  image?: string
  updatedAt: number
  by: string
}

export interface AlbumDoc {
  id: string
  meta: AlbumMeta
  entries: Record<string, AlbumEntry>
  cover?: AlbumCover
}

export const BUCKETS = 16
export const MAX_TRACKS = 1000

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const WIDTH = 4
const pad = (k: string) => (k + '0'.repeat(WIDTH)).slice(0, WIDTH)

/** `k` (WIDTH digits) as a number moved by one, never ending in 0; null past either end. */
function step(k: string, dir: 1 | -1): string | null {
  const d = [...k].map((c) => DIGITS.indexOf(c))
  do {
    let i = d.length - 1
    for (; i >= 0; i--) {
      d[i] += dir
      if (d[i] >= 0 && d[i] < DIGITS.length) break
      d[i] = dir === 1 ? 0 : DIGITS.length - 1
    }
    if (i < 0) return null
  } while (d[d.length - 1] === 0)
  return d.map((x) => DIGITS[x]).join('')
}

/**
 * A position key strictly between `a` and `b` (either may be open). Keys compare as strings and
 * never end in 0 (so there is always room before one). Adding at either end counts on in four
 * digits — a million steps without the key growing — and only a place in the middle halves a gap.
 */
export function between(a?: string, b?: string): string {
  if (b === undefined) return (a === undefined ? 'i' : step(pad(a), 1)) ?? midpoint(a, b)
  if (a === undefined) return step(pad(b), -1) ?? midpoint(a, b)
  return midpoint(a, b)
}

function midpoint(a?: string, b?: string): string {
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

// What an album's track may carry, the same for what is kept here and what is read from relays.
export const MAX_TEXT = 300
export const MAX_DURATION = 36_000
export const okAccessKey = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(v)
/** Only VK's and SoundCloud's image servers: a cover from anywhere else would tell that server who looks. */
export const okCover = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 1000 && /^https:\/\/([a-z0-9-]+\.)+(userapi\.com|vkuserphoto\.ru|vkuser\.net|vk-cdn\.net|sndcdn\.com)\//.test(v)
export const okPermalink = (v: unknown): v is string => typeof v === 'string' && v.length <= 500 && /^https:\/\/([a-z0-9-]+\.)*soundcloud\.com\//.test(v)
/** The longest cover, whole `data:` address: its record still fits under the relays' 60 KB. */
export const MAX_IMAGE = 48_000
/** The widest a cover from elsewhere may say it is: ours are 320 px; a few bytes may claim gigabytes of pixels. */
export const MAX_SIDE = 1024

/** An album's own picture: a small webp, jpeg or png carried inside the album (never an address to fetch), of a sane size. */
export function okImage(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_IMAGE || !/^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) return false
  const size = imageSize(v)
  return !!size && size.w > 0 && size.h > 0 && size.w <= MAX_SIDE && size.h <= MAX_SIDE
}

/** The pixel size a picture's header claims (PNG, WebP, JPEG, as its `data:` type says); null when it cannot be read. */
export function imageSize(dataUrl: string): { w: number; h: number } | null {
  const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/]*)/.exec(dataUrl)
  if (!m) return null
  let b: Uint8Array
  try {
    const text = m[2].slice(0, m[2].length - (m[2].length % 4))
    b = Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0))
  const be16 = (i: number) => (b[i] << 8) | b[i + 1]
  const be32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  const le16 = (i: number) => b[i] | (b[i + 1] << 8)
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  const le32 = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
  if (m[1] === 'png') {
    if (b.length < 24 || be32(0) !== 0x89504e47 || be32(4) !== 0x0d0a1a0a || !at(12, 'IHDR')) return null
    return { w: be32(16), h: be32(20) }
  }
  if (m[1] === 'webp') {
    if (b.length < 30 || !at(0, 'RIFF') || !at(8, 'WEBP')) return null
    if (at(12, 'VP8X')) return { w: le24(24) + 1, h: le24(27) + 1 }
    if (at(12, 'VP8L') && b[20] === 0x2f) {
      const bits = le32(21)
      return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 }
    }
    if (at(12, 'VP8 ') && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff }
    return null
  }
  // JPEG: walk the segments to the frame header (SOF0…SOF15 but DHT, JPG and DAC)
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2
      continue
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: be16(i + 7), h: be16(i + 5) }
    if (marker === 0xda || marker === 0xd9) return null
    i += 2 + be16(i + 2)
  }
  return null
}

export function snapshot(t: Track): AlbumTrack {
  const sc = t.service === 'sc'
  const cover = t.cover?.m
  return {
    ...(sc ? { service: 'sc' as const } : {}),
    id: t.id,
    ownerId: t.ownerId,
    ...(!sc && okAccessKey(t.accessKey) ? { accessKey: t.accessKey } : {}),
    title: t.title.slice(0, MAX_TEXT),
    artist: t.artist.slice(0, MAX_TEXT),
    duration: Math.min(Math.max(0, Number.isFinite(t.duration) ? t.duration : 0), MAX_DURATION),
    ...(okCover(cover) ? { cover } : {}),
    ...(sc && okPermalink(t.permalink) ? { permalink: t.permalink } : {}),
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

/** What an album shows as its picture: its own cover, else four track covers, else the first one. */
export function albumArt(d: AlbumDoc): { src?: string; mosaic?: string[] } {
  if (d.cover?.image) return { src: d.cover.image }
  const covers = liveEntries(d)
    .map((e) => e.track!.cover)
    .filter((u): u is string => !!u)
    .slice(0, 4)
  if (covers.length >= 4) return { mosaic: covers }
  return covers[0] ? { src: covers[0] } : {}
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
  return { ...d, meta: { ...d.meta, name, updatedAt: after(d.meta.updatedAt, now), by } }
}

/** Sets the album's own picture (`undefined` takes it off: the track covers show again). */
export function setAlbumCover(d: AlbumDoc, image: string | undefined, now: number, by: string): AlbumDoc {
  // later than what is there, even when that came from a clock ahead (or someone's future): a change here must win
  return { ...d, cover: { ...(image ? { image } : {}), updatedAt: after(d.cover?.updatedAt, now), by } }
}

/** `now`, or just after `t` when `t` is not behind. */
const after = (t: number | undefined, now: number) => Math.max(now, (t ?? 0) + 1)

export function deleteAlbum(d: AlbumDoc, now: number, by: string): AlbumDoc {
  const at = after(d.meta.updatedAt, now)
  // the picture goes too: a deleted album is published again for long, and should be small
  const cover = d.cover?.image ? setAlbumCover(d, undefined, now, by).cover : d.cover
  return { ...d, meta: { ...d.meta, deletedAt: at, updatedAt: at, by }, ...(cover ? { cover } : {}) }
}

const newer = <T extends { updatedAt: number; by: string }>(a: T, b: T): T => (b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && b.by > a.by) ? b : a)

/** Same time and device (only a forged copy): the picture itself decides, the same on every device. */
const newerCover = (a: AlbumCover, b: AlbumCover): AlbumCover => (a.updatedAt === b.updatedAt && a.by === b.by ? ((b.image ?? '') > (a.image ?? '') ? b : a) : newer(a, b))

/** A removal wins over any change to the entry (ids are never used again, so nothing undoes it). */
export const mergeEntry = (a: AlbumEntry, b: AlbumEntry): AlbumEntry => (a.removedAt && !b.removedAt ? a : b.removedAt && !a.removedAt ? b : newer(a, b))

export function mergeAlbum(a: AlbumDoc, b: AlbumDoc): AlbumDoc {
  const entries: Record<string, AlbumEntry> = { ...a.entries }
  for (const [eid, e] of Object.entries(b.entries)) entries[eid] = entries[eid] ? mergeEntry(entries[eid], e) : e
  const cover = a.cover && b.cover ? newerCover(a.cover, b.cover) : (a.cover ?? b.cover)
  return { id: a.id, meta: newer(a.meta, b.meta), entries, ...(cover ? { cover } : {}) }
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
