import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { ScUser } from '../sc/normalize'
import type { User } from '../vk/models'

const VK_SESSION_KEY = 'nocturne:vk-session:v1'
const VK_SNAP_KEY = 'nocturne:vk-snap:v1'
const SC_SESSION_KEY = 'nocturne:sc-session:v1'
const SC_SNAP_KEY = 'nocturne:sc-snap:v1'

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
const SNAP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SNAP_ENTRIES = 24
const MAX_TOTAL_CHARS = 850_000
const FLUSH_DEBOUNCE_MS = 600

const VK_SNAPSHOT_PREFIXES = new Set([
  'catalog',
  'tracks',
  'playlists',
  'friends',
  'section',
  'playlist',
  'playlist-tracks',
  'playlist-cover-tracks',
])

const SC_SNAPSHOT_PREFIXES = new Set([
  'sc-selections',
  'sc-stream',
  'sc-feed',
  'sc-feed-people',
  'sc-likes',
  'sc-my-playlists',
  'sc-playlist-likes',
  'sc-followings',
  'sc-playlist',
])

export interface VkSessionSnapshot {
  signedIn: boolean
  userId: number
  user: User | null
  at: number
}

export interface ScSessionSnapshot {
  signedIn: boolean
  user: ScUser | null
  at: number
}

interface SnapRecord {
  key: QueryKey
  infinite?: boolean
  data: unknown
  at: number
}

type SnapStore = Record<string, SnapRecord>

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

function serializeKey(key: QueryKey): string {
  return JSON.stringify(key)
}

function isInfiniteShape(v: unknown): v is { pages: unknown[]; pageParams: unknown[] } {
  return !!v && typeof v === 'object' && Array.isArray((v as { pages?: unknown }).pages) && Array.isArray((v as { pageParams?: unknown }).pageParams)
}

export function isVkSnapshotKey(key: QueryKey): boolean {
  return Array.isArray(key) && typeof key[0] === 'string' && VK_SNAPSHOT_PREFIXES.has(key[0])
}

export function isScSnapshotKey(key: QueryKey): boolean {
  return Array.isArray(key) && typeof key[0] === 'string' && SC_SNAPSHOT_PREFIXES.has(key[0])
}

export function readVkSessionSnapshot(now = Date.now()): VkSessionSnapshot | null {
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(VK_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<VkSessionSnapshot> | null
    if (!parsed || typeof parsed !== 'object' || parsed.signedIn !== true) return null
    if (typeof parsed.userId !== 'number' || !Number.isFinite(parsed.userId) || parsed.userId <= 0) return null
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at) || now - parsed.at > SESSION_TTL_MS) return null
    const u = parsed.user
    const user: User | null =
      u && typeof u === 'object' && typeof u.id === 'number' && typeof u.name === 'string'
        ? { id: u.id, name: u.name, ...(typeof u.photo === 'string' ? { photo: u.photo } : {}) }
        : null
    return { signedIn: true, userId: parsed.userId, user, at: parsed.at }
  } catch {
    return null
  }
}

export function writeVkSessionSnapshot(signedIn: boolean, userId: number, user: User | null): void {
  const ls = storage()
  if (!ls) return
  if (!signedIn || userId <= 0) {
    try {
      ls.removeItem(VK_SESSION_KEY)
    } catch {}
    return
  }
  const cleanUser: User | null = user ? { id: user.id, name: user.name, ...(user.photo ? { photo: user.photo } : {}) } : null
  const payload: VkSessionSnapshot = { signedIn: true, userId, user: cleanUser, at: Date.now() }
  try {
    ls.setItem(VK_SESSION_KEY, JSON.stringify(payload))
  } catch {}
}

export function readScSessionSnapshot(now = Date.now()): ScSessionSnapshot | null {
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(SC_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ScSessionSnapshot> | null
    if (!parsed || typeof parsed !== 'object' || parsed.signedIn !== true) return null
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at) || now - parsed.at > SESSION_TTL_MS) return null
    const u = parsed.user
    const user: ScUser | null =
      u && typeof u === 'object' && typeof u.id === 'number' && typeof u.name === 'string'
        ? {
            id: u.id,
            name: u.name,
            avatar: typeof u.avatar === 'string' ? u.avatar : null,
            permalink: typeof u.permalink === 'string' ? u.permalink : null,
          }
        : null
    return { signedIn: true, user, at: parsed.at }
  } catch {
    return null
  }
}

