import { normalizeSearch } from '../lib/format'
import type { WireTrack } from './protocol'

/** Seconds of drift a listener may have before being moved to the host position. */
export const DRIFT_LIMIT = 0.75

/** The host's last word: what plays, where it was and on whose clock. */
export interface HostState {
  seq: number
  track: WireTrack | null
  position: number
  playing: boolean
  /** ms on the host clock when `position` was true */
  at: number
}

export interface LocalState {
  /** Key of the host track the listener plays now (its own copy may differ), or null. */
  followingKey: string | null
  position: number
  playing: boolean
  loading: boolean
  /** The listener paused themselves: stay paused until they press play. */
  localPaused: boolean
}

export type FollowAction = { kind: 'load'; track: WireTrack; at: number; play: boolean } | { kind: 'seek'; to: number } | { kind: 'play' } | { kind: 'pause' }

export const wireKey = (t: Pick<WireTrack, 'owner' | 'id'>) => `${t.owner}_${t.id}`

/** Where the host is at `now` (our clock), given how far its clock is ahead of ours. */
export function expectedPosition(host: HostState, now: number, offset: number): number {
  const moved = host.playing ? (now + offset - host.at) / 1000 : 0
  const pos = Math.max(0, host.position + moved)
  return host.track ? Math.min(pos, host.track.duration) : pos
}

/** What the listener's player should do to be where the host is. */
export function decide(host: HostState, local: LocalState, now: number, offset: number): FollowAction[] {
  if (!host.track) return local.playing ? [{ kind: 'pause' }] : []
  const at = expectedPosition(host, now, offset)
  if (local.followingKey !== wireKey(host.track)) return [{ kind: 'load', track: host.track, at, play: host.playing && !local.localPaused }]
  if (local.loading) return []
  if (local.localPaused) return local.playing ? [{ kind: 'pause' }] : []

  const drifted = Math.abs(local.position - at) > DRIFT_LIMIT
  const actions: FollowAction[] = []
  if (!host.playing) {
    if (local.playing) actions.push({ kind: 'pause' })
    if (drifted) actions.push({ kind: 'seek', to: at })
    return actions
  }
  if (drifted) actions.push({ kind: 'seek', to: at })
  if (!local.playing) actions.push({ kind: 'play' })
  return actions
}

/** The same recording under another id: title and artist equal ignoring case and «ё», length within 3 s. */
export function sameSongAs(t: { title: string; artist: string; duration: number }, w: Pick<WireTrack, 'title' | 'artist' | 'duration'>): boolean {
  return normalizeSearch(t.title) === normalizeSearch(w.title) && normalizeSearch(t.artist) === normalizeSearch(w.artist) && Math.abs(t.duration - w.duration) <= 3
}
