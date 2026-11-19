import { afterEach, describe, expect, test, vi } from 'vitest'

const tauriMock = vi.hoisted(() => ({
  isTauri: false,
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<ArrayBuffer> => new Uint8Array([1, 2, 3, 4]).buffer),
}))

vi.mock('./tauri', () => ({
  isTauri: () => tauriMock.isTauri,
  invoke: (cmd: string, args?: unknown) => tauriMock.invoke(cmd, args),
}))

const { artworkAccent, parseCssRgb, pickAccent, toCss } = await import('./color')

function pixels(colors: [number, number, number][], each = 16): Uint8ClampedArray {
  const out = new Uint8ClampedArray(colors.length * each * 4)
  let i = 0
  for (const [r, g, b] of colors) {
    for (let k = 0; k < each; k++) {
      out[i++] = r
      out[i++] = g
      out[i++] = b
      out[i++] = 255
    }
  }
  return out
}

describe('pickAccent', () => {
  test('finds the dominant vivid hue', () => {
    const c = pickAccent(pixels([[20, 60, 230], [20, 60, 230], [20, 60, 230], [240, 200, 30]]))!
    expect(c.b).toBeGreaterThan(c.r)
    expect(c.b).toBeGreaterThan(c.g)
  })

  test('ignores near-black, near-white and gray pixels', () => {
    const c = pickAccent(pixels([[5, 5, 5], [250, 250, 250], [128, 128, 128], [128, 128, 128], [220, 30, 60]]))!
    expect(c.r).toBeGreaterThan(c.g + 60)
  })

  test('returns null for a grayscale image', () => {
    expect(pickAccent(pixels([[10, 10, 10], [120, 120, 120], [240, 240, 240]]))).toBeNull()
  })

  test('lifts dark colors into a readable accent range', () => {
    const c = pickAccent(pixels([[60, 0, 20]]))!
    const max = Math.max(c.r, c.g, c.b)
    expect(max).toBeGreaterThanOrEqual(150)
  })

  test('skips transparent pixels', () => {
    const data = pixels([[0, 200, 0]])
    for (let i = 3; i < data.length; i += 4) data[i] = 0
    expect(pickAccent(data)).toBeNull()
  })

  test('falls back to muted/pastel hues when a cover has no high-saturation pixels while keeping grayscale null', () => {
    // Dusty muted blue (s ≈ 0.19) across enough pixels -> picks blue hue instead of null
    const mutedBlue = pickAccent(pixels([[95, 118, 142]], 64))!
    expect(mutedBlue).not.toBeNull()
    expect(mutedBlue.b).toBeGreaterThan(mutedBlue.r + 30)

    // Pure grayscale with 1 tiny noisy tinted pixel still returns null
    const grayWithNoise = new Uint8ClampedArray([
      ...pixels([[40, 40, 40], [120, 120, 120], [210, 210, 210]], 32),
      100, 118, 136, 255,
    ])
    expect(pickAccent(grayWithNoise)).toBeNull()
  })
})

describe('toCss', () => {
  test('formats rgb', () => {
    expect(toCss({ r: 1, g: 2, b: 3 })).toBe('rgb(1 2 3)')
  })

  test('parses hex, short hex, space-separated rgb, and rgba strings', () => {
    expect(parseCssRgb('rgb(40 165 255)')).toEqual({ r: 40, g: 165, b: 255 })
    expect(parseCssRgb('rgba(12, 240, 128, 0.75)')).toEqual({ r: 12, g: 240, b: 128 })
    expect(parseCssRgb('#30d158')).toEqual({ r: 48, g: 209, b: 88 })
    expect(parseCssRgb('#0af')).toEqual({ r: 0, g: 170, b: 255 })
    expect(parseCssRgb('invalid')).toBeNull()
  })
})

describe('artworkAccent', () => {
  const origCreateBitmap = globalThis.createImageBitmap
  const origImage = globalThis.Image
  const origDocument = globalThis.document

  afterEach(() => {
    tauriMock.isTauri = false
    tauriMock.invoke.mockReset()
    globalThis.createImageBitmap = origCreateBitmap
    globalThis.Image = origImage
    ;(globalThis as Record<string, unknown>).document = origDocument
    vi.restoreAllMocks()
  })

  test('loads VK vkuserphoto.ru cover via proxy_fetch in Tauri and falls back to direct Image if proxy_fetch fails', async () => {
    tauriMock.isTauri = true
    const cyanPixels = pixels([[20, 225, 210]], 32)
    const purplePixels = pixels([[180, 60, 240]], 32)
    let activePixels = cyanPixels

    ;(globalThis as Record<string, unknown>).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          clearRect() {},
          drawImage(src: { _pixels?: Uint8ClampedArray }) {
            if (src?._pixels) activePixels = src._pixels
          },
          getImageData: () => ({ data: activePixels }),
        }),
      }),
    }

    let closed = 0
    globalThis.createImageBitmap = (async () => ({
      _pixels: cyanPixels,
      close() { closed++ },
    })) as unknown as typeof createImageBitmap

    // 1. Primary Tauri path: proxy_fetch succeeds for sun9-69.vkuserphoto.ru -> extracts vivid cyan!
    const vkUrl = 'https://sun9-69.vkuserphoto.ru/impg/cyan.jpg?size=300x300'
    tauriMock.invoke.mockResolvedValueOnce(new Uint8Array([0xff, 0xd8, 0xff]).buffer)
    const cyan = await artworkAccent(vkUrl)
    expect(tauriMock.invoke).toHaveBeenCalledWith('proxy_fetch', { url: vkUrl })
    expect(cyan).not.toBeNull()
    expect(cyan!.g).toBeGreaterThan(150)
    expect(cyan!.b).toBeGreaterThan(150)
    expect(closed).toBe(1)

    // 2. Fallback path: if proxy_fetch ever rejects a new CDN host, direct CORS Image still extracts color!
    const futureCdn = 'https://new-cdn.example/cover.jpg'
    tauriMock.invoke.mockRejectedValueOnce(new Error('media host not allowed'))
    class MockImage {
      crossOrigin = ''
      referrerPolicy = ''
      src = ''
      _pixels = purplePixels
      async decode() {}
    }
    globalThis.Image = MockImage as unknown as typeof Image
    const purple = await artworkAccent(futureCdn)
    expect(purple).not.toBeNull()
    expect(purple!.b).toBeGreaterThan(purple!.g + 50)
  })
})
