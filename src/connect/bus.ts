import { openRelayBus } from '../lib/relayBus'
import { serverNow } from '../lib/serverTime'
import { RateLimit } from '../together/rules'
import { RELAYS } from '../together/transport'
import { groupKey, groupTopic } from './link'
import { parseConnectMessage, type ConnectMessage } from './protocol'

/**
 * The channel of one person's linked devices: everyone in the group hears everyone (or one, with
 * `to`), sealed with the group key. Fewer relays than listening together, since it stays open the
 * whole time the app runs.
 */
export const CONNECT_RELAYS = RELAYS.slice(0, 4)

/** A message older than this (clock skew, replays) is not looked at. */
const MAX_AGE_MS = 2 * 60_000

interface Envelope {
  v: 1
  from: string
  at: number
  to?: string
  msg: unknown
}

export interface ConnectBus {
  send(msg: ConnectMessage, to?: string): void
  up(): boolean
  close(): void
}

export interface ConnectBusOptions {
  relays?: string[]
  WebSocketImpl?: typeof WebSocket
  /** A relay connected: a good moment to say who we are. */
  onOpen?(): void
}

export async function openConnectBus(code: string, me: string, onMessage: (msg: ConnectMessage, from: string) => void, opts: ConnectBusOptions = {}): Promise<ConnectBus> {
  const limit = new RateLimit(20)
  const bus = openRelayBus({
    relays: opts.relays ?? CONNECT_RELAYS,
    WebSocketImpl: opts.WebSocketImpl,
    onOpen: opts.onOpen,
    topic: await groupTopic(code),
    key: await groupKey(code),
    onData: (data) => {
      const env = data as Partial<Envelope> | null
      if (!env || typeof env !== 'object' || env.v !== 1 || typeof env.from !== 'string' || !/^[0-9a-f]{16}$/.test(env.from) || env.from === me) return
      if (typeof env.at !== 'number' || Math.abs(serverNow() - env.at) > MAX_AGE_MS) return
      if (env.to !== undefined && env.to !== me) return
      if (!limit.hit(env.from, Date.now())) return
      const msg = parseConnectMessage(env.msg)
      if (msg) onMessage(msg, env.from)
    },
  })
  return {
    send: (msg, to) => void bus.publish({ v: 1, from: me, at: serverNow(), ...(to ? { to } : {}), msg } satisfies Envelope),
    up: () => bus.up(),
    close: () => bus.close(),
  }
}
