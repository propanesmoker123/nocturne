import { invoke, isTauri } from '../lib/tauri'
import { readCachedLyrics, writeCachedLyrics } from '../lyrics/cache'
import { lyricsMatch, searchQueriesFor } from '../lyrics/match'
import {
  geniusLyrics,
  kugouLyrics,
  lrclibLyrics,
  lyricsOvhLyrics,
  neteaseLyrics,
  qqLyrics,
  type LyricsFetcher,
} from '../lyrics/sources'
import * as sp from '../spotify/api'
import * as vk from '../vk/api'
import type { Lyrics, Track } from '../vk/models'

export { lyricsMatch }

interface ProviderHealth {
  cleanResponses: number
  transportErrors: number
}

function trackCall<T>(p: Promise<T>, health: ProviderHealth): Promise<T | null> {
  return p.then(
    (val) => {
      health.cleanResponses++
      return val
    },
    () => {
      health.transportErrors++
      return null
    },
  )
}

function makeTrackedFetcher(health: ProviderHealth): LyricsFetcher | null {
  if (!isTauri()) return null
  return async (url: string) => {
    try {
      const res = await invoke<string>('lyrics_fetch', { url })
      health.cleanResponses++
      return res
    } catch (err) {
      health.transportErrors++
      throw err
    }
  }
}

function lyricsRank(l: Lyrics): number {
  if (l.instrumental && !l.lines.length) return 0
  if (!l.lines.length) return -1
  if (l.synced && l.lines.some((line) => Boolean(line.words?.length))) return 3
  if (l.synced) return 2
  return 1
}

function preferBetter(current: Lyrics | null, candidate: Lyrics | null): Lyrics | null {
  if (!candidate) return current
  if (!current) return candidate
  const candRank = lyricsRank(candidate)
  const curRank = lyricsRank(current)
  if (candRank > curRank) return candidate
  if (candRank === curRank && candidate.lines.length > current.lines.length && !current.synced) {
    return candidate
  }
  return current
}

async function vkFallbackLyrics(t: Track, health: ProviderHealth): Promise<Lyrics | null> {
  const queries = searchQueriesFor(t).slice(0, 2)
  if (!queries.length) return null
  let fallback: Lyrics | null = null
  const seen = new Set<string>([t.key])

  for (const query of queries) {
    const found = await trackCall(vk.searchTracks(query), health)
    const matches = (found?.items ?? [])
      .filter((c) => c.hasLyrics && !seen.has(c.key) && lyricsMatch(t, c))
      .sort((a, b) => {
        const scoreA = (a.ownerId < 0 ? 2 : 0) + (a.album ? 1 : 0)
        const scoreB = (b.ownerId < 0 ? 2 : 0) + (b.album ? 1 : 0)
        return scoreB - scoreA
      })
      .slice(0, 3)

    for (const hit of matches) {
      seen.add(hit.key)
      const res = await trackCall(vk.getLyrics(hit), health)
      if (!res) continue
      const normalized: Lyrics = {
        ...res,
        source: res.source ?? 'vk',
        credits: res.credits?.trim() || 'Текст: ВКонтакте',
      }
      fallback = preferBetter(fallback, normalized)
      if (fallback?.synced && fallback.lines.length) return fallback
    }
  }
  return fallback
}

async function spotifyFallbackLyrics(t: Track, health: ProviderHealth): Promise<Lyrics | null> {
  if (typeof sp.search !== 'function' || typeof sp.getSpotifyLyrics !== 'function') return null
  const queries = searchQueriesFor(t).slice(0, 2)
  if (!queries.length) return null
  let fallback: Lyrics | null = null
  const seen = new Set<string>()

  for (const query of queries) {
    const found = await trackCall(sp.search(query), health)
    const hits = (found?.tracks ?? []).filter((c) => c.spotifyId && !seen.has(c.spotifyId) && lyricsMatch(t, c)).slice(0, 2)
    for (const hit of hits) {
      if (!hit.spotifyId) continue
      seen.add(hit.spotifyId)
      const res = await trackCall(sp.getSpotifyLyrics(hit.spotifyId, hit.cover?.l ?? hit.cover?.m ?? hit.cover?.s), health)
      if (!res) continue
      const normalized: Lyrics = {
        ...res,
        source: res.source ?? 'spotify',
      }
      fallback = preferBetter(fallback, normalized)
      if (fallback?.synced && fallback.lines.length) return fallback
    }
  }
  return fallback
}

const inflight = new Map<string, Promise<Lyrics | null>>()

/** Warm lyrics for `t` in the background (idempotent and deduplicated per track key). */
export function prefetchLyrics(t: Track | null | undefined): Promise<Lyrics | null> {
  if (!t?.key || (!t.artist?.trim() && !t.title?.trim())) return Promise.resolve(null)
  return findLyrics(t)
}

