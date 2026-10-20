import { expect, test } from 'vitest'
import { enterPlays } from './rowKeys'

test("Enter on a row plays it; Enter on a button inside the row is the button's own", () => {
  const row = {}
  expect(enterPlays({ key: 'Enter', target: row, currentTarget: row })).toBe(true)
  expect(enterPlays({ key: 'Enter', target: {}, currentTarget: row })).toBe(false)
  expect(enterPlays({ key: ' ', target: row, currentTarget: row })).toBe(false)
})
