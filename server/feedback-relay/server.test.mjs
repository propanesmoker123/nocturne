import { describe, expect, it, vi } from 'vitest'
import {
  clientIp,
  createRateLimiter,
  createRelayHandler,
  createRelayStore,
  escapeHtml,
  formatTelegramHtml,
  processTelegramUpdate,
  validatePayload,
} from './server.mjs'

describe('feedback relay server', () => {
  it('validates feedback payloads strictly and strips unsafe characters from metadata', () => {
    expect(validatePayload(null).ok).toBe(false)
    expect(validatePayload({ kind: 'bug', message: '   ' }).ok).toBe(false)
    expect(validatePayload({ kind: 'bug', message: 'hi', clientId: 'short' }).ok).toBe(false)

    const valid = validatePayload({
      kind: 'idea',
      message: 'Добавить эквалайзер <3>',
      contact: '@tester\nspam',
      version: '0.3.5',
      platform: 'windows',
      arch: 'x86_64',
      log: '2026-11-16 line 1\n',
      clientId: 'client_1234567890abcdef',
      clientToken: 'tok_1234567890abcdef1234567890',
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.data.contact).toBe('@tester spam')
      expect(formatTelegramHtml(valid.data)).toContain('&lt;3&gt;')
      expect(formatTelegramHtml(valid.data)).toContain('Ответьте (Reply) сюда')
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
      json: async () => ({ ok: true, result: { message_id: 42, chat: { id: 999 } } }),
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
    expect(JSON.parse(bodyText)).toMatchObject({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.telegram.org/botBOT_TOKEN/sendDocument')
    const sentForm = fetchMock.mock.calls[0]?.[1]?.body
    expect(sentForm).toBeInstanceOf(FormData)
    expect(String(sentForm.get('caption'))).toContain('<b>IP:</b> <code>9.8.7.6</code>')
  })

  it('extracts client IP safely from proxy headers and strips IPv4-mapped prefix', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 95.24.10.2' }, socket: {} })).toBe('95.24.10.2')
    expect(clientIp({ headers: { 'x-real-ip': '::ffff:192.0.2.55' }, socket: {} })).toBe('192.0.2.55')
    expect(clientIp({ headers: {}, socket: { remoteAddress: '::ffff:203.0.113.9' } })).toBe('203.0.113.9')
  })

  it('stores Telegram Reply answers per clientId and enforces token authentication on /inbox', async () => {
    const store = createRelayStore()
    const clientId = 'user-device-12345678'
    const clientToken = 'secret-token-0123456789abcdef'
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 700, chat: { id: 555123 } } }),
    }))

    const handler = createRelayHandler({
      token: 'BOT_TOKEN',
      chatId: '@propsmanxr',
      fetchImpl: fetchMock,
      store,
      readBody: async () => ({
        kind: 'bug',
        message: 'В Spotify не работает трек',
        version: '0.3.7',
        platform: 'windows',
        arch: 'x86_64',
        clientId,
        clientToken,
      }),
    })

    const runReq = async (req) => {
      let code = 0
      let body = ''
      await handler(req, {
        writeHead(c) {
          code = c
        },
        end(chunk) {
          body = String(chunk)
        },
      })
      return { code, json: JSON.parse(body) }
    }

    const postRes = await runReq({ method: 'POST', url: '/nocturne-feedback', headers: {}, socket: {} })
    expect(postRes.code).toBe(200)
    expect(postRes.json.reportId).toMatch(/^r_/)

    // Stranger cannot reply from another Telegram chat
    const spoofRes = await processTelegramUpdate(
      {
        update_id: 1,
        message: {
          message_id: 701,
          chat: { id: 999999, type: 'private', username: 'attacker' },
          from: { id: 999999, is_bot: false, username: 'attacker' },
          reply_to_message: { message_id: 700, from: { is_bot: true } },
          text: 'Взломал',
        },
      },
      { store, token: 'BOT_TOKEN', chatId: '@propsmanxr', fetchImpl: fetchMock },
    )
    expect(spoofRes.handled).toBe(false)

    // Owner replies in Telegram -> routed directly to that client's inbox
    const replyRes = await processTelegramUpdate(
      {
        update_id: 2,
        message: {
          message_id: 702,
          chat: { id: 555123, type: 'private', username: 'propsmanxr' },
          from: { id: 555123, is_bot: false, username: 'propsmanxr' },
          reply_to_message: { message_id: 700, from: { is_bot: true } },
          text: 'Исправлено в 0.3.7, проверь пожалуйста!',
        },
      },
      { store, token: 'BOT_TOKEN', chatId: '@propsmanxr', fetchImpl: fetchMock },
    )
    expect(replyRes).toMatchObject({ handled: true, action: 'reply_saved', clientId })

    // Owner also posts an announcement via /announce
    const annRes = await processTelegramUpdate(
      {
        update_id: 3,
        message: {
          message_id: 703,
          chat: { id: 555123, type: 'private', username: 'propsmanxr' },
          from: { id: 555123, is_bot: false, username: 'propsmanxr' },
          text: '/announce Важно\nВышло обновление 0.3.7',
        },
      },
      { store, token: 'BOT_TOKEN', chatId: '@propsmanxr', fetchImpl: fetchMock },
    )
    expect(annRes).toMatchObject({ handled: true, action: 'announce' })

    // Wrong client token cannot read replies for that clientId
    const badInbox = await runReq({
      method: 'GET',
      url: '/nocturne-feedback/inbox',
      headers: { 'x-nocturne-client': clientId, 'x-nocturne-token': 'wrong-token-0123456789abcdefgh' },
      socket: {},
    })
    expect(badInbox.code).toBe(403)

    // Matching device receives both its targeted reply and global announcement
    const okInbox = await runReq({
      method: 'GET',
      url: '/nocturne-feedback/inbox',
      headers: { 'x-nocturne-client': clientId, 'x-nocturne-token': clientToken },
      socket: {},
    })
    expect(okInbox.code).toBe(200)
    expect(okInbox.json.replies).toHaveLength(1)
    expect(okInbox.json.replies[0]).toMatchObject({
      reportId: postRes.json.reportId,
      reportMessage: 'В Spotify не работает трек',
      message: 'Исправлено в 0.3.7, проверь пожалуйста!',
    })
    expect(okInbox.json.announcements).toHaveLength(1)
    expect(okInbox.json.announcements[0]).toMatchObject({
      title: 'Важно',
      message: 'Вышло обновление 0.3.7',
    })
  })

  it('does not disclose replies left by an expired client registration', async () => {
    const store = createRelayStore()
    const clientId = 'expired-device-12345678'
    const clientToken = 'new-token-0123456789abcdef'
    store.recordReport({ reportId: 'previous', clientId, kind: 'bug', message: 'Prior report', messageIds: [808] })
    store.addOrUpdateReply({ clientId, reportId: 'previous', tgMessageId: 809, message: 'Private reply' })

    const handler = createRelayHandler({ store })
    const req = {
      method: 'GET',
      url: '/nocturne-feedback/inbox',
      headers: { 'x-nocturne-client': clientId, 'x-nocturne-token': clientToken },
      socket: {},
    }
    const response = { writeHead: vi.fn(), end: vi.fn() }
    await handler(req, response)
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
    expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({ replies: [] })

    expect(store.verifyOrRegisterClient(clientId, clientToken).ok).toBe(true)
    expect(store.getInbox(clientId).replies).toEqual([])
    expect(store.findReportByMessageId(808)).toBeNull()
  })

  it('ignores spoofed X-Real-Ip when X-Forwarded-For is set by reverse proxy and ignores forwarded headers from non-loopback peers', () => {
    expect(
      clientIp({
        headers: { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '203.0.113.1, 198.51.100.7' },
        socket: { remoteAddress: '127.0.0.1' },
      }),
    ).toBe('198.51.100.7')

    expect(
      clientIp({
        headers: { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '198.51.100.7' },
        socket: { remoteAddress: '203.0.113.42' },
      }),
    ).toBe('203.0.113.42')
  })

  it('bounds rate-limiter map size under distinct-IP floods without losing recent entries', () => {
    const allow = createRateLimiter({ max: 1, windowMs: 60_000, maxKeys: 16 })
    for (let i = 0; i < 64; i++) {
      expect(allow(`198.51.100.${i}`, 1000 + i)).toBe(true)
    }
    // Most recent IP is still rate-limited within the window
    expect(allow('198.51.100.63', 2000)).toBe(false)
    // Oldest IP was evicted due to bounded capacity
    expect(allow('198.51.100.0', 2000)).toBe(true)
  })

  it('does not register a new client when Telegram delivery fails', async () => {
    const store = createRelayStore()
    const clientId = 'failed-delivery-12345678'
    const clientToken = 'secret-token-0123456789abcdef'
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ ok: false }),
    }))
    const handler = createRelayHandler({
      token: 'BOT_TOKEN',
      chatId: '999',
      fetchImpl: fetchMock,
      store,
      readBody: async () => ({
        kind: 'bug',
        message: 'Broken upstream',
        version: '0.3.9',
        platform: 'windows',
        arch: 'x86_64',
        clientId,
        clientToken,
      }),
    })
    const res = { writeHead: vi.fn(), end: vi.fn() }
    await handler({ method: 'POST', url: '/', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
    expect(res.writeHead).toHaveBeenCalledWith(502, expect.any(Object))
    expect(store.verifyClient(clientId, clientToken)).toBe('unknown')
  })

  it('keeps Telegram sendMessage plain text within 4096 chars even for MAX_MESSAGE_CHARS payloads', () => {
    const longMsg = 'A'.repeat(4000)
    const html = formatTelegramHtml({
      kind: 'bug',
      message: longMsg,
      contact: '@someone_with_long_handle_1234567890',
      version: '0.3.9',
      platform: 'windows',
      arch: 'x86_64',
      ip: '203.0.113.9',
      clientId: 'client_1234567890abcdef',
    })
    const plain = html.replace(/<[^>]+>/g, '')
    expect(plain.length).toBeLessThanOrEqual(4096)
  })

  it('respects numeric TELEGRAM_CHAT_ID over stale persisted ownerChatId and accepts channel_post announcements', async () => {
    const store = createRelayStore()
    store.setOwnerChatId('111111')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 10 } }),
    }))

    // Old cached ownerChatId must NOT be authorized when configured chatId is a different numeric ID
    const staleRes = await processTelegramUpdate(
      {
        update_id: 10,
        message: {
          message_id: 800,
          chat: { id: 111111, type: 'private' },
          from: { id: 111111, is_bot: false },
          text: '/announce Stale\nShould be ignored',
        },
      },
      { store, token: 'BOT_TOKEN', chatId: '-100222333444', fetchImpl: fetchMock },
    )
    expect(staleRes.handled).toBe(false)

    // Channel posts from the configured numeric channel ID are handled
    const chanRes = await processTelegramUpdate(
      {
        update_id: 11,
        channel_post: {
          message_id: 801,
          chat: { id: -100222333444, type: 'channel' },
          text: '/announce Канал\nНовость из канала',
        },
      },
      { store, token: 'BOT_TOKEN', chatId: '-100222333444', fetchImpl: fetchMock },
    )
    expect(chanRes).toMatchObject({ handled: true, action: 'announce' })
  })
})
