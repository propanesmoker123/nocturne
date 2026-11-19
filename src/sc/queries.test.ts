import { expect, test } from 'vitest'
import { nextCursor } from './queries'

const page = (n: number, next?: string) => ({ items: Array.from({ length: n }, (_, i) => i), next })

test('cursor pages stop at max, at the end, on empty pages, on duplicate cursors, and at page cap', () => {
  expect(nextCursor([page(200, '/a')], 2000)).toBe('/a')
  expect(nextCursor([page(200, '/a'), page(200)], 2000)).toBeUndefined()
  expect(nextCursor(Array.from({ length: 10 }, (_, i) => page(200, `/more-${i}`)), 2000)).toBeUndefined()
  expect(nextCursor([page(150, '/b')], 100)).toBeUndefined()
  expect(nextCursor([], 2000)).toBeUndefined()
  // Empty page stops cursor pagination even if next_href is present
  expect(nextCursor([page(0, '/empty-next')], 2000)).toBeUndefined()
  // Duplicate cursor URL stops infinite loop
  expect(nextCursor([page(10, '/dup'), page(10, '/dup')], 2000)).toBeUndefined()
})
