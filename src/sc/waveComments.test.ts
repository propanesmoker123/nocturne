import { describe, expect, test } from 'vitest'
import type { ScComment } from './normalize'
import { commentsOf, passing, placeComments } from './waveComments'

const c = (id: number, atMs: number): ScComment => ({ id, atMs, body: `c${id}`, user: { name: `u${id}` } })

describe('comments on the waveform', () => {
  test('200 comments on a narrow wave: one avatar per place', () => {
    const all = Array.from({ length: 200 }, (_, i) => c(i, i * 1000))
    const slots = placeComments(all, 200_000, 300, 14)
    expect(slots.length).toBeLessThanOrEqual(Math.floor(300 / 14) + 1)
    expect(slots.flatMap((s) => s.comments)).toHaveLength(200)
    for (const s of slots) expect(s.x >= 7 && s.x <= 293).toBe(true)
    expect(slots.map((s) => s.x)).toEqual([...slots.map((s) => s.x)].sort((a, b) => a - b))
  })

  test('comments past the end of the track are not placed', () => {
    expect(placeComments([c(1, 5000), c(2, 300_000), c(3, -1)], 200_000, 300, 14).flatMap((s) => s.comments.map((x) => x.id))).toEqual([1])
    expect(placeComments([c(1, 5000)], 0, 300, 14)).toEqual([])
  })

  test('a place keeps its comments in time order', () => {
    const [slot] = placeComments([c(2, 1500), c(1, 1000)], 200_000, 300, 14)
    expect(slot.comments.map((x) => x.id)).toEqual([1, 2])
  })

  test('a comment lights up while the track passes it', () => {
    const [slot] = placeComments([c(1, 1000)], 200_000, 300, 14)
    expect([passing(slot, 999), passing(slot, 1000), passing(slot, 3499), passing(slot, 3500)]).toEqual([false, true, true, false])
  })

  test('comments of another track are not placed', () => {
    expect(commentsOf({ trackId: 1, comments: [c(1, 5)] }, 2)).toEqual([])
    expect(commentsOf(undefined, 1)).toEqual([])
    expect(commentsOf({ trackId: 1, comments: [c(1, 5)] }, 1)).toHaveLength(1)
  })
})
