import { serviceOf, type Track } from '../vk/models'
import type { Presence } from './protocol'

/** A device that said nothing for this long is gone. */
export const OFFLINE_MS = 45_000
/** Paused for this long, a steered device no longer holds the remote. */
export const IDLE_REMOTE_MS = 10 * 60_000

/** Another device of the group as last heard: its word, when it came, when it last played. */
export interface SeenDevice {
  id: string
  presence: Presence
  seen: number
  lastPlaying: number
}

export function onlineDevices(devices: Record<string, SeenDevice>, now: number): SeenDevice[] {
  return Object.values(devices)
    .filter((d) => now - d.seen <= OFFLINE_MS)
    .sort((a, b) => a.presence.name.localeCompare(b.presence.name, 'ru'))
}

/** The device playing right now: the latest to start, if somehow two do. */
export function playingDevice(devices: SeenDevice[]): SeenDevice | null {
  let best: SeenDevice | null = null
  for (const d of devices) if (d.presence.playing && (!best || d.presence.since > best.presence.since)) best = d
  return best
}

/** «One device plays»: this one stops when another started later; a tie goes to the larger id. */
export function shouldYield(me: { id: string; playing: boolean; since: number }, other: SeenDevice): boolean {
  if (!me.playing || !other.presence.playing) return false
  if (other.presence.since !== me.since) return other.presence.since > me.since
  return other.id > me.id
}

/** At most `max` items around `index` — a quarter before, the rest after — and where it is among them. */
export function queueWindow<T>(items: T[], index: number, max: number): { items: T[]; index: number } {
  const start = Math.max(0, Math.min(index - Math.floor(max / 4), items.length - max))
  return { items: items.slice(start, start + max), index: index - start }
}

/** Where the steered device is now: its last word plus the time since, while it plays. */
export function remotePosition(p: Presence, receivedAt: number, now: number): number {
  if (!p.playing) return p.position
  const at = p.position + Math.max(0, now - receivedAt) / 1000
  return p.duration > 0 ? Math.min(at, p.duration) : at
}

/** Whether a steered device still holds the remote: online, and playing or paused not long ago. */
export function remoteHolds(d: SeenDevice | undefined, now: number): boolean {
  if (!d || now - d.seen > OFFLINE_MS) return false
  return d.presence.playing || now - d.lastPlaying <= IDLE_REMOTE_MS
}

/** Plaintext budget of one order: sealed (AES-GCM) and base64'd it must stay under the relays' 16 KB. */
export const ORDER_BUDGET = 11_500

/** Drops tracks from the ends (later ones first) until the order fits one sealed message; the current one always stays. */
export function fitOrder<O extends { tracks: unknown[]; index: number }>(order: O, max = ORDER_BUDGET): O {
  const size = (o: O) => new TextEncoder().encode(JSON.stringify(o)).length
  let fitted = order
  while (fitted.tracks.length > 1 && size(fitted) > max) {
    fitted = fitted.tracks.length - 1 > fitted.index ? { ...fitted, tracks: fitted.tracks.slice(0, -1) } : { ...fitted, tracks: fitted.tracks.slice(1), index: fitted.index - 1 }
  }
  return fitted
}

/** The queue without SoundCloud tracks (they do not travel between devices yet), the current one
 *  kept in place; null when the current track is a SoundCloud one. */
export function vkOnly(tracks: Track[], index: number): { tracks: Track[]; index: number } | null {
  if (tracks[index] && serviceOf(tracks[index]) === 'sc') return null
  const kept: Track[] = []
  let at = 0
  tracks.forEach((t, i) => {
    if (serviceOf(t) === 'sc') return
    if (i === index) at = kept.length
    kept.push(t)
  })
  return { tracks: kept, index: at }
}