export function writeScSessionSnapshot(signedIn: boolean, user: ScUser | null): void {
  const ls = storage()
  if (!ls) return
  if (!signedIn) {
    try {
      ls.removeItem(SC_SESSION_KEY)
    } catch {}
    return
  }
  const cleanUser: ScUser | null = user
    ? { id: user.id, name: user.name, avatar: user.avatar ?? null, permalink: user.permalink ?? null }
    : null
  const payload: ScSessionSnapshot = { signedIn: true, user: cleanUser, at: Date.now() }
  try {
    ls.setItem(SC_SESSION_KEY, JSON.stringify(payload))
  } catch {}
}

let memStorage: Storage | null = null
const memStores = new Map<string, SnapStore>()
const dirtyKeys = new Set<string>()
const flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
let unloadHooked = false

function resetMemoryIfStorageChanged(ls: Storage | null): void {
  if (ls === memStorage) return
  for (const t of flushTimers.values()) clearTimeout(t)
  flushTimers.clear()
  dirtyKeys.clear()
  memStores.clear()
  memStorage = ls
}

function parseSnapStore(ls: Storage, storageKey: string, now: number): SnapStore {
  try {
    const raw = ls.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean: SnapStore = {}
    for (const [id, rec] of Object.entries(parsed)) {
      if (!rec || typeof rec !== 'object') continue
      const r = rec as Partial<SnapRecord>
      if (!Array.isArray(r.key) || typeof r.at !== 'number' || !Number.isFinite(r.at)) continue
      if (now - r.at > SNAP_TTL_MS || r.data === undefined) continue
      clean[id] = { key: r.key as QueryKey, infinite: Boolean(r.infinite), data: r.data, at: r.at }
    }
    return clean
  } catch {
    return {}
  }
}

function getSnapStore(storageKey: string, now = Date.now()): SnapStore | null {
  const ls = storage()
  resetMemoryIfStorageChanged(ls)
  if (!ls) return null
  let store = memStores.get(storageKey)
  if (!store) {
    store = parseSnapStore(ls, storageKey, now)
    memStores.set(storageKey, store)
  }
  return store
}

function flushKey(storageKey: string): void {
  const t = flushTimers.get(storageKey)
  if (t !== undefined) {
    clearTimeout(t)
    flushTimers.delete(storageKey)
  }
  if (!dirtyKeys.has(storageKey)) return
  dirtyKeys.delete(storageKey)
  const ls = storage()
  if (!ls || ls !== memStorage) return
  const store = memStores.get(storageKey)
  if (!store) return
  let entries = Object.entries(store).sort((a, b) => a[1].at - b[1].at)
  if (entries.length > MAX_SNAP_ENTRIES) {
    entries = entries.slice(entries.length - MAX_SNAP_ENTRIES)
  }
  while (entries.length > 0) {
    const raw = JSON.stringify(Object.fromEntries(entries))
    if (raw.length <= MAX_TOTAL_CHARS) {
      try {
        ls.setItem(storageKey, raw)
      } catch {
        if (entries.length > 1) {
          entries.shift()
          continue
        }
      }
      return
    }
    entries.shift()
  }
}

export function flushWarmCache(): void {
  for (const key of [...dirtyKeys]) flushKey(key)
}

function scheduleFlush(storageKey: string): void {
  dirtyKeys.add(storageKey)
  if (!unloadHooked && typeof window !== 'undefined') {
    unloadHooked = true
    window.addEventListener('pagehide', flushWarmCache)
    window.addEventListener('beforeunload', flushWarmCache)
  }
  const prev = flushTimers.get(storageKey)
  if (prev !== undefined) clearTimeout(prev)
  flushTimers.set(
    storageKey,
    setTimeout(() => {
      flushTimers.delete(storageKey)
      flushKey(storageKey)
    }, FLUSH_DEBOUNCE_MS),
  )
}

