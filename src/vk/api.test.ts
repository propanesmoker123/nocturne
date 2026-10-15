import { afterEach, describe, expect, test } from 'vitest'
import { audioAttachment, call, sendTrack, setCaptchaHandler, setTransport } from './api'
import { VkError } from './errors'

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
