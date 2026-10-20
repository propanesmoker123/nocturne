/** Tiny pictures for tests: real headers (what decides the size a picture claims), filler after. */

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
const u16be = (n: number) => [(n >>> 8) & 255, n & 255]
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const u16le = (n: number) => [n & 255, (n >>> 8) & 255]
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]

export function toBase64(bytes: ArrayLike<number>): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...Array.from(bytes).slice(i, i + 0x8000))
  return btoa(s)
}

const fill = (n: number) => new Array<number>(n).fill(0)

export const pngHeader = (w: number, h: number) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, ...fill(4)]

export const png = (w: number, h: number, pad = 0) => `data:image/png;base64,${toBase64([...pngHeader(w, h), ...fill(pad)])}`

const riff = (chunk: number[]) => [...ascii('RIFF'), ...u32le(chunk.length + 4), ...ascii('WEBP'), ...chunk]

/** Extended WebP (what carries alpha and animation). */
export const webpVp8x = (w: number, h: number) => `data:image/webp;base64,${toBase64(riff([...ascii('VP8X'), ...u32le(10), 0x10, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1), ...fill(32)]))}`

/** Lossless WebP. */
export const webpVp8l = (w: number, h: number) => `data:image/webp;base64,${toBase64(riff([...ascii('VP8L'), ...u32le(5), 0x2f, ...u32le(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14)), ...fill(32)]))}`

/** Lossy WebP (what a canvas makes). */
export const webpVp8 = (w: number, h: number) => `data:image/webp;base64,${toBase64(riff([...ascii('VP8 '), ...u32le(10), 0x50, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h), ...fill(32)]))}`

/** A baseline JPEG: an APP0 segment, then the frame with the size. */
export const jpeg = (w: number, h: number) =>
  `data:image/jpeg;base64,${toBase64([0xff, 0xd8, 0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, ...fill(9), 0xff, 0xd9])}`
