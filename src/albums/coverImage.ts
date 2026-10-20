import { MAX_IMAGE, okImage } from './model'

/** Sizes and qualities tried, best first: the first small enough to travel with the album is the cover. */
export const COVER_STEPS: [side: number, quality: number][] = [
  [320, 0.85],
  [320, 0.75],
  [320, 0.65],
  [256, 0.7],
  [256, 0.55],
  [200, 0.5],
]

/** A picture bigger than this is not even opened. */
export const MAX_SOURCE = 30 * 1024 * 1024

export async function fitCover(encode: (side: number, quality: number) => Promise<string>, max = MAX_IMAGE): Promise<string | null> {
  for (const [side, quality] of COVER_STEPS) {
    const out = await encode(side, quality)
    if (out.length <= max) return out
  }
  return null
}

/** The middle square of a `w`×`h` picture, drawn at `want` px (a small picture is not blown up). */
export function squareCrop(w: number, h: number, want: number) {
  const size = Math.min(w, h)
  return { sx: Math.round((w - size) / 2), sy: Math.round((h - size) / 2), size, side: Math.min(want, size) }
}

/** The cover for a chosen file: its middle square, small (webp, jpeg where webp is not made); null when it cannot be one. */
export async function makeCover(file: Blob): Promise<string | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_SOURCE) return null
  const bmp = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const out = await fitCover(async (want, quality) => {
      const { sx, sy, size, side } = squareCrop(bmp.width, bmp.height, want)
      canvas.width = side
      canvas.height = side
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bmp, sx, sy, size, size, 0, 0, side, side)
      const webp = canvas.toDataURL('image/webp', quality)
      return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality)
    })
    return out && okImage(out) ? out : null
  } finally {
    bmp.close()
  }
}

/** The system's file picker for one picture; null when it was closed. */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp'
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}
