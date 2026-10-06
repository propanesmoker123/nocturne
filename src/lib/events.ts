import type { RepeatMode } from '../player/queue'

/** Event names shared by the main window, the island and Rust. */
export const EV = {
  playerState: 'player:state',
  playerCommand: 'player:command',
  requestState: 'player:request-state',
  islandHover: 'island:hover',
  islandSettings: 'island:settings',
  islandSet: 'island:set',
  sessionReady: 'session:ready',
  sessionLoggedOut: 'session:logged-out',
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
}

export type PlayerCommand =
  | { type: 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'toggleShuffle' | 'cycleRepeat' | 'toggleLike' | 'toggleMute' | 'showWindow' }
  | { type: 'seek' | 'seekBy' | 'volume' | 'volumeBy'; value: number }
