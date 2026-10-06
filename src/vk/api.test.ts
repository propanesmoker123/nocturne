import { afterEach, describe, expect, test } from 'vitest'
import { call, setCaptchaHandler, setTransport } from './api'
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
