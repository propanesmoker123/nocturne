import type { RepeatMode } from '../player/queue'

/** Event names shared by the main window, the island and Rust. */
export const EV = {
  playerState: 'player:state',
  playerCommand: 'player:command',
  requestState: 'player:request-state',
  islandHover: 'island:hover',
  islandSettings: 'island:settings',
  islandSet: 'island:set',
  /** Waveform of the current track for the island (main → island). */
  islandWave: 'island:wave',
  /** Quick search window (Ctrl+Alt+F): shown by Rust, which then sends this to it. */
  quickOpen: 'quick:open',
  /** quick search → main: the query typed so far */
  quickQuery: 'quick:query',
  /** main → quick search: what was found for that query */
  quickResults: 'quick:results',
  /** quick search → main: play a found track now or right after the current one */
  quickPlay: 'quick:play',
  sessionReady: 'session:ready',
  sessionLoggedOut: 'session:logged-out',
  /** VK keeps asking to try again (or the network is down): the app retries for a few minutes. */
  sessionBusy: 'session:busy',
} as const

export interface IslandTrack {
  key: string
  title: string
  artist: string
  cover?: string
  coverLarge?: string
  explicit: boolean
  liked: boolean
  duration: number
}

export interface IslandWave {
  key: string | null
  peaks: number[] | null
  /** The user's waveform colour, or null to follow the accent. */
  color: string | null
}

export interface PlayerSnapshot {
  track: IslandTrack | null
  isPlaying: boolean
  isLoading: boolean
  /** seconds at `at` (ms epoch); receivers interpolate while playing */
  position: number
  at: number
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  accent: string | null
  /** Listening together: the island shows who leads or how many follow. */
  together: { role: 'host' | 'listener'; listeners: number; hostName: string | null } | null
}

export type PlayerCommand =
  | { type: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'toggleShuffle' | 'cycleRepeat' | 'toggleLike' | 'toggleMute' | 'showWindow' }
  | { type: 'seek' | 'seekBy' | 'volume' | 'volumeBy'; value: number }

/** A found track as the quick search window gets it: display fields only, no stream links or access keys. */
export interface QuickTrack {
  key: string
  title: string
  subtitle?: string
  artist: string
  cover?: string
  duration: number
  explicit: boolean
  playable: boolean
}

export interface QuickQuery {
  /** Grows with every keystroke; answers to older queries are dropped. */
  seq: number
  q: string
}

export interface QuickResults {
  seq: number
  own: QuickTrack[]
  others: QuickTrack[]
  /** Still waiting for the library or VK. */
  loading: boolean
  error: string | null
  accent: string | null
  /** The current track (marked in the list) and whether it is playing or paused. */
  playingKey: string | null
  playing: boolean
}

export interface QuickPlay {
  key: string
  /** Put it right after the current track instead of playing it now. */
  next: boolean
}
