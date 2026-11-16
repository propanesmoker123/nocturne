import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const MAX_BODY_BYTES = 220 * 1024
export const MAX_MESSAGE_CHARS = 4000
export const MAX_CONTACT_CHARS = 160
export const MAX_META_CHARS = 64
export const MAX_LOG_CHARS = 140_000
const TELEGRAM_CAPTION_LIMIT = 900

const ALLOWED_KINDS = new Set(['bug', 'idea', 'other'])

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
  const contact = cleanShort(raw.contact, MAX_CONTACT_CHARS)
  const version = cleanShort(raw.version, MAX_META_CHARS) || 'unknown'
  const platform = cleanShort(raw.platform, MAX_META_CHARS) || 'unknown'
  const arch = cleanShort(raw.arch, MAX_META_CHARS) || ''
  const log = typeof raw.log === 'string' ? raw.log.slice(-MAX_LOG_CHARS) : ''
  return {
    ok: true,
    data: { kind, message, contact, version, platform, arch, log },
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
  if (data.contact) {
    lines.push('', `<b>Контакт:</b> ${escapeHtml(data.contact)}`)
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
    await telegramPost(fetchImpl, token, 'sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
    return
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
    await telegramPost(
      fetchImpl,
      token,
      'sendDocument',
      makeForm({ caption: html, parse_mode: 'HTML' }),
      true,
    )
    return
  }

  const msg = await telegramPost(fetchImpl, token, 'sendMessage', {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
  const replyParams = msg?.message_id ? { reply_parameters: JSON.stringify({ message_id: msg.message_id }) } : {}
  await telegramPost(fetchImpl, token, 'sendDocument', makeForm(replyParams), true)
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

function clientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim()
  }
  const real = req.headers['x-real-ip']
  if (typeof real === 'string' && real.trim()) return real.trim()
  return req.socket?.remoteAddress || 'unknown'
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
  readBody = (req) => readJsonBody(req, MAX_BODY_BYTES),
}) {
  return async (req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (req.method === 'GET' && path === '/health') {
      return jsonReply(res, 200, { ok: true })
    }
    if (req.method !== 'POST' || (path !== '/' && path !== '/nocturne-feedback' && path !== '/feedback')) {
      return jsonReply(res, 404, { ok: false, error: 'Not found' })
    }
    const ip = clientIp(req)
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

    try {
      await deliverToTelegram(parsed.data, { token, chatId, fetchImpl })
      console.log(`[feedback] delivered kind=${parsed.data.kind} logBytes=${parsed.data.log.length}`)
      return jsonReply(res, 200, { ok: true })
    } catch (err) {
      console.error(`[feedback] delivery error: ${err?.message || err}`)
      return jsonReply(res, 502, { ok: false, error: 'Upstream delivery failed' })
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
  const handler = createRelayHandler({
    token,
    chatId,
    allowIp: createRateLimiter({ max, windowMs }),
  })
  const server = http.createServer((req, res) => void handler(req, res))
  server.listen(port, host, () => {
    console.log(`Nocturne feedback relay listening on http://${host}:${port}`)
  })
}
