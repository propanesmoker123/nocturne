import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_BODY_BYTES = 220 * 1024
export const MAX_MESSAGE_CHARS = 4000
export const MAX_CONTACT_CHARS = 160
export const MAX_META_CHARS = 64
export const MAX_LOG_CHARS = 140_000
export const MAX_REPLY_CHARS = 2000
const TELEGRAM_CAPTION_LIMIT = 900
const MAX_REPORTS_TRACKED = 3000
const MAX_REPLIES_PER_CLIENT = 50
const MAX_ANNOUNCEMENTS = 20
const MAX_CLIENTS = 10_000

const ALLOWED_KINDS = new Set(['bug', 'idea', 'other'])
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
const CLIENT_TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function cleanShort(val, max) {
  if (typeof val !== 'string') return ''
  return val.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max)
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

function previewText(text, max = 110) {
  const one = String(text || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

export function validatePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'Expected JSON object' }
  }
  const kind = ALLOWED_KINDS.has(raw.kind) ? raw.kind : 'bug'
  const message = typeof raw.message === 'string' ? raw.message.trim() : ''
  if (!message) {
    return { ok: false, status: 400, error: 'Message is required' }
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, status: 400, error: `Message exceeds ${MAX_MESSAGE_CHARS} characters` }
  }
  const hasId = raw.clientId !== undefined && raw.clientId !== null && raw.clientId !== ''
  const hasTok = raw.clientToken !== undefined && raw.clientToken !== null && raw.clientToken !== ''
  let clientId = ''
  let clientToken = ''
  if (hasId || hasTok) {
    if (typeof raw.clientId !== 'string' || !CLIENT_ID_RE.test(raw.clientId.trim())) {
      return { ok: false, status: 400, error: 'Invalid clientId' }
    }
    if (typeof raw.clientToken !== 'string' || !CLIENT_TOKEN_RE.test(raw.clientToken.trim())) {
      return { ok: false, status: 400, error: 'Invalid clientToken' }
    }
    clientId = raw.clientId.trim()
    clientToken = raw.clientToken.trim()
  }
  const contact = cleanShort(raw.contact, MAX_CONTACT_CHARS)
  const version = cleanShort(raw.version, MAX_META_CHARS) || 'unknown'
  const platform = cleanShort(raw.platform, MAX_META_CHARS) || 'unknown'
  const arch = cleanShort(raw.arch, MAX_META_CHARS) || ''
  const log = typeof raw.log === 'string' ? raw.log.slice(-MAX_LOG_CHARS) : ''
  return {
    ok: true,
    data: { kind, message, contact, version, platform, arch, log, clientId, clientToken },
  }
}

export function formatTelegramHtml(data) {
  const badge =
    data.kind === 'idea'
      ? '💡 Идея / пожелание'
      : data.kind === 'other'
        ? '💬 Обратная связь'
        : '🐛 Ошибка (баг)'
  const env = [data.platform, data.arch].filter(Boolean).join(' ')
  const lines = [
    `<b>${badge}</b> · Nocturne <code>${escapeHtml(data.version)}</code> (${escapeHtml(env)})`,
    '',
    escapeHtml(data.message),
  ]
  const meta = []
  if (data.contact) meta.push(`<b>Контакт:</b> ${escapeHtml(data.contact)}`)
  if (data.ip) meta.push(`<b>IP:</b> <code>${escapeHtml(data.ip)}</code>`)
  if (data.clientId) {
    meta.push(`<b>Устройство:</b> <code>${escapeHtml(data.clientId.slice(0, 8))}</code> · <i>Ответьте (Reply) сюда для ответа в Nocturne</i>`)
  }
  if (meta.length) {
    lines.push('', ...meta)
  }
  return lines.join('\n')
}

export function createRateLimiter({ max = 6, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map()
  return function allow(ip, now = Date.now()) {
    const key = String(ip || 'unknown')
    if (hits.size > 4096) {
      for (const [k, ts] of hits) {
        if (!ts.length || now - ts[ts.length - 1] > windowMs) hits.delete(k)
      }
    }
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs)
    if (list.length >= max) {
      hits.set(key, list)
      return false
    }
    list.push(now)
    hits.set(key, list)
    return true
  }
}

