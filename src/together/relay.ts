import { schnorr } from '@noble/secp256k1'
import { roomKey, seal, signedEvent, unseal, type EventKeys } from './seal'
import type { Handshake, Message, Role } from './protocol'
import { RELAYS, type OpenTransport, type TransportEvents } from './transport'

/**
 * Listening together over public Nostr relays only: every message is a sealed, signed ephemeral
 * event in the room's topic. Works wherever ordinary secure websockets do (VPN, mobile internet,
 * networks that block direct UDP), needs no server of our own, and participants never learn
 * each other's IP addresses. A few messages a minute; relays are not asked to store any of them.
 */

/** Ephemeral kind (20000–29999): relays pass such events on and do not keep them. */
export const KIND = 25050

export interface RelayOptions {
  relays?: string[]
  WebSocketImpl?: typeof WebSocket
  /** No word from the other side for this long means it is gone. */
  silenceMs?: number
  /** A listener without a host asks again this often. */
  joinEveryMs?: number
  /** Say something at least this often, even with nothing to say. */
  keepAliveMs?: number
  /** How often silence and keep-alive are checked. */
  tickMs?: number
}

type Ctl = 'join' | 'full' | 'leave' | 'alive'

interface Envelope {
  v: 1
  from: string
  role: Role
  at: number
  to?: string
  ctl?: Ctl
  msg?: unknown
}

const OPEN = 1
const MAX_CONTENT = 16 * 1024
/** Copies of an old message are ignored; one older than this is not even looked at. */
const MAX_AGE_MS = 10 * 60_000
const SEEN_LIMIT = 600

const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')

function isEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return (
    e.v === 1 &&
    typeof e.from === 'string' &&
    /^[0-9a-f]{16}$/.test(e.from) &&
    (e.role === 'host' || e.role === 'listener') &&
    typeof e.at === 'number' &&
    (e.to === undefined || typeof e.to === 'string') &&
    (e.ctl === undefined || e.ctl === 'join' || e.ctl === 'full' || e.ctl === 'leave' || e.ctl === 'alive')
  )
}

export function makeRelayTransport(opts: RelayOptions = {}): OpenTransport {
  const { relays = RELAYS, WebSocketImpl = globalThis.WebSocket, silenceMs = 30_000, joinEveryMs = 3000, keepAliveMs = 10_000, tickMs = 1000 } = opts

  return async ({ roomId, password, role }, ev: TransportEvents) => {
    const key = await roomKey(password)
    const keys: EventKeys = schnorr.keygen()
    const me = randomHex(8)
    const topic = `nocturne-${roomId}`
    const subId = `n${me.slice(0, 8)}`
    const sockets = new Set<WebSocket>()
    const seen = new Set<string>()
    const banned = new Set<string>()
    /** Who we talk with and when they last said anything: listeners (host side) or the host. */
    const peers = new Map<string, number>()
    let host: string | null = null
    let hostHere = false
    let closed = false
    let lastSent = 0
    const timers: ReturnType<typeof setInterval>[] = []

    const remember = (id: string) => {
      seen.add(id)
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!)
    }

    const publish = async (extra: Partial<Envelope>) => {
      if (closed && extra.ctl !== 'leave') return
      lastSent = Date.now()
      const env: Envelope = { v: 1, from: me, role, at: Date.now(), ...extra }
      const event = await signedEvent(keys, KIND, topic, await seal(key, env))
      const frame = JSON.stringify(['EVENT', event])
      for (const ws of sockets) if (ws.readyState === OPEN) ws.send(frame)
    }

    const subscribe = (ws: WebSocket) =>
      ws.send(JSON.stringify(['REQ', subId, { kinds: [KIND], '#x': [topic], since: Math.floor(Date.now() / 1000) - 10 }]))

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
        if (role === 'listener' && !hostHere) void publish({ ctl: 'join' })
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
      const env = await unseal(key, content)
      if (closed || !isEnvelope(env) || env.from === me || banned.has(env.from)) return
      if (Math.abs(Date.now() - env.at) > MAX_AGE_MS) return
      if (env.to !== undefined && env.to !== me) return
      if (role === 'host') onListener(env)
      else onHost(env)
    }

    const onListener = (env: Envelope) => {
      if (env.role !== 'listener') return
      if (env.ctl === 'join') {
        if (!peers.has(env.from)) {
          const verdict = ev.admit(env.from, { role: 'listener', full: false } satisfies Handshake)
          if (verdict !== 'accept') {
            if (verdict === 'full') void publish({ to: env.from, ctl: 'full' })
            return
          }
          peers.set(env.from, Date.now())
          ev.onPeerJoin(env.from)
        }
        peers.set(env.from, Date.now())
        return void publish({ to: env.from, ctl: 'join' })
      }
      if (!peers.has(env.from)) return
      if (env.ctl === 'leave') {
        peers.delete(env.from)
        return ev.onPeerLeave(env.from)
      }
      peers.set(env.from, Date.now())
      if (env.msg !== undefined) ev.onMessage(env.msg, env.from)
    }

    const onHost = (env: Envelope) => {
      if (env.role !== 'host') return
      if (env.ctl === 'full') {
        if (env.to === me) ev.onError('full')
        return
      }
      if (host === null) {
        // Only the host's answer to our own «join» lets it in
        if (env.ctl !== 'join' || env.to !== me) return
        if (ev.admit(env.from, { role: 'host', full: false }) !== 'accept') return
        host = env.from
      }
      if (env.from !== host) return
      peers.set(host, Date.now())
      if (env.ctl === 'leave') {
        if (hostHere) {
          hostHere = false
          ev.onPeerLeave(host)
        }
        return
      }
      if (!hostHere) {
        hostHere = true
        ev.onPeerJoin(host)
      }
      if (env.msg !== undefined) ev.onMessage(env.msg, host)
    }

    // Who went quiet, who needs to hear from us, and a listener still looking for its host
    timers.push(
      setInterval(() => {
        const now = Date.now()
        for (const [peer, at] of peers) {
          if (now - at <= silenceMs) continue
          if (role === 'host') {
            peers.delete(peer)
            ev.onPeerLeave(peer)
          } else if (hostHere) {
            hostHere = false
            ev.onPeerLeave(peer)
          }
        }
        const talking = role === 'host' ? peers.size > 0 : hostHere
        if (talking && now - lastSent >= keepAliveMs) void publish({ ctl: 'alive', ...(role === 'listener' && host ? { to: host } : {}) })
      }, tickMs),
    )
    if (role === 'listener') {
      timers.push(
        setInterval(() => {
          if (!hostHere) void publish({ ctl: 'join' })
        }, joinEveryMs),
      )
    }

    for (const url of relays) connect(url)

    return {
      send: (msg: Message, to?: string) => void publish({ msg, ...(to ? { to } : role === 'listener' && host ? { to: host } : {}) }),
      relaysUp: async () => [...sockets].some((ws) => ws.readyState === OPEN),
      kick: (peer: string) => {
        banned.add(peer)
        if (peers.delete(peer)) ev.onPeerLeave(peer)
      },
      leave: () => {
        if (closed) return
        void publish({ ctl: 'leave' }).finally(() => {
          for (const ws of sockets) ws.close()
          sockets.clear()
        })
        closed = true
        for (const t of timers) clearInterval(t)
      },
    }
  }
}

export const openRelays: OpenTransport = makeRelayTransport()
