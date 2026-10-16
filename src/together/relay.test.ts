import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Message } from './protocol'
import { makeRelayTransport, type RelayOptions } from './relay'
import type { OpenTransport, Transport, TransportEvents } from './transport'
import { FakeSocket } from '../test/fakeRelay'

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
/** Waits for a condition (the full suite runs many files at once), then lets the dust settle. */
async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await advance(20)
  await settle()
}

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
    await until(() => H.joins.length > 0 && L.joins.length > 0)
    expect(H.admitted.map((a) => a.role)).toEqual(['listener'])
    expect(H.joins).toHaveLength(1)
    expect(L.joins).toHaveLength(1)
    expect(L.admitted[0].role).toBe('host')

    host.send(ping(1))
    listener.send(ping(2))
    await until(() => L.msgs.length > 0 && H.msgs.length > 0)
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
    await until(() => L.errors.includes('full'))
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
    await until(() => H.joins.length > 0 && L.joins.length > 0)
    host.send(ping(7))
    await until(() => L.msgs.some((m) => (m.msg as { t0: number }).t0 === 7))
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
    await until(() => H.joins.length > 0 && L.joins.length > 0)
    await advance(2000)
    expect(H.leaves).toEqual([])
    expect(L.leaves).toEqual([])
    host.leave()
    await until(() => L.leaves.length > 0)
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
    await until(() => H.joins.length > 0 && L.joins.length > 0)
    HostSocket.muted = true
    await advance(300)
    expect(L.leaves).toEqual([])
    await advance(700)
    expect(L.leaves).toEqual([L.joins[0]])
    HostSocket.muted = false
    host.send(ping(1))
    await until(() => L.joins.length > 1)
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
    await until(() => H.joins.length > 0 && L.joins.length > 0)
    host.kick(H.joins[0])
    expect(H.leaves).toEqual([H.joins[0]])
    listener.send(ping(9))
    await advance(400)
    expect(H.msgs).toEqual([])
    expect(H.joins).toHaveLength(1)
  })
})
