import { describe, expect, test } from 'vitest'
import { bestOffset, sampleOffset } from './clock'

describe('clock difference between listener and host', () => {
  test('one round trip: the host clock is ahead by its reading minus the middle of the trip', () => {
    // sent at 1000 by the listener, the host read 1520 on its clock, the answer came back at 1040
    expect(sampleOffset({ t0: 1000, t1: 1520, t2: 1040 })).toEqual({ offset: 500, rtt: 40 })
    expect(sampleOffset({ t0: 1000, t1: 700, t2: 1100 })).toEqual({ offset: -350, rtt: 100 })
  })

  test('the fastest round trip is trusted most; no samples means no correction', () => {
    const samples = [
      { t0: 0, t1: 900, t2: 600 },
      { t0: 1000, t1: 1520, t2: 1040 },
      { t0: 2000, t1: 2700, t2: 2300 },
    ]
    expect(bestOffset(samples)).toBe(500)
    expect(bestOffset([])).toBe(0)
  })
})
