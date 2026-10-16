import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeSocket } from '../test/fakeRelay'
import { openConnectBus, type ConnectBus } from './bus'
import type { ConnectMessage } from './protocol'

const CODE = 'K7QM-2XFD-9WRA-HT4C'
const OTHER = 'ZZZZ-2XFD-9WRA-HT4C'
const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'
const C = 'cccccccccccccccc'
const OPTS = { relays: ['wss://a', 'wss://b'], WebSocketImpl: FakeSocket as never }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Waits for a condition instead of a fixed time: the full suite runs many files at once. */
async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await wait(10)
}
const connected = () => until(() => open.every((b) => b.up()))
const open: ConnectBus[] = []

async function device(code: string, id: string) {
  const got: { msg: ConnectMessage; from: string }[] = []
  const bus = await openConnectBus(code, id, (msg, from) => got.push({ msg, from }), OPTS)
  open.push(bus)
  return { bus, got }
}

beforeEach(() => {
  FakeSocket.hub.clear()
  FakeSocket.down.clear()
  FakeSocket.frames = []
})
afterEach(() => {
  for (const b of open.splice(0)) b.close()
})

describe('the group channel', () => {
  test('one device hears another of the same group, once, with who said it; never itself', async () => {
    const a = await device(CODE, A)
    const b = await device(CODE, B)
    await connected()
    a.bus.send({ type: 'pull' })
    await until(() => b.got.length > 0)
    await wait(100)
    expect(b.got).toEqual([{ msg: { type: 'pull' }, from: A }])
    expect(a.got).toEqual([])
  })

  test('a message for one device is not opened by another', async () => {
    const a = await device(CODE, A)
    const b = await device(CODE, B)
    const c = await device(CODE, C)
    await connected()
    a.bus.send({ type: 'pull' }, C)
    await until(() => c.got.length > 0)
    await wait(100)
    expect(b.got).toEqual([])
    expect(c.got).toHaveLength(1)
  })

  test('another group hears nothing', async () => {
    const a = await device(CODE, A)
    const x = await device(OTHER, B)
    await connected()
    a.bus.send({ type: 'bye' })
    await wait(300)
    expect(x.got).toEqual([])
  })

  test('a device whose clock runs ahead still hears the others (relays hold events to the asked «since»)', async () => {
    const a = await device(CODE, A)
    const real = Date.now
    const ahead = vi.spyOn(Date, 'now').mockImplementation(() => real() + 40_000)
    const b = await device(CODE, B)
    await connected()
    ahead.mockRestore()
    a.bus.send({ type: 'pull' })
    await until(() => b.got.length > 0)
    expect(b.got).toEqual([{ msg: { type: 'pull' }, from: A }])
  })

  test('junk and floods are dropped', async () => {
    const a = await device(CODE, A)
    const b = await device(CODE, B)
    await connected()
    a.bus.send({ type: 'reboot' } as never)
    for (let i = 0; i < 40; i++) a.bus.send({ type: 'command', action: 'next' }, B)
    await until(() => b.got.length >= 20)
    await wait(300)
    expect(b.got.length).toBeLessThanOrEqual(20)
    expect(b.got.every((g) => g.msg.type === 'command')).toBe(true)
  })
})
