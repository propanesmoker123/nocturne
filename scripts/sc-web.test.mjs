import { describe, expect, test, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'

const script = readFileSync(new URL('../src-tauri/src/sc/like.js', import.meta.url), 'utf8')

const params = { key: 'one', url: 'https://api-v2.soundcloud.com/users/7/track_likes/402?client_id=public', method: 'PUT', token: 'test-token' }

async function run(origin, answer) {
  const fetch = vi.fn(answer)
  const window = {}
  const started = runInNewContext(`(${script})(${JSON.stringify(params)})`, {
    location: { origin }, window, fetch, AbortController,
    setTimeout: () => 1, clearTimeout: () => {}, URL,
  })
  await vi.waitFor(() => {
    if (started) expect(window.__nocturneScLikes.one.reply).not.toBeNull()
  })
  return { started, fetch, reply: window.__nocturneScLikes?.one.reply }
}

describe('SoundCloud browser request', () => {
  test('polling detects only visible challenges while the site holds a fetch', () => {
    const poll = (visible) => runInNewContext(`(${script})({key: 'one', poll: true})`, {
      location: { origin: 'https://soundcloud.com' },
      window: { __nocturneScLikes: { one: { reply: null } }, getComputedStyle: () => ({ visibility: 'visible' }) },
      document: { querySelectorAll: () => [{ getClientRects: () => visible ? [{}] : [] }] },
    })
    expect(poll(true)).toEqual({ reply: null, challenge: true })
    expect(poll(false)).toEqual({ reply: null, challenge: false })
  })

  test('uses the browser session and accepts an empty 204 response', async () => {
    const r = await run('https://soundcloud.com', async () => ({ status: 204 }))
    expect(r.started).toBe(true)
    expect(r.fetch).toHaveBeenCalledWith(params.url, expect.objectContaining({
      method: 'PUT', credentials: 'include', headers: { Authorization: 'OAuth test-token', Accept: 'application/json' },
    }))
    expect(r.reply).toEqual({ status: 204, captcha: false })
  })

  test('never sends the key from another origin', async () => {
    const r = await run('https://soundcloud.com.evil.test', async () => ({ status: 200 }))
    expect(r.started).toBe(false)
    expect(r.fetch).not.toHaveBeenCalled()
  })

  test('reports a DataDome challenge without navigating or claiming success', async () => {
    const r = await run('https://soundcloud.com', async () => ({ status: 403, json: async () => ({ url: 'https://geo.captcha-delivery.com/captcha/?test' }) }))
    expect(r.reply).toEqual({ status: 403, captcha: true })
    expect(r.fetch).toHaveBeenCalledOnce()
  })

  test('ordinary 403s and network errors stay failures', async () => {
    expect((await run('https://soundcloud.com', async () => ({ status: 403, json: async () => ({ message: 'denied' }) }))).reply).toEqual({ status: 403, captcha: false })
    expect((await run('https://soundcloud.com', async () => { throw new Error('network') })).reply).toEqual({ network: true })
  })
})
