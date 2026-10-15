import { describe, expect, test } from 'vitest'
import { scrollTarget } from './scrollWithin'

// The box shows 400px, currently scrolled by 100; the element is 40px tall
const box = { top: 50, scrollTop: 100, height: 400 }

describe('scrolling one panel to an element', () => {
  test('block start puts the element at the top, minus the scroll margin', () => {
    expect(scrollTarget({ top: 350, height: 40 }, box, 'start', 0)).toBe(400)
    expect(scrollTarget({ top: 350, height: 40 }, box, 'start', 52)).toBe(348)
  })

  test('block center puts it in the middle', () => {
    expect(scrollTarget({ top: 350, height: 40 }, box, 'center', 0)).toBe(220)
  })

  test('never above the start', () => {
    expect(scrollTarget({ top: 60, height: 40 }, box, 'start', 52)).toBe(58)
    expect(scrollTarget({ top: 0, height: 40 }, { top: 50, scrollTop: 0, height: 400 }, 'start', 0)).toBe(0)
  })
})
