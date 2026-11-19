import { afterEach, describe, expect, test } from 'vitest'
import { addToPlaylist, audioAttachment, call, getMe, removeFromPlaylist, sendTrack, setBroadcast, setCaptchaHandler, setTransport } from './api'
import { VkError } from './errors'
import type { Playlist, Track } from './models'

afterEach(() => {
  setTransport(null)
  setCaptchaHandler(null)
})

describe('call', () => {
  test('passes method and params to the transport', async () => {
    const seen: unknown[] = []
    setTransport(async (method, params) => {
      seen.push([method, params])
      return { ok: true }
    })
    await expect(call('audio.get', { count: 5 })).resolves.toEqual({ ok: true })
    expect(seen).toEqual([['audio.get', { count: 5 }]])
  })

  test('wraps transport rejections into VkError', async () => {
    setTransport(async () => {
      throw { kind: 'vk', code: 201, message: 'Access denied' }
    })
    const err = (await call('audio.get', {}).catch((e: unknown) => e)) as VkError
    expect(err).toBeInstanceOf(VkError)
    expect(err.isAccessDenied).toBe(true)
  })

  test('asks the captcha handler and retries once with the answer', async () => {
    const calls: Record<string, unknown>[] = []
    setTransport(async (_m, params) => {
      calls.push(params)
      if (!params.captcha_key) throw { kind: 'vk', code: 14, message: 'Captcha needed', captchaSid: 'sid9', captchaImg: 'https://c' }
      return 'done'
    })
    setCaptchaHandler(async (e) => (e.captchaSid === 'sid9' ? 'qwerty' : null))
    await expect(call('audio.add', { audio_id: 1 })).resolves.toBe('done')
    expect(calls[1]).toEqual({ audio_id: 1, captcha_sid: 'sid9', captcha_key: 'qwerty' })
  })

  test('rejects with the captcha error when the user cancels', async () => {
    setTransport(async () => {
      throw { kind: 'vk', code: 14, message: 'Captcha needed', captchaSid: 's', captchaImg: 'https://c' }
    })
    setCaptchaHandler(async () => null)
    const err = (await call('audio.add', {}).catch((e: unknown) => e)) as VkError
    expect(err.isCaptcha).toBe(true)
  })

  test('serializes concurrent captcha prompts so one sheet completes before the next opens', async () => {
    let activePrompts = 0
    let maxConcurrentPrompts = 0
    setTransport(async (_m, params) => {
      if (!params.captcha_key) {
        const sid = `sid_${String(params.audio_id)}`
        throw { kind: 'vk', code: 14, message: 'Captcha needed', captchaSid: sid, captchaImg: 'https://c' }
      }
      return `ok_${String(params.captcha_key)}`
    })
    setCaptchaHandler(async (e) => {
      activePrompts++
      maxConcurrentPrompts = Math.max(maxConcurrentPrompts, activePrompts)
      await new Promise((r) => setTimeout(r, 15))
      activePrompts--
      return `key_for_${e.captchaSid}`
    })

    const [r1, r2] = await Promise.all([
      call('audio.add', { audio_id: 1 }),
      call('audio.add', { audio_id: 2 }),
    ])
    expect(maxConcurrentPrompts).toBe(1)
    expect(r1).toBe('ok_key_for_sid_1')
    expect(r2).toBe('ok_key_for_sid_2')
  })

  test('skips empty playlist mutations and rejects empty getMe response cleanly', async () => {
    const calls: string[] = []
    setTransport(async (method) => {
      calls.push(method)
      return []
    })
    const pl = { id: 1, ownerId: 1 } as Playlist
    await addToPlaylist(pl, [])
    await removeFromPlaylist(pl, [])
    expect(calls).toEqual([])
    await expect(getMe()).rejects.toMatchObject({ kind: 'invalid' })
  })
})

describe('sending a track to a friend', () => {
  test('the track goes as an audio attachment, with its access key when it has one', () => {
    expect(audioAttachment({ ownerId: -2001, id: 456, accessKey: 'ab12' })).toBe('audio-2001_456_ab12')
    expect(audioAttachment({ ownerId: 7, id: 9 })).toBe('audio7_9')
  })

  test('messages.send gets the friend, the attachment and a random id', async () => {
    const seen: [string, Record<string, unknown>][] = []
    setTransport(async (method, params) => {
      seen.push([method, params])
      return 1
    })
    await sendTrack(42, { ownerId: 7, id: 9 })
    expect(seen[0][0]).toBe('messages.send')
    expect(seen[0][1]).toMatchObject({ peer_id: 42, attachment: 'audio7_9' })
    expect(Number.isInteger(seen[0][1].random_id)).toBe(true)
  })
})

describe('the VK status', () => {
  test('SoundCloud and Spotify tracks never go to VK as an audio: the status is cleared instead', async () => {
    const seen: unknown[] = []
    setTransport(async (method, params) => {
      seen.push([method, params])
      return 1
    })
    await setBroadcast({ service: 'sc', id: 402, ownerId: 501 } as Track)
    await setBroadcast({ service: 'spotify', id: 123, ownerId: 0 } as Track)
    await setBroadcast({ id: 5, ownerId: 2 } as Track)
    expect(seen).toEqual([
      ['audio.setBroadcast', {}],
      ['audio.setBroadcast', {}],
      ['audio.setBroadcast', { audio: '2_5' }],
    ])
  })
})
