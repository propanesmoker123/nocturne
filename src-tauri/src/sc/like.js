(p) => {
  if (location.origin !== 'https://soundcloud.com') return false
  const box = window.__nocturneScLikes ||= Object.create(null)
  if (p.poll) {
    const challenge = [...document.querySelectorAll('iframe[src*="captcha-delivery.com"]')].some((frame) =>
      frame.getClientRects().length > 0 && window.getComputedStyle(frame).visibility !== 'hidden')
    return { reply: box[p.key]?.reply ?? null, challenge }
  }
  const controller = new AbortController()
  const entry = box[p.key] = { reply: null, abort: () => controller.abort() }
  const timer = setTimeout(() => controller.abort(), 25000)
  // Use the site's fetch wrapper too: its DataDome integration can display its own challenge.
  fetch(p.url, {
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
