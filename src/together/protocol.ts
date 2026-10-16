/**
 * Everything participants of a shared session may say to each other, and the strict check every
 * incoming message goes through: known shapes only, numbers in range, strings cut to length,
 * anything else dropped. Nothing here ever carries tokens, cookies or stream links.
 */

export const MAX_MESSAGE_BYTES = 4096
export const MAX_LISTENERS = 5
const MAX_SECONDS = 36_000

export type Role = 'host' | 'listener'
export type ListenerState = 'connecting' | 'listening' | 'paused' | 'unavailable'

/** A track as the host announces it: enough to find it in VK and to show it, nothing more. */
export interface WireTrack {
  owner: number
  id: number
  accessKey?: string
  title: string
  artist: string
  duration: number
}

export type Message =
  | { v: 1; type: 'hello'; name: string }
  | { v: 1; type: 'welcome'; host: string; listeners: number }
  | { v: 1; type: 'state'; seq: number; track: WireTrack | null; position: number; playing: boolean; at: number }
  | { v: 1; type: 'status'; state: ListenerState }
  | { v: 1; type: 'ping'; t0: number }
  | { v: 1; type: 'pong'; t0: number; t1: number }
  | { v: 1; type: 'bye' }

export interface Handshake {
  role: Role
  /** Sent by a host that already has MAX_LISTENERS listeners. */
  full: boolean
}

const STATES: ListenerState[] = ['connecting', 'listening', 'paused', 'unavailable']

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const text = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.trim().slice(0, max) : null)

export function wireTrack(v: unknown): WireTrack | null | undefined {
  if (v === null) return null
  if (!isObj(v)) return undefined
  const title = text(v.title, 200)
  const artist = text(v.artist, 200)
  if (!int(v.owner, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) || !int(v.id, 0, Number.MAX_SAFE_INTEGER)) return undefined
  if (title === null || artist === null || !num(v.duration, 0, MAX_SECONDS)) return undefined
  if (v.accessKey !== undefined && !(typeof v.accessKey === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(v.accessKey))) return undefined
  return { owner: v.owner, id: v.id, ...(v.accessKey ? { accessKey: v.accessKey as string } : {}), title, artist, duration: v.duration }
}

/** The message, cleaned, or null when it must be ignored. */
export function parseMessage(raw: unknown): Message | null {
  if (!isObj(raw) || raw.v !== 1) return null
  let size = 0
  try {
    size = JSON.stringify(raw).length
  } catch {
    return null
  }
  if (size > MAX_MESSAGE_BYTES) return null

  switch (raw.type) {
    case 'hello': {
      const name = text(raw.name, 40)
      return name === null ? null : { v: 1, type: 'hello', name: name || 'Слушатель' }
    }
    case 'welcome': {
      const host = text(raw.host, 40)
      return host !== null && int(raw.listeners, 0, MAX_LISTENERS) ? { v: 1, type: 'welcome', host: host || 'Ведущий', listeners: raw.listeners } : null
    }
    case 'state': {
      const track = wireTrack(raw.track)
      if (track === undefined || !int(raw.seq, 0, Number.MAX_SAFE_INTEGER)) return null
      if (!num(raw.position, 0, MAX_SECONDS) || typeof raw.playing !== 'boolean' || !num(raw.at, 1, Number.MAX_SAFE_INTEGER)) return null
      return { v: 1, type: 'state', seq: raw.seq, track, position: raw.position, playing: raw.playing, at: raw.at }
    }
    case 'status':
      return STATES.includes(raw.state as ListenerState) ? { v: 1, type: 'status', state: raw.state as ListenerState } : null
    case 'ping':
      return num(raw.t0, 0, Number.MAX_SAFE_INTEGER) ? { v: 1, type: 'ping', t0: raw.t0 } : null
    case 'pong':
      return num(raw.t0, 0, Number.MAX_SAFE_INTEGER) && num(raw.t1, 0, Number.MAX_SAFE_INTEGER) ? { v: 1, type: 'pong', t0: raw.t0, t1: raw.t1 } : null
    case 'bye':
      return { v: 1, type: 'bye' }
    default:
      return null
  }
}

export function parseHandshake(raw: unknown): Handshake | null {
  if (!isObj(raw) || raw.v !== 1 || (raw.role !== 'host' && raw.role !== 'listener')) return null
  return { role: raw.role, full: raw.full === true }
}
