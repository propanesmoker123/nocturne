/** Test only: an in-memory stand-in for public Nostr relays, shared by the relay and device-channel tests. */

type Filter = { kinds: number[]; '#x'?: string[]; '#d'?: string[]; since?: number }
type Event = { id?: string; kind: number; tags: string[][]; created_at?: number; pubkey?: string; [field: string]: unknown }

const dTag = (e: Event) => e.tags.find((t) => t[0] === 'd')?.[1]
const matches = (f: Filter, e: Event) => f.kinds.includes(e.kind) && (f['#x'] ? f['#x'].includes(e.tags[0]?.[1]) : true) && (f['#d'] ? f['#d'].includes(dTag(e) ?? '') : true)

/**
 * An in-memory Nostr relay: REQ subscriptions by kind and #x or #d tag, EVENT fan-out a few ms
 * later, and storage of addressable events (30000–39999: the latest per author, kind and `d`).
 */
export class FakeSocket {
  static hub = new Map<string, Set<FakeSocket>>()
  /** per relay address: addressable events by `pubkey:kind:d` */
  static stored = new Map<string, Map<string, Event>>()
  static down = new Set<string>()
  static frames: { url: string; frame: unknown[] }[] = []
  readyState = 0
  private listeners: Record<string, ((e: { data?: string }) => void)[]> = {}
  private subs = new Map<string, Filter>()

  constructor(readonly url: string) {
    setTimeout(() => {
      if (FakeSocket.down.has(url)) return this.emit('close', {})
      this.readyState = 1
      if (!FakeSocket.hub.has(url)) FakeSocket.hub.set(url, new Set())
      FakeSocket.hub.get(url)!.add(this)
      this.emit('open', {})
    }, 1)
  }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    ;(this.listeners[type] ??= []).push(fn)
  }
  private emit(type: string, e: { data?: string }) {
    for (const fn of this.listeners[type] ?? []) fn(e)
  }
  /** Set on a subclass to drop everything it sends, like a computer that lost the network. */
  static muted = false
  send(data: string) {
    if ((this.constructor as typeof FakeSocket).muted) return
    const frame = JSON.parse(data) as unknown[]
    FakeSocket.frames.push({ url: this.url, frame })
    if (frame[0] === 'REQ') {
      const [, subId, filter] = frame as [string, string, Filter]
      this.subs.set(subId, filter)
      if (filter['#d']) {
        const kept = [...(FakeSocket.stored.get(this.url)?.values() ?? [])].filter((e) => matches(filter, e))
        setTimeout(() => {
          for (const e of kept) this.readyState === 1 && this.emit('message', { data: JSON.stringify(['EVENT', subId, e]) })
          this.readyState === 1 && this.emit('message', { data: JSON.stringify(['EOSE', subId]) })
        }, 3)
      }
    }
    if (frame[0] === 'CLOSE') this.subs.delete(frame[1] as string)
    if (frame[0] === 'EVENT') {
      const event = frame[1] as Event
      if (event.kind >= 30000 && event.kind < 40000) this.keep(event)
      setTimeout(() => this.readyState === 1 && this.emit('message', { data: JSON.stringify(['OK', event.id ?? '', true, '']) }), 2)
      this.fanOut(event)
    }
  }
  private keep(event: Event) {
    if (!FakeSocket.stored.has(this.url)) FakeSocket.stored.set(this.url, new Map())
    const box = FakeSocket.stored.get(this.url)!
    const k = `${event.pubkey}:${event.kind}:${dTag(event)}`
    const old = box.get(k)
    if (!old || (old.created_at ?? 0) <= (event.created_at ?? 0)) box.set(k, event)
  }
  fanOut(event: Event) {
    for (const s of FakeSocket.hub.get(this.url) ?? []) {
      for (const [subId, f] of s.subs) {
        // real relays hold live events to `since` too
        const late = f.since !== undefined && (event.created_at ?? 0) < f.since
        if (matches(f, event) && !late) {
          setTimeout(() => s.readyState === 1 && s.emit('message', { data: JSON.stringify(['EVENT', subId, event]) }), 5)
        }
      }
    }
  }
  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    FakeSocket.hub.get(this.url)?.delete(this)
    this.emit('close', {})
  }
}
