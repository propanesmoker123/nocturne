import { schnorr } from '@noble/secp256k1'
import { seal, signedEvent, unseal } from '../together/seal'
import { serverNow } from './serverTime'

/**
 * Sealed, signed ephemeral events in one topic over a handful of public Nostr relays — the
 * plumbing listening together and the device remote share: connect (and reconnect with
 * backoff), ask for the topic, open each message once whichever relay brought it.
 */

/** Ephemeral kind (20000–29999): relays pass such events on and do not keep them. */
export const KIND = 25050

const OPEN = 1
const MAX_CONTENT = 16 * 1024
const SEEN_LIMIT = 600

export interface RelayBusOptions {
  relays: string[]
  WebSocketImpl?: typeof WebSocket
  /** The tag events go out and are asked for under. */
  topic: string
  key: CryptoKey
  /** Every message that opened with `key`, once. */
  onData(data: unknown): void
  /** A relay connected and was asked for the topic. */
  onOpen?(): void
}

export interface RelayBus {
  publish(data: unknown): Promise<void>
  /** Whether any relay is connected (to tell «no internet» from «nobody there»). */
  up(): boolean
  close(): void
}

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

export function openRelayBus(o: RelayBusOptions): RelayBus {
  const WebSocketImpl = o.WebSocketImpl ?? globalThis.WebSocket
  const keys = schnorr.keygen()
  const subId = `n${randomHex(4)}`
  const sockets = new Set<WebSocket>()
  const seen = new Set<string>()
  let closed = false

  const remember = (id: string) => {
    seen.add(id)
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
  }

  // Only live events (`limit: 0`), and no `since`: relays hold live events to it too, so a clock a
  // little ahead of another device's would stop hearing that device while still being heard by it.
  // Freshness is the envelope's job, with its wide window.
  const subscribe = (ws: WebSocket) => ws.send(JSON.stringify(['REQ', subId, { kinds: [KIND], '#x': [o.topic], limit: 0 }]))

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
      o.onOpen?.()
    })
    ws.addEventListener('message', (e) => void onFrame(String((e as MessageEvent).data)))
    ws.addEventListener('close', () => {
      sockets.delete(ws)
      if (!closed) setTimeout(() => connect(url, attempt + 1), Math.min(30_000, 2000 * 2 ** attempt))
    })
    ws.addEventListener('error', () => {})
  }

  const onFrame = async (raw: string) => {
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(frame)) return
    if (frame[0] === 'CLOSED' && frame[1] === subId) {
      // The relay dropped our subscription (limits, restarts): ask again a bit later
      return void setTimeout(() => {
        for (const ws of sockets) if (ws.readyState === OPEN) subscribe(ws)
      }, 5000)
    }
    if (frame[0] !== 'EVENT' || frame[1] !== subId) return
    const event = frame[2] as { content?: unknown } | undefined
    const content = event?.content
    if (typeof content !== 'string' || content.length > MAX_CONTENT) return
    // The same sealed message comes from every relay, and could be re-posted: one look only
    const nonce = content.slice(0, 16)
    if (seen.has(nonce)) return
    remember(nonce)
    const data = await unseal(o.key, content)
    if (closed || data === null) return
    o.onData(data)
  }

  for (const url of o.relays) connect(url)

  return {
    publish: async (data) => {
      const event = await signedEvent(keys, KIND, o.topic, await seal(o.key, data), Math.floor(serverNow() / 1000))
      const frame = JSON.stringify(['EVENT', event])
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
