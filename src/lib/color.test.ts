import { describe, expect, test } from 'vitest'
import { pickAccent, toCss } from './color'

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
})

describe('toCss', () => {
  test('formats rgb', () => {
    expect(toCss({ r: 1, g: 2, b: 3 })).toBe('rgb(1 2 3)')
  })
})
