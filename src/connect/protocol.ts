import { wireTrack, type WireTrack } from '../together/protocol'

/**
 * What a person's own devices say to each other (the device remote), and the strict check every
 * incoming message goes through — known shapes only, numbers in range, strings cut to length,
 * anything else dropped. Never tokens, cookies or stream links.
 */

/** A «play this» order carries at most this many tracks, so the sealed message stays under 16 KB. */
export const MAX_PLAY_TRACKS = 40
const MAX_SECONDS = 36_000
const MAX_TIME = 8_640_000_000_000

export type Platform = 'desktop' | 'android'
export type Repeat = 'off' | 'all' | 'one'

/** A device about itself: who it is and what it plays. */
export interface Presence {
  name: string
  platform: Platform
  track: WireTrack | null
  position: number
  duration: number
  playing: boolean
  /** When playback started there (ms), for «one device plays»; 0 while it does not play. */
  since: number
  volume: number
  shuffle: boolean
  repeat: Repeat
  queue: { pos: number; total: number }
}

export type CommandAction = 'toggle' | 'play' | 'pause' | 'next' | 'prev' | 'seek' | 'volume' | 'shuffle' | 'repeat' | 'mix'

/** «Play this»: a window of a queue in play order, where to start and how. */
export interface PlayOrder {
  tracks: WireTrack[]
  index: number
  position: number
  playing: boolean
  shuffle: boolean
  repeat: Repeat
  label?: string
  /** VK Mix: the receiver keeps it going instead of playing a list that runs out. */
  mix?: boolean
  /** «Перемешать»: start anywhere, not at `index`. */
  randomStart?: boolean
}

export type ConnectMessage =
  | { type: 'presence'; presence: Presence }
  | { type: 'command'; action: CommandAction; value?: number }
  | ({ type: 'play' } & PlayOrder)
  | { type: 'pull' }
  | { type: 'move'; target: string }
  | { type: 'bye' }

const ACTIONS: CommandAction[] = ['toggle', 'play', 'pause', 'next', 'prev', 'seek', 'volume', 'shuffle', 'repeat', 'mix']
const REPEATS: Repeat[] = ['off', 'all', 'one']

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.trim().slice(0, max) : null)
const repeat = (v: unknown): v is Repeat => REPEATS.includes(v as Repeat)

function presence(v: unknown): Presence | null {
  if (!isObj(v)) return null
  const name = text(v.name, 40)
  const track = wireTrack(v.track)
  const q = v.queue
  if (!name || track === undefined || (v.platform !== 'desktop' && v.platform !== 'android')) return null
  if (!num(v.position, 0, MAX_SECONDS) || !num(v.duration, 0, MAX_SECONDS) || typeof v.playing !== 'boolean' || !num(v.since, 0, MAX_TIME)) return null
  if (!num(v.volume, 0, 1) || typeof v.shuffle !== 'boolean' || !repeat(v.repeat)) return null
  if (!isObj(q) || !int(q.pos, 0, 100_000) || !int(q.total, 0, 100_000)) return null
  return { name, platform: v.platform, track, position: v.position, duration: v.duration, playing: v.playing, since: v.since, volume: v.volume, shuffle: v.shuffle, repeat: v.repeat, queue: { pos: q.pos, total: q.total } }
}

function playOrder(v: Record<string, unknown>): PlayOrder | null {
  if (!Array.isArray(v.tracks) || v.tracks.length === 0 || v.tracks.length > MAX_PLAY_TRACKS) return null
  const tracks = v.tracks.map(wireTrack)
  if (tracks.some((t) => !t)) return null
  if (!int(v.index, 0, tracks.length - 1) || !num(v.position, 0, MAX_SECONDS) || typeof v.playing !== 'boolean' || typeof v.shuffle !== 'boolean' || !repeat(v.repeat)) return null
  const label = v.label === undefined ? undefined : text(v.label, 100)
  if (label === null) return null
  if ((v.mix !== undefined && typeof v.mix !== 'boolean') || (v.randomStart !== undefined && typeof v.randomStart !== 'boolean')) return null
  return { tracks: tracks as WireTrack[], index: v.index, position: v.position, playing: v.playing, shuffle: v.shuffle, repeat: v.repeat, ...(label ? { label } : {}), ...(v.mix ? { mix: true } : {}), ...(v.randomStart ? { randomStart: true } : {}) }
}

/** The message, cleaned, or null when it must be ignored. */
export function parseConnectMessage(raw: unknown): ConnectMessage | null {
  if (!isObj(raw)) return null
  switch (raw.type) {
    case 'presence': {
      const p = presence(raw.presence)
      return p ? { type: 'presence', presence: p } : null
    }
    case 'command': {
      const action = raw.action as CommandAction
      if (!ACTIONS.includes(action)) return null
      if (action === 'seek') return num(raw.value, 0, MAX_SECONDS) ? { type: 'command', action, value: raw.value } : null
      if (action === 'volume') return num(raw.value, 0, 1) ? { type: 'command', action, value: raw.value } : null
      return { type: 'command', action }
    }
    case 'play': {
      const o = playOrder(raw)
      return o ? { type: 'play', ...o } : null
    }
    case 'pull':
      return { type: 'pull' }
    case 'move':
      return typeof raw.target === 'string' && /^[0-9a-f]{16}$/.test(raw.target) ? { type: 'move', target: raw.target } : null
    case 'bye':
      return { type: 'bye' }
    default:
      return null
  }
}
