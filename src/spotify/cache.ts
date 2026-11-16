import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { spKeys } from './queries'

const SESSION_KEY = 'nocturne:sp-session:v1'
const SNAP_KEY = 'nocturne:sp-snap:v1'
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000
const SNAP_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_SNAP_ENTRIES = 20
const MAX_TOTAL_CHARS = 750_000

export interface SpotifySessionSnapshot {
  signedIn: boolean
  user: { id: string; name: string; avatar?: string } | null
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

export function readSpotifySessionSnapshot(now = Date.now()): SpotifySessionSnapshot | null {
  const ls = storage()
  if (!ls) return null
  try {
    const raw = ls.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<SpotifySessionSnapshot> | null
    if (!parsed || typeof parsed !== 'object' || parsed.signedIn !== true) return null
    if (typeof parsed.at !== 'number' || !Number.isFinite(parsed.at) || now - parsed.at > SESSION_TTL_MS) return null
    const u = parsed.user
    const user = u && typeof u === 'object' && typeof u.id === 'string' && typeof u.name === 'string'
      ? { id: u.id, name: u.name, avatar: typeof u.avatar === 'string' ? u.avatar : undefined }
      : null
    return { signedIn: true, user, at: parsed.at }
  } catch {
    return null
  }
}

export function writeSpotifySessionSnapshot(signedIn: boolean, user: { id: string; name: string; avatar?: string } | null): void {
  const ls = storage()
  if (!ls) return
  if (!signedIn) {
    try {
      ls.removeItem(SESSION_KEY)
    } catch {}
    return
  }
  const cleanUser = user ? { id: user.id, name: user.name, avatar: user.avatar } : null
  const payload: SpotifySessionSnapshot = { signedIn: true, user: cleanUser, at: Date.now() }
  try {
    ls.setItem(SESSION_KEY, JSON.stringify(payload))
  } catch {}
}

function readSnapStore(now = Date.now()): SnapStore {
  const ls = storage()
  if (!ls) return {}
  try {
    const raw = ls.getItem(SNAP_KEY)
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

function writeSnapStore(store: SnapStore): void {
  const ls = storage()
  if (!ls) return
  let entries = Object.entries(store).sort((a, b) => a[1].at - b[1].at)
  if (entries.length > MAX_SNAP_ENTRIES) {
    entries = entries.slice(entries.length - MAX_SNAP_ENTRIES)
  }
  while (entries.length > 0) {
    const raw = JSON.stringify(Object.fromEntries(entries))
    if (raw.length <= MAX_TOTAL_CHARS || entries.length === 1) {
      try {
        ls.setItem(SNAP_KEY, raw)
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

export function writeSpotifyQuerySnapshot(key: QueryKey, data: unknown, opts?: { infinite?: boolean }): void {
  if (data === undefined || data === null) return
  const now = Date.now()
  const store = readSnapStore(now)
  const id = serializeKey(key)
  store[id] = {
    key,
    infinite: Boolean(opts?.infinite),
    data,
    at: now,
  }
  writeSnapStore(store)
}

/** Preloads persisted Spotify snapshots into React Query with stale updatedAt so UI paints instantly and revalidates in background. */
export function hydrateSpotifySnapshots(qc: QueryClient, now = Date.now()): number {
  const store = readSnapStore(now)
  let hydrated = 0
  for (const rec of Object.values(store)) {
    // Only hydrate if not already populated in memory
    if (qc.getQueryData(rec.key) !== undefined) continue
    const value = rec.infinite ? { pages: [rec.data], pageParams: [0] } : rec.data
    // Mark older than 60s staleTime so useQuery displays immediately yet refreshes cleanly in background
    const updatedAt = Math.min(rec.at, Math.max(1, now - 120_000))
    qc.setQueryData(rec.key, value, { updatedAt })
    hydrated++
  }
  return hydrated
}

export function clearSpotifyCache(): void {
  const ls = storage()
  if (!ls) return
  try {
    ls.removeItem(SESSION_KEY)
    ls.removeItem(SNAP_KEY)
  } catch {}
}

export function snapshotKeysForWarmup() {
  return [spKeys.home(), spKeys.myPlaylists(), spKeys.likes()]
}
