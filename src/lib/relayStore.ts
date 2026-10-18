import { schnorr } from '@noble/secp256k1'
import { signedEvent, type EventKeys } from '../together/seal'
import { loadJSON, saveJSON } from './persist'
import { serverNow } from './serverTime'

/**
 * Records kept on public Nostr relays (addressable events, NIP-33): a relay keeps the latest one
 * per author and tag `d`. Unlike `relayBus`, what was published while a device was away is still
 * there when it comes back — the albums' sync rests on that. The content is opaque here: sealing
 * belongs to the caller.
 */

/** Application data, addressable: relays keep the latest per author and `d`. */
export const STORED_KIND = 30078

const OPEN = 1
const MAX_CONTENT = 64 * 1024
const SEEN_LIMIT = 4000
/** Tags per REQ: relays limit filter sizes. */
const CHUNK = 100
/** Events published but not yet acknowledged by any relay: sent again on every (re)connect. */
const MAX_PENDING = 400

export interface StoredRecord {
  d: string
  /** hex public key of the device that published it */
  author: string
  createdAt: number
  content: string
}

export interface RelayStore {
  /** The tags to read: what is kept now, then what comes live. Replaces the previous set. */
  watch(tags: string[]): void
  publish(d: string, content: string): Promise<void>
  up(): boolean
  close(): void
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

export function openRelayStore(o: { relays: string[]; WebSocketImpl?: typeof WebSocket; keys: EventKeys; onRecord(r: StoredRecord): void }): RelayStore {
  const WebSocketImpl = o.WebSocketImpl ?? globalThis.WebSocket
  const prefix = `s${randomHex(4)}`
  const sockets = new Set<WebSocket>()
  const seen = new Set<string>()
  const pending = new Map<string, string>()
  let tags: string[] = []
  let chunks = 0
  let closed = false

  const remember = (id: string) => {
    seen.add(id)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
  }

  const subscribe = (ws: WebSocket) => {
    for (let i = 0; i < tags.length; i += CHUNK) ws.send(JSON.stringify(['REQ', `${prefix}-${i / CHUNK}`, { kinds: [STORED_KIND], '#d': tags.slice(i, i + CHUNK) }]))
  }

  const connect = (url: string, attempt = 0) => {
    if (closed) return
    let ws: WebSocket
    try {
      ws = new WebSocketImpl(url)
    } catch {
      return void setTimeout(() => connect(url, attempt + 1), Math.min(30_000, 2000 * 2 ** attempt))
    }
    ws.addEventListener('open', () => {
      attempt = 0
      sockets.add(ws)
      subscribe(ws)
      for (const frame of pending.values()) ws.send(frame)
    })
    ws.addEventListener('message', (e) => onFrame(String((e as MessageEvent).data)))
    ws.addEventListener('close', () => {
      sockets.delete(ws)
      if (!closed) setTimeout(() => connect(url, attempt + 1), Math.min(30_000, 2000 * 2 ** attempt))
    })
    ws.addEventListener('error', () => {})
  }

  const onFrame = (raw: string) => {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(frame)) return
    if (frame[0] === 'OK' && frame[2] === true) return void pending.delete(String(frame[1]))
    if (frame[0] !== 'EVENT' || typeof frame[1] !== 'string' || !frame[1].startsWith(prefix)) return
    const e = frame[2] as { id?: unknown; kind?: unknown; pubkey?: unknown; created_at?: unknown; tags?: unknown; content?: unknown } | undefined
    if (!e || e.kind !== STORED_KIND || typeof e.id !== 'string' || typeof e.pubkey !== 'string' || typeof e.content !== 'string') return
    if (e.content.length > MAX_CONTENT || !Array.isArray(e.tags)) return
    const d = (e.tags as unknown[]).find((t): t is string[] => Array.isArray(t) && t[0] === 'd')?.[1]
    if (typeof d !== 'string' || !tags.includes(d)) return
    if (seen.has(e.id)) return
    remember(e.id)
    o.onRecord({ d, author: e.pubkey, createdAt: Number(e.created_at) || 0, content: e.content })
  }

  for (const url of o.relays) connect(url)

  return {
    watch(next) {
      const want = [...new Set(next)]
      // the same tags again (an edit that changed no album's code): the relays are not asked again
      const have = new Set(tags)
      if (want.length === have.size && want.every((t) => have.has(t))) return
      const before = chunks
      tags = want
      chunks = Math.ceil(tags.length / CHUNK)
      for (const ws of sockets) {
        if (ws.readyState !== OPEN) continue
        for (let i = 0; i < before; i++) ws.send(JSON.stringify(['CLOSE', `${prefix}-${i}`]))
        subscribe(ws)
      }
    },
    publish: async (d, content) => {
      const event = await signedEvent(o.keys, STORED_KIND, '', content, Math.floor(serverNow() / 1000), [['d', d]])
      const frame = JSON.stringify(['EVENT', event])
      pending.set(event.id, frame)
      if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!)
      for (const ws of sockets) if (ws.readyState === OPEN) ws.send(frame)
    },
    up: () => [...sockets].some((ws) => ws.readyState === OPEN),
    close: () => {
      closed = true
      for (const ws of sockets) ws.close()
      sockets.clear()
    },
  }
}

/**
 * This device's own signing keys for stored records: made once and kept, so its copy of each
 * album stays one record per tag on the relays. Never printed, never journaled.
 */
export async function loadDeviceKeys(): Promise<EventKeys> {
  const saved = await loadJSON<{ secret: string }>('album-keys')
  if (saved && /^[0-9a-f]{64}$/.test(saved.secret)) {
    const secretKey = Uint8Array.from(saved.secret.match(/../g)!, (b) => parseInt(b, 16))
    return { secretKey, publicKey: schnorr.getPublicKey(secretKey) }
  }
  const keys = schnorr.keygen()
  await saveJSON('album-keys', { secret: hex(keys.secretKey) })
  return keys
}
