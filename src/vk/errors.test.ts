import { describe, expect, test } from 'vitest'
import { VkError, describeError } from './errors'

describe('VkError.from', () => {
  test('maps the tagged payload rejected by the vk_api command', () => {
    const e = VkError.from({ kind: 'vk', code: 14, message: 'Captcha needed', captchaSid: 's1', captchaImg: 'https://img' })
    expect(e).toBeInstanceOf(VkError)
    expect(e.kind).toBe('vk')
    expect(e.code).toBe(14)
    expect(e.isCaptcha).toBe(true)
    expect(e.captchaSid).toBe('s1')
    expect(e.captchaImg).toBe('https://img')
  })

  test('maps auth errors', () => {
    const e = VkError.from({ kind: 'auth', message: 'not logged in' })
    expect(e.isAuth).toBe(true)
    expect(e.isCaptcha).toBe(false)
  })

  test('treats plain strings and Errors as network-ish failures', () => {
    expect(VkError.from('boom').kind).toBe('network')
    expect(VkError.from(new Error('offline')).message).toBe('offline')
  })

  test('returns the same instance for an existing VkError', () => {
    const e = new VkError('vk', 'x', 201)
    expect(VkError.from(e)).toBe(e)
  })

  test('recognises hidden audio access errors', () => {
    expect(new VkError('vk', 'Access denied', 201).isAccessDenied).toBe(true)
    expect(new VkError('vk', 'Access denied', 15).isAccessDenied).toBe(true)
    expect(new VkError('vk', 'Rate', 6).isAccessDenied).toBe(false)
  })
})

describe('describeError', () => {
  test('explains common failures in russian', () => {
    expect(describeError(new VkError('vk', 'Access denied: audio', 201))).toBe('Пользователь скрыл свои аудиозаписи')
    expect(describeError(new VkError('auth', 'expired'))).toBe('Сессия VK закончилась — войдите снова')
    expect(describeError(new VkError('network', 'dns'))).toBe('Нет связи с VK. Проверьте интернет и повторите')
    expect(describeError(new VkError('vk', 'Flood control', 9))).toBe('VK просит передохнуть: слишком много действий подряд')
  })

  test('falls back to the VK message for unknown codes', () => {
    expect(describeError(new VkError('vk', 'Something odd', 777))).toBe('VK ответил ошибкой: Something odd')
  })
})