export function createRelayStore(stateFile = '') {
  const empty = () => ({
    updateOffset: 0,
    ownerChatId: '',
    clientTokens: {},
    reportsByMsg: {},
    replies: {},
    announcements: [],
  })

  let state = empty()
  let persistDisabled = !stateFile

  if (stateFile) {
    try {
      if (fs.existsSync(stateFile)) {
        const loaded = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        if (loaded && typeof loaded === 'object') {
          state = {
            ...empty(),
            updateOffset: Number.isFinite(loaded.updateOffset) ? loaded.updateOffset : 0,
            ownerChatId: typeof loaded.ownerChatId === 'string' ? loaded.ownerChatId : '',
            clientTokens: loaded.clientTokens && typeof loaded.clientTokens === 'object' ? loaded.clientTokens : {},
            reportsByMsg: loaded.reportsByMsg && typeof loaded.reportsByMsg === 'object' ? loaded.reportsByMsg : {},
            replies: loaded.replies && typeof loaded.replies === 'object' ? loaded.replies : {},
            announcements: Array.isArray(loaded.announcements) ? loaded.announcements : [],
          }
        }
      }
    } catch (err) {
      console.error(`[relay-store] load error (${stateFile}): ${err?.message || err}`)
    }
  }

  function flush() {
    if (persistDisabled || !stateFile) return
    try {
      const dir = path.dirname(stateFile)
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${stateFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      fs.renameSync(tmp, stateFile)
    } catch (err) {
      persistDisabled = true
      console.error(`[relay-store] persist disabled (${stateFile}): ${err?.message || err}`)
    }
  }

  function trimObject(obj, limit) {
    const keys = Object.keys(obj)
    const removed = keys.slice(0, Math.max(0, keys.length - limit))
    for (const key of removed) {
      delete obj[key]
    }
    return removed
  }

  function removeClientData(clientId) {
    delete state.replies[clientId]
    for (const [messageId, report] of Object.entries(state.reportsByMsg)) {
      if (report?.clientId === clientId) delete state.reportsByMsg[messageId]
    }
  }

  return {
    getUpdateOffset() {
      return state.updateOffset
    },
    setUpdateOffset(nextOffset) {
      if (Number.isFinite(nextOffset) && nextOffset > state.updateOffset) {
        state.updateOffset = nextOffset
        flush()
      }
    },
    getOwnerChatId() {
      return state.ownerChatId
    },
    setOwnerChatId(cid) {
      const clean = cid ? String(cid) : ''
      if (clean && clean !== state.ownerChatId) {
        state.ownerChatId = clean
        flush()
      }
    },
    verifyOrRegisterClient(clientId, token) {
      if (!clientId) return { ok: true, registered: false }
      const incomingHash = hashToken(token)
      const existing = state.clientTokens[clientId]
      if (existing) {
        return { ok: safeEqualHex(existing, incomingHash), registered: true }
      }
      // A new token must never inherit reports or replies from an older registration.
      removeClientData(clientId)
      state.clientTokens[clientId] = incomingHash
      for (const evicted of trimObject(state.clientTokens, MAX_CLIENTS)) {
        removeClientData(evicted)
      }
      flush()
      return { ok: true, registered: true }
    },
    verifyClient(clientId, token) {
      if (!clientId || !token) return 'invalid'
      const existing = state.clientTokens[clientId]
      if (!existing) return 'unknown'
      return safeEqualHex(existing, hashToken(token)) ? 'ok' : 'mismatch'
    },
    recordReport({ reportId, clientId, kind, message, messageIds }) {
      const entry = {
        reportId,
        clientId: clientId || '',
        kind,
        preview: previewText(message),
        createdAt: Date.now(),
      }
      for (const mid of messageIds) {
        if (mid === undefined || mid === null) continue
        state.reportsByMsg[String(mid)] = entry
      }
      trimObject(state.reportsByMsg, MAX_REPORTS_TRACKED)
      flush()
    },
    findReportByMessageId(msgId) {
      return state.reportsByMsg[String(msgId)] ?? null
    },
    addOrUpdateReply({ clientId, reportId, reportPreview, kind, tgMessageId, message }) {
      if (!clientId) return null
      const list = Array.isArray(state.replies[clientId]) ? state.replies[clientId] : []
      const existing = tgMessageId ? list.find((r) => r.tgMessageId === String(tgMessageId)) : null
      if (existing) {
        existing.message = String(message).slice(0, MAX_REPLY_CHARS)
        existing.updatedAt = Date.now()
        flush()
        return { item: existing, updated: true }
      }
      const item = {
        id: `rep_${crypto.randomUUID()}`,
        tgMessageId: tgMessageId ? String(tgMessageId) : '',
        reportId: reportId || '',
        reportMessage: reportPreview || '',
        kind: kind || 'bug',
        message: String(message).slice(0, MAX_REPLY_CHARS),
        createdAt: Date.now(),
      }
      list.push(item)
      if (list.length > MAX_REPLIES_PER_CLIENT) {
        list.splice(0, list.length - MAX_REPLIES_PER_CLIENT)
      }
      state.replies[clientId] = list
      flush()
      return { item, updated: false }
    },
    addOrUpdateAnnouncement({ tgMessageId, title, message }) {
      const existing = tgMessageId ? state.announcements.find((a) => a.tgMessageId === String(tgMessageId)) : null
      if (existing) {
        existing.title = cleanShort(title, 120) || 'Новость Nocturne'
        existing.message = String(message).slice(0, MAX_REPLY_CHARS)
        existing.updatedAt = Date.now()
        flush()
        return { item: existing, updated: true }
      }
      const item = {
        id: `ann_${crypto.randomUUID()}`,
        tgMessageId: tgMessageId ? String(tgMessageId) : '',
        title: cleanShort(title, 120) || 'Новость Nocturne',
        message: String(message).slice(0, MAX_REPLY_CHARS),
        createdAt: Date.now(),
      }
      state.announcements.unshift(item)
      if (state.announcements.length > MAX_ANNOUNCEMENTS) {
        state.announcements.length = MAX_ANNOUNCEMENTS
      }
      flush()
      return { item, updated: false }
    },
    clearAnnouncements() {
      state.announcements = []
      flush()
    },
    getInbox(clientId) {
      const rawReplies = Array.isArray(state.replies[clientId]) ? state.replies[clientId] : []
      const replies = rawReplies.map(({ tgMessageId: _tg, ...rest }) => rest).sort((a, b) => b.createdAt - a.createdAt)
      const announcements = state.announcements.map(({ tgMessageId: _tg, ...rest }) => rest)
      return { replies, announcements }
    },
  }
}

async function telegramPost(fetchImpl, token, method, payload, isMultipart = false) {
  const url = `https://api.telegram.org/bot${token}/${method}`
  const res = await fetchImpl(
    url,
    isMultipart
      ? { method: 'POST', body: payload }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
  )
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.ok) {
    throw new Error(`Telegram ${method} failed (HTTP ${res.status})`)
  }
  return body.result
}

