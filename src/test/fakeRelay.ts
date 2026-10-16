/** Test only: an in-memory stand-in for public Nostr relays, shared by the relay and device-channel tests. */

/** An in-memory Nostr relay: REQ subscriptions by kind and #x tag, EVENT fan-out a few ms later. */
export class FakeSocket {
  static hub = new Map<string, Set<FakeSocket>>()
  static down = new Set<string>()
  static frames: { url: string; frame: unknown[] }[] = []
  readyState = 0
  private listeners: Record<string, ((e: { data?: string }) => void)[]> = {}
  private subs = new Map<string, { kinds: number[]; '#x': string[] }>()

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
    if (frame[0] === 'REQ') this.subs.set(frame[1] as string, frame[2] as never)
    if (frame[0] === 'CLOSE') this.subs.delete(frame[1] as string)
    if (frame[0] === 'EVENT') this.fanOut(frame[1] as { kind: number; tags: string[][] })
  }
  fanOut(event: { kind: number; tags: string[][]; [field: string]: unknown }) {
    for (const s of FakeSocket.hub.get(this.url) ?? []) {
      for (const [subId, f] of s.subs) {
        if (f.kinds.includes(event.kind) && f['#x'].includes(event.tags[0][1])) {
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
