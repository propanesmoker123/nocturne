import { describe, expect, test } from 'vitest'
import {
  append,
  createQueue,
  current,
  insertNext,
  move,
  next,
  prev,
  removeAt,
  setShuffle,
  upcoming,
} from './queue'

const ok = () => true

describe('createQueue', () => {
  test('starts at the requested index in natural order', () => {
    const q = createQueue(['a', 'b', 'c'], 1, false, 'off')
    expect(current(q)).toBe('b')
    expect(q.order).toEqual([0, 1, 2])
    expect(upcoming(q)).toEqual(['c'])
  })

  test('empty queue has no current item', () => {
    expect(current(createQueue([], 0, false, 'off'))).toBeNull()
  })

  test('shuffled start keeps the chosen track first', () => {
    const q = createQueue([1, 2, 3, 4], 3, true, 'off', () => 0.1)
    expect(current(q)).toBe(4)
    expect(q.pos).toBe(0)
    expect([...q.order].sort()).toEqual([0, 1, 2, 3])
  })
})

describe('next', () => {
  test('advances to the following track', () => {
    expect(current(next(createQueue(['a', 'b', 'c'], 0, false, 'off'), ok, false)!)).toBe('b')
  })

  test('wraps to the first track with repeat all', () => {
    expect(current(next(createQueue(['a', 'b'], 1, false, 'all'), ok, false)!)).toBe('a')
  })

  test('returns null at the end with repeat off', () => {
    expect(next(createQueue(['a'], 0, false, 'off'), ok, false)).toBeNull()
  })

  test('repeat one keeps the track on auto-advance but not on manual next', () => {
    const q = createQueue(['a', 'b'], 0, false, 'one')
    expect(current(next(q, ok, false)!)).toBe('a')
    expect(current(next(q, ok, true)!)).toBe('b')
  })

  test('skips unplayable tracks', () => {
    const q = createQueue(['a', 'x', 'b'], 0, false, 'off')
    expect(current(next(q, (t) => t !== 'x', true)!)).toBe('b')
  })

  test('returns null when nothing is playable, even with repeat all', () => {
    const q = createQueue(['a', 'x', 'y'], 0, false, 'all')
    expect(next(q, () => false, true)).toBeNull()
  })

  test('repeat one on an unplayable track moves on instead of looping', () => {
    const q = createQueue(['x', 'b'], 0, false, 'one')
    expect(current(next(q, (t) => t !== 'x', false)!)).toBe('b')
  })
})

describe('prev', () => {
  test('goes back one track', () => {
    expect(current(prev(createQueue(['a', 'b', 'c'], 2, false, 'off'), ok)!)).toBe('b')
  })

  test('returns null at the start with repeat off', () => {
    expect(prev(createQueue(['a', 'b'], 0, false, 'off'), ok)).toBeNull()
  })

  test('wraps to the last track with repeat all', () => {
    expect(current(prev(createQueue(['a', 'b', 'c'], 0, false, 'all'), ok)!)).toBe('c')
  })

  test('skips unplayable tracks backwards', () => {
    expect(current(prev(createQueue(['a', 'x', 'b'], 2, false, 'off'), (t) => t !== 'x')!)).toBe('a')
  })
})

describe('setShuffle', () => {
  test('keeps the current track first and produces a permutation', () => {
    const q = setShuffle(createQueue([1, 2, 3, 4, 5], 2, false, 'off'), true, () => 0.42)
    expect(current(q)).toBe(3)
    expect(q.pos).toBe(0)
    expect([...q.order].sort()).toEqual([0, 1, 2, 3, 4])
    expect(q.shuffle).toBe(true)
  })

  test('turning shuffle off restores natural order around the current track', () => {
    const shuffled = setShuffle(createQueue([1, 2, 3, 4, 5], 3, false, 'off'), true, () => 0.7)
    const q = setShuffle(shuffled, false)
    expect(q.order).toEqual([0, 1, 2, 3, 4])
    expect(current(q)).toBe(4)
    expect(q.pos).toBe(3)
  })
})

describe('queue editing', () => {
  test('insertNext places items right after the current track', () => {
    const q = insertNext(createQueue(['a', 'b'], 0, false, 'off'), ['z'])
    expect(current(q)).toBe('a')
    expect(upcoming(q)).toEqual(['z', 'b'])
  })

  test('insertNext keeps multiple items in their given order', () => {
    const q = insertNext(createQueue(['a', 'b'], 0, false, 'off'), ['y', 'z'])
    expect(upcoming(q)).toEqual(['y', 'z', 'b'])
  })

  test('append adds items to the end of the queue', () => {
    const q = append(createQueue(['a', 'b'], 0, false, 'off'), ['z'])
    expect(upcoming(q)).toEqual(['b', 'z'])
  })

  test('removing a track before the current one keeps the current track', () => {
    const q = removeAt(createQueue(['a', 'b', 'c'], 2, false, 'off'), 0)
    expect(current(q)).toBe('c')
    expect(q.order).toHaveLength(2)
  })

  test('removing an upcoming track drops it from upcoming', () => {
    const q = removeAt(createQueue(['a', 'b', 'c'], 0, false, 'off'), 1)
    expect(upcoming(q)).toEqual(['c'])
  })

  test('move reorders upcoming tracks without changing the current track', () => {
    const q = move(createQueue(['a', 'b', 'c', 'd'], 0, false, 'off'), 3, 1)
    expect(current(q)).toBe('a')
    expect(upcoming(q)).toEqual(['d', 'b', 'c'])
  })

  test('moving the current track keeps pointing at it', () => {
    const q = move(createQueue(['a', 'b', 'c'], 0, false, 'off'), 0, 2)
    expect(current(q)).toBe('a')
    expect(q.pos).toBe(2)
  })
})
