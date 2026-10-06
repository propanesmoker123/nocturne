import { describe, expect, test } from 'vitest'
import { CHECK_EVERY_MS, shouldCheck } from './updates'

describe('shouldCheck', () => {
  test('checks when never checked and then every few hours', () => {
    expect(shouldCheck(null, 1000)).toBe(true)
    expect(shouldCheck(1000, 1000 + CHECK_EVERY_MS - 1)).toBe(false)
    expect(shouldCheck(1000, 1000 + CHECK_EVERY_MS)).toBe(true)
  })
})
