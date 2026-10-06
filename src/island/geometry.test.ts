import { describe, expect, test } from 'vitest'
import { SHAPES, WINDOW, collapseDelay, hitRect, isInteractive } from './geometry'

describe('island geometry', () => {
  test('every shape fits inside the fixed island window', () => {
    for (const shape of Object.values(SHAPES)) {
      expect(shape.w).toBeLessThanOrEqual(WINDOW.w)
      expect(shape.h + 8).toBeLessThanOrEqual(WINDOW.h)
    }
  })

  test('hit rect is centred horizontally with a small comfort margin', () => {
    expect(hitRect('compact')).toEqual({ x: 136, y: 4, w: 208, h: 44 })
    expect(hitRect('expanded')).toEqual({ x: 26, y: 4, w: 428, h: SHAPES.expanded.h + 8 })
  })

  test('compact and peek pass clicks through in hover mode but not in click mode', () => {
    expect(isInteractive('compact', 'hover')).toBe(false)
    expect(isInteractive('peek', 'hover')).toBe(false)
    expect(isInteractive('compact', 'click')).toBe(true)
    expect(isInteractive('expanded', 'hover')).toBe(true)
  })
})

describe('collapseDelay', () => {
  test('collapses quickly after the cursor leaves in both modes', () => {
    expect(collapseDelay('click')).toBeLessThanOrEqual(250)
    expect(collapseDelay('hover')).toBeLessThanOrEqual(350)
  })
})
