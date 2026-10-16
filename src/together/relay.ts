import { openRelayBus } from '../lib/relayBus'
import { roomKey } from './seal'
import type { Handshake, Message, Role } from './protocol'
import { RELAYS, type OpenTransport, type TransportEvents } from './transport'

/**
 * Listening together over public Nostr relays only: every message is a sealed, signed ephemeral
 * event in the room's topic. Works wherever ordinary secure websockets do (VPN, mobile internet,
 * networks that block direct UDP), needs no server of our own, and participants never learn
 * each other's IP addresses. A few messages a minute; relays are not asked to store any of them.
 */

export { KIND } from '../lib/relayBus'

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

/** Copies of an old message are ignored; one older than this is not even looked at. */
const MAX_AGE_MS = 10 * 60_000

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
    const me = randomHex(8)
    const banned = new Set<string>()
    /** Who we talk with and when they last said anything: listeners (host side) or the host. */
    const peers = new Map<string, number>()
    let host: string | null = null
    let hostHere = false
    let closed = false
    let lastSent = 0
    const timers: ReturnType<typeof setInterval>[] = []

    const bus = openRelayBus({
      relays,
      WebSocketImpl,
      topic: `nocturne-${roomId}`,
      key: await roomKey(password),
      onOpen: () => {
        if (role === 'listener' && !hostHere) void publish({ ctl: 'join' })
      },
      onData: (env) => {
        if (closed || !isEnvelope(env) || env.from === me || banned.has(env.from)) return
        if (Math.abs(Date.now() - env.at) > MAX_AGE_MS) return
        if (env.to !== undefined && env.to !== me) return
        if (role === 'host') onListener(env)
        else onHost(env)
      },
    })

    const publish = async (extra: Partial<Envelope>) => {
      if (closed && extra.ctl !== 'leave') return
      lastSent = Date.now()
      await bus.publish({ v: 1, from: me, role, at: Date.now(), ...extra })
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

    return {
      send: (msg: Message, to?: string) => void publish({ msg, ...(to ? { to } : role === 'listener' && host ? { to: host } : {}) }),
      relaysUp: async () => bus.up(),
      kick: (peer: string) => {
        banned.add(peer)
        if (peers.delete(peer)) ev.onPeerLeave(peer)
      },
      leave: () => {
        if (closed) return
        void publish({ ctl: 'leave' }).finally(() => bus.close())
        closed = true
        for (const t of timers) clearInterval(t)
      },
    }
  }
}

export const openRelays: OpenTransport = makeRelayTransport()
