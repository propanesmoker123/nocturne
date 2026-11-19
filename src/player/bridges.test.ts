import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RGB } from '../lib/color'
import type { Track } from '../vk/models'

const h = vi.hoisted(() => {
  const accentCalls: Array<string | undefined> = []
  const pending = new Map<string, (rgb: RGB | null) => void>()
  let immediate = new Map<string, RGB | null>()
  return {
    accentCalls,
    pending,
    setImmediate(url: string, rgb: RGB | null) {
      immediate.set(url, rgb)
    },
    reset() {
      accentCalls.length = 0
      pending.clear()
      immediate = new Map()
    },
    artworkAccent: (url: string | undefined): Promise<RGB | null> => {
      accentCalls.push(url)
      if (!url) return Promise.resolve(null)
      if (immediate.has(url)) return Promise.resolve(immediate.get(url) ?? null)
      return new Promise<RGB | null>((resolve) => {
        pending.set(url, resolve)
      })
    },
  }
})

vi.mock('../lib/color', () => ({
  artworkAccent: h.artworkAccent,
  toCss: ({ r, g, b }: RGB) => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`,
}))
vi.mock('../lib/tauri', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => null),
  emitTo: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}))
vi.mock('../lib/persist', () => ({
  loadJSON: async () => null,
  saveJSON: async () => {},
  debouncedSaver: () => ({ save() {}, flush() {} }),
}))

const cssProps = new Map<string, string>()
const fakeDoc = {
  documentElement: {
    style: {
      setProperty(k: string, v: string) { cssProps.set(k, v) },
      getPropertyValue(k: string) { return cssProps.get(k) ?? '' },
    },
  },
}
class FakeAudio extends EventTarget {
  preload = 'auto'
  src = ''
  paused = true
  ended = false
  muted = false
  volume = 1
  currentTime = 0
  duration = 0
  readyState = 4
  buffered = { length: 0, start: () => 0, end: () => 0 }
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  load() {}
  removeAttribute() { this.src = '' }
}
;(globalThis as Record<string, unknown>).document = fakeDoc
;(globalThis as Record<string, unknown>).Audio = FakeAudio

const { usePlayer } = await import('./store')
const { useSettings } = await import('../lib/settings')

const vkTrack = (id: number, cover?: Track['cover']): Track => ({
  service: 'vk',
  id,
  ownerId: 100,
  key: `100_${id}`,
  artist: 'Ny.Daad',
  title: `Track ${id}`,
  duration: 180,
  url: `https://cs1.vkuseraudio.ru/${id}/index.m3u8`,
  urlFetchedAt: Date.now(),
  cover,
  explicit: false,
  artists: [{ name: 'Ny.Daad' }],
  playable: true,
  hasLyrics: false,
  liked: false,
})

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('bridges VK cover accent extraction', () => {
  beforeEach(() => {
    h.reset()
    useSettings.setState({ accent: 'auto' })
  })

  test('applies cover accent on startup for restored VK track, updates when same-track cover arrives later, and drops stale resolutions', async () => {
    const cyanUrl = 'https://sun9-69.vkuserphoto.ru/impg/cyan-cover.jpg'
    const purpleUrl = 'https://sun1-22.vkuserphoto.ru/impg/purple-cover.jpg'
    const greenUrl = 'https://sun9-50.vkuserphoto.ru/impg/green-cover.jpg'
    h.setImmediate(cyanUrl, { r: 30, g: 220, b: 210 })
    h.setImmediate(purpleUrl, { r: 170, g: 70, b: 240 })

    // 1. Track is already restored in store BEFORE startBridges runs (matches real main.tsx boot order!)
    usePlayer.setState({
      current: vkTrack(1, { s: cyanUrl, m: cyanUrl, l: cyanUrl }),
    })

    const { startBridges } = await import('./bridges')
    startBridges({ toggleLike() {}, showWindow() {} })
    await flush()

    expect(h.accentCalls).toContain(cyanUrl)
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('rgb(30 220 210)')

    // 2. Switching to a VK track with no cover resets accent to default, then populating cover on the SAME track key updates accent!
    usePlayer.setState({ current: vkTrack(2, undefined) })
    await flush()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff375f')

    // Cover arrives later on track 2 (only cover.l present -> fallback still extracts accent!)
    usePlayer.setState({ current: vkTrack(2, { s: '', m: '', l: purpleUrl }) })
    await flush()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('rgb(170 70 240)')

    // 3. Stale slow accent resolution from skipped track 3 must NOT overwrite track 4's accent
    const slowUrl = 'https://sun9-62.vkuserphoto.ru/impg/slow-red.jpg'
    h.setImmediate(greenUrl, { r: 40, g: 210, b: 95 })
    usePlayer.setState({ current: vkTrack(3, { s: slowUrl, m: slowUrl, l: slowUrl }) })
    await flush()
    usePlayer.setState({ current: vkTrack(4, { s: greenUrl, m: greenUrl, l: greenUrl }) })
    await flush()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('rgb(40 210 95)')

    // Now the old track 3 cover resolves late -> must be ignored!
    h.pending.get(slowUrl)?.({ r: 240, g: 20, b: 20 })
    await flush()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('rgb(40 210 95)')
  })
})
