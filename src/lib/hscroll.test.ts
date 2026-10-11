import { describe, expect, test } from 'vitest'
import { columnTarget, wheelPixels, wheelStep } from './hscroll'

describe('wheelPixels', () => {
  test('lines and pages become pixels, a horizontal swipe is left to the browser', () => {
    expect(wheelPixels({ deltaX: 0, deltaY: 100, deltaMode: 0 }, 800)).toBe(100)
    expect(wheelPixels({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 800)).toBe(120)
    expect(wheelPixels({ deltaX: 0, deltaY: -1, deltaMode: 2 }, 800)).toBe(-800)
    expect(wheelPixels({ deltaX: 60, deltaY: 10, deltaMode: 0 }, 800)).toBe(0)
  })
})

describe('wheelStep', () => {
  test('a mouse notch is one step; small trackpad deltas add up first', () => {
    expect(wheelStep(0, 100)).toEqual({ dir: 1, acc: 0 })
    expect(wheelStep(0, -120)).toEqual({ dir: -1, acc: 0 })
    expect(wheelStep(0, 15)).toEqual({ dir: 0, acc: 15 })
    expect(wheelStep(30, 15)).toEqual({ dir: 1, acc: 0 })
    expect(wheelStep(30, -15)).toEqual({ dir: 0, acc: -15 })
  })
})

describe('columnTarget', () => {
  test('moves to the next or previous column, never past the ends', () => {
    expect(columnTarget(0, 1, 300, 1000)).toBe(300)
    expect(columnTarget(300, 1, 300, 1000)).toBe(600)
    expect(columnTarget(450, 1, 300, 1000)).toBe(600)
    expect(columnTarget(900, 1, 300, 1000)).toBe(1000)
    expect(columnTarget(1000, 1, 300, 1000)).toBe(1000)
    expect(columnTarget(450, -1, 300, 1000)).toBe(300)
    expect(columnTarget(300, -1, 300, 1000)).toBe(0)
    expect(columnTarget(0, -1, 300, 1000)).toBe(0)
  })
})