export async function findLyrics(t: Track, opts?: { force?: boolean }): Promise<Lyrics | null> {
  if (!opts?.force) {
    const cached = readCachedLyrics(t.key)
    if (cached !== undefined) return cached
    const pending = inflight.get(t.key)
    if (pending) return pending
  }

  const task = resolveLyrics(t).finally(() => {
    if (inflight.get(t.key) === task) inflight.delete(t.key)
  })
  if (!opts?.force) inflight.set(t.key, task)
  return task
}

async function resolveLyrics(t: Track): Promise<Lyrics | null> {
  let best: Lyrics | null = null
  let instrumentalHint: Lyrics | null = null
  const health: ProviderHealth = { cleanResponses: 0, transportErrors: 0 }
  const fetcher = makeTrackedFetcher(health)

  if (t.service === 'spotify' && t.spotifyId) {
    const native = await trackCall(sp.getSpotifyLyrics(t.spotifyId, t.cover?.l ?? t.cover?.m ?? t.cover?.s), health)
    if (native) {
      best = preferBetter(best, { ...native, source: native.source ?? 'spotify' })
      if (best?.synced && best.lines.length && lyricsRank(best) >= 3) {
        writeCachedLyrics(t.key, best)
        return best
      }
    }
  } else if (!t.service || t.service === 'vk') {
    if (t.hasLyrics) {
      const native = await trackCall(vk.getLyrics(t), health)
      if (native) {
        best = preferBetter(best, {
          ...native,
          source: native.source ?? 'vk',
          credits: native.credits?.trim() || 'Текст: ВКонтакте',
        })
        if (best?.synced && best.lines.length && lyricsRank(best) >= 3) {
          writeCachedLyrics(t.key, best)
          return best
        }
      }
    }
    if (!best?.synced && t.releaseId) {
      const parts = t.releaseId.split('_')
      const relOwner = Number(parts[0])
      const relId = Number(parts[1])
      if (Number.isFinite(relOwner) && Number.isFinite(relId) && `${relOwner}_${relId}` !== t.key) {
        const relNative = await trackCall(
          vk.getLyrics({ ...t, ownerId: relOwner, id: relId, key: `${relOwner}_${relId}`, accessKey: parts[2] || t.accessKey }),
          health,
        )
        if (relNative) {
          best = preferBetter(best, {
            ...relNative,
            source: relNative.source ?? 'vk',
            credits: relNative.credits?.trim() || 'Текст: ВКонтакте',
          })
          if (best?.synced && best.lines.length && lyricsRank(best) >= 3) {
            writeCachedLyrics(t.key, best)
            return best
          }
        }
      }
    }
  }

  if (best?.synced && lyricsRank(best) < 3) {
    const wordTasks: Promise<Lyrics | null>[] = [
      lrclibLyrics(t, fetcher).catch(() => null),
      neteaseLyrics(t, fetcher).catch(() => null),
    ]
    if (t.service !== 'spotify') {
      wordTasks.push(spotifyFallbackLyrics(t, health).catch(() => null))
    }
    const upgraded = await Promise.all(wordTasks)
    for (const r of upgraded) {
      if (r && lyricsRank(r) >= 3) {
        best = preferBetter(best, r)
      }
    }
    if (best?.lines.length) {
      writeCachedLyrics(t.key, best)
      return best
    }
  }

  if (!best?.synced) {
    const syncedTasks: Promise<Lyrics | null>[] = [
      lrclibLyrics(t, fetcher).catch(() => null),
      kugouLyrics(t, fetcher).catch(() => null),
      neteaseLyrics(t, fetcher).catch(() => null),
      qqLyrics(t, fetcher).catch(() => null),
      vkFallbackLyrics(t, health).catch(() => null),
    ]
    if (t.service !== 'spotify') {
      syncedTasks.push(spotifyFallbackLyrics(t, health).catch(() => null))
    }

    const results = await Promise.all(syncedTasks)
    for (const r of results) {
      if (!r) continue
      if (r.instrumental && !r.lines.length) {
        instrumentalHint ??= r
        continue
      }
      best = preferBetter(best, r)
    }

    if (best?.synced && best.lines.length) {
      writeCachedLyrics(t.key, best)
      return best
    }
  }

  if (!best?.lines.length) {
    const fallbackTasks: Promise<Lyrics | null>[] = [
      geniusLyrics(t, fetcher).catch(() => null),
      lyricsOvhLyrics(t, fetcher).catch(() => null),
    ]
    const fallbacks = await Promise.all(fallbackTasks)
    for (const r of fallbacks) {
      best = preferBetter(best, r)
    }
  }

  const finalResult = best ?? instrumentalHint
  // Never poison the 24h negative cache when every attempted provider failed with a transport error (e.g. offline).
  if (finalResult !== null || health.cleanResponses > 0 || health.transportErrors === 0) {
    writeCachedLyrics(t.key, finalResult)
  }
  return finalResult
}
