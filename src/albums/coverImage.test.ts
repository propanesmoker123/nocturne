import { describe, expect, test } from 'vitest'
import { COVER_STEPS, fitCover, squareCrop } from './coverImage'

describe('making a cover from a picture', () => {
  test('the first size and quality small enough is taken, best first', async () => {
    const tried: string[] = []
    // pretend: the bigger and better, the longer
    const encode = async (side: number, quality: number) => {
      tried.push(`${side}@${quality}`)
      return 'x'.repeat(Math.round(side * side * quality))
    }
    const out = await fitCover(encode, 50_000)
    expect(out).toHaveLength(Math.round(256 * 256 * 0.7))
    expect(tried[0]).toBe(`${COVER_STEPS[0][0]}@${COVER_STEPS[0][1]}`)
    expect(tried.at(-1)).toBe('256@0.7')
  })

  test('a picture that never gets small enough is refused', async () => {
    expect(await fitCover(async () => 'x'.repeat(60_000), 50_000)).toBeNull()
  })

  test('the middle square of the picture, never blown up', () => {
    expect(squareCrop(1200, 800, 320)).toEqual({ sx: 200, sy: 0, size: 800, side: 320 })
    expect(squareCrop(600, 900, 320)).toEqual({ sx: 0, sy: 150, size: 600, side: 320 })
    expect(squareCrop(100, 150, 320)).toEqual({ sx: 0, sy: 25, size: 100, side: 100 })
  })
})
