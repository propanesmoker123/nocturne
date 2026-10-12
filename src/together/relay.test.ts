import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Message } from './protocol'
import { makeRelayTransport, type RelayOptions } from './relay'
import type { OpenTransport, Transport, TransportEvents } from './transport'

/** An in-memory Nostr relay: REQ subscriptions by kind and #x tag, EVENT fan-out a few ms later. */
class FakeSocket {
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

const CODE = 'K7QM-2XFD-9WRA-HT4C'
// Real time, short intervals: signing and sealing run on real WebCrypto
const OPTS: RelayOptions = { relays: ['wss://a', 'wss://b'], WebSocketImpl: FakeSocket as never, silenceMs: 600, joinEveryMs: 100, keepAliveMs: 200, tickMs: 50 }

function recorder(admit: TransportEvents['admit'] = () => 'accept') {
  const r = {
    joins: [] as string[],
    leaves: [] as string[],
    msgs: [] as { msg: unknown; from: string }[],
    errors: [] as string[],
    admitted: [] as { peer: string; role: string }[],
    ev: {
      admit: (peer, theirs) => {
        r.admitted.push({ peer, role: theirs.role })
        return admit(peer, theirs)
      },
      onPeerJoin: (p) => void r.joins.push(p),
      onPeerLeave: (p) => void r.leaves.push(p),
      onMessage: (msg, from) => void r.msgs.push({ msg, from }),
      onError: (e) => void r.errors.push(e),
    } as TransportEvents,
  }
  return r
}

const ping = (t0: number): Message => ({ v: 1, type: 'ping', t0 })

// Every test gets its own room, and everyone in it leaves afterwards
let room = ''
const live: Transport[] = []
const opener =
  (o: RelayOptions = OPTS): OpenTransport =>
  async (args, ev) => {
    const t = await makeRelayTransport(o)({ ...args, roomId: room }, ev)
    live.push(t)
    return t
  }
const advance = (ms: number) => new Promise((r) => setTimeout(r, ms))
const settle = () => advance(300)

beforeEach(() => {
  room = `r${Math.random().toString(36).slice(2)}`
  FakeSocket.hub.clear()
  FakeSocket.down.clear()
  FakeSocket.frames = []
})
afterEach(() => {
  for (const t of live.splice(0)) t.leave()
})

describe('listening together over relays', () => {
  test('a listener finds the host, and they talk both ways', async () => {
    const H = recorder()
    const L = recorder()
    const open = opener()
    const host = await open({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    const listener = await open({ roomId: 'r1', password: CODE, role: 'listener' }, L.ev)
    await settle()
    expect(H.admitted.map((a) => a.role)).toEqual(['listener'])
    expect(H.joins).toHaveLength(1)
    expect(L.joins).toHaveLength(1)
    expect(L.admitted[0].role).toBe('host')

    host.send(ping(1))
    listener.send(ping(2))
    await settle()
    expect(L.msgs).toEqual([{ msg: ping(1), from: L.joins[0] }])
    expect(H.msgs).toEqual([{ msg: ping(2), from: H.joins[0] }])
    expect(await host.relaysUp()).toBe(true)
  })

  test('a full room is said to the listener, who is not let in', async () => {
    const H = recorder(() => 'full')
    const L = recorder()
    const open = opener()
    await open({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    await open({ roomId: 'r1', password: CODE, role: 'listener' }, L.ev)
    await settle()
    expect(H.joins).toEqual([])
    expect(L.errors).toContain('full')
    expect(L.joins).toEqual([])
  })

  test('one message through two relays is delivered once; a replayed copy is dropped', async () => {
    const H = recorder()
    const L = recorder()
    const open = opener()
    const host = await open({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    await open({ roomId: 'r1', password: CODE, role: 'listener' }, L.ev)
    await settle()
    host.send(ping(7))
    await settle()
    expect(L.msgs.filter((m) => (m.msg as { t0: number }).t0 === 7)).toHaveLength(1)
    // someone re-posts the very same sealed content in a new event: still nothing new
    const original = FakeSocket.frames.filter((f) => f.frame[0] === 'EVENT').at(-1)!.frame[1] as { kind: number; tags: string[][]; id: string }
    const relay = [...FakeSocket.hub.get('wss://a')!][0]
    relay.fanOut({ ...original, id: 'f'.repeat(64) })
    await settle()
    expect(L.msgs.filter((m) => (m.msg as { t0: number }).t0 === 7)).toHaveLength(1)
  })

  test('someone with another code in the same room hears nothing and is heard by nobody', async () => {
    const H = recorder()
    const S = recorder()
    const open = opener()
    const host = await open({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    await open({ roomId: 'r1', password: 'AAAA-BBBB-CCCC-DDDD', role: 'listener' }, S.ev)
    await settle()
    host.send(ping(3))
    await settle()
    expect(H.joins).toEqual([])
    expect(S.joins).toEqual([])
    expect(S.msgs).toEqual([])
  })

  test('quiet participants keep alive by themselves; goodbye means leaving at once', async () => {
    const H = recorder()
    const L = recorder()
    const open = opener()
    const host = await open({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    await open({ roomId: 'r1', password: CODE, role: 'listener' }, L.ev)
    await settle()
    await advance(2000)
    expect(H.leaves).toEqual([])
    expect(L.leaves).toEqual([])
    host.leave()
    await settle()
    expect(L.leaves).toEqual([L.joins[0]])
  })

  test('a host that falls silent is gone after a while, and back when it speaks again', async () => {
    class HostSocket extends FakeSocket {
      static muted = false
    }
    const H = recorder()
    const L = recorder()
    const host = await opener({ ...OPTS, WebSocketImpl: HostSocket as never })({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    await opener()({ roomId: 'r1', password: CODE, role: 'listener' }, L.ev)
    await settle()
    HostSocket.muted = true
    await advance(300)
    expect(L.leaves).toEqual([])
    await advance(700)
    expect(L.leaves).toEqual([L.joins[0]])
    HostSocket.muted = false
    host.send(ping(1))
    await settle()
    expect(L.joins).toEqual([L.joins[0], L.joins[0]])
  })

  test('relays that cannot be reached are reported as down', async () => {
    FakeSocket.down.add('wss://a')
    FakeSocket.down.add('wss://b')
    const open = opener()
    const t = await open({ roomId: 'r1', password: CODE, role: 'host' }, recorder().ev)
    await settle()
    expect(await t.relaysUp()).toBe(false)
    t.leave()
  })

  test('a kicked participant is dropped and not heard again', async () => {
    const H = recorder()
    const L = recorder()
    const open = opener()
    const host = await open({ roomId: 'r1', password: CODE, role: 'host' }, H.ev)
    const listener = await open({ roomId: 'r1', password: CODE, role: 'listener' }, L.ev)
    await settle()
    host.kick(H.joins[0])
    expect(H.leaves).toEqual([H.joins[0]])
    listener.send(ping(9))
    await advance(400)
    expect(H.msgs).toEqual([])
    expect(H.joins).toHaveLength(1)
  })
})
