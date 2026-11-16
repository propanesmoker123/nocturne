import { queryClient } from '../app/queryClient'
import { prefetchLyrics } from '../app/lyrics'
import { invoke, isTauri } from '../lib/tauri'
import * as vk from '../vk/api'
import * as sc from '../sc/api'
import * as spotify from '../spotify/api'
import type { ScPlaybackSource } from '../sc/playback'
import { serviceOf, type Track } from '../vk/models'
import { needsFreshUrl } from './logic'
import * as waveform from './waveform'

export const MAX_PRELOAD_BYTES = 24 * 1024 * 1024
const SC_SOURCE_TTL_MS = 4 * 60 * 1000

export interface PreloadedSource {
  url: string
  fetchedAt: number
  scSource?: ScPlaybackSource
}

interface ParsedHls {
  variants: string[]
  media: string[]
  initAndKeys: string[]
  segments: string[]
}

let generation = 0
let activeKey: string | null = null
let cachedBytes = 0
const bytesCache = new Map<string, ArrayBuffer>()
const blobBytes = new Map<string, ArrayBuffer>()
const inflight = new Map<string, Promise<ArrayBuffer>>()
const sources = new Map<string, PreloadedSource>()

function resolveHttpUrl(ref: string, baseUrl: string): string | null {
  try {
    const abs = new URL(ref.trim(), baseUrl).toString()
    return /^https?:\/\//i.test(abs) ? abs : null
  } catch {
    return null
  }
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of urls) {
    if (!seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  return out
}

/** Extracts variant/audio playlists, keys, init maps, and segment URLs from an M3U8 playlist. */
export function parseHlsManifest(playlistText: string, baseUrl: string): ParsedHls {
  const variants: { url: string; bw: number }[] = []
  const media: string[] = []
  const initAndKeys: string[] = []
  const segments: string[] = []
  let pendingBw: number | null = null

  for (const raw of playlistText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const m = /BANDWIDTH=(\d+)/i.exec(line)
        pendingBw = m ? Number(m[1]) : 0
        continue
      }
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const uri = /URI="([^"]+)"/i.exec(line)?.[1]
        const url = uri ? resolveHttpUrl(uri, baseUrl) : null
        if (url && (!/TYPE=/i.test(line) || /TYPE=AUDIO/i.test(line))) media.push(url)
        continue
      }
      if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-MAP:')) {
        const uri = /URI="([^"]+)"/i.exec(line)?.[1]
        const url = uri ? resolveHttpUrl(uri, baseUrl) : null
        if (url) initAndKeys.push(url)
      }
      continue
    }
    const url = resolveHttpUrl(line, baseUrl)
    if (pendingBw !== null) {
      if (url) variants.push({ url, bw: pendingBw })
      pendingBw = null
    } else if (url) {
      segments.push(url)
    }
  }

  variants.sort((a, b) => b.bw - a.bw)
  return {
    variants: dedupeUrls(variants.map((v) => v.url)),
    media: dedupeUrls(media),
    initAndKeys: dedupeUrls(initAndKeys),
    segments: dedupeUrls(segments),
  }
}

function storeBytes(gen: number, url: string, buf: ArrayBuffer): boolean {
  if (gen !== generation) return false
  if (bytesCache.has(url)) return true
  if (cachedBytes + buf.byteLength > MAX_PRELOAD_BYTES) return false
  bytesCache.set(url, buf)
  cachedBytes += buf.byteLength
  return true
}

function fetchPreloadBytes(gen: number, url: string): Promise<ArrayBuffer> {
  const existing = bytesCache.get(url)
  if (existing) return Promise.resolve(existing)
  const pending = inflight.get(url)
  if (pending) return pending
  const p = invoke<ArrayBuffer>('proxy_fetch', { url })
    .then((buf) => {
      storeBytes(gen, url, buf)
      return buf
    })
    .finally(() => {
      if (gen === generation) inflight.delete(url)
    })
  inflight.set(url, p)
  return p
}

function warmCoverImages(t: Track) {
  if (typeof Image === 'undefined' || !t.cover) return
  for (const src of [t.cover.m, t.cover.l]) if (src) new Image().src = src
}

async function preloadHlsStream(gen: number, manifestUrl: string) {
  const buf = await fetchPreloadBytes(gen, manifestUrl)
  if (gen !== generation) return
  const parsed = parseHlsManifest(new TextDecoder().decode(buf), manifestUrl)

  const subPlaylists = parsed.variants.length
    ? [parsed.variants[0], ...parsed.media.slice(0, 1)]
    : []

  if (subPlaylists.length) {
    for (const subUrl of subPlaylists) {
      if (gen !== generation || cachedBytes >= MAX_PRELOAD_BYTES) return
      const subBuf = await fetchPreloadBytes(gen, subUrl)
      if (gen !== generation) return
      const subParsed = parseHlsManifest(new TextDecoder().decode(subBuf), subUrl)
      for (const u of [...subParsed.initAndKeys, ...subParsed.segments]) {
        if (gen !== generation || cachedBytes >= MAX_PRELOAD_BYTES) return
        try {
          await fetchPreloadBytes(gen, u)
        } catch {
          // Stop on segment failure without breaking playback; hls.js can still retry live.
          return
        }
      }
    }
    return
  }

  for (const u of [...parsed.initAndKeys, ...parsed.segments]) {
    if (gen !== generation || cachedBytes >= MAX_PRELOAD_BYTES) return
    try {
      await fetchPreloadBytes(gen, u)
    } catch {
      return
    }
  }
}