export async function deliverToTelegram(data, { token, chatId, fetchImpl = fetch }) {
  const html = formatTelegramHtml(data)
  if (!data.log) {
    const res = await telegramPost(fetchImpl, token, 'sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    return {
      messageIds: res?.message_id ? [res.message_id] : [],
      chatId: res?.chat?.id !== undefined ? String(res.chat.id) : '',
    }
  }

  const filename = `nocturne-${data.version.replace(/[^a-zA-Z0-9._-]/g, '_')}.log`
  const makeForm = (extra) => {
    const form = new FormData()
    form.set('chat_id', String(chatId))
    for (const [k, v] of Object.entries(extra)) {
      form.set(k, String(v))
    }
    form.set('document', new Blob([data.log], { type: 'text/plain; charset=utf-8' }), filename)
    return form
  }

  if (html.length <= TELEGRAM_CAPTION_LIMIT) {
    const doc = await telegramPost(
      fetchImpl,
      token,
      'sendDocument',
      makeForm({ caption: html, parse_mode: 'HTML' }),
      true,
    )
    return {
      messageIds: doc?.message_id ? [doc.message_id] : [],
      chatId: doc?.chat?.id !== undefined ? String(doc.chat.id) : '',
    }
  }

  const msg = await telegramPost(fetchImpl, token, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
  const replyParams = msg?.message_id ? { reply_parameters: JSON.stringify({ message_id: msg.message_id }) } : {}
  const doc = await telegramPost(fetchImpl, token, 'sendDocument', makeForm(replyParams), true)
  return {
    messageIds: [msg?.message_id, doc?.message_id].filter((x) => x !== undefined && x !== null),
    chatId: msg?.chat?.id !== undefined ? String(msg.chat.id) : '',
  }
}

function isOwnerMessage(msg, configuredChatId, knownOwnerChatId) {
  const cid = msg?.chat?.id !== undefined ? String(msg.chat.id) : ''
  if (!cid) return false
  if (knownOwnerChatId && cid === String(knownOwnerChatId)) return true
  const expected = String(configuredChatId || '').trim()
  if (/^-?\d+$/.test(expected) && cid === expected) return true
  if (expected.startsWith('@')) {
    const handle = expected.slice(1).toLowerCase()
    if (msg?.chat?.username?.toLowerCase() === handle) return true
    if (msg?.from?.username?.toLowerCase() === handle && msg?.chat?.type === 'private') return true
  }
  return false
}

export async function processTelegramUpdate(update, { store, token, chatId, fetchImpl = fetch }) {
  const isEdit = Boolean(update?.edited_message && !update?.message)
  const msg = update?.message || update?.edited_message
  if (!msg || typeof msg !== 'object') return { handled: false }
  if (msg.from?.is_bot) return { handled: false }
  if (!isOwnerMessage(msg, chatId, store.getOwnerChatId())) return { handled: false }
  if (msg.chat?.id !== undefined && msg.chat?.type === 'private') {
    store.setOwnerChatId(String(msg.chat.id))
  }

  const text = String(msg.text || msg.caption || '').trim()
  if (!text) return { handled: false }
  const replyChat = msg.chat.id

  const confirm = async (notice) => {
    if (isEdit) return
    try {
      await telegramPost(fetchImpl, token, 'sendMessage', {
        chat_id: replyChat,
        text: notice,
        reply_parameters: { message_id: msg.message_id },
      })
    } catch {}
  }

  if (/^\/announce_clear(?:@\w+)?\b/i.test(text) && !isEdit) {
    store.clearAnnouncements()
    await confirm('🗑 Объявления очищены.')
    return { handled: true, action: 'announce_clear' }
  }

  const annMatch = text.match(/^\/announce(?:@\w+)?(?:\s+([\s\S]+))?$/i)
  if (annMatch) {
    const body = (annMatch[1] || '').trim()
    if (!body) {
      await confirm('Использование: /announce Заголовок (первая строка)\nТекст объявления')
      return { handled: true, action: 'announce_help' }
    }
    const parts = body.split(/\r?\n/)
    const hasTitle = parts.length > 1 && parts[0].trim().length > 0 && parts[0].trim().length <= 100
    const title = hasTitle ? parts[0].trim() : 'Объявление'
    const content = hasTitle ? parts.slice(1).join('\n').trim() : body
    if (!content) {
      await confirm('⚠️ Добавьте текст объявления после заголовка.')
      return { handled: true, action: 'announce_empty' }
    }
    store.addOrUpdateAnnouncement({ tgMessageId: String(msg.message_id), title, message: content })
    await confirm(isEdit ? '✅ Объявление обновлено.' : '✅ Объявление опубликовано — появится в колокольчике Nocturne.')
    return { handled: true, action: 'announce' }
  }

  const replyToId = msg.reply_to_message?.message_id
  if (replyToId !== undefined && replyToId !== null) {
    const report = store.findReportByMessageId(String(replyToId))
    if (!report) {
      if (msg.reply_to_message?.from?.is_bot && !isEdit) {
        await confirm('⚠️ Не найден отчёт по этому сообщению (возможно, оно не из баг-репорта или релей перезапущен без тома данных).')
      }
      return { handled: false }
    }
    if (!report.clientId) {
      await confirm('⚠️ Этот репорт отправлен со старой версии Nocturne без ID устройства — ответить прямо в приложение нельзя.')
      return { handled: true, action: 'legacy_report' }
    }
    if (text.length > MAX_REPLY_CHARS) {
      await confirm(`⚠️ Ответ длиннее ${MAX_REPLY_CHARS} символов — сократите текст.`)
      return { handled: true, action: 'reply_too_long' }
    }
    store.addOrUpdateReply({
      clientId: report.clientId,
      reportId: report.reportId,
      reportPreview: report.preview,
      kind: report.kind,
      tgMessageId: String(msg.message_id),
      message: text,
    })
    await confirm('✅ Ответ сохранён — пользователь увидит его в колокольчике Nocturne.')
    return { handled: true, action: isEdit ? 'reply_updated' : 'reply_saved', clientId: report.clientId }
  }

  return { handled: false }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }))
      }
    })
    req.on('error', () => reject(Object.assign(new Error('Read error'), { status: 400 })))
  })
}

