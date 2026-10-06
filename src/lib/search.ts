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
  return { own, others: global.filter((g) => !own.some((o) => sameSong(o, g))) }
}