async function warmTrackLyrics(gen: number, track: Track): Promise<void> {
  if (gen !== generation) return
  try {
    const res = await prefetchLyrics(track)
    if (gen === generation && res !== undefined) {
      queryClient.setQueryData(['lyrics', track.key], res)
    }
  } catch {
    // Lyrics warm-up failures must remain silent and never block audio preloading.
  }
}

async function preloadTrack(gen: number, track: Track) {
  warmCoverImages(track)
  const lyricsTask = warmTrackLyrics(gen, track)
  const svc = serviceOf(track)
  if (svc === 'spotify') {
    const spId = track.spotifyId || (track.url?.startsWith('spotify:track:') ? track.url.slice('spotify:track:'.length) : '')
    const tasks: Promise<unknown>[] = [lyricsTask]
    if (spId) {
      tasks.push(
        waveform.warmSpotifyWaveform?.(track.key, spId, track.duration),
        spotify.warmSpotifyTrack?.(spId),
      )
    }
    await Promise.allSettled(tasks)
    return
  }

  let streamUrl = track.url ?? ''
  let fetchedAt = track.urlFetchedAt
  let scSource: ScPlaybackSource | undefined

  try {
    if (svc === 'sc') {
      scSource = await sc.streamSource(track)
      if (gen !== generation) return
      streamUrl = scSource.url
      fetchedAt = Date.now()
      sources.set(track.key, { url: streamUrl, fetchedAt, scSource })
      if (scSource.waveformUrl && scSource.drm) {
        void waveform.warmProviderWaveform?.(track.key, scSource.waveformUrl)
      }
    } else if (!streamUrl || needsFreshUrl(track, Date.now())) {
      const [fresh] = await vk.getByIds([track])
      if (gen !== generation) return
      if (!fresh?.url || !fresh.playable) return
      streamUrl = fresh.url
      fetchedAt = fresh.urlFetchedAt
      sources.set(track.key, { url: streamUrl, fetchedAt })
    } else {
      sources.set(track.key, { url: streamUrl, fetchedAt })
    }
  } catch {
    return
  }

  if (gen !== generation || !streamUrl || !isTauri()) return
  try {
    if (streamUrl.includes('.m3u8')) {
      await preloadHlsStream(gen, streamUrl)
    } else {
      await fetchPreloadBytes(gen, streamUrl)
    }
  } catch {
    // Background preload failures must remain silent and never interfere with the active track.
  }
  await lyricsTask
}

/** Cancels any active preload and frees all cached source/byte buffers. */
export function clearPreload() {
  generation++
  activeKey = null
  cachedBytes = 0
  bytesCache.clear()
  blobBytes.clear()
  inflight.clear()
  sources.clear()
}

/** Drops any preloaded data unless it belongs to `keepKey` (the track about to play). */
export function clearPreloadExcept(keepKey: string) {
  if (activeKey === keepKey) return
  clearPreload()
}

/** Keeps at most one next track preloaded; cancels and evicts immediately when `track` changes. */
export function syncNextPreload(track: Track | null | undefined) {
  if (!track || !track.playable) {
    if (activeKey !== null) clearPreload()
    return
  }
  if (activeKey === track.key) return
  clearPreload()
  activeKey = track.key
  const gen = generation
  void preloadTrack(gen, track)
}

/** Pops a preloaded stream URL / SoundCloud source if still fresh; retries never reuse consumed entries. */
export function takePreloadedSource(track: Track, now = Date.now()): PreloadedSource | null {
  const entry = sources.get(track.key)
  if (!entry) return null
  sources.delete(track.key)
  if (track.urlFetchedAt === 0 && entry.fetchedAt <= 0) return null
  const svc = serviceOf(track)
  if (svc === 'sc') {
    return now - entry.fetchedAt < SC_SOURCE_TTL_MS ? entry : null
  }
  return !needsFreshUrl({ ...track, url: entry.url, urlFetchedAt: entry.fetchedAt }, now) ? entry : null
}

/** Returns already-cached or currently downloading bytes for `TauriLoader`. */
export function getPreloadedResource(url: string): ArrayBuffer | Promise<ArrayBuffer> | null {
  const ready = bytesCache.get(url)
  if (ready) return ready
  return inflight.get(url) ?? null
}

/** Builds a one-shot `blob:` URL only when a direct audio file has finished preloading completely. */
export function takePreloadedBlobUrl(url: string): string | null {
  const buf = bytesCache.get(url)
  if (!buf) return null
  bytesCache.delete(url)
  cachedBytes = Math.max(0, cachedBytes - buf.byteLength)
  let mime = ''
  try {
    const p = new URL(url).pathname.toLowerCase()
    if (p.endsWith('.mp3')) mime = 'audio/mpeg'
    else if (p.endsWith('.m4a') || p.endsWith('.mp4')) mime = 'audio/mp4'
    else if (p.endsWith('.ogg') || p.endsWith('.opus')) mime = 'audio/ogg'
    else if (p.endsWith('.wav')) mime = 'audio/wav'
  } catch {}
  const blobUrl = URL.createObjectURL(mime ? new Blob([buf], { type: mime }) : new Blob([buf]))
  blobBytes.set(blobUrl, buf)
  if (blobBytes.size > 3) blobBytes.delete(blobBytes.keys().next().value!)
  return blobUrl
}

/** Pops raw bytes associated with a `blob:` URL created by `takePreloadedBlobUrl`. */
export function takePreloadedBlobBytes(url: string): ArrayBuffer | null {
  const buf = blobBytes.get(url) ?? null
  if (buf) blobBytes.delete(url)
  return buf
}

export function getPreloadDebugState() {
  return {
    activeKey,
    cachedBytes,
    entries: bytesCache.size,
    inflight: inflight.size,
    sources: sources.size,
  }
}
