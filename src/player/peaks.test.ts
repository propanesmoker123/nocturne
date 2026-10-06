import { describe, expect, test } from 'vitest'
import { BINS, accumulate, isComplete, newAcc, resample, toPeaks } from './peaks'

const tone = (seconds: number, rate: number, amp: number) => new Float32Array(Math.round(seconds * rate)).fill(amp)

describe('peaks', () => {
  test('places a chunk by its start time and leaves the rest unknown', () => {
    const acc = newAcc()
    // 240 s track → 1 s per bin; a 10 s chunk starting at 100 s fills bins 100..109.
    accumulate(acc, [tone(10, 100, 0.5)], 100, 100, 240)
    const p = toPeaks(acc)
    expect(p[99]).toBe(-1)
    expect(p[100]).toBeCloseTo(1)
    expect(p[109]).toBeCloseTo(1)
    expect(p[110]).toBe(-1)
    expect(isComplete(acc)).toBe(false)
  })

  test('normalises to the loudest bin, chunks can arrive in any order', () => {
    const acc = newAcc()
    accumulate(acc, [tone(120, 50, 0.1)], 50, 120, 240)
    accumulate(acc, [tone(120, 50, 0.4)], 50, 0, 240)
    const p = toPeaks(acc)
    expect(isComplete(acc)).toBe(true)
    expect(p[0]).toBeCloseTo(1)
    expect(p[200]).toBeCloseTo(Math.pow(0.25, 0.8))
  })

  test('averages channels and ignores samples past the end', () => {
    const acc = newAcc()
    accumulate(acc, [tone(300, 10, 0.6), tone(300, 10, 0)], 10, 0, 240)
    expect(isComplete(acc)).toBe(true)
    expect(acc.counts.reduce((a, b) => a + b, 0)).toBe(240 * 10)
  })

  test('resample keeps the loudest bin per column and the unknown marker', () => {
    const peaks = new Float32Array(BINS).fill(-1)
    peaks[0] = 0.2
    peaks[1] = 0.9
    const bars = resample(peaks, 120)
    expect(bars[0]).toBeCloseTo(0.9)
    expect(bars[1]).toBe(-1)
    expect(resample(null, 3)).toEqual([-1, -1, -1])
    expect(resample(peaks, 480)[0]).toBeCloseTo(0.2)
  })
})
