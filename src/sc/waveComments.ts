import type { ScComment } from './normalize'

/** One avatar on the waveform: where it sits (px from the left) and the comments it stands for. */
export interface CommentSlot {
  x: number
  comments: ScComment[]
}

/**
 * Comments laid over a waveform `width` px wide: one avatar of `size` px per place, so a busy
 * track does not pile hundreds of them up; a place keeps all its comments, in time order.
 */
export function placeComments(comments: ScComment[], durationMs: number, width: number, size: number): CommentSlot[] {
  if (!(durationMs > 0) || !(width > 0) || !(size > 0)) return []
  const byPlace = new Map<number, ScComment[]>()
  for (const c of comments) {
    if (c.atMs < 0 || c.atMs > durationMs) continue
    const place = Math.floor(((c.atMs / durationMs) * width) / size)
    const list = byPlace.get(place) ?? []
    list.push(c)
    byPlace.set(place, list)
  }
  const half = size / 2
  return [...byPlace.entries()]
    .sort(([a], [b]) => a - b)
    .map(([place, list]) => ({ x: Math.min(Math.max((place + 0.5) * size, half), width - half), comments: list.sort((a, b) => a.atMs - b.atMs) }))
}

/** True while the track plays through one of the place's comments (and `windowMs` after it). */
export const passing = (slot: CommentSlot, positionMs: number, windowMs = 2500) => slot.comments.some((c) => c.atMs <= positionMs && positionMs < c.atMs + windowMs)

/** The comments read for `trackId`, never another track's (the player may have moved on). */
export const commentsOf = (data: { trackId: number; comments: ScComment[] } | undefined, trackId: number | undefined): ScComment[] =>
  data && trackId !== undefined && data.trackId === trackId ? data.comments : []
