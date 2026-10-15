import { describe, expect, test } from 'vitest'
import { CHECK_EVERY_MS, ON_RETURN_MS, shouldCheck } from './updates'

describe('shouldCheck', () => {
  test('checks when never checked and then every half hour', () => {
    expect(CHECK_EVERY_MS).toBe(30 * 60_000)
    expect(shouldCheck(null, 1000)).toBe(true)
    expect(shouldCheck(1000, 1000 + CHECK_EVERY_MS - 1)).toBe(false)
    expect(shouldCheck(1000, 1000 + CHECK_EVERY_MS)).toBe(true)
  })

  test('coming back to the window checks again after a few minutes, not on every glance', () => {
    expect(shouldCheck(1000, 1000 + ON_RETURN_MS - 1, ON_RETURN_MS)).toBe(false)
    expect(shouldCheck(1000, 1000 + ON_RETURN_MS, ON_RETURN_MS)).toBe(true)
  })
})
