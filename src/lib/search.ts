import type { Track } from '../vk/models'
import { filterTracks, normalizeSearch } from './format'

/** Same recording even when VK serves it from different owners (library copy vs catalog). */
export const sameSong = (a: Track, b: Track) =>
  (!!a.releaseId && a.releaseId === b.releaseId) ||
  (normalizeSearch(a.title) === normalizeSearch(b.title) && normalizeSearch(a.artist) === normalizeSearch(b.artist) && Math.abs(a.duration - b.duration) <= 2)

/** Library tracks matching the query, and the VK results minus the songs already found there. */
export function splitOwnFirst(library: Track[], global: Track[], q: string): { own: Track[]; others: Track[] } {
  const own = q.trim() ? filterTracks(library, q) : []
  if (own.length === 0) return { own, others: global }
  const ownReleaseIds = new Set<string>()
  const ownByKey = new Map<string, number[]>()
  for (const o of own) {
    if (o.releaseId) ownReleaseIds.add(o.releaseId)
    const k = `${normalizeSearch(o.title)}\0${normalizeSearch(o.artist)}`
    const durs = ownByKey.get(k)
    if (durs) durs.push(o.duration)
    else ownByKey.set(k, [o.duration])
  }
  return {
    own,
    others: global.filter((g) => {
      if (g.releaseId && ownReleaseIds.has(g.releaseId)) return false
      const durs = ownByKey.get(`${normalizeSearch(g.title)}\0${normalizeSearch(g.artist)}`)
      return !(durs && durs.some((d) => Math.abs(d - g.duration) <= 2))
    }),
  }
}
