import type { Handshake, Message, Role } from './protocol'

/**
 * The network under listening together, as the session sees it: who may come in, who joined or
 * left, messages to and from them. The real one goes through public Nostr relays (`relay.ts`);
 * tests put a fake underneath.
 */

/** Public Nostr relays that answered from the developer's machine; the window CSP allows exactly these. */
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

export type TransportError = 'full' | 'relays'

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
