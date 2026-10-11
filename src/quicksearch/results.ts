import type { QuickTrack } from '../lib/events'
import { splitOwnFirst } from '../lib/search'
import type { Track } from '../vk/models'

/** The quick panel is for picking a song, not browsing: a handful of each. */
export const OWN_LIMIT = 6
export const VK_LIMIT = 30

/** Only what the panel draws: the stream link and access keys stay in the main window. */
export function toQuickTrack(t: Track): QuickTrack {
  return {
    key: t.key,
    title: t.title,
    ...(t.subtitle ? { subtitle: t.subtitle } : {}),
    artist: t.artist,
    cover: t.cover?.s,
    duration: t.duration,
    explicit: t.explicit,
    playable: t.playable,
  }
}

export function quickResults(library: Track[], global: Track[], q: string): { own: Track[]; others: Track[] } {
  if (!q.trim()) return { own: [], others: [] }
  const { own, others } = splitOwnFirst(library, global, q)
  return { own: own.slice(0, OWN_LIMIT), others: others.slice(0, VK_LIMIT) }
}
