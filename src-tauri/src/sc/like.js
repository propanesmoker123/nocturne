(p) => {
  if (location.origin !== 'https://soundcloud.com') return false
  const box = window.__nocturneScLikes ||= Object.create(null)
  if (p.poll) {
    const challenge = [...document.querySelectorAll('iframe[src*="captcha-delivery.com"]')].some((frame) =>
      frame.getClientRects().length > 0 && window.getComputedStyle(frame).visibility !== 'hidden')
    return { reply: box[p.key]?.reply ?? null, challenge }
  }
  let requestUrl = p.url
  if (p.method === 'POST') {
    const url = new URL(p.url)
    const target = /^\/me\/followings\/(\d+)$/.exec(url.pathname)?.[1]
    if (!target || !Number.isSafeInteger(p.me) || p.me <= 0) return false
    // SoundCloud's sign(), 55-240c8d7e.js (2026-10-20). The signing salt is shipped publicly
    // with the site. Use this webview's agent and the exact client id the request will carry.
    const salt = '5Dpr3ubBw8LFtbvQcd4Hx6hU'
    const agent = window.navigator.userAgent.split(/[ /]/)
    const message = '1' + salt + url.searchParams.get('client_id') + salt + target + p.me + agent[agent[0].length % agent.length]
    let hash = 7996111
    for (const byte of new TextEncoder().encode(message)) {
      hash = ((hash >> 1) + ((hash & 1) << 23) + byte) & 0xffffff
    }
    url.searchParams.set('signature', '1:' + hash.toString(16))
    requestUrl = url.href
  }
  const controller = new AbortController()
  const entry = box[p.key] = { reply: null, abort: () => controller.abort() }
  const timer = setTimeout(() => controller.abort(), 25000)
  // Use the site's fetch wrapper too: its DataDome integration can display its own challenge.
  fetch(requestUrl, {
    method: p.method,
    credentials: 'include',
    headers: { Authorization: 'OAuth ' + p.token, Accept: 'application/json' },
    signal: controller.signal,
  }).then(async (r) => {
    let captcha = false
    if (r.status === 403) {
      const body = await r.json().catch(() => null)
      if (typeof body?.url === 'string') {
        try {
          const u = new URL(body.url)
          captcha = u.protocol === 'https:' && (u.hostname === 'captcha-delivery.com' || u.hostname.endsWith('.captcha-delivery.com'))
        } catch {}
      }
    }
    entry.reply = { status: r.status, captcha }
  }).catch(() => { entry.reply = { network: true } })
    .finally(() => clearTimeout(timer))
  return true
}
