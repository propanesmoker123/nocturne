import { describe, expect, it, vi } from 'vitest'
import { createRateLimiter, createRelayHandler, escapeHtml, formatTelegramHtml, validatePayload } from './server.mjs'

describe('feedback relay server', () => {
  it('validates feedback payloads strictly and strips unsafe characters from metadata', () => {
    expect(validatePayload(null).ok).toBe(false)
    expect(validatePayload({ kind: 'bug', message: '   ' }).ok).toBe(false)

    const valid = validatePayload({
      kind: 'idea',
      message: 'Добавить эквалайзер <3>',
      contact: '@tester\nspam',
      version: '0.3.5',
      platform: 'windows',
      arch: 'x86_64',
      log: '2026-11-16 line 1\n',
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.data.contact).toBe('@tester spam')
      expect(formatTelegramHtml(valid.data)).toContain('&lt;3&gt;')
      expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    }
  })

  it('rate-limits repeated submissions per IP within the window', () => {
    const allow = createRateLimiter({ max: 2, windowMs: 60_000 })
    expect(allow('1.2.3.4', 1000)).toBe(true)
    expect(allow('1.2.3.4', 2000)).toBe(true)
    expect(allow('1.2.3.4', 3000)).toBe(false)
    expect(allow('5.6.7.8', 3000)).toBe(true)
    expect(allow('1.2.3.4', 65_000)).toBe(true)
  })

  it('delivers short bug reports with attached log via Telegram sendDocument', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    }))
    const handler = createRelayHandler({
      token: 'BOT_TOKEN',
      chatId: '999',
      fetchImpl: fetchMock,
      readBody: async () => ({
        kind: 'bug',
        message: 'Не входит в SoundCloud',
        version: '0.3.5',
        platform: 'windows',
        arch: 'x86_64',
        log: '2026-11-16 13:06:53 UTC [sc] popup #0 created\n',
      }),
    })

    let statusCode = 0
    let bodyText = ''
    const req = { method: 'POST', url: '/nocturne-feedback', headers: { 'x-forwarded-for': '9.8.7.6' }, socket: {} }
    const res = {
      writeHead(code) {
        statusCode = code
      },
      end(chunk) {
        bodyText = String(chunk)
      },
    }

    await handler(req, res)
    expect(statusCode).toBe(200)
    expect(JSON.parse(bodyText)).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.telegram.org/botBOT_TOKEN/sendDocument')
  })
})
