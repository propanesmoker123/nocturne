import { schnorr } from '@noble/secp256k1'
import { describe, expect, test } from 'vitest'
import { roomKey, seal, signedEvent, unseal } from './seal'

describe('sealed messages', () => {
  test('what is sealed with the invite code opens with the same code, typed any way', async () => {
    const a = await roomKey('K7QM-2XFD-9WRA-HT4C')
    const b = await roomKey('k7qm 2xfd 9wra ht4c')
    const box = await seal(a, { hello: 'мир', n: 1 })
    expect(await unseal(b, box)).toEqual({ hello: 'мир', n: 1 })
  })

  test('a different code, a changed byte or garbage opens to nothing', async () => {
    const key = await roomKey('K7QM-2XFD-9WRA-HT4C')
    const other = await roomKey('K7QM-2XFD-9WRA-HT4D')
    const box = await seal(key, { x: 1 })
    expect(await unseal(other, box)).toBe(null)
    const flipped = box.slice(0, 30) + (box[30] === 'A' ? 'B' : 'A') + box.slice(31)
    expect(await unseal(key, flipped)).toBe(null)
    expect(await unseal(key, 'not base64 at all!')).toBe(null)
    expect(await unseal(key, '')).toBe(null)
  })

  test('the same message sealed twice looks different (random nonce)', async () => {
    const key = await roomKey('K7QM-2XFD-9WRA-HT4C')
    expect(await seal(key, { x: 1 })).not.toBe(await seal(key, { x: 1 }))
  })
})

describe('relay events', () => {
  test('an event carries its topic, its id is the hash of its contents and the signature checks out', async () => {
    const keys = schnorr.keygen()
    const e = await signedEvent(keys, 25050, 'room-topic', 'sealed', 1_790_000_000)
    expect(e).toMatchObject({ kind: 25050, tags: [['x', 'room-topic']], content: 'sealed', created_at: 1_790_000_000 })
    const serial = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serial)))
    expect(e.id).toBe(Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join(''))
    const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)))
    expect(await schnorr.verifyAsync(hex(e.sig), hash, hex(e.pubkey))).toBe(true)
  })
})
