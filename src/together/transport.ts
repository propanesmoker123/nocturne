import { parseHandshake, type Handshake, type Message, type Role } from './protocol'

/**
 * The network under listening together: Trystero finds the other computers through a few public
 * Nostr relays (the handshake is encrypted with the invite code, the relays see only noise),
 * then everything goes directly computer to computer over WebRTC. Swappable for a fake in tests.
 */

export const APP_ID = 'nocturne-together-v1'

/** Relays from Trystero's own list that answered from the developer's machine; CSP allows exactly these. */
export const RELAYS = [
  'wss://nos.lol',
  'wss://cdn.satellite.earth',
  'wss://0x-nostr-relay.fly.dev',
  'wss://nostr.chaima.info',
  'wss://nostr.christiansass.de',
  'wss://nostr.rblb.it',
  'wss://nostr.stakey.net',
  'wss://relay.bitmacro.cloud',
]

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

/** Our messages are a few hundred bytes; refuse anything bigger before it is even received. */
const MAX_RECEIVE_BYTES = 8 * 1024

export type TransportError = 'direct' | 'full' | 'relays'

export interface TransportEvents {
  /** During the handshake: let this peer in? */
  admit(peer: string, theirs: Handshake): 'accept' | 'full' | 'reject'
  onPeerJoin(peer: string): void
  onPeerLeave(peer: string): void
  onMessage(raw: unknown, peer: string): void
  onError(error: TransportError): void
}

export interface Transport {
  send(msg: Message, to?: string): void
  /** Whether any relay is connected (to tell «no internet» from «nobody there»). */
  relaysUp(): Promise<boolean>
  /** Drop a participant who breaks the rules (floods messages). */
  kick(peer: string): void
  leave(): void
}

export type OpenTransport = (opts: { roomId: string; password: string; role: Role }, events: TransportEvents) => Promise<Transport>

/** Our own handshake refusals; they are expected (listener↔listener) and never shown. */
const OURS = 'nocturne:'

export const openTrystero: OpenTransport = async ({ roomId, password, role }, ev) => {
  const { joinRoom, getRelaySockets } = await import('trystero/nostr')
  const room = joinRoom(
    {
      appId: APP_ID,
      password,
      maxReceiveBytes: MAX_RECEIVE_BYTES,
      relayConfig: { urls: RELAYS, warnOnRelayFailure: false },
      rtcConfig: { iceServers: ICE_SERVERS },
    },
    roomId,
    {
      handshakeTimeoutMs: 10_000,
      onJoinError: ({ error }) => {
        if (error.startsWith('could not connect')) ev.onError('direct')
      },
      onPeerHandshake: async (peer, send, receive, isInitiator) => {
        const mine = { v: 1, role }
        let theirs: Handshake | null
        if (isInitiator) {
          await send(mine)
          theirs = parseHandshake((await receive()).data)
        } else {
          theirs = parseHandshake((await receive()).data)
          await send(mine)
        }
        if (!theirs || theirs.role === role) throw new Error(`${OURS}pair`)
        // Second round: the host tells the listener whether there is room for them
        if (role === 'host') {
          const verdict = ev.admit(peer, theirs)
          await send({ v: 1, role: 'host', full: verdict !== 'accept' })
          if (verdict !== 'accept') throw new Error(`${OURS}${verdict}`)
          return
        }
        const verdict = parseHandshake((await receive()).data)
        if (!verdict || verdict.full) {
          if (verdict?.full) ev.onError('full')
          throw new Error(`${OURS}full`)
        }
        if (ev.admit(peer, theirs) !== 'accept') throw new Error(`${OURS}second-host`)
      },
    },
  )
  const channel = room.makeAction('m')
  channel.onMessage = (data, { peerId }) => ev.onMessage(data, peerId)
  room.onPeerJoin = (peer) => ev.onPeerJoin(peer)
  room.onPeerLeave = (peer) => ev.onPeerLeave(peer)

  return {
    send: (msg, to) => void channel.send(msg as unknown as Parameters<typeof channel.send>[0], to ? { target: to } : undefined).catch(() => {}),
    relaysUp: async () => Object.values(getRelaySockets()).some((s) => (s as WebSocket).readyState === WebSocket.OPEN),
    kick: (peer) => room.getPeers()[peer]?.close(),
    leave: () => void room.leave().catch(() => {}),
  }
}
