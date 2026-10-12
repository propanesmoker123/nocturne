import { MAX_LISTENERS, type Handshake, type Role } from './protocol'

/**
 * Who a participant lets in, decided during the handshake: a host takes listeners up to the
 * limit; a listener takes its one host. Everything else (two hosts, listener↔listener — the
 * library connects everyone with everyone) is turned away.
 */
export function admit(me: Role, theirs: Handshake, room: { listeners: number; host: string | null }, peer: string): 'accept' | 'full' | 'reject' {
  if (me === 'host') {
    if (theirs.role !== 'listener') return 'reject'
    return room.listeners < MAX_LISTENERS ? 'accept' : 'full'
  }
  if (theirs.role !== 'host') return 'reject'
  return room.host === null || room.host === peer ? 'accept' : 'reject'
}

/** At most `perSecond` messages per participant in any one-second window. */
export class RateLimit {
  private windows = new Map<string, { start: number; count: number }>()

  constructor(private perSecond = 20) {}

  hit(peer: string, now: number): boolean {
    const w = this.windows.get(peer)
    if (!w || now - w.start >= 1000) {
      this.windows.set(peer, { start: now, count: 1 })
      return true
    }
    w.count++
    return w.count <= this.perSecond
  }

  forget(peer: string) {
    this.windows.delete(peer)
  }
}
