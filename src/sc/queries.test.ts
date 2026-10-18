import { expect, test } from 'vitest'
import { nextCursor } from './queries'

const page = (n: number, next?: string) => ({ items: Array.from({ length: n }, (_, i) => i), next })

test('cursor pages stop at max and at the end', () => {
  expect(nextCursor([page(200, '/a')], 2000)).toBe('/a')
  expect(nextCursor([page(200, '/a'), page(200)], 2000)).toBeUndefined()
  expect(nextCursor(Array.from({ length: 10 }, () => page(200, '/more')), 2000)).toBeUndefined()
  expect(nextCursor([page(150, '/b')], 100)).toBeUndefined()
  expect(nextCursor([], 2000)).toBeUndefined()
})
