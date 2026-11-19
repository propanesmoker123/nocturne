import { invoke, isTauri } from './tauri'

export interface RGB {
  r: number
  g: number
  b: number
}

export function rgbToHsl({ r, g, b }: RGB): { h: number; s: number; l: number } {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (max === R) h = ((G - B) / d) % 6
  else if (max === G) h = (B - R) / d + 2
  else h = (R - G) / d + 4
  h /= 6
  if (h < 0) h += 1
  return { h, s, l }
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255) }
}

const BINS = 24

function pickFromHistogram(
  data: Uint8ClampedArray,
  minSat: number,
  minLight: number,
  maxLight: number,
  minWeight: number,
  liftSat: number,
): RGB | null {
  const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const px = { r: data[i], g: data[i + 1], b: data[i + 2] }
    const { h, s, l } = rgbToHsl(px)
    if (s < minSat || l < minLight || l > maxLight) continue
    const w = s * (1 - Math.abs(l - 0.5) * 1.2)
    if (w <= 0) continue
    const bin = bins[Math.floor(h * BINS) % BINS]
    bin.w += w
    bin.r += px.r * w
    bin.g += px.g * w
    bin.b += px.b * w
  }
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a))
  if (best.w < minWeight) return null
  const avg = { r: best.r / best.w, g: best.g / best.w, b: best.b / best.w }
  const { h, s, l } = rgbToHsl(avg)
  return hslToRgb(h, Math.max(s, liftSat), Math.min(0.66, Math.max(0.52, l)))
}

/**
 * Picks a vivid accent from RGBA pixels: hue histogram weighted by saturation and
 * mid-lightness, ignoring gray/black/white, then lifted into a readable range.
 * Falls back to a muted-hue pass for pastel/low-saturation covers while still returning null for grayscale.
 */
export function pickAccent(data: Uint8ClampedArray): RGB | null {
  return (
    pickFromHistogram(data, 0.25, 0.1, 0.92, 0.5, 0.55) ??
    pickFromHistogram(data, 0.14, 0.08, 0.94, 2.0, 0.42)
  )
}

export const toCss = ({ r, g, b }: RGB): string => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`

const HEX6_RE = /^#?([0-9a-f]{6})$/i
const HEX3_RE = /^#?([0-9a-f]{3})$/i
const RGB_FN_RE = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*(?:,|\s)\s*(\d+(?:\.\d+)?)\s*(?:,|\s)\s*(\d+(?:\.\d+)?)/i

/** Parses CSS hex (`#rgb` / `#rrggbb`) or `rgb(...)` / `rgba(...)` into `[0..255]` RGB. */
export function parseCssRgb(value: string): RGB | null {
  const s = value.trim()
  if (!s) return null
  const m6 = s.match(HEX6_RE)
  if (m6) {
    const h = m6[1]!
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    }
  }
  const m3 = s.match(HEX3_RE)
  if (m3) {
    const h = m3[1]!
    return {
      r: parseInt(h[0]! + h[0]!, 16),
      g: parseInt(h[1]! + h[1]!, 16),
      b: parseInt(h[2]! + h[2]!, 16),
    }
  }
  const mRgb = s.match(RGB_FN_RE)
  if (mRgb) {
    const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)))
    return {
      r: clamp255(Number(mRgb[1])),
      g: clamp255(Number(mRgb[2])),
      b: clamp255(Number(mRgb[3])),
    }
  }
  return null
}

const MAX_CACHE = 200
const cache = new Map<string, Promise<RGB | null>>()
let scratchCtx: CanvasRenderingContext2D | null = null

function getScratchCtx(): CanvasRenderingContext2D | null {
  if (scratchCtx) return scratchCtx
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  scratchCtx = canvas.getContext('2d', { willReadFrequently: true })
  return scratchCtx
}

async function decodeBlobAsImage(blob: Blob): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = objectUrl
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function loadImageDirect(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.referrerPolicy = 'no-referrer'
  img.src = url
  await img.decode()
  return img
}

async function loadBitmap(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (isTauri() && url.startsWith('https://')) {
    try {
      const bytes = await invoke<ArrayBuffer>('proxy_fetch', { url })
      const blob = new Blob([bytes])
      if (typeof createImageBitmap === 'function') {
        try {
          return await createImageBitmap(blob)
        } catch {
          return await decodeBlobAsImage(blob)
        }
      }
      return await decodeBlobAsImage(blob)
    } catch {
      return await loadImageDirect(url)
    }
  }
  return await loadImageDirect(url)
}

/** Accent color of an artwork URL (cached). Null when the image has no vivid color. */
export function artworkAccent(url: string | undefined): Promise<RGB | null> {
  if (!url) return Promise.resolve(null)
  const existing = cache.get(url)
  if (existing) {
    // Refresh LRU recency
    cache.delete(url)
    cache.set(url, existing)
    return existing
  }
  let p: Promise<RGB | null> | undefined
  p = (async () => {
    let src: ImageBitmap | HTMLImageElement | null = null
    try {
      src = await loadBitmap(url)
      const ctx = getScratchCtx()
      if (!ctx) return null
      ctx.clearRect(0, 0, 32, 32)
      ctx.drawImage(src, 0, 0, 32, 32)
      return pickAccent(ctx.getImageData(0, 0, 32, 32).data)
    } catch {
      // Evict transient network/decode errors so later plays can retry.
      if (p && cache.get(url) === p) cache.delete(url)
      return null
    } finally {
      if (src && 'close' in src && typeof src.close === 'function') src.close()
    }
  })()
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(url, p)
  return p
}
