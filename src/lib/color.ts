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

/**
 * Picks a vivid accent from RGBA pixels: hue histogram weighted by saturation and
 * mid-lightness, ignoring gray/black/white, then lifted into a readable range.
 */
export function pickAccent(data: Uint8ClampedArray): RGB | null {
  const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const px = { r: data[i], g: data[i + 1], b: data[i + 2] }
    const { h, s, l } = rgbToHsl(px)
    if (s < 0.25 || l < 0.1 || l > 0.92) continue
    const w = s * (1 - Math.abs(l - 0.5) * 1.2)
    if (w <= 0) continue
    const bin = bins[Math.floor(h * BINS) % BINS]
    bin.w += w
    bin.r += px.r * w
    bin.g += px.g * w
    bin.b += px.b * w
  }
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a))
  if (best.w < 0.5) return null
  const avg = { r: best.r / best.w, g: best.g / best.w, b: best.b / best.w }
  const { h, s, l } = rgbToHsl(avg)
  return hslToRgb(h, Math.max(s, 0.55), Math.min(0.66, Math.max(0.52, l)))
}

export const toCss = ({ r, g, b }: RGB): string => `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`

const cache = new Map<string, Promise<RGB | null>>()

async function loadBitmap(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (isTauri() && url.startsWith('https://')) {
    const bytes = await invoke<ArrayBuffer>('proxy_fetch', { url })
    return createImageBitmap(new Blob([bytes]))
  }
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await img.decode()
  return img
}

/** Accent color of an artwork URL (cached). Null when the image has no vivid color. */
export function artworkAccent(url: string | undefined): Promise<RGB | null> {
  if (!url) return Promise.resolve(null)
  let p = cache.get(url)
  if (!p) {
    p = (async () => {
      try {
        const src = await loadBitmap(url)
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        ctx.drawImage(src, 0, 0, 32, 32)
        return pickAccent(ctx.getImageData(0, 0, 32, 32).data)
      } catch {
        return null
      }
    })()
    cache.set(url, p)
  }
  return p
}