function writeQuerySnapshot(storageKey: string, key: QueryKey, data: unknown, opts?: { infinite?: boolean }): void {
  if (data === undefined || data === null) return
  let infinite = Boolean(opts?.infinite)
  let payload = data
  if (isInfiniteShape(data)) {
    if (data.pages.length === 0) return
    infinite = true
    payload = { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
  }
  const now = Date.now()
  const store = getSnapStore(storageKey, now)
  if (!store) return
  store[serializeKey(key)] = {
    key,
    infinite,
    data: payload,
    at: now,
  }
  const entries = Object.entries(store)
  if (entries.length > MAX_SNAP_ENTRIES) {
    entries.sort((a, b) => a[1].at - b[1].at)
    const drop = entries.length - MAX_SNAP_ENTRIES
    for (let i = 0; i < drop; i++) delete store[entries[i]![0]]
  }
  scheduleFlush(storageKey)
}

function hydrateSnapshots(storageKey: string, qc: QueryClient, now = Date.now()): number {
  const store = getSnapStore(storageKey, now)
  if (!store) return 0
  let hydrated = 0
  for (const [id, rec] of Object.entries(store)) {
    if (now - rec.at > SNAP_TTL_MS) {
      delete store[id]
      continue
    }
    if (qc.getQueryData(rec.key) !== undefined) continue
    const value = rec.infinite
      ? isInfiniteShape(rec.data)
        ? rec.data
        : { pages: [rec.data], pageParams: [undefined] }
      : rec.data
    qc.setQueryData(rec.key, value, { updatedAt: now })
    hydrated++
  }
  return hydrated
}

export function writeVkQuerySnapshot(key: QueryKey, data: unknown, opts?: { infinite?: boolean }): void {
  writeQuerySnapshot(VK_SNAP_KEY, key, data, opts)
}

export function hydrateVkSnapshots(qc: QueryClient, now = Date.now()): number {
  return hydrateSnapshots(VK_SNAP_KEY, qc, now)
}

export function markVkSnapshotsStale(qc: QueryClient): void {
  void qc.invalidateQueries({ predicate: (q) => isVkSnapshotKey(q.queryKey) })
}

export function clearVkCache(): void {
  const t = flushTimers.get(VK_SNAP_KEY)
  if (t !== undefined) {
    clearTimeout(t)
    flushTimers.delete(VK_SNAP_KEY)
  }
  dirtyKeys.delete(VK_SNAP_KEY)
  const ls = storage()
  resetMemoryIfStorageChanged(ls)
  memStores.set(VK_SNAP_KEY, {})
  if (!ls) return
  try {
    ls.removeItem(VK_SESSION_KEY)
    ls.removeItem(VK_SNAP_KEY)
  } catch {}
}

export function writeScQuerySnapshot(key: QueryKey, data: unknown, opts?: { infinite?: boolean }): void {
  writeQuerySnapshot(SC_SNAP_KEY, key, data, opts)
}

export function hydrateScSnapshots(qc: QueryClient, now = Date.now()): number {
  return hydrateSnapshots(SC_SNAP_KEY, qc, now)
}

export function markScSnapshotsStale(qc: QueryClient): void {
  void qc.invalidateQueries({ predicate: (q) => isScSnapshotKey(q.queryKey) })
}

export function clearScCache(): void {
  const t = flushTimers.get(SC_SNAP_KEY)
  if (t !== undefined) {
    clearTimeout(t)
    flushTimers.delete(SC_SNAP_KEY)
  }
  dirtyKeys.delete(SC_SNAP_KEY)
  const ls = storage()
  resetMemoryIfStorageChanged(ls)
  memStores.set(SC_SNAP_KEY, {})
  if (!ls) return
  try {
    ls.removeItem(SC_SESSION_KEY)
    ls.removeItem(SC_SNAP_KEY)
  } catch {}
}

/** Persists successful VK and SoundCloud queries in the background for instant next-launch warm hydration. */
export function installWarmCacheObserver(qc: QueryClient): () => void {
  const lastSavedAt = new Map<string, number>()
  // Seed from already-hydrated queries so startup hydration does not trigger redundant writes.
  for (const q of qc.getQueryCache().getAll()) {
    if (q.state.status === 'success' && q.state.dataUpdatedAt) {
      if (isVkSnapshotKey(q.queryKey) || isScSnapshotKey(q.queryKey)) {
        lastSavedAt.set(serializeKey(q.queryKey), q.state.dataUpdatedAt)
      }
    }
  }
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return
    const q = event.query
    if (q.state.status !== 'success' || q.state.data === undefined) return
    const key = q.queryKey
    const isVk = isVkSnapshotKey(key)
    const isSc = !isVk && isScSnapshotKey(key)
    if (!isVk && !isSc) return
    const updatedAt = q.state.dataUpdatedAt
    if (!updatedAt) return
    const id = serializeKey(key)
    if (lastSavedAt.get(id) === updatedAt) return
    lastSavedAt.set(id, updatedAt)
    if (isVk) writeVkQuerySnapshot(key, q.state.data)
    else writeScQuerySnapshot(key, q.state.data)
  })
}
