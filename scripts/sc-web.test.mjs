import { describe, expect, test, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { readFileSync } from 'node:fs'

const script = readFileSync(new URL('../src-tauri/src/sc/like.js', import.meta.url), 'utf8')

const params = { key: 'one', url: 'https://api-v2.soundcloud.com/users/7/track_likes/402?client_id=public', method: 'PUT', token: 'test-token' }

const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0'

async function run(origin, answer, args = params, ua = userAgent) {
  const fetch = vi.fn(answer)
  const window = { navigator: { userAgent: ua } }
  const started = runInNewContext(`(${script})(${JSON.stringify(args)})`, {
    location: { origin }, window, fetch, AbortController,
    setTimeout: () => 1, clearTimeout: () => {}, URL, TextEncoder,
  })
  await vi.waitFor(() => {
    if (started) expect(window.__nocturneScLikes.one.reply).not.toBeNull()
  })
  return { started, fetch, reply: window.__nocturneScLikes?.one.reply }
}

describe('SoundCloud browser request', () => {
  // Oracle values from the sign() function in SoundCloud's 55-240c8d7e.js on 2026-10-20.
  test.each([
    [7, 'public', userAgent, '1:73c1f3'],
    [9, 'other-client', userAgent, '1:5ceeac'],
    [7, 'public', 'Nocturne Тест/1.0', '1:c1201a'],
  ])('signs a follow with the current account, client id and actual browser agent (%s, %s)', async (me, client, ua, signature) => {
    const args = { ...params, method: 'POST', url: `https://api-v2.soundcloud.com/me/followings/12?client_id=${client}`, me }
    const r = await run('https://soundcloud.com', async () => ({ status: 200 }), args, ua)
    const [url, options] = r.fetch.mock.calls[0]
    const sent = new URL(url)
    expect(sent.pathname).toBe('/me/followings/12')
    expect(sent.searchParams.get('signature')).toBe(signature)
    expect(sent.searchParams.get('client_id')).toBe(client)
    expect(options).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(r.reply.status).toBe(200)
  })

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

  test.each(['PUT', 'DELETE'])('changes a playlist like through the browser session (%s)', async (method) => {
    const args = { ...params, method, url: 'https://api-v2.soundcloud.com/users/7/playlist_likes/9002?client_id=public' }
    const r = await run('https://soundcloud.com', async () => ({ status: 204 }), args)
    expect(r.started).toBe(true)
    expect(r.fetch).toHaveBeenCalledWith(args.url, expect.objectContaining({
      method, credentials: 'include', headers: { Authorization: 'OAuth test-token', Accept: 'application/json' },
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
