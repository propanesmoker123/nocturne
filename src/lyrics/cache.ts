import type { Lyrics } from '../vk/models'

const STORAGE_KEY = 'nocturne:lyrics:v4'
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 400

interface CacheRecord {
  at: number
  lyrics: Lyrics | null
}

type CacheStore = Record<string, CacheRecord>

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

function isExpired(rec: CacheRecord, now: number): boolean {
  const ttl = rec.lyrics === null ? MISS_TTL_MS : HIT_TTL_MS
  return now - rec.at > ttl
}

function readStore(now = Date.now()): CacheStore {
  const ls = storage()
  if (!ls) return {}
  try {
    const raw = ls.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean: CacheStore = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object') continue
      const rec = val as Partial<CacheRecord>
      if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue
      if (rec.lyrics !== null && (typeof rec.lyrics !== 'object' || !Array.isArray(rec.lyrics.lines))) continue
      const normalized: CacheRecord = { at: rec.at, lyrics: rec.lyrics ?? null }
      if (!isExpired(normalized, now)) clean[key] = normalized
    }
    return clean
  } catch {
    return {}
  }
}

function writeStore(store: CacheStore): void {
  const ls = storage()
  if (!ls) return
  const entries = Object.entries(store).sort((a, b) => a[1].at - b[1].at)
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries
  const payload = Object.fromEntries(trimmed)
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    try {
      const half = Object.fromEntries(trimmed.slice(Math.floor(trimmed.length / 2)))
      ls.setItem(STORAGE_KEY, JSON.stringify(half))
    } catch {
      /* ignore unavailable/full storage */
    }
  }
}

export function readCachedLyrics(key: string): Lyrics | null | undefined {
  if (!key) return undefined
  const store = readStore()
  return key in store ? store[key].lyrics : undefined
}

export function writeCachedLyrics(key: string, lyrics: Lyrics | null): void {
  if (!key) return
  const now = Date.now()
  const store = readStore(now)
  store[key] = { at: now, lyrics }
  writeStore(store)
}

export function clearCachedLyrics(key: string): void {
  if (!key) return
  const store = readStore()
  if (!(key in store)) return
  delete store[key]
  writeStore(store)
}