function normalizeIp(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^::ffff:/i, '')
}

export function clientIp(req) {
  const real = req.headers?.['x-real-ip']
  const realIp = normalizeIp(Array.isArray(real) ? real[real.length - 1] : real)
  if (realIp) return realIp

  const xff = req.headers?.['x-forwarded-for']
  const xffRaw = Array.isArray(xff) ? xff.join(',') : xff
  if (typeof xffRaw === 'string' && xffRaw.trim()) {
    // Use the right-most hop added by the trusted reverse proxy rather than an untrusted left-most header value.
    const parts = xffRaw
      .split(',')
      .map(normalizeIp)
      .filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }

  return normalizeIp(req.socket?.remoteAddress) || 'unknown'
}

function normalizeRoute(rawUrl) {
  const pathOnly = (rawUrl || '/').split('?')[0]
  const trimmed = pathOnly.length > 1 ? pathOnly.replace(/\/+$/, '') : pathOnly
  if (trimmed === '/health' || trimmed === '/nocturne-feedback/health' || trimmed === '/feedback/health') {
    return '/health'
  }
  if (trimmed === '/inbox' || trimmed === '/nocturne-feedback/inbox' || trimmed === '/feedback/inbox') {
    return '/inbox'
  }
  if (trimmed === '/' || trimmed === '/nocturne-feedback' || trimmed === '/feedback') {
    return '/'
  }
  return trimmed
}

