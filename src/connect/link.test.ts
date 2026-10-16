import { describe, expect, test } from 'vitest'
import { roomIdFor } from '../together/code'
import { seal, unseal } from '../together/seal'
import { codeFromLink, groupKey, groupTopic, linkFor, newDeviceId, newGroupCode } from './link'

const CODE = 'K7QM-2XFD-9WRA-HT4C'

describe('linking devices', () => {
  test('a QR link carries the code, and only a proper link gives one back', () => {
    expect(linkFor(CODE)).toBe('nocturne://link?code=K7QM-2XFD-9WRA-HT4C')
    expect(codeFromLink('nocturne://link?code=k7qm-2xfd-9wra-ht4c')).toBe(CODE)
    expect(codeFromLink('nocturne://link/?code=K7QM2XFD9WRAHT4C')).toBe(CODE)
    expect(codeFromLink('https://evil.example/link?code=K7QM-2XFD-9WRA-HT4C')).toBeNull()
    expect(codeFromLink('nocturne://link?code=K7QM-2XFD')).toBeNull()
    expect(codeFromLink('nocturne://link?code=K7QM-2XFD-9WRA-HT4C&x=<script>')).toBeNull()
  })

  test('the topic relays see is never the code and never a listen-together room', async () => {
    const topic = await groupTopic(CODE)
    expect(topic).toMatch(/^nocturne-c-[0-9a-f]{16}$/)
    expect(topic).toBe(await groupTopic('k7qm 2xfd 9wra ht4c'))
    expect(topic).not.toContain(await roomIdFor(CODE))
    expect(await groupTopic(newGroupCode())).not.toBe(topic)
  })

  test('the group key opens what it sealed, and another group cannot', async () => {
    const sealed = await seal(await groupKey(CODE), { hi: 1 })
    expect(await unseal(await groupKey(CODE), sealed)).toEqual({ hi: 1 })
    expect(await unseal(await groupKey(newGroupCode()), sealed)).toBeNull()
  })

  test('a device id is 16 hex digits, new every time', () => {
    expect(newDeviceId()).toMatch(/^[0-9a-f]{16}$/)
    expect(newDeviceId()).not.toBe(newDeviceId())
  })
})
