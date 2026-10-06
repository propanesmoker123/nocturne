import type { Track } from '../vk/models'
import { current, upcoming, type QueueState } from './queue'

/** VK signs stream URLs for a limited time; refresh well before they expire. */
export const URL_MAX_AGE_MS = 2 * 3600_000

export function needsFreshUrl(t: Track, now: number, maxAge = URL_MAX_AGE_MS): boolean {
  if (!t.url) return true
  if (t.url.startsWith('blob:') || t.url.startsWith('data:')) return false
  return now - t.urlFetchedAt > maxAge
}

/** iOS behaviour: "previous" restarts the track unless it just began. */
export function prevAction(position: number): 'restart' | 'previous' {
  return position > 3 ? 'restart' : 'previous'
}

/** Slider position → element volume on a perceptual (square) curve. */
export function volumeToGain(v: number): number {
  const c = Math.min(1, Math.max(0, v))
  return c * c
}

/** Tracks from `incoming` whose key is not already in `existing` (and not repeated). */
export function dedupeAppend(existing: Track[], incoming: Track[]): Track[] {
  const seen = new Set(existing.map((t) => t.key))
  const out: Track[] = []
  for (const t of incoming) {
    if (seen.has(t.key)) continue
    seen.add(t.key)
    out.push(t)
  }
  return out
}

/** Time left in the current track plus everything queued after it. */
export function remainingSeconds(q: QueueState<Track> | null, position: number): number {
  if (!q) return 0
  const cur = current(q)
  if (!cur) return 0
  return Math.max(0, cur.duration - position) + upcoming(q).reduce((sum, t) => sum + t.duration, 0)
}
