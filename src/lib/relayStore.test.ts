import { schnorr } from '@noble/secp256k1'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { FakeSocket } from '../test/fakeRelay'
import type { StoredRecord } from './relayStore'

const h = vi.hoisted(() => ({ saved: new Map<string, unknown>() }))
vi.mock('./persist', () => ({ loadJSON: async (name: string) => h.saved.get(name) ?? null, saveJSON: async (name: string, data: unknown) => void h.saved.set(name, data) }))

const { openRelayStore, loadDeviceKeys } = await import('./relayStore')

const RELAYS = ['wss://r1', 'wss://r2']
const WS = FakeSocket as unknown as typeof WebSocket

async function until(cond: () => boolean, ms = 3000) {
  for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10))
}

function device() {
  const got: StoredRecord[] = []
  const keys = schnorr.keygen()
  const store = openRelayStore({ relays: RELAYS, WebSocketImpl: WS, keys, onRecord: (r) => got.push(r) })
  return { got, store, keys, author: Array.from(keys.publicKey, (b) => b.toString(16).padStart(2, '0')).join('') }
}

beforeEach(() => {
  FakeSocket.hub.clear()
  FakeSocket.stored.clear()
  h.saved.clear()
})

describe('stored records on relays', () => {
  test('a record published by one device is read by another that starts later', async () => {
    const a = device()
    await until(() => a.store.up())
    await a.store.publish('d1', 'hello')
    await until(() => FakeSocket.stored.get('wss://r1')?.size === 1)
    a.store.close()
    const b = device()
    b.store.watch(['d1'])
    await until(() => b.got.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(b.got).toHaveLength(1)
    expect(b.got[0]).toMatchObject({ d: 'd1', content: 'hello', author: a.author })
  })

  test('two authors under one tag are both kept and both read', async () => {
    const a = device()
    const b = device()
    await until(() => a.store.up() && b.store.up())
    await a.store.publish('d1', 'from a')
    await b.store.publish('d1', 'from b')
    await new Promise((r) => setTimeout(r, 30))
    const c = device()
    c.store.watch(['d1'])
    await until(() => c.got.length >= 2)
    expect(c.got.map((r) => r.content).sort()).toEqual(['from a', 'from b'])
  })

  test('a newer record of the same author replaces the older', async () => {
    const a = device()
    await until(() => a.store.up())
    await a.store.publish('d1', 'old')
    await new Promise((r) => setTimeout(r, 1100))
    await a.store.publish('d1', 'new')
    await new Promise((r) => setTimeout(r, 30))
    const c = device()
    c.store.watch(['d1'])
    await until(() => c.got.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(c.got.map((r) => r.content)).toEqual(['new'])
  })

  test('watch replaces the tags asked for', async () => {
    const a = device()
    const b = device()
    b.store.watch(['d1'])
    await until(() => a.store.up() && b.store.up())
    b.store.watch(['d2'])
    await new Promise((r) => setTimeout(r, 20))
    await a.store.publish('d1', 'not for b any more')
    await a.store.publish('d2', 'for b')
    await until(() => b.got.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(b.got.map((r) => r.content)).toEqual(['for b'])
  })

  test('content longer than 64 KB is refused on the way in', async () => {
    const a = device()
    const b = device()
    b.store.watch(['d1'])
    await until(() => a.store.up() && b.store.up())
    await a.store.publish('d1', 'x'.repeat(64 * 1024 + 1))
    await a.store.publish('d1', 'small')
    await until(() => b.got.length > 0)
    await new Promise((r) => setTimeout(r, 50))
    expect(b.got.map((r) => r.content)).toEqual(['small'])
  })

  test('the same record from several relays reaches onRecord once', async () => {
    const a = device()
    const b = device()
    b.store.watch(['d1'])
    await until(() => a.store.up() && b.store.up())
    await a.store.publish('d1', 'once')
    await until(() => b.got.length > 0)
    await new Promise((r) => setTimeout(r, 60))
    expect(b.got).toHaveLength(1)
  })

  test('device keys are made once and kept', async () => {
    const first = await loadDeviceKeys()
    const second = await loadDeviceKeys()
    expect(Array.from(second.publicKey)).toEqual(Array.from(first.publicKey))
    expect(h.saved.has('album-keys')).toBe(true)
  })
})

describe('asking the relays', () => {
  test('watching the same tags again asks the relays for nothing new', async () => {
    const a = device()
    await until(() => (FakeSocket.hub.get('wss://r1')?.size ?? 0) > 0 && (FakeSocket.hub.get('wss://r2')?.size ?? 0) > 0)
    a.store.watch(['d1', 'd2'])
    await new Promise((r) => setTimeout(r, 20))
    const n = FakeSocket.frames.length
    a.store.watch(['d2', 'd1'])
    await new Promise((r) => setTimeout(r, 20))
    expect(FakeSocket.frames.length).toBe(n)
    a.store.close()
  })
})
