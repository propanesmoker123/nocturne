import type { Lyrics } from '../vk/models'

const STORAGE_KEY = 'nocturne:lyrics:v4'
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MISS_TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 400
const FLUSH_DEBOUNCE_MS = 500

interface CacheRecord {
  at: number
  lyrics: Lyrics | null
}

type CacheStore = Record<string, CacheRecord>

let memStore: CacheStore | null = null
let memStorage: Storage | null = null
let flushTimer: ReturnType<typeof setTimeout> | null = null
let dirty = false
let unloadHooked = false

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

function parseFromStorage(ls: Storage, now: number): CacheStore {
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

function getStore(now = Date.now()): CacheStore | null {
  const ls = storage()
  if (!ls) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    memStore = null
    memStorage = null
    dirty = false
    return null
  }
  if (ls !== memStorage || !memStore) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    dirty = false
    memStorage = ls
    memStore = parseFromStorage(ls, now)
  }
  return memStore
}

function trimStore(store: CacheStore, now: number): void {
  const keys = Object.keys(store)
  for (const k of keys) {
    if (isExpired(store[k]!, now)) delete store[k]
  }
  const entries = Object.entries(store)
  if (entries.length <= MAX_ENTRIES) return
  entries.sort((a, b) => a[1].at - b[1].at)
  const drop = entries.length - MAX_ENTRIES
  for (let i = 0; i < drop; i++) {
    delete store[entries[i]![0]]
  }
}

export function flushLyricsCache(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (!dirty || !memStore) return
  const ls = storage()
  if (!ls || ls !== memStorage) {
    dirty = false
    return
  }
  dirty = false
  const entries = Object.entries(memStore).sort((a, b) => a[1].at - b[1].at)
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

function scheduleFlush(): void {
  dirty = true
  if (!unloadHooked && typeof window !== 'undefined') {
    unloadHooked = true
    window.addEventListener('pagehide', flushLyricsCache)
    window.addEventListener('beforeunload', flushLyricsCache)
  }
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(flushLyricsCache, FLUSH_DEBOUNCE_MS)
}

export function readCachedLyrics(key: string): Lyrics | null | undefined {
  if (!key) return undefined
  const now = Date.now()
  const store = getStore(now)
  if (!store || !(key in store)) return undefined
  const rec = store[key]!
  if (isExpired(rec, now)) {
    delete store[key]
    scheduleFlush()
    return undefined
  }
  return rec.lyrics
}

export function writeCachedLyrics(key: string, lyrics: Lyrics | null): void {
  if (!key) return
  const now = Date.now()
  const store = getStore(now)
  if (!store) return
  store[key] = { at: now, lyrics }
  if (Object.keys(store).length > MAX_ENTRIES) {
    trimStore(store, now)
  }
  scheduleFlush()
}

export function clearCachedLyrics(key: string): void {
  if (!key) return
  const store = getStore()
  if (!store || !(key in store)) return
  delete store[key]
  scheduleFlush()
}