function jsonReply(res, status, obj) {
  const payload = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function createRelayHandler({
  token,
  chatId,
  fetchImpl = fetch,
  allowIp = createRateLimiter(),
  allowInboxIp = createRateLimiter({ max: 60, windowMs: 10 * 60 * 1000 }),
  store = createRelayStore(),
  readBody = (req) => readJsonBody(req, MAX_BODY_BYTES),
}) {
  return async (req, res) => {
    const route = normalizeRoute(req.url)
    if (req.method === 'GET' && route === '/health') {
      return jsonReply(res, 200, { ok: true })
    }

    const ip = clientIp(req)
    if (req.method === 'GET' && route === '/inbox') {
      if (!allowInboxIp(ip)) {
        return jsonReply(res, 429, { ok: false, error: 'Too many requests' })
      }
      const cidRaw = req.headers?.['x-nocturne-client']
      const tokRaw = req.headers?.['x-nocturne-token']
      const clientId = typeof cidRaw === 'string' ? cidRaw.trim() : ''
      const clientToken = typeof tokRaw === 'string' ? tokRaw.trim() : ''
      if (!CLIENT_ID_RE.test(clientId) || !CLIENT_TOKEN_RE.test(clientToken)) {
        return jsonReply(res, 400, { ok: false, error: 'Invalid client credentials' })
      }
      const auth = store.verifyClient(clientId, clientToken)
      if (auth === 'mismatch') {
        return jsonReply(res, 403, { ok: false, error: 'Unauthorized client token' })
      }
      const inbox = store.getInbox(auth === 'ok' ? clientId : '')
      return jsonReply(res, 200, { ok: true, ...inbox })
    }

    if (req.method !== 'POST' || route !== '/') {
      return jsonReply(res, 404, { ok: false, error: 'Not found' })
    }
    if (!allowIp(ip)) {
      return jsonReply(res, 429, { ok: false, error: 'Too many requests' })
    }

    let raw
    try {
      raw = await readBody(req)
    } catch (err) {
      return jsonReply(res, err?.status || 400, { ok: false, error: err?.message || 'Bad request' })
    }

    const parsed = validatePayload(raw)
    if (!parsed.ok) {
      return jsonReply(res, parsed.status, { ok: false, error: parsed.error })
    }

    if (parsed.data.clientId) {
      const reg = store.verifyOrRegisterClient(parsed.data.clientId, parsed.data.clientToken)
      if (!reg.ok) {
        return jsonReply(res, 403, { ok: false, error: 'Client token mismatch' })
      }
    }

    const reportId = `r_${crypto.randomUUID()}`
    try {
      const sent = await deliverToTelegram({ ...parsed.data, ip }, { token, chatId, fetchImpl })
      if (sent.chatId) store.setOwnerChatId(sent.chatId)
      if (sent.messageIds.length) {
        store.recordReport({
          reportId,
          clientId: parsed.data.clientId,
          kind: parsed.data.kind,
          message: parsed.data.message,
          messageIds: sent.messageIds,
        })
      }
      console.log(`[feedback] delivered kind=${parsed.data.kind} ip=${ip} logBytes=${parsed.data.log.length}`)
      return jsonReply(res, 200, { ok: true, reportId })
    } catch (err) {
      console.error(`[feedback] delivery error: ${err?.message || err}`)
      return jsonReply(res, 502, { ok: false, error: 'Upstream delivery failed' })
    }
  }
}

async function runTelegramPolling({ token, chatId, store, fetchImpl = fetch }) {
  let backoffMs = 2000
  while (true) {
    try {
      const offset = store.getUpdateOffset()
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=25&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message']))}`
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(35_000) })
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.ok) {
        throw new Error(`getUpdates HTTP ${res.status}`)
      }
      backoffMs = 2000
      for (const upd of body.result ?? []) {
        await processTelegramUpdate(upd, { store, token, chatId, fetchImpl })
        if (Number.isFinite(upd?.update_id)) {
          store.setUpdateOffset(upd.update_id + 1)
        }
      }
    } catch (err) {
      console.error(`[telegram-poll] ${err?.message || err}`)
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs = Math.min(30_000, backoffMs * 2)
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variable')
    process.exit(1)
  }
  const host = process.env.BIND_HOST || '127.0.0.1'
  const port = Number(process.env.PORT || 8787)
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 10 * 60 * 1000)
  const max = Number(process.env.RATE_LIMIT_MAX || 6)
  const stateFile = process.env.STATE_FILE?.trim() || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'relay-state.json') : '/tmp/nocturne-relay-state.json')
  const store = createRelayStore(stateFile)
  const handler = createRelayHandler({
    token,
    chatId,
    store,
    allowIp: createRateLimiter({ max, windowMs }),
  })
  const server = http.createServer((req, res) => void handler(req, res))
  server.listen(port, host, () => {
    console.log(`Nocturne feedback relay listening on http://${host}:${port} (state=${stateFile})`)
  })
  if (process.env.POLL_TELEGRAM !== '0') {
    void runTelegramPolling({ token, chatId, store })
  }
}
